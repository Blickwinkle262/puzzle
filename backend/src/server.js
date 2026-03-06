import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import express from "express";

import { runMigrations } from "./migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const WEB_PUBLIC_DIR = path.join(ROOT_DIR, "web", "public");
const STORY_PUBLIC_PREFIX = "/content/stories";
const DEFAULT_STORIES_ROOT_DIR = path.join(ROOT_DIR, "backend", "data", "generated", "content", "stories");
const LEGACY_STORIES_ROOT_DIR = path.join(WEB_PUBLIC_DIR, "content", "stories");
const STORIES_ROOT_DIR = resolveStoriesRootDir();
const STORY_INDEX_FILE = path.join(STORIES_ROOT_DIR, "index.json");

const DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "puzzle_session";
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || "puzzle_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const SESSION_TTL_MS = resolveSessionTtlMs();
const COOKIE_SECURE = resolveCookieSecure();
const COOKIE_SAME_SITE = resolveCookieSameSite(COOKIE_SECURE);
const VALID_PROGRESS_STATUS = new Set(["not_started", "in_progress", "completed"]);
const AUTH_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 10;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 20;
const RESET_TOKEN_TTL_MS = 1000 * 60 * 30;
const GENERATED_ROOT_DIR = path.join(ROOT_DIR, "backend", "data", "generated");
const STORY_GENERATOR_OUTPUT_ROOT = resolveProjectPath(
  process.env.STORY_GENERATOR_OUTPUT_ROOT
    || process.env.STORY_GENERATION_OUTPUT_ROOT,
  path.join(GENERATED_ROOT_DIR, "content", "stories"),
);
const STORY_GENERATOR_INDEX_FILE = resolveProjectPath(
  process.env.STORY_GENERATOR_INDEX_FILE
    || process.env.STORY_GENERATION_INDEX_FILE,
  path.join(STORY_GENERATOR_OUTPUT_ROOT, "index.json"),
);
const STORY_GENERATOR_LOG_DIR = resolveProjectPath(
  process.env.STORY_GENERATOR_LOG_DIR
    || process.env.STORY_GENERATION_LOG_DIR,
  path.join(GENERATED_ROOT_DIR, "logs", "story_generator"),
);
const STORY_GENERATOR_SUMMARY_DIR = resolveProjectPath(
  process.env.STORY_GENERATOR_SUMMARY_DIR
    || process.env.STORY_GENERATION_SUMMARY_DIR,
  path.join(GENERATED_ROOT_DIR, "summaries", "story_generator"),
);
const ADMIN_USERNAMES = new Set(
  String(process.env.ADMIN_USERNAMES || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0),
);
const parsedMaxGenerationJobs = Number(process.env.MAX_GENERATION_JOBS || 100);
const MAX_GENERATION_JOBS = Number.isFinite(parsedMaxGenerationJobs) && parsedMaxGenerationJobs > 0
  ? Math.max(10, Math.floor(parsedMaxGenerationJobs))
  : 100;
const STORY_GENERATOR_WORKER_TOKEN = String(
  process.env.STORY_GENERATOR_WORKER_TOKEN
    || process.env.STORY_GENERATION_WORKER_TOKEN
    || "",
).trim();
const STORY_GENERATOR_PYTHON_BIN = String(
  process.env.STORY_GENERATOR_PYTHON_BIN
    || process.env.STORY_GENERATION_PYTHON_BIN
    || process.env.PYTHON_BIN
    || "",
).trim();
const STORY_GENERATOR_PYTHON_CMD = resolveStoryGeneratorPythonCommand({
  explicitCmd: process.env.STORY_GENERATOR_PYTHON_CMD || process.env.STORY_GENERATION_PYTHON_CMD || "",
  explicitBin: STORY_GENERATOR_PYTHON_BIN,
});
const STORY_GENERATOR_ATOMIC_MODULE = "scripts.story_generator_pipeline.atomic_cli";
const parsedAtomicTimeoutMs = Number(
  process.env.STORY_GENERATOR_ATOMIC_TIMEOUT_MS
    || process.env.STORY_GENERATION_ATOMIC_TIMEOUT_MS
    || 1000 * 60 * 8,
);
const STORY_GENERATOR_ATOMIC_TIMEOUT_MS = Number.isFinite(parsedAtomicTimeoutMs) && parsedAtomicTimeoutMs > 0
  ? Math.floor(parsedAtomicTimeoutMs)
  : 1000 * 60 * 8;
const LEGACY_GENERATE_STORY_CREATE_ENABLED = normalizeBoolean(
  process.env.GENERATION_LEGACY_CREATE_ENABLED
    || process.env.STORY_GENERATOR_LEGACY_CREATE_ENABLED
    || false,
);
const GENERATION_FLOW_STAGES = new Set([
  "",
  "text_generating",
  "text_ready",
  "images_generating",
  "review_ready",
  "published",
  "failed",
]);
const GENERATION_SCENE_TEXT_STATUSES = new Set(["pending", "ready", "failed", "deleted"]);
const GENERATION_SCENE_IMAGE_STATUSES = new Set(["pending", "queued", "running", "success", "failed", "skipped"]);
const DEFAULT_TIMER_POLICY = Object.freeze({
  base_seconds: 45,
  per_piece_seconds: 4,
  min_seconds: 60,
  max_seconds: 600,
  difficulty_factor: {
    easy: 1.2,
    normal: 1.0,
    hard: 0.85,
    nightmare: 0.7,
  },
});
const MANAGED_ADMIN_ROLES = new Set(["admin", "editor", "level_designer", "operator"]);
const MANAGED_LEVEL_DIFFICULTIES = new Set(["easy", "normal", "hard", "nightmare"]);
const BOOK_INGEST_DB_PATH = resolveProjectPath(
  process.env.BOOK_INGEST_DB_PATH,
  path.join(ROOT_DIR, "scripts", "book_ingest", "data", "books.sqlite"),
);
const RESOLVED_BOOK_INGEST_DB_PATH = BOOK_INGEST_DB_PATH;
let booksDb = null;


fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(STORIES_ROOT_DIR, { recursive: true });
fs.mkdirSync(STORY_GENERATOR_LOG_DIR, { recursive: true });
fs.mkdirSync(STORY_GENERATOR_SUMMARY_DIR, { recursive: true });
ensureStoryIndexFile();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
initializeSchema(db);
runMigrations(db);

if (LEGACY_GENERATE_STORY_CREATE_ENABLED) {
  console.warn(
    "[generation] legacy POST /api/admin/generate-story is enabled via GENERATION_LEGACY_CREATE_ENABLED=1; this is temporary compatibility mode.",
  );
}

const authRateBuckets = new Map();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(STORY_PUBLIC_PREFIX, express.static(STORIES_ROOT_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    now: nowIso(),
    story_generator: {
      atomic_module: STORY_GENERATOR_ATOMIC_MODULE,
      python_command: STORY_GENERATOR_PYTHON_CMD,
      python_command_text: STORY_GENERATOR_PYTHON_CMD.join(" "),
      legacy_create_enabled: LEGACY_GENERATE_STORY_CREATE_ENABLED,
    },
  });
});

app.post("/api/auth/register", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = normalizePassword(req.body?.password);

  if (!passAuthRateLimit(req, username, res)) {
    return;
  }

  if (!username || !password) {
    res.status(400).json({ message: "用户名和密码不能为空" });
    return;
  }

  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (exists) {
    res.status(409).json({ message: "用户名已存在" });
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const now = nowIso();

  const result = db
    .prepare(
      "INSERT INTO users (username, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?)",
    )
    .run(username, passwordHash, now, now);

  const userId = Number(result.lastInsertRowid);
  clearAuthRateLimit(req, username);
  const session = createSession(userId);
  runProgressMaintenanceForUser(userId);
  setAuthCookies(res, session);

  res.status(201).json({
    user: buildAuthUserPayload({
      id: userId,
      username,
      is_guest: false,
    }),
  });
});

app.post("/api/auth/login", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = normalizePassword(req.body?.password);

  if (!passAuthRateLimit(req, username, res)) {
    return;
  }

  if (!username || !password) {
    res.status(400).json({ message: "用户名和密码不能为空" });
    return;
  }

  const user = db
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.password_hash,
        u.is_guest,
        CASE WHEN EXISTS (
          SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role = 'admin'
        ) THEN 1 ELSE 0 END AS has_admin_role
      FROM users u
      WHERE u.username = ?
      `,
    )
    .get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ message: "用户名或密码错误" });
    return;
  }

  const now = nowIso();
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, user.id);

  clearAuthRateLimit(req, user.username);
  const session = createSession(user.id);
  runProgressMaintenanceForUser(user.id);
  setAuthCookies(res, session);

  res.json({
    user: buildAuthUserPayload(user),
  });
});

app.post("/api/auth/guest-login", (req, res) => {
  if (!passAuthRateLimit(req, "guest", res)) {
    return;
  }

  const username = createGuestUsername();
  const passwordHash = bcrypt.hashSync(randomToken(), 10);
  const now = nowIso();

  const result = db
    .prepare(
      "INSERT INTO users (username, password_hash, is_guest, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(username, passwordHash, 1, now, now);

  const userId = Number(result.lastInsertRowid);
  clearAuthRateLimit(req, "guest");
  const session = createSession(userId);
  runProgressMaintenanceForUser(userId);
  setAuthCookies(res, session);

  res.status(201).json({
    user: buildAuthUserPayload({
      id: userId,
      username,
      is_guest: true,
    }),
  });
});

app.post("/api/auth/logout", (req, res) => {
  pruneExpiredSessions();

  const token = extractSessionToken(req);
  if (!token) {
    clearAuthCookies(res);
    res.status(204).end();
    return;
  }

  const row = db
    .prepare("SELECT token, csrf_token FROM sessions WHERE token = ? AND expires_at > ?")
    .get(token, nowIso());

  if (!row) {
    clearAuthCookies(res);
    res.status(204).end();
    return;
  }

  const csrfHeader = extractCsrfHeader(req);
  if (!csrfHeader || csrfHeader !== row.csrf_token) {
    res.status(403).json({ message: "CSRF 校验失败" });
    return;
  }

  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  clearAuthCookies(res);
  res.status(204).end();
});

app.post("/api/auth/refresh", requireAuth, requireCsrf, (req, res) => {
  const rotated = rotateSession(req.authToken);
  if (!rotated) {
    res.status(401).json({ message: "登录状态已失效" });
    return;
  }

  setAuthCookies(res, rotated);
  res.json({
    user: buildAuthUserPayload(req.authUser),
    refreshed_at: nowIso(),
  });
});

app.post("/api/auth/guest-upgrade", requireAuth, requireCsrf, (req, res) => {
  if (!req.authUser.is_guest) {
    res.status(400).json({ message: "当前账号不是游客模式" });
    return;
  }

  const username = normalizeUsername(req.body?.username);
  const password = normalizePassword(req.body?.password);

  if (!username || !password) {
    res.status(400).json({ message: "用户名和密码不能为空" });
    return;
  }

  const exists = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(username, req.authUser.id);
  if (exists) {
    res.status(409).json({ message: "用户名已存在" });
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const now = nowIso();
  db.prepare("UPDATE users SET username = ?, password_hash = ?, is_guest = 0, last_login_at = ? WHERE id = ?").run(
    username,
    passwordHash,
    now,
    req.authUser.id,
  );

  res.json({
    user: buildAuthUserPayload({
      id: req.authUser.id,
      username,
      is_guest: false,
    }),
  });
});

app.post("/api/auth/change-password", requireAuth, requireCsrf, (req, res) => {
  const currentPassword = typeof req.body?.current_password === "string" ? req.body.current_password : "";
  const newPassword = normalizePassword(req.body?.new_password);

  if (!currentPassword || !newPassword) {
    res.status(400).json({ message: "当前密码和新密码不能为空" });
    return;
  }

  const row = db.prepare("SELECT password_hash, username, is_guest FROM users WHERE id = ?").get(req.authUser.id);
  if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
    res.status(401).json({ message: "当前密码错误" });
    return;
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  const now = nowIso();
  db.prepare("UPDATE users SET password_hash = ?, last_login_at = ? WHERE id = ?").run(passwordHash, now, req.authUser.id);

  const session = createSession(req.authUser.id);
  setAuthCookies(res, session);

  res.json({
    user: buildAuthUserPayload({
      id: req.authUser.id,
      username: row.username,
      is_guest: Boolean(row.is_guest),
    }),
  });
});

app.post("/api/auth/forgot-password", (req, res) => {
  const username = normalizeUsername(req.body?.username);

  // Always return success shape to avoid username enumeration.
  const safeResponse = {
    message: "如果账号存在，重置方式已生成",
  };

  if (!username) {
    res.status(200).json(safeResponse);
    return;
  }

  const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (!user) {
    res.status(200).json(safeResponse);
    return;
  }

  const resetToken = issuePasswordResetToken(user.id, req);
  if (process.env.NODE_ENV !== "production") {
    res.status(200).json({
      ...safeResponse,
      reset_token: resetToken,
    });
    return;
  }

  res.status(200).json(safeResponse);
});

app.post("/api/auth/reset-password", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const newPassword = normalizePassword(req.body?.new_password);

  if (!token || !newPassword) {
    res.status(400).json({ message: "重置码和新密码不能为空" });
    return;
  }

  const resetRow = consumePasswordResetToken(token);
  if (!resetRow) {
    res.status(400).json({ message: "重置码无效或已过期" });
    return;
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  const now = nowIso();
  db.prepare("UPDATE users SET password_hash = ?, last_login_at = ? WHERE id = ?").run(passwordHash, now, resetRow.user_id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(resetRow.user_id);

  clearAuthCookies(res);
  res.status(204).end();
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    user: buildAuthUserPayload(req.authUser),
  });
});

app.post("/api/admin/generate-story", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  if (!LEGACY_GENERATE_STORY_CREATE_ENABLED) {
    res.status(410).json({
      message: "旧入口 /api/admin/generate-story 已下线，请改用 /api/runs/:runId/generate-text。",
      code: "legacy_generate_story_disabled",
      migration: {
        since: "2026-03-06",
        create_run: "POST /api/runs/:runId/generate-text",
        list_runs: "GET /api/runs",
        review_run: "GET /api/runs/:runId",
      },
    });
    return;
  }

  const targetDate = normalizeTargetDate(req.body?.target_date);
  if (!targetDate) {
    res.status(400).json({ message: "target_date 必须是 YYYY-MM-DD" });
    return;
  }

  const runId = normalizeRunId(req.body?.run_id) || defaultGenerationRunId();
  const chapterId = normalizePositiveInteger(req.body?.chapter_id);
  if (req.body?.chapter_id !== undefined && !chapterId) {
    res.status(400).json({ message: "chapter_id 必须是正整数" });
    return;
  }

  const inputStoryFile = normalizeStoryFile(req.body?.story_file);
  if (req.body?.story_file && !inputStoryFile) {
    res.status(400).json({ message: "story_file 无效或不存在" });
    return;
  }

  if (chapterId && inputStoryFile) {
    res.status(400).json({ message: "chapter_id 与 story_file 只能二选一" });
    return;
  }

  let storyFile = inputStoryFile;
  let chapterSource = null;
  if (chapterId) {
    try {
      chapterSource = materializeChapterTextToFile(chapterId, runId);
      storyFile = chapterSource.story_file;
    } catch (error) {
      const message = asMessage(error, "读取章节失败");
      const status = message.includes("不存在") ? 404 : 400;
      res.status(status).json({ message });
      return;
    }
  }

  const requestedSceneCount = normalizePositiveInteger(req.body?.scene_count);
  if (req.body?.scene_count !== undefined && (!requestedSceneCount || requestedSceneCount <= 5)) {
    res.status(400).json({ message: "scene_count 必须是大于 5 的正整数" });
    return;
  }

  let candidateScenes = normalizePositiveInteger(req.body?.candidate_scenes);
  let minScenes = normalizePositiveInteger(req.body?.min_scenes);
  let maxScenes = normalizePositiveInteger(req.body?.max_scenes);

  if (requestedSceneCount) {
    maxScenes = requestedSceneCount;
    minScenes = Math.max(6, requestedSceneCount - 2);
    candidateScenes = requestedSceneCount;
  }

  if (maxScenes && minScenes && maxScenes < minScenes) {
    res.status(400).json({ message: "max_scenes 必须 >= min_scenes" });
    return;
  }

  if (candidateScenes && maxScenes && candidateScenes < maxScenes) {
    res.status(400).json({ message: "candidate_scenes 必须 >= max_scenes" });
    return;
  }

  const dryRun = Boolean(req.body?.dry_run);
  const reviewMode = req.body?.review_mode === undefined ? true : normalizeBoolean(req.body?.review_mode);
  const logFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.log`);
  const eventLogFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.events.jsonl`);
  const summaryPath = path.join(STORY_GENERATOR_SUMMARY_DIR, buildGenerationSummaryFileName(targetDate, runId));

  const payload = {
    run_id: runId,
    target_date: targetDate,
    story_file: storyFile || "",
    dry_run: dryRun,
    review_mode: reviewMode,
    output_root: STORY_GENERATOR_OUTPUT_ROOT,
    index_file: STORY_GENERATOR_INDEX_FILE,
    summary_output_dir: STORY_GENERATOR_SUMMARY_DIR,
    log_file: logFile,
    event_log_file: eventLogFile,
    summary_path: summaryPath,
    story_id: normalizeShortText(req.body?.story_id) || "",
    image_size: normalizeShortText(req.body?.image_size) || "",
    scene_count: requestedSceneCount || null,
    candidate_scenes: candidateScenes,
    min_scenes: minScenes,
    max_scenes: maxScenes,
    concurrency: normalizePositiveInteger(req.body?.concurrency),
    timeout_sec: normalizePositiveNumber(req.body?.timeout_sec),
    poll_seconds: normalizePositiveNumber(req.body?.poll_seconds),
    poll_attempts: normalizePositiveInteger(req.body?.poll_attempts),
    chapter_id: chapterSource?.chapter_id || chapterId || null,
    chapter_title: chapterSource?.chapter_title || "",
    chapter_index: chapterSource?.chapter_index ?? null,
    chapter_char_count: chapterSource?.char_count ?? null,
    book_id: chapterSource?.book_id ?? null,
    book_title: chapterSource?.book_title || "",
  };

  try {
    enqueueGenerationJob({
      runId,
      requestedBy: req.authUser.username,
      targetDate,
      storyFile,
      dryRun,
      payload,
      logFile,
      eventLogFile,
      summaryPath,
    });
  } catch (error) {
    const message = asMessage(error, "创建生成任务失败");
    if (message.includes("UNIQUE") || message.includes("run_id")) {
      res.status(409).json({ message: `run_id 已存在: ${runId}` });
      return;
    }
    res.status(500).json({ message });
    return;
  }

  res.status(202).json({
    ok: true,
    run_id: runId,
    status: "queued",
    target_date: targetDate,
    dry_run: dryRun,
    review_mode: reviewMode,
    log_file: logFile,
    event_log_file: eventLogFile,
    summary_path: summaryPath,
    scene_count: maxScenes || null,
    story_file: storyFile || "",
    chapter: chapterSource
      ? {
          chapter_id: chapterSource.chapter_id,
          chapter_index: chapterSource.chapter_index,
          chapter_title: chapterSource.chapter_title,
          char_count: chapterSource.char_count,
          book_id: chapterSource.book_id,
          book_title: chapterSource.book_title,
        }
      : null,
  });
});

app.post("/api/internal/generation-jobs/claim", requireWorkerAuth, (_req, res) => {
  try {
    const job = claimGenerationJob();
    res.json({ job });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "领取任务失败") });
  }
});

app.post("/api/internal/generation-jobs/:runId/complete", requireWorkerAuth, (req, res) => {
  const runId = String(req.params.runId || "").trim();
  if (!runId) {
    res.status(400).json({ message: "run_id 不能为空" });
    return;
  }

  const status = normalizeGenerationJobStatus(req.body?.status);
  if (!status) {
    res.status(400).json({ message: "status 必须是 succeeded/failed/cancelled" });
    return;
  }

  const rawExitCode = req.body?.exit_code;
  let exitCode = null;
  if (rawExitCode !== undefined && rawExitCode !== null && String(rawExitCode).trim() !== "") {
    const parsedExitCode = Number(rawExitCode);
    if (!Number.isInteger(parsedExitCode)) {
      res.status(400).json({ message: "exit_code 必须是整数或 null" });
      return;
    }
    exitCode = parsedExitCode;
  }

  const errorMessage = normalizeErrorMessage(req.body?.error_message);
  const storyId = normalizeShortText(req.body?.story_id);
  const reviewStatus = normalizeGenerationReviewStatus(req.body?.review_status);

  try {
    const job = completeGenerationJobByRunId(runId, {
      status,
      exitCode,
      errorMessage,
      storyId,
      reviewStatus,
    });
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }
    res.json({ job });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "更新任务状态失败") });
  }
});

app.post("/api/internal/generation-candidate-retries/claim", requireWorkerAuth, (_req, res) => {
  try {
    const task = claimGenerationCandidateImageRetry();
    res.json({ task });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "领取重试任务失败") });
  }
});

app.post("/api/internal/generation-candidate-retries/:retryId/complete", requireWorkerAuth, (req, res) => {
  const retryId = normalizePositiveInteger(req.params.retryId);
  if (!retryId) {
    res.status(400).json({ message: "retry_id 不合法" });
    return;
  }

  const status = String(req.body?.status || "").trim();
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    res.status(400).json({ message: "status 必须是 succeeded/failed/cancelled" });
    return;
  }

  const imageUrl = String(req.body?.image_url || "").trim();
  const imagePath = String(req.body?.image_path || "").trim();
  const errorMessage = normalizeErrorMessage(req.body?.error_message);

  try {
    const result = completeGenerationCandidateImageRetry({
      retryId,
      status,
      imageUrl,
      imagePath,
      errorMessage,
    });

    if (!result) {
      res.status(404).json({ message: "retry_id 不存在" });
      return;
    }

    const runId = String(result.retry?.run_id || "").trim();
    if (runId) {
      const job = getGenerationJobByRunId(runId);
      appendRunEvent(job?.event_log_file, {
        ts: nowIso(),
        event: "review.retry.completed",
        run_id: runId,
        retry_id: Number(result.retry?.retry_id || 0),
        scene_index: Number(result.retry?.scene_index || 0),
        status: String(result.retry?.status || status),
        error_message: String(result.retry?.error_message || ""),
      });
    }

    res.json({ ok: true, retry: result.retry, candidate: result.candidate });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "更新重试任务失败") });
  }
});

app.get("/api/admin/book-chapters", requireAuth, requireAdmin, (req, res) => {
  try {
    const booksDatabase = getBooksDbOrThrow();

    const limit = Math.min(200, normalizePositiveInteger(req.query?.limit) || 50);
    const offset = normalizeNonNegativeInteger(req.query?.offset, 0);
    const minChars = normalizePositiveInteger(req.query?.min_chars);
    const maxChars = normalizePositiveInteger(req.query?.max_chars);
    const includeUsed = normalizeBoolean(req.query?.include_used);
    const includeTocLike = normalizeBoolean(req.query?.include_toc_like);
    const bookId = normalizePositiveInteger(req.query?.book_id);
    const keyword = normalizeShortText(req.query?.keyword);
    const bookTitle = normalizeShortText(req.query?.book_title);

    const where = ["1 = 1"];
    const params = [];

    if (bookId) {
      where.push("b.id = ?");
      params.push(bookId);
    } else if (bookTitle) {
      where.push("b.title LIKE ?");
      params.push(`%${bookTitle}%`);
    }

    if (minChars) {
      where.push("c.char_count >= ?");
      params.push(minChars);
    }

    if (maxChars) {
      where.push("c.char_count <= ?");
      params.push(maxChars);
    }

    if (keyword) {
      where.push("c.chapter_title LIKE ?");
      params.push(`%${keyword}%`);
    }

    if (!includeTocLike) {
      where.push("COALESCE(json_extract(c.meta_json, '$.is_toc_like'), 0) = 0");
    }

    if (!includeUsed) {
      where.push(
        `NOT EXISTS (
          SELECT 1
          FROM chapter_usage su
          WHERE su.chapter_id = c.id
            AND su.usage_type = 'puzzle_story'
            AND su.status = 'succeeded'
        )`,
      );
    }

    const whereClause = where.join(" AND ");

    const totalRow = booksDatabase
      .prepare(
        `
        SELECT COUNT(1) AS total
        FROM chapters c
        JOIN books b ON b.id = c.book_id
        WHERE ${whereClause}
      `,
      )
      .get(...params);

    const rows = booksDatabase
      .prepare(
        `
        SELECT c.id, c.book_id, b.title AS book_title, b.genre,
               c.chapter_index, c.chapter_title, c.char_count, c.word_count,
               c.used_count, c.last_used_at, c.meta_json,
               SUBSTR(REPLACE(REPLACE(c.chapter_text, char(13), ' '), char(10), ' '), 1, 120) AS preview,
               CASE WHEN EXISTS (
                 SELECT 1
                 FROM chapter_usage su
                 WHERE su.chapter_id = c.id
                   AND su.usage_type = 'puzzle_story'
                   AND su.status = 'succeeded'
               ) THEN 1 ELSE 0 END AS has_succeeded_story
        FROM chapters c
        JOIN books b ON b.id = c.book_id
        WHERE ${whereClause}
        ORDER BY c.used_count ASC, c.char_count DESC, c.chapter_index ASC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, limit, offset);

    const generatedByChapterId = getGeneratedChapterMap(rows.map((item) => Number(item.id)));

    const books = booksDatabase
      .prepare(
        `
        SELECT b.id, b.title, b.author, b.genre, b.source_format,
               COUNT(c.id) AS chapter_count,
               COALESCE(MIN(c.char_count), 0) AS min_char_count,
               COALESCE(MAX(c.char_count), 0) AS max_char_count
        FROM books b
        LEFT JOIN chapters c ON c.book_id = b.id
        GROUP BY b.id
        ORDER BY b.updated_at DESC, b.id DESC
      `,
      )
      .all();

    res.json({
      db_path: RESOLVED_BOOK_INGEST_DB_PATH,
      total: Number(totalRow?.total || 0),
      has_more: Number(totalRow?.total || 0) > offset + rows.length,
      filters: {
        limit,
        offset,
        min_chars: minChars || null,
        max_chars: maxChars || null,
        keyword,
        include_used: includeUsed,
        include_toc_like: includeTocLike,
        book_id: bookId || null,
        book_title: bookTitle,
      },
      books: books.map((item) => ({
        id: Number(item.id),
        title: String(item.title || ""),
        author: String(item.author || ""),
        genre: String(item.genre || ""),
        source_format: String(item.source_format || ""),
        chapter_count: Number(item.chapter_count || 0),
        min_char_count: Number(item.min_char_count || 0),
        max_char_count: Number(item.max_char_count || 0),
      })),
      chapters: rows.map((row) => {
        const chapterId = Number(row.id);
        const generatedMeta = generatedByChapterId.get(chapterId);
        const hasSucceededStory = Boolean(row.has_succeeded_story) || Boolean(generatedMeta);

        return {
          id: chapterId,
          book_id: Number(row.book_id),
          book_title: String(row.book_title || ""),
          genre: String(row.genre || ""),
          chapter_index: Number(row.chapter_index),
          chapter_title: String(row.chapter_title || ""),
          char_count: Number(row.char_count || 0),
          word_count: Number(row.word_count || 0),
          used_count: Number(row.used_count || 0),
          last_used_at: row.last_used_at || null,
          preview: String(row.preview || ""),
          has_succeeded_story: hasSucceededStory,
          generated_story_id: generatedMeta?.story_id || null,
          generated_run_id: generatedMeta?.run_id || null,
          generated_at: generatedMeta?.generated_at || null,
          meta_json: safeParseJsonObject(row.meta_json),
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取章节列表失败") });
  }
});

app.get("/api/admin/generate-story", requireAuth, requireAdmin, (req, res) => {
  try {
    const limit = normalizePositiveInteger(req.query?.limit) || 50;
    const jobs = listGenerationJobs(Math.min(200, limit));
    res.json({ jobs });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取任务列表失败") });
  }
});

app.get("/api/admin/generate-story/:runId", requireAuth, requireAdmin, (req, res) => {
  const runId = String(req.params.runId || "").trim();
  if (!runId) {
    res.status(400).json({ message: "run_id 不能为空" });
    return;
  }

  try {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    const events = readRunEvents(job.event_log_file, runId, 30);
    const logTail = readTailLines(job.log_file, 80);
    let summary = readJsonSafe(job.summary_path);
    let candidates = [];
    let candidateCounts = {
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
      selected: 0,
      ready_for_publish: 0,
    };

    if (hasGenerationSceneRows(runId)) {
      const scenes = listGenerationScenes(runId, { include_deleted: true });
      const sceneCounts = summarizeGenerationScenes(scenes);
      candidates = scenes.map((scene) => serializeGenerationSceneAsLegacyCandidate(scene));
      candidateCounts = summarizeLegacyCandidateCountsFromScenes(sceneCounts);

      if (!summary || typeof summary !== "object") {
        summary = {
          run_id: runId,
          total_scenes: Math.max(0, candidateCounts.total),
          generated_scenes: Number(sceneCounts.images_success || 0),
          review_mode: true,
          review_status: job.review_status,
        };
      }
    } else {
      if (job.status === "succeeded") {
        syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
      }
      candidates = listGenerationJobCandidates(runId);
      candidateCounts = summarizeGenerationCandidates(candidates);
    }

    res.json({
      ...job,
      events,
      log_tail: logTail,
      summary,
      candidates,
      candidate_counts: candidateCounts,
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取任务详情失败") });
  }
});

app.get("/api/runs", requireAuth, requireAdmin, (_req, res) => {
  try {
    const runs = listGenerationJobs(60);
    res.json({ runs });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取 runs 失败") });
  }
});

app.get("/api/runs/:runId", requireAuth, requireAdmin, (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  if (!runId) {
    res.status(400).json({ message: "run_id 不合法" });
    return;
  }

  try {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    materializeGenerationScenesFromLegacy(runId, job);

    const scenes = listGenerationScenes(runId, { include_deleted: true });
    const attempts = listGenerationSceneAttempts(runId);
    const attemptsByScene = {};
    for (const item of attempts) {
      const key = String(item.scene_index || 0);
      const bucket = attemptsByScene[key] || [];
      bucket.push(item);
      attemptsByScene[key] = bucket;
    }

    let compatibleScenes = scenes;
    if (compatibleScenes.length === 0 && !hasGenerationSceneRows(runId)) {
      if (job.status === "succeeded") {
        syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
      }

      const legacyCandidates = listGenerationJobCandidates(runId);
      if (legacyCandidates.length > 0) {
        compatibleScenes = legacyCandidates.map((item) => ({
          ...item,
          text_status: "ready",
          image_status: normalizeGenerationSceneImageStatus(item.image_status),
          deleted_at: null,
          source_kind: "legacy",
        }));
      }
    }

    res.json({
      job,
      scenes: compatibleScenes,
      counts: summarizeGenerationScenes(compatibleScenes),
      attempts_by_scene: attemptsByScene,
      attempts,
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取 run 详情失败") });
  }
});

app.post("/api/runs/:runId/generate-text", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  if (!runId) {
    res.status(400).json({ message: "run_id 不合法" });
    return;
  }

  const writable = ensureGenerationRunWritable(runId);
  if (writable.status !== 200 && writable.status !== 404) {
    res.status(writable.status).json({ message: writable.message });
    return;
  }

  const targetDate = normalizeTargetDate(req.body?.target_date || writable.job?.target_date);
  if (!targetDate) {
    res.status(400).json({ message: "target_date 必须是 YYYY-MM-DD" });
    return;
  }

  const chapterId = normalizePositiveInteger(req.body?.chapter_id);
  if (req.body?.chapter_id !== undefined && !chapterId) {
    res.status(400).json({ message: "chapter_id 必须是正整数" });
    return;
  }

  const inputStoryFile = normalizeStoryFile(req.body?.story_file);
  if (req.body?.story_file !== undefined && !inputStoryFile) {
    res.status(400).json({ message: "story_file 无效或不存在" });
    return;
  }

  if (chapterId && inputStoryFile) {
    res.status(400).json({ message: "chapter_id 与 story_file 只能二选一" });
    return;
  }

  const requestedSceneCount = normalizePositiveInteger(req.body?.scene_count);
  if (req.body?.scene_count !== undefined && (!requestedSceneCount || requestedSceneCount < 6)) {
    res.status(400).json({ message: "scene_count 必须是 >= 6 的正整数" });
    return;
  }

  let chapterSource = null;
  let storyFile = inputStoryFile || writable.job?.story_file || "";

  try {
    if (chapterId) {
      chapterSource = materializeChapterTextToFile(chapterId, runId);
      storyFile = chapterSource.story_file;
    }
  } catch (error) {
    const message = asMessage(error, "读取章节失败");
    res.status(message.includes("不存在") ? 404 : 400).json({ message });
    return;
  }

  if (!storyFile) {
    res.status(400).json({ message: "缺少 story_file，请选择 chapter 或传入 story_file" });
    return;
  }

  const existingPayload = writable.job?.payload && typeof writable.job.payload === "object"
    ? writable.job.payload
    : {};
  let candidateScenes = normalizePositiveInteger(req.body?.candidate_scenes)
    || normalizePositiveInteger(existingPayload.candidate_scenes)
    || requestedSceneCount
    || 12;
  let minScenes = normalizePositiveInteger(req.body?.min_scenes)
    || normalizePositiveInteger(existingPayload.min_scenes)
    || Math.max(6, candidateScenes - 2);
  let maxScenes = normalizePositiveInteger(req.body?.max_scenes)
    || normalizePositiveInteger(existingPayload.max_scenes)
    || requestedSceneCount
    || candidateScenes;

  if (requestedSceneCount) {
    candidateScenes = requestedSceneCount;
    minScenes = Math.max(6, requestedSceneCount - 2);
    maxScenes = requestedSceneCount;
  }

  if (maxScenes < minScenes) {
    res.status(400).json({ message: "max_scenes 必须 >= min_scenes" });
    return;
  }

  if (candidateScenes < maxScenes) {
    res.status(400).json({ message: "candidate_scenes 必须 >= max_scenes" });
    return;
  }

  const logFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.log`);
  const eventLogFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.events.jsonl`);
  const summaryPath = path.join(STORY_GENERATOR_SUMMARY_DIR, buildGenerationSummaryFileName(targetDate, runId));

  const mergedPayload = {
    ...existingPayload,
    run_id: runId,
    target_date: targetDate,
    story_file: storyFile,
    review_mode: true,
    dry_run: false,
    chapter_id: chapterSource?.chapter_id || chapterId || normalizePositiveInteger(existingPayload.chapter_id) || null,
    chapter_title: chapterSource?.chapter_title || String(existingPayload.chapter_title || ""),
    chapter_index: chapterSource?.chapter_index ?? normalizePositiveInteger(existingPayload.chapter_index) ?? null,
    chapter_char_count: chapterSource?.char_count ?? normalizePositiveInteger(existingPayload.chapter_char_count) ?? null,
    book_id: chapterSource?.book_id ?? normalizePositiveInteger(existingPayload.book_id) ?? null,
    book_title: chapterSource?.book_title || String(existingPayload.book_title || ""),
    candidate_scenes: candidateScenes,
    min_scenes: minScenes,
    max_scenes: maxScenes,
    scene_count: maxScenes,
    log_file: logFile,
    event_log_file: eventLogFile,
    summary_path: summaryPath,
  };

  try {
    createOrUpdateAtomicGenerationRun({
      runId,
      requestedBy: req.authUser.username,
      targetDate,
      storyFile,
      payload: mergedPayload,
      logFile,
      eventLogFile,
      summaryPath,
    });

    db.prepare("DELETE FROM generation_job_scene_image_attempts WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM generation_job_scenes WHERE run_id = ?").run(runId);

    const atomicResult = await runStoryGeneratorAtomicCommand("generate-text", {
      story_file: storyFile,
      target_date: targetDate,
      scene_count: maxScenes,
      candidate_scenes: candidateScenes,
      min_scenes: minScenes,
      max_scenes: maxScenes,
      max_source_chars: normalizePositiveInteger(req.body?.max_source_chars)
        || normalizePositiveInteger(existingPayload.max_source_chars)
        || 12000,
      base_url: String(req.body?.base_url || existingPayload.base_url || "").trim() || undefined,
      text_model: String(req.body?.text_model || existingPayload.text_model || "").trim() || undefined,
      prompts_dir: String(req.body?.prompts_dir || existingPayload.prompts_dir || "").trim() || undefined,
      system_prompt_file: String(req.body?.system_prompt_file || existingPayload.system_prompt_file || "").trim() || undefined,
      user_prompt_template_file: String(req.body?.user_prompt_template_file || existingPayload.user_prompt_template_file || "").trim() || undefined,
      image_prompt_suffix_file: String(req.body?.image_prompt_suffix_file || existingPayload.image_prompt_suffix_file || "").trim() || undefined,
    });

    const scenes = Array.isArray(atomicResult?.scenes)
      ? atomicResult.scenes
      : [];
    if (scenes.length === 0) {
      throw new Error("文本生成结果为空（scenes=0）");
    }

    const sceneRows = scenes.map((item, index) => ({
      scene_index: normalizePositiveInteger(item.scene_index) || index + 1,
      scene_id: normalizePositiveInteger(item.scene_id) || normalizePositiveInteger(item.scene_index) || index + 1,
      title: String(item.title || "").trim(),
      description: String(item.description || "").trim(),
      story_text: String(item.story_text || "").trim(),
      image_prompt: String(item.image_prompt || "").trim(),
      mood: String(item.mood || "").trim(),
      characters: normalizeGenerationSceneCharacters(item.characters),
      grid_rows: normalizeIntegerInRange(item.grid_rows, 2, 20) || 6,
      grid_cols: normalizeIntegerInRange(item.grid_cols, 2, 20) || 4,
      time_limit_sec: normalizeIntegerInRange(item.time_limit_sec, 30, 3600) || 180,
      text_status: "ready",
      image_status: "pending",
      image_url: "",
      image_path: "",
      error_message: "",
      selected: true,
    }));

    const storedScenes = replaceGenerationScenes(runId, sceneRows, "pipeline");

    const now = nowIso();
    const nextPayload = {
      ...mergedPayload,
      title: String(atomicResult.title || "").trim(),
      description: String(atomicResult.description || "").trim(),
      story_overview_title: String(atomicResult.story_overview_title || "").trim(),
      story_overview_paragraphs: Array.isArray(atomicResult.story_overview_paragraphs)
        ? atomicResult.story_overview_paragraphs.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
        : [],
      source_file: String(atomicResult.source_file || "").trim() || storyFile,
    };

    db.prepare(
      `
      UPDATE generation_jobs
      SET status = 'running',
          review_status = '',
          flow_stage = 'text_ready',
          payload_json = ?,
          error_message = '',
          exit_code = NULL,
          published_at = NULL,
          ended_at = NULL,
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(JSON.stringify(nextPayload), now, runId);

    writeJsonAtomic(summaryPath, {
      run_id: runId,
      target_date: targetDate,
      review_mode: true,
      review_status: "pending_review",
      title: String(atomicResult.title || "").trim(),
      description: String(atomicResult.description || "").trim(),
      story_overview_title: String(atomicResult.story_overview_title || "").trim(),
      story_overview_paragraphs: Array.isArray(atomicResult.story_overview_paragraphs)
        ? atomicResult.story_overview_paragraphs.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
        : [],
      source_file: String(atomicResult.source_file || "").trim(),
      total_scenes: storedScenes.length,
      generated_scenes: 0,
      candidate_counts: {
        total: storedScenes.length,
        success: 0,
        failed: 0,
        selected: storedScenes.length,
      },
      candidates: storedScenes.map((scene) => ({
        scene_index: scene.scene_index,
        scene_id: scene.scene_id,
        title: scene.title,
        description: scene.description,
        story_text: scene.story_text,
        image_prompt: scene.image_prompt,
        mood: scene.mood,
        characters: scene.characters,
        grid_rows: scene.grid_rows,
        grid_cols: scene.grid_cols,
        time_limit_sec: scene.time_limit_sec,
        image_status: "pending",
        image_url: "",
        image_path: "",
        error_message: "",
        selected: scene.selected,
      })),
    });

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    const latestScenes = listGenerationScenes(runId, { include_deleted: true });
    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      scenes: latestScenes,
      counts: summarizeGenerationScenes(latestScenes),
    });
  } catch (error) {
    const now = nowIso();
    db.prepare(
      `
      UPDATE generation_jobs
      SET status = 'failed',
          review_status = '',
          flow_stage = 'failed',
          error_message = ?,
          exit_code = 1,
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(asMessage(error, "文本生成失败"), now, now, runId);

    res.status(500).json({ message: asMessage(error, "文本生成失败") });
  }
});

app.post("/api/runs/:runId/scenes/:sceneIndex/generate-image", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
  if (!runId || !sceneIndex) {
    res.status(400).json({ message: "run_id 或 scene_index 不合法" });
    return;
  }

  const writable = ensureGenerationRunWritable(runId);
  if (writable.status !== 200) {
    res.status(writable.status).json({ message: writable.message });
    return;
  }

  const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
  if (!scene) {
    res.status(404).json({ message: "scene 不存在" });
    return;
  }

  if (scene.text_status !== "ready") {
    res.status(409).json({ message: "scene 文案未就绪，无法生成图片" });
    return;
  }

  const payload = writable.job?.payload && typeof writable.job.payload === "object" ? writable.job.payload : {};
  const now = nowIso();
  db.prepare(
    `
    UPDATE generation_jobs
    SET status = 'running',
        review_status = '',
        flow_stage = 'images_generating',
        error_message = '',
        exit_code = NULL,
        ended_at = NULL,
        updated_at = ?
    WHERE run_id = ?
  `,
  ).run(now, runId);

  const attemptRow = createGenerationSceneImageAttempt({
    runId,
    sceneIndex,
    provider: "atomic_cli",
    model: String(req.body?.image_model || payload.image_model || "").trim(),
    imagePrompt: scene.image_prompt,
  });
  const attemptNo = Number(attemptRow?.attempt_no || nextGenerationSceneAttemptNo(runId, sceneIndex));
  setGenerationSceneImageRunning(runId, sceneIndex);

  const startedAtMs = Date.now();

  try {
    const atomicResult = await runStoryGeneratorAtomicCommand("generate-image", {
      target_date: writable.job?.target_date || now.slice(0, 10),
      images_dir: resolveGenerationRunImagesDir(runId),
      base_url: String(req.body?.base_url || payload.base_url || "").trim() || undefined,
      image_model: String(req.body?.image_model || payload.image_model || "").trim() || undefined,
      image_size: String(req.body?.image_size || payload.image_size || "").trim() || undefined,
      watermark: req.body?.watermark !== undefined ? normalizeBoolean(req.body?.watermark) : normalizeBoolean(payload.watermark),
      concurrency: 1,
      timeout_sec: normalizePositiveNumber(req.body?.timeout_sec) || normalizePositiveNumber(payload.timeout_sec) || 120,
      poll_seconds: normalizePositiveNumber(req.body?.poll_seconds) || normalizePositiveNumber(payload.poll_seconds) || 2.5,
      poll_attempts: normalizePositiveInteger(req.body?.poll_attempts) || normalizePositiveInteger(payload.poll_attempts) || 40,
      scene: {
        scene_index: scene.scene_index,
        scene_id: scene.scene_id || scene.scene_index,
        title: scene.title,
        description: scene.description,
        story_text: scene.story_text,
        image_prompt: scene.image_prompt,
        mood: scene.mood,
        characters: scene.characters,
        grid_rows: scene.grid_rows,
        grid_cols: scene.grid_cols,
        time_limit_sec: scene.time_limit_sec,
      },
    });

    const firstResult = Array.isArray(atomicResult?.results) && atomicResult.results.length > 0
      ? atomicResult.results[0]
      : null;

    const imageStatus = normalizeGenerationSceneImageStatus(firstResult?.status || "failed");
    const imagePath = String(firstResult?.image_path || "").trim();
    const imageUrl = String(firstResult?.image_url || "").trim() || resolveStoryAssetUrlFromFsPath(imagePath);
    const errorMessage = imageStatus === "success"
      ? ""
      : String(firstResult?.error_message || "image generation failed").trim();

    finalizeGenerationSceneImageAttempt({
      runId,
      sceneIndex,
      attemptNo,
      status: imageStatus === "success" ? "succeeded" : "failed",
      imageUrl,
      imagePath,
      errorMessage,
      latencyMs: Date.now() - startedAtMs,
    });

    setGenerationSceneImageResult({
      runId,
      sceneIndex,
      status: imageStatus,
      imageUrl,
      imagePath,
      errorMessage,
    });

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
    const attempts = listGenerationSceneAttempts(runId, sceneIndex);

    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      scene: latestScene,
      attempt: attempts.length > 0 ? attempts[attempts.length - 1] : null,
      counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
    });
  } catch (error) {
    const errorMessage = asMessage(error, "生成图片失败");
    finalizeGenerationSceneImageAttempt({
      runId,
      sceneIndex,
      attemptNo,
      status: "failed",
      imageUrl: "",
      imagePath: "",
      errorMessage,
      latencyMs: Date.now() - startedAtMs,
    });
    setGenerationSceneImageResult({
      runId,
      sceneIndex,
      status: "failed",
      imageUrl: "",
      imagePath: "",
      errorMessage,
    });
    refreshGenerationRunState(runId);
    res.status(500).json({ message: errorMessage });
  }
});

app.post("/api/runs/:runId/scenes/generate-images-batch", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  if (!runId) {
    res.status(400).json({ message: "run_id 不合法" });
    return;
  }

  const writable = ensureGenerationRunWritable(runId);
  if (writable.status !== 200) {
    res.status(writable.status).json({ message: writable.message });
    return;
  }

  const payload = writable.job?.payload && typeof writable.job.payload === "object" ? writable.job.payload : {};
  const sceneIndexList = Array.isArray(req.body?.scene_indexes)
    ? req.body.scene_indexes.map((item) => normalizePositiveInteger(item)).filter((item) => Boolean(item))
    : [];
  const sceneIndexSet = new Set(sceneIndexList);

  const allScenes = listGenerationScenes(runId, { include_deleted: false });
  const targetScenes = allScenes
    .filter((scene) => scene.text_status === "ready")
    .filter((scene) => sceneIndexSet.size === 0 || sceneIndexSet.has(scene.scene_index))
    .filter((scene) => scene.image_status === "pending" || scene.image_status === "failed" || scene.image_status === "skipped");

  if (targetScenes.length === 0) {
    res.status(400).json({ message: "没有可生成图片的 scene" });
    return;
  }

  const now = nowIso();
  db.prepare(
    `
    UPDATE generation_jobs
    SET status = 'running',
        review_status = '',
        flow_stage = 'images_generating',
        error_message = '',
        exit_code = NULL,
        ended_at = NULL,
        updated_at = ?
    WHERE run_id = ?
  `,
  ).run(now, runId);

  const attemptsBySceneIndex = new Map();
  for (const scene of targetScenes) {
    const attemptRow = createGenerationSceneImageAttempt({
      runId,
      sceneIndex: scene.scene_index,
      provider: "atomic_cli_batch",
      model: String(req.body?.image_model || payload.image_model || "").trim(),
      imagePrompt: scene.image_prompt,
    });
    attemptsBySceneIndex.set(scene.scene_index, Number(attemptRow?.attempt_no || 1));
    setGenerationSceneImageRunning(runId, scene.scene_index);
  }

  const startedAtMs = Date.now();

  try {
    const atomicResult = await runStoryGeneratorAtomicCommand("generate-images", {
      target_date: writable.job?.target_date || now.slice(0, 10),
      images_dir: resolveGenerationRunImagesDir(runId),
      base_url: String(req.body?.base_url || payload.base_url || "").trim() || undefined,
      image_model: String(req.body?.image_model || payload.image_model || "").trim() || undefined,
      image_size: String(req.body?.image_size || payload.image_size || "").trim() || undefined,
      watermark: req.body?.watermark !== undefined ? normalizeBoolean(req.body?.watermark) : normalizeBoolean(payload.watermark),
      concurrency: normalizePositiveInteger(req.body?.concurrency) || normalizePositiveInteger(payload.concurrency) || 3,
      timeout_sec: normalizePositiveNumber(req.body?.timeout_sec) || normalizePositiveNumber(payload.timeout_sec) || 120,
      poll_seconds: normalizePositiveNumber(req.body?.poll_seconds) || normalizePositiveNumber(payload.poll_seconds) || 2.5,
      poll_attempts: normalizePositiveInteger(req.body?.poll_attempts) || normalizePositiveInteger(payload.poll_attempts) || 40,
      scenes: targetScenes.map((scene) => ({
        scene_index: scene.scene_index,
        scene_id: scene.scene_id || scene.scene_index,
        title: scene.title,
        description: scene.description,
        story_text: scene.story_text,
        image_prompt: scene.image_prompt,
        mood: scene.mood,
        characters: scene.characters,
        grid_rows: scene.grid_rows,
        grid_cols: scene.grid_cols,
        time_limit_sec: scene.time_limit_sec,
      })),
    });

    const resultRows = Array.isArray(atomicResult?.results) ? atomicResult.results : [];
    const resultBySceneIndex = new Map();
    for (const item of resultRows) {
      const sceneIndex = normalizePositiveInteger(item.scene_index);
      if (sceneIndex) {
        resultBySceneIndex.set(sceneIndex, item);
      }
    }

    for (const scene of targetScenes) {
      const result = resultBySceneIndex.get(scene.scene_index) || null;
      const imageStatus = normalizeGenerationSceneImageStatus(result?.status || "failed");
      const imagePath = String(result?.image_path || "").trim();
      const imageUrl = String(result?.image_url || "").trim() || resolveStoryAssetUrlFromFsPath(imagePath);
      const errorMessage = imageStatus === "success"
        ? ""
        : String(result?.error_message || "image generation failed").trim();
      const attemptNo = Number(attemptsBySceneIndex.get(scene.scene_index) || 1);

      finalizeGenerationSceneImageAttempt({
        runId,
        sceneIndex: scene.scene_index,
        attemptNo,
        status: imageStatus === "success" ? "succeeded" : "failed",
        imageUrl,
        imagePath,
        errorMessage,
        latencyMs: Date.now() - startedAtMs,
      });

      setGenerationSceneImageResult({
        runId,
        sceneIndex: scene.scene_index,
        status: imageStatus,
        imageUrl,
        imagePath,
        errorMessage,
      });
    }

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    const latestScenes = listGenerationScenes(runId, { include_deleted: true });

    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      scenes: latestScenes,
      counts: summarizeGenerationScenes(latestScenes),
      processed: targetScenes.length,
    });
  } catch (error) {
    const errorMessage = asMessage(error, "批量生成图片失败");
    for (const scene of targetScenes) {
      const attemptNo = Number(attemptsBySceneIndex.get(scene.scene_index) || 1);
      finalizeGenerationSceneImageAttempt({
        runId,
        sceneIndex: scene.scene_index,
        attemptNo,
        status: "failed",
        imageUrl: "",
        imagePath: "",
        errorMessage,
        latencyMs: Date.now() - startedAtMs,
      });
      setGenerationSceneImageResult({
        runId,
        sceneIndex: scene.scene_index,
        status: "failed",
        imageUrl: "",
        imagePath: "",
        errorMessage,
      });
    }

    refreshGenerationRunState(runId);
    res.status(500).json({ message: errorMessage });
  }
});

app.patch("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
  if (!runId || !sceneIndex) {
    res.status(400).json({ message: "run_id 或 scene_index 不合法" });
    return;
  }

  const writable = ensureGenerationRunWritable(runId);
  if (writable.status !== 200) {
    res.status(writable.status).json({ message: writable.message });
    return;
  }

  const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
  if (!scene) {
    res.status(404).json({ message: "scene 不存在" });
    return;
  }

  const nextTitle = req.body?.title !== undefined ? String(req.body.title || "").trim().slice(0, 500) : null;
  const nextDescription = req.body?.description !== undefined ? String(req.body.description || "").trim().slice(0, 2000) : null;
  const nextStoryText = req.body?.story_text !== undefined ? String(req.body.story_text || "").trim().slice(0, 20000) : null;
  const nextPrompt = req.body?.image_prompt !== undefined ? String(req.body.image_prompt || "").trim().slice(0, 12000) : null;
  const hasSelected = req.body?.selected !== undefined;
  const nextSelected = hasSelected ? normalizeBoolean(req.body?.selected) : null;
  const nextRows = req.body?.grid_rows !== undefined ? normalizeIntegerInRange(req.body?.grid_rows, 2, 20) : null;
  const nextCols = req.body?.grid_cols !== undefined ? normalizeIntegerInRange(req.body?.grid_cols, 2, 20) : null;
  const nextTimeLimit = req.body?.time_limit_sec !== undefined ? normalizeIntegerInRange(req.body?.time_limit_sec, 30, 3600) : null;

  if ((req.body?.grid_rows !== undefined && !nextRows)
    || (req.body?.grid_cols !== undefined && !nextCols)
    || (req.body?.time_limit_sec !== undefined && !nextTimeLimit)) {
    res.status(400).json({ message: "rows/cols/time_limit_sec 参数非法" });
    return;
  }

  const changedPrompt = nextPrompt !== null && nextPrompt !== scene.image_prompt;
  const hasUpdate = nextTitle !== null
    || nextDescription !== null
    || nextStoryText !== null
    || nextPrompt !== null
    || hasSelected
    || nextRows !== null
    || nextCols !== null
    || nextTimeLimit !== null;

  if (!hasUpdate) {
    res.status(400).json({ message: "没有可更新字段" });
    return;
  }

  const now = nowIso();
  db.prepare(
    `
    UPDATE generation_job_scenes
    SET title = COALESCE(?, title),
        description = COALESCE(?, description),
        story_text = COALESCE(?, story_text),
        image_prompt = COALESCE(?, image_prompt),
        selected = CASE WHEN ? IS NULL THEN selected ELSE ? END,
        grid_rows = COALESCE(?, grid_rows),
        grid_cols = COALESCE(?, grid_cols),
        time_limit_sec = COALESCE(?, time_limit_sec),
        image_status = CASE WHEN ? = 1 THEN 'pending' ELSE image_status END,
        image_url = CASE WHEN ? = 1 THEN '' ELSE image_url END,
        image_path = CASE WHEN ? = 1 THEN '' ELSE image_path END,
        error_message = CASE WHEN ? = 1 THEN '' ELSE error_message END,
        updated_at = ?
    WHERE run_id = ?
      AND scene_index = ?
      AND deleted_at IS NULL
  `,
  ).run(
    nextTitle,
    nextDescription,
    nextStoryText,
    nextPrompt,
    hasSelected ? 1 : null,
    hasSelected && nextSelected ? 1 : 0,
    nextRows,
    nextCols,
    nextTimeLimit,
    changedPrompt ? 1 : 0,
    changedPrompt ? 1 : 0,
    changedPrompt ? 1 : 0,
    changedPrompt ? 1 : 0,
    now,
    runId,
    sceneIndex,
  );

  if (changedPrompt) {
    db.prepare(
      `
      UPDATE generation_job_scene_image_attempts
      SET status = CASE
            WHEN status IN ('queued', 'running') THEN 'cancelled'
            ELSE status
          END,
          error_message = CASE
            WHEN status IN ('queued', 'running') THEN 'prompt updated before completion'
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ? AND scene_index = ?
    `,
    ).run(now, now, runId, sceneIndex);
  }

  const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
  const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
  res.json({
    ok: true,
    run_id: runId,
    job: latestJob,
    scene: latestScene,
    counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
  });
});

app.delete("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
  if (!runId || !sceneIndex) {
    res.status(400).json({ message: "run_id 或 scene_index 不合法" });
    return;
  }

  const writable = ensureGenerationRunWritable(runId);
  if (writable.status !== 200) {
    res.status(writable.status).json({ message: writable.message });
    return;
  }

  const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
  if (!scene) {
    res.status(404).json({ message: "scene 不存在" });
    return;
  }

  const now = nowIso();
  db.prepare(
    `
    UPDATE generation_job_scenes
    SET text_status = 'deleted',
        image_status = 'skipped',
        selected = 0,
        deleted_at = COALESCE(deleted_at, ?),
        updated_at = ?
    WHERE run_id = ?
      AND scene_index = ?
  `,
  ).run(now, now, runId, sceneIndex);

  db.prepare(
    `
    UPDATE generation_job_scene_image_attempts
    SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
        error_message = CASE
          WHEN status IN ('queued', 'running') THEN 'scene deleted'
          ELSE error_message
        END,
        ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
        updated_at = ?
    WHERE run_id = ? AND scene_index = ?
  `,
  ).run(now, now, runId, sceneIndex);

  const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
  res.json({
    ok: true,
    run_id: runId,
    job: latestJob,
    counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
  });
});

app.post("/api/runs/:runId/publish", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  if (!runId) {
    res.status(400).json({ message: "run_id 不合法" });
    return;
  }

  const writable = ensureGenerationRunWritable(runId);
  if (writable.status !== 200) {
    res.status(writable.status).json({ message: writable.message });
    return;
  }

  const job = writable.job;
  if (!job) {
    res.status(404).json({ message: "run_id 不存在" });
    return;
  }

  const scenes = listGenerationScenes(runId, { include_deleted: false });
  const selectedScenes = scenes.filter((scene) => scene.selected && scene.image_status === "success");
  if (selectedScenes.length === 0) {
    res.status(400).json({ message: "没有可发布关卡，请先选择至少一个成功 scene" });
    return;
  }

  try {
    const summary = readJsonSafe(job.summary_path) || {};
    const published = publishSelectedGenerationCandidates({
      runId,
      job,
      summary,
      selectedCandidates: selectedScenes,
    });

    const now = nowIso();
    db.prepare(
      `
      UPDATE generation_jobs
      SET status = 'succeeded',
          review_status = 'published',
          flow_stage = 'published',
          published_at = COALESCE(published_at, ?),
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(now, now, now, runId);

    const latestScenes = listGenerationScenes(runId, { include_deleted: true });
    res.json({
      ok: true,
      run_id: runId,
      ...published,
      job: getGenerationJobByRunId(runId),
      counts: summarizeGenerationScenes(latestScenes),
      scenes: latestScenes,
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "发布失败") });
  }
});

app.post("/api/runs/:runId/cancel", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  if (!runId) {
    res.status(400).json({ message: "run_id 不合法" });
    return;
  }

  try {
    const job = cancelGenerationRun(runId, String(req.body?.reason || "").trim() || "cancelled by admin");
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    res.json({
      ok: true,
      run_id: runId,
      job,
      counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
    });
  } catch (error) {
    const message = asMessage(error, "取消任务失败");
    const status = message.includes("不允许") ? 409 : 500;
    res.status(status).json({ message });
  }
});

app.delete("/api/runs/:runId", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const runId = normalizeRunId(req.params.runId);
  if (!runId) {
    res.status(400).json({ message: "run_id 不合法" });
    return;
  }

  try {
    const result = deleteGenerationRun(runId, {
      force: req.body?.force,
      allow_published: req.body?.allow_published,
      purge_files: req.body?.purge_files,
    });

    if (!result.deleted) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    res.json({
      ok: true,
      run_id: runId,
      removed_files: result.removed_files,
    });
  } catch (error) {
    const message = asMessage(error, "删除任务失败");
    const status = message.includes("不允许") || message.includes("请先") ? 409 : 500;
    res.status(status).json({ message });
  }
});

app.get("/api/admin/generation-jobs/:runId/review", requireAuth, requireAdmin, (req, res) => {
  const runId = String(req.params.runId || "").trim();
  if (!runId) {
    res.status(400).json({ message: "run_id 不能为空" });
    return;
  }

  try {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    materializeGenerationScenesFromLegacy(runId, job);

    if (hasGenerationSceneRows(runId)) {
      const scenes = listGenerationScenes(runId, { include_deleted: false });
      const sceneCounts = summarizeGenerationScenes(scenes);
      const candidates = scenes.map((scene) => serializeGenerationSceneAsLegacyCandidate(scene));
      const counts = summarizeLegacyCandidateCountsFromScenes(sceneCounts);

      res.json({
        job,
        candidates,
        scenes,
        counts,
        scene_counts: sceneCounts,
        publish: {
          review_status: job.review_status,
          published_at: job.published_at,
        },
      });
      return;
    }

    if (job.status === "succeeded") {
      syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
    }

    const candidates = listGenerationJobCandidates(runId);
    const counts = summarizeGenerationCandidates(candidates);
    res.json({
      job,
      candidates,
      counts,
      publish: {
        review_status: job.review_status,
        published_at: job.published_at,
      },
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取审核数据失败") });
  }
});

app.patch("/api/admin/generation-jobs/:runId/candidates/:sceneIndex", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const runId = String(req.params.runId || "").trim();
  const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
  if (!runId || !sceneIndex) {
    res.status(400).json({ message: "run_id 或 scene_index 不合法" });
    return;
  }

  const selectedRaw = req.body?.selected;
  const hasSelected = selectedRaw !== undefined;
  const selectedValue = hasSelected ? normalizeBoolean(selectedRaw) : null;

  const rowsRaw = req.body?.grid_rows;
  const colsRaw = req.body?.grid_cols;
  const hasRows = rowsRaw !== undefined;
  const hasCols = colsRaw !== undefined;

  const gridRows = hasRows ? normalizeIntegerInRange(rowsRaw, 2, 20) : null;
  const gridCols = hasCols ? normalizeIntegerInRange(colsRaw, 2, 20) : null;

  if ((hasRows && !gridRows) || (hasCols && !gridCols)) {
    res.status(400).json({ message: "grid_rows/grid_cols 必须在 2~20 之间" });
    return;
  }

  if (!hasSelected && !hasRows && !hasCols) {
    res.status(400).json({ message: "至少需要更新 selected 或 grid_rows/grid_cols" });
    return;
  }

  try {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    if (job.status !== "succeeded") {
      res.status(409).json({ message: "仅支持修改已完成任务的候选配置" });
      return;
    }

    if (job.review_status === "published") {
      res.status(409).json({ message: "该任务已发布，审核页不允许继续修改" });
      return;
    }

    if (hasGenerationSceneRows(runId)) {
      const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
      if (!scene) {
        res.status(404).json({ message: "候选关卡不存在" });
        return;
      }

      const now = nowIso();
      db.prepare(
        `
        UPDATE generation_job_scenes
        SET selected = CASE WHEN ? IS NULL THEN selected ELSE ? END,
            grid_rows = COALESCE(?, grid_rows),
            grid_cols = COALESCE(?, grid_cols),
            updated_at = ?
        WHERE run_id = ? AND scene_index = ?
      `,
      ).run(
        hasSelected ? 1 : null,
        hasSelected && selectedValue ? 1 : 0,
        gridRows,
        gridCols,
        now,
        runId,
        sceneIndex,
      );

      refreshGenerationRunState(runId);
      const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
      res.json({
        ok: true,
        candidate: latestScene ? serializeGenerationSceneAsLegacyCandidate(latestScene) : null,
      });
      return;
    }

    const updated = updateGenerationJobCandidate({
      runId,
      sceneIndex,
      selected: hasSelected ? selectedValue : null,
      gridRows,
      gridCols,
    });

    if (!updated) {
      res.status(404).json({ message: "候选关卡不存在" });
      return;
    }

    res.json({ ok: true, candidate: updated });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "更新候选关卡失败") });
  }
});

app.post(
  "/api/admin/generation-jobs/:runId/candidates/:sceneIndex/retry-image",
  requireAuth,
  requireCsrf,
  requireAdmin,
  async (req, res) => {
    const runId = String(req.params.runId || "").trim();
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      res.status(400).json({ message: "run_id 或 scene_index 不合法" });
      return;
    }

    try {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      if (job.status !== "succeeded") {
        res.status(409).json({ message: "仅支持对 succeeded 任务执行重试" });
        return;
      }

      if (job.review_status === "published") {
        res.status(409).json({ message: "该任务已发布，审核页不允许继续重试" });
        return;
      }

      if (hasGenerationSceneRows(runId)) {
        const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
        if (!scene) {
          res.status(404).json({ message: "候选关卡不存在" });
          return;
        }

        if (!scene.image_prompt) {
          res.status(400).json({ message: "该候选缺少 image_prompt，无法重试" });
          return;
        }

        const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
        const now = nowIso();
        db.prepare(
          `
          UPDATE generation_jobs
          SET status = 'running',
              review_status = '',
              flow_stage = 'images_generating',
              error_message = '',
              exit_code = NULL,
              ended_at = NULL,
              updated_at = ?
          WHERE run_id = ?
        `,
        ).run(now, runId);

        const attemptRow = createGenerationSceneImageAttempt({
          runId,
          sceneIndex,
          provider: req.authUser?.username || "admin_retry",
          model: String(payload.image_model || "").trim(),
          imagePrompt: scene.image_prompt,
        });
        const attemptNo = Number(attemptRow?.attempt_no || nextGenerationSceneAttemptNo(runId, sceneIndex));
        setGenerationSceneImageRunning(runId, sceneIndex);
        const startedAtMs = Date.now();

        try {
          const atomicResult = await runStoryGeneratorAtomicCommand("generate-image", {
            target_date: job.target_date || now.slice(0, 10),
            images_dir: resolveGenerationRunImagesDir(runId),
            base_url: String(payload.base_url || "").trim() || undefined,
            image_model: String(payload.image_model || "").trim() || undefined,
            image_size: String(payload.image_size || "").trim() || undefined,
            watermark: normalizeBoolean(payload.watermark),
            concurrency: 1,
            timeout_sec: normalizePositiveNumber(payload.timeout_sec) || 120,
            poll_seconds: normalizePositiveNumber(payload.poll_seconds) || 2.5,
            poll_attempts: normalizePositiveInteger(payload.poll_attempts) || 40,
            scene: {
              scene_index: scene.scene_index,
              scene_id: scene.scene_id || scene.scene_index,
              title: scene.title,
              description: scene.description,
              story_text: scene.story_text,
              image_prompt: scene.image_prompt,
              mood: scene.mood,
              characters: scene.characters,
              grid_rows: scene.grid_rows,
              grid_cols: scene.grid_cols,
              time_limit_sec: scene.time_limit_sec,
            },
          });

          const firstResult = Array.isArray(atomicResult?.results) && atomicResult.results.length > 0
            ? atomicResult.results[0]
            : null;

          const imageStatus = normalizeGenerationSceneImageStatus(firstResult?.status || "failed");
          const imagePath = String(firstResult?.image_path || "").trim();
          const imageUrl = String(firstResult?.image_url || "").trim() || resolveStoryAssetUrlFromFsPath(imagePath);
          const errorMessage = imageStatus === "success"
            ? ""
            : String(firstResult?.error_message || "retry image generation failed").trim();

          finalizeGenerationSceneImageAttempt({
            runId,
            sceneIndex,
            attemptNo,
            status: imageStatus === "success" ? "succeeded" : "failed",
            imageUrl,
            imagePath,
            errorMessage,
            latencyMs: Date.now() - startedAtMs,
          });

          setGenerationSceneImageResult({
            runId,
            sceneIndex,
            status: imageStatus,
            imageUrl,
            imagePath,
            errorMessage,
          });
        } catch (retryError) {
          const errorMessage = asMessage(retryError, "retry image generation failed");
          finalizeGenerationSceneImageAttempt({
            runId,
            sceneIndex,
            attemptNo,
            status: "failed",
            imageUrl: "",
            imagePath: "",
            errorMessage,
            latencyMs: Date.now() - startedAtMs,
          });
          setGenerationSceneImageResult({
            runId,
            sceneIndex,
            status: "failed",
            imageUrl: "",
            imagePath: "",
            errorMessage,
          });
        }

        const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
        const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
        const attempts = listGenerationSceneAttempts(runId, sceneIndex);
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

        appendRunEvent(job.event_log_file, {
          ts: nowIso(),
          event: "review.retry.completed",
          run_id: runId,
          scene_index: sceneIndex,
          retry_id: Number(latestAttempt?.id || 0),
          status: String(latestAttempt?.status || ""),
          error_message: String(latestAttempt?.error_message || ""),
        });

        res.json({
          ok: true,
          retry_id: Number(latestAttempt?.id || 0),
          retry: serializeGenerationSceneAttemptAsLegacyRetry(latestAttempt),
          candidate: latestScene ? serializeGenerationSceneAsLegacyCandidate(latestScene) : null,
          job: latestJob,
        });
        return;
      }

      syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
      const candidate = listGenerationJobCandidates(runId).find((item) => item.scene_index === sceneIndex) || null;
      if (!candidate) {
        res.status(404).json({ message: "候选关卡不存在" });
        return;
      }

      if (!candidate.image_prompt) {
        res.status(400).json({ message: "该候选缺少 image_prompt，无法重试" });
        return;
      }

      const queued = enqueueGenerationCandidateImageRetry({
        runId,
        sceneIndex,
        requestedBy: req.authUser?.username || "",
      });

      appendRunEvent(job.event_log_file, {
        ts: nowIso(),
        event: "review.retry.queued",
        run_id: runId,
        scene_index: sceneIndex,
        retry_id: queued.retry_id,
      });

      res.json({
        ok: true,
        retry_id: queued.retry_id,
        retry: queued.retry,
        candidate: queued.candidate,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "创建重试任务失败") });
    }
  },
);

app.post("/api/admin/generation-jobs/:runId/publish-selected", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const runId = String(req.params.runId || "").trim();
  if (!runId) {
    res.status(400).json({ message: "run_id 不能为空" });
    return;
  }

  try {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    if (job.status !== "succeeded") {
      res.status(409).json({ message: "仅支持发布 succeeded 状态的任务" });
      return;
    }

    if (!isReviewModePayload(job.payload, job.dry_run)) {
      res.status(409).json({ message: "仅 review_mode 任务支持审核发布" });
      return;
    }

    if (job.review_status === "published") {
      const publishedAtHint = job.published_at ? `（${job.published_at}）` : "";
      res.status(409).json({ message: `该任务已发布${publishedAtHint}` });
      return;
    }

    if (job.dry_run) {
      res.status(409).json({ message: "dry_run 任务不支持发布" });
      return;
    }

    if (hasGenerationSceneRows(runId)) {
      const scenes = listGenerationScenes(runId, { include_deleted: false });
      const selectedCandidates = scenes.filter((item) => item.selected && item.image_status === "success");
      if (selectedCandidates.length === 0) {
        res.status(400).json({ message: "没有可发布的关卡，请先勾选至少一个成功关卡" });
        return;
      }

      const summary = readJsonSafe(job.summary_path) || {};
      const published = publishSelectedGenerationCandidates({
        runId,
        job,
        summary,
        selectedCandidates,
      });

      const now = nowIso();
      db.prepare(
        `
        UPDATE generation_jobs
        SET status = 'succeeded',
            review_status = 'published',
            flow_stage = 'published',
            published_at = COALESCE(published_at, ?),
            ended_at = COALESCE(ended_at, ?),
            updated_at = ?
        WHERE run_id = ?
      `,
      ).run(now, now, now, runId);

      const latestScenes = listGenerationScenes(runId, { include_deleted: true });
      res.json({
        ok: true,
        run_id: runId,
        ...published,
        counts: summarizeLegacyCandidateCountsFromScenes(summarizeGenerationScenes(latestScenes)),
      });
      return;
    }

    syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
    const allCandidates = listGenerationJobCandidates(runId);
    const selectedCandidates = allCandidates.filter((item) => item.selected && item.image_status === "success");
    if (selectedCandidates.length === 0) {
      res.status(400).json({ message: "没有可发布的关卡，请先勾选至少一个成功关卡" });
      return;
    }

    const summary = readJsonSafe(job.summary_path) || {};
    const published = publishSelectedGenerationCandidates({
      runId,
      job,
      summary,
      selectedCandidates,
    });

    const latestCandidates = listGenerationJobCandidates(runId);
    res.json({
      ok: true,
      run_id: runId,
      ...published,
      counts: summarizeGenerationCandidates(latestCandidates),
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "发布选中关卡失败") });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  try {
    const limit = Math.min(300, normalizePositiveInteger(req.query?.limit) || 120);
    const keyword = normalizeShortText(req.query?.keyword);
    const role = normalizeAdminRole(req.query?.role);

    const where = ["1 = 1"];
    const params = [];

    if (keyword) {
      where.push("u.username LIKE ?");
      params.push(`%${keyword}%`);
    }

    if (role) {
      where.push("EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = ?)");
      params.push(role);
    }

    const whereClause = where.join(" AND ");
    const totalRow = db
      .prepare(
        `
        SELECT COUNT(1) AS total
        FROM users u
        WHERE ${whereClause}
      `,
      )
      .get(...params);

    const users = db
      .prepare(
        `
        SELECT
          u.id,
          u.username,
          u.is_guest,
          u.created_at,
          u.last_login_at,
          COALESCE(stats.best_time_level_count, 0) AS best_time_level_count,
          stats.fastest_level_time_ms AS fastest_level_time_ms,
          COALESCE(stats.completed_level_count, 0) AS completed_level_count
        FROM users u
        LEFT JOIN (
          SELECT
            user_id,
            COUNT(best_time_ms) AS best_time_level_count,
            MIN(best_time_ms) AS fastest_level_time_ms,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_level_count
          FROM user_level_progress
          GROUP BY user_id
        ) AS stats ON stats.user_id = u.id
        WHERE ${whereClause}
        ORDER BY u.id DESC
        LIMIT ?
      `,
      )
      .all(...params, limit);

    const rolesByUserId = getRolesByUserIds(users.map((item) => Number(item.id)));

    res.json({
      total: Number(totalRow?.total || 0),
      filters: {
        limit,
        keyword,
        role: role || "",
      },
      users: users.map((item) => serializeAdminUser(item, rolesByUserId.get(Number(item.id)) || [])),
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取用户权限失败") });
  }
});

app.post("/api/admin/users/:id/roles", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const userId = normalizePositiveInteger(req.params.id);
  if (!userId) {
    res.status(400).json({ message: "用户 id 不合法" });
    return;
  }

  const role = normalizeAdminRole(req.body?.role);
  if (!role) {
    res.status(400).json({ message: "role 必须是 admin/editor/level_designer/operator" });
    return;
  }

  const note = normalizeShortText(req.body?.note);

  try {
    const targetUser = db
      .prepare("SELECT id, username, is_guest, created_at, last_login_at FROM users WHERE id = ?")
      .get(userId);
    if (!targetUser) {
      res.status(404).json({ message: "用户不存在" });
      return;
    }

    const beforeRoles = getRolesByUserId(userId);

    db.prepare(
      `
      INSERT OR IGNORE INTO user_roles (user_id, role, granted_by_user_id, source, note, granted_at)
      VALUES (?, ?, ?, 'manual', ?, ?)
    `,
    ).run(userId, role, req.authUser.id, note || "", nowIso());

    const afterRoles = getRolesByUserId(userId);

    appendAdminAuditLog({
      actorUserId: req.authUser.id,
      actorUsername: req.authUser.username,
      action: "user.role.grant",
      targetType: "user",
      targetId: String(userId),
      before: { roles: beforeRoles },
      after: { roles: afterRoles },
      meta: { role, note: note || "" },
    });

    res.json({
      ok: true,
      user: serializeAdminUser(targetUser, afterRoles),
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "授予角色失败") });
  }
});

app.delete("/api/admin/users/:id/roles/:role", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const userId = normalizePositiveInteger(req.params.id);
  if (!userId) {
    res.status(400).json({ message: "用户 id 不合法" });
    return;
  }

  const role = normalizeAdminRole(req.params.role);
  if (!role) {
    res.status(400).json({ message: "role 必须是 admin/editor/level_designer/operator" });
    return;
  }

  try {
    const targetUser = db
      .prepare("SELECT id, username, is_guest, created_at, last_login_at FROM users WHERE id = ?")
      .get(userId);
    if (!targetUser) {
      res.status(404).json({ message: "用户不存在" });
      return;
    }

    const beforeRoles = getRolesByUserId(userId);
    if (!beforeRoles.includes(role)) {
      res.status(404).json({ message: "该角色不存在" });
      return;
    }

    if (role === "admin") {
      const adminCount = countAdminUsers();
      if (adminCount <= 1) {
        res.status(400).json({ message: "不能移除最后一个 admin" });
        return;
      }
    }

    db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role = ?").run(userId, role);
    const afterRoles = getRolesByUserId(userId);

    appendAdminAuditLog({
      actorUserId: req.authUser.id,
      actorUsername: req.authUser.username,
      action: "user.role.revoke",
      targetType: "user",
      targetId: String(userId),
      before: { roles: beforeRoles },
      after: { roles: afterRoles },
      meta: { role },
    });

    res.json({
      ok: true,
      user: serializeAdminUser(targetUser, afterRoles),
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "移除角色失败") });
  }
});

app.get("/api/admin/stories/:storyId/levels/:levelId/config", requireAuth, requireAdmin, (req, res) => {
  const storyId = normalizeShortText(req.params.storyId);
  const levelId = normalizeShortText(req.params.levelId);
  if (!storyId || !levelId) {
    res.status(400).json({ message: "storyId 与 levelId 不能为空" });
    return;
  }

  try {
    const snapshot = buildAdminLevelConfigSnapshot(storyId, levelId);
    if (!snapshot) {
      res.status(404).json({ message: "故事或关卡不存在" });
      return;
    }

    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取关卡配置失败") });
  }
});

app.put("/api/admin/stories/:storyId/levels/:levelId/config", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const storyId = normalizeShortText(req.params.storyId);
  const levelId = normalizeShortText(req.params.levelId);
  if (!storyId || !levelId) {
    res.status(400).json({ message: "storyId 与 levelId 不能为空" });
    return;
  }

  const parsedPatch = parseAdminLevelConfigPatch(req.body, { allowEmpty: false });
  if (!parsedPatch.ok) {
    res.status(400).json({ message: parsedPatch.message || "配置参数不合法" });
    return;
  }

  try {
    const beforeSnapshot = buildAdminLevelConfigSnapshot(storyId, levelId);
    if (!beforeSnapshot) {
      res.status(404).json({ message: "故事或关卡不存在" });
      return;
    }

    const savedOverride = saveAdminLevelOverrideConfig(storyId, levelId, parsedPatch.patch, req.authUser.id);
    const afterSnapshot = buildAdminLevelConfigSnapshot(storyId, levelId);

    appendAdminAuditLog({
      actorUserId: req.authUser.id,
      actorUsername: req.authUser.username,
      action: "level.config.update",
      targetType: "level",
      targetId: `${storyId}:${levelId}`,
      before: {
        override_config: beforeSnapshot.override_config,
        effective_config: beforeSnapshot.effective_config,
      },
      after: {
        override_config: afterSnapshot?.override_config || null,
        effective_config: afterSnapshot?.effective_config || null,
      },
      meta: {
        patch: parsedPatch.patch,
        saved_override: serializeLevelOverrideConfig(savedOverride),
      },
    });

    res.json({
      ok: true,
      ...afterSnapshot,
    });
  } catch (error) {
    const message = asMessage(error, "更新关卡配置失败");
    if (message.includes("配置") || message.includes("必须") || message.includes("范围")) {
      res.status(400).json({ message });
      return;
    }
    res.status(500).json({ message });
  }
});

app.post("/api/admin/stories/:storyId/levels/:levelId/preview", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const storyId = normalizeShortText(req.params.storyId);
  const levelId = normalizeShortText(req.params.levelId);
  if (!storyId || !levelId) {
    res.status(400).json({ message: "storyId 与 levelId 不能为空" });
    return;
  }

  const parsedPatch = parseAdminLevelConfigPatch(req.body, { allowEmpty: true });
  if (!parsedPatch.ok) {
    res.status(400).json({ message: parsedPatch.message || "预览参数不合法" });
    return;
  }

  try {
    const snapshot = buildAdminLevelConfigSnapshot(storyId, levelId, {
      previewPatch: parsedPatch.patch,
    });
    if (!snapshot) {
      res.status(404).json({ message: "故事或关卡不存在" });
      return;
    }

    res.json({
      ok: true,
      ...snapshot,
    });
  } catch (error) {
    const message = asMessage(error, "预览关卡配置失败");
    if (message.includes("配置") || message.includes("必须") || message.includes("范围")) {
      res.status(400).json({ message });
      return;
    }
    res.status(500).json({ message });
  }
});

app.post("/api/admin/stories/:storyId/levels/:levelId/test-run", requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const storyId = normalizeShortText(req.params.storyId);
  const levelId = normalizeShortText(req.params.levelId);
  if (!storyId || !levelId) {
    res.status(400).json({ message: "storyId 与 levelId 不能为空" });
    return;
  }

  const parsedPatch = parseAdminLevelConfigPatch(req.body, { allowEmpty: true });
  if (!parsedPatch.ok) {
    res.status(400).json({ message: parsedPatch.message || "测试参数不合法" });
    return;
  }

  try {
    const snapshot = buildAdminLevelConfigSnapshot(storyId, levelId, {
      previewPatch: parsedPatch.patch,
    });
    if (!snapshot) {
      res.status(404).json({ message: "故事或关卡不存在" });
      return;
    }

    const story = loadStoryById(storyId);
    const level = story?.levels?.find((item) => item.id === levelId);
    if (!story || !level) {
      res.status(404).json({ message: "故事或关卡不存在" });
      return;
    }

    const effectiveConfig = snapshot.preview_effective_config || snapshot.effective_config;
    const levelForTest = {
      ...level,
      grid: {
        rows: effectiveConfig.grid_rows,
        cols: effectiveConfig.grid_cols,
      },
      time_limit_sec: effectiveConfig.time_limit_sec,
      difficulty: effectiveConfig.difficulty,
      content_version: effectiveConfig.content_version,
      admin_test: true,
    };

    res.json({
      ok: true,
      mode: "admin_test",
      save_progress: false,
      message: "管理员测试模式，不会写入正式进度",
      test_run_id: `admin_test_${Date.now()}_${randomToken().slice(0, 6)}`,
      story_id: storyId,
      level_id: levelId,
      level: levelForTest,
      config: snapshot,
    });
  } catch (error) {
    const message = asMessage(error, "创建测试关卡失败");
    if (message.includes("配置") || message.includes("必须") || message.includes("范围")) {
      res.status(400).json({ message });
      return;
    }
    res.status(500).json({ message });
  }
});

app.get("/api/stories", requireAuth, (req, res) => {
  try {
    const stories = listStoriesForUser(req.authUser.id);
    res.json({ stories });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取故事列表失败") });
  }
});

app.get("/api/stories/:storyId", requireAuth, (req, res) => {
  try {
    const story = loadStoryById(req.params.storyId);
    if (!story) {
      res.status(404).json({ message: "故事不存在" });
      return;
    }

    const levelProgress = getLevelProgressMap(req.authUser.id, story);
    res.json({
      story: {
        ...story,
        level_progress: levelProgress,
      },
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取故事详情失败") });
  }
});

app.get("/api/stories/:storyId/levels/:levelId", requireAuth, (req, res) => {
  try {
    const story = loadStoryById(req.params.storyId);
    if (!story) {
      res.status(404).json({ message: "故事不存在" });
      return;
    }

    const level = story.levels.find((item) => item.id === req.params.levelId);
    if (!level) {
      res.status(404).json({ message: "关卡不存在" });
      return;
    }

    const levelProgress = getLevelProgressMap(req.authUser.id, story);

    res.json({
      level,
      progress: levelProgress[level.id] ?? {
        status: "not_started",
      },
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取关卡失败") });
  }
});

app.put("/api/progress/levels/:levelId", requireAuth, requireCsrf, (req, res) => {
  const levelId = String(req.params.levelId || "").trim();
  const storyId = String(req.body?.story_id || "").trim();
  const status = String(req.body?.status || "in_progress").trim();

  if (!levelId || !storyId) {
    res.status(400).json({ message: "story_id 与 levelId 不能为空" });
    return;
  }

  if (!VALID_PROGRESS_STATUS.has(status)) {
    res.status(400).json({ message: "status 不合法" });
    return;
  }

  const story = loadStoryById(storyId);
  if (!story) {
    res.status(404).json({ message: "故事不存在" });
    return;
  }

  const levelConfig = story.levels.find((item) => item.id === levelId);
  if (!levelConfig) {
    res.status(404).json({ message: "关卡不存在" });
    return;
  }

  if (levelConfig.asset_missing) {
    res.status(409).json({ message: "关卡资源缺失，暂不可写入进度" });
    return;
  }

  const attemptsIncrement = normalizeAttempts(req.body?.attempts_increment, status === "in_progress" ? 1 : 0);
  const bestTimeMs = normalizePositiveInteger(req.body?.best_time_ms);
  const bestMoves = normalizePositiveInteger(req.body?.best_moves);
  const contentVersion = Number.isInteger(req.body?.content_version)
    ? Number(req.body.content_version)
    : normalizeContentVersion(levelConfig.content_version);

  const existing = db
    .prepare(
      "SELECT status, best_time_ms, best_moves, attempts, save_state_json, completed_at FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?",
    )
    .get(req.authUser.id, storyId, levelId);

  const now = nowIso();

  let saveStateJson = existing?.save_state_json ?? null;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "save_state_json")) {
    const raw = req.body.save_state_json;
    if (raw === null) {
      saveStateJson = null;
    } else if (typeof raw === "string") {
      saveStateJson = raw;
    } else {
      saveStateJson = JSON.stringify(raw);
    }
  }

  const completedAt =
    status === "completed" ? existing?.completed_at ?? now : existing?.completed_at ?? null;

  db.prepare(
    `
    INSERT INTO user_level_progress (
      user_id,
      story_id,
      level_id,
      status,
      best_time_ms,
      best_moves,
      attempts,
      last_played_at,
      completed_at,
      save_state_json,
      content_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, story_id, level_id) DO UPDATE SET
      status = CASE
        WHEN user_level_progress.status = 'completed' THEN 'completed'
        WHEN excluded.status = 'completed' THEN 'completed'
        ELSE excluded.status
      END,
      best_time_ms = CASE
        WHEN excluded.best_time_ms IS NULL THEN user_level_progress.best_time_ms
        WHEN user_level_progress.best_time_ms IS NULL THEN excluded.best_time_ms
        WHEN excluded.best_time_ms < user_level_progress.best_time_ms THEN excluded.best_time_ms
        ELSE user_level_progress.best_time_ms
      END,
      best_moves = CASE
        WHEN excluded.best_moves IS NULL THEN user_level_progress.best_moves
        WHEN user_level_progress.best_moves IS NULL THEN excluded.best_moves
        WHEN excluded.best_moves < user_level_progress.best_moves THEN excluded.best_moves
        ELSE user_level_progress.best_moves
      END,
      attempts = user_level_progress.attempts + excluded.attempts,
      last_played_at = excluded.last_played_at,
      completed_at = CASE
        WHEN user_level_progress.completed_at IS NOT NULL THEN user_level_progress.completed_at
        WHEN excluded.status = 'completed' THEN excluded.completed_at
        ELSE NULL
      END,
      save_state_json = excluded.save_state_json,
      content_version = excluded.content_version
  `,
  ).run(
    req.authUser.id,
    storyId,
    levelId,
    status,
    bestTimeMs,
    bestMoves,
    attemptsIncrement,
    now,
    completedAt,
    saveStateJson,
    contentVersion,
  );

  const row = db
    .prepare(
      "SELECT story_id, level_id, status, best_time_ms, best_moves, attempts, last_played_at, completed_at FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?",
    )
    .get(req.authUser.id, storyId, levelId);

  res.json({
    progress: serializeProgressRow(row),
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`puzzle backend running at http://localhost:${port}`);
});

function initializeSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_guest INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_level_progress (
      user_id INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      level_id TEXT NOT NULL,
      status TEXT NOT NULL,
      best_time_ms INTEGER,
      best_moves INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_played_at TEXT,
      completed_at TEXT,
      save_state_json TEXT,
      content_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, story_id, level_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      requested_by TEXT NOT NULL,
      target_date TEXT NOT NULL,
      story_file TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      log_file TEXT NOT NULL,
      event_log_file TEXT NOT NULL,
      summary_path TEXT NOT NULL,
      error_message TEXT,
      exit_code INTEGER,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      requested_ip TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_progress_user_story ON user_level_progress(user_id, story_id);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created ON generation_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_created ON generation_jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_expires_at ON password_reset_tokens(expires_at);
  `);

  ensureSessionColumns(database);
  ensureUserColumns(database);
  enforceSingleSessionConstraint(database);
  markStaleGenerationJobsAsFailed(database);
}


function ensureSessionColumns(database) {
  const columns = database.prepare("PRAGMA table_info(sessions)").all();
  const hasCsrfToken = columns.some((column) => column.name === "csrf_token");

  if (!hasCsrfToken) {
    database.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT");
  }

  database.prepare("DELETE FROM sessions WHERE csrf_token IS NULL OR length(csrf_token) = 0").run();
}

function ensureUserColumns(database) {
  const columns = database.prepare("PRAGMA table_info(users)").all();
  const hasIsGuest = columns.some((column) => column.name === "is_guest");

  if (!hasIsGuest) {
    database.exec("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0");
  }

  database.prepare("UPDATE users SET is_guest = 0 WHERE is_guest IS NULL").run();
}

function enforceSingleSessionConstraint(database) {
  const duplicatedUsers = database
    .prepare("SELECT user_id FROM sessions GROUP BY user_id HAVING COUNT(*) > 1")
    .all();

  for (const row of duplicatedUsers) {
    const sessions = database
      .prepare("SELECT token FROM sessions WHERE user_id = ? ORDER BY expires_at DESC, created_at DESC")
      .all(row.user_id);

    const redundantTokens = sessions.slice(1).map((session) => session.token);
    if (redundantTokens.length > 0) {
      const placeholders = redundantTokens.map(() => "?").join(", ");
      database.prepare(`DELETE FROM sessions WHERE token IN (${placeholders})`).run(...redundantTokens);
    }
  }

  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_single_user ON sessions(user_id)");
}

function authRateLimitKey(req, username) {
  const forwarded = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "";
  const ip = (forwarded.split(",")[0] || req.ip || req.socket?.remoteAddress || "unknown").trim();
  const name = (username || "").toLowerCase();
  return `${ip}|${name}`;
}

function passAuthRateLimit(req, username, res) {
  const key = authRateLimitKey(req, username);
  const now = Date.now();

  const bucket = authRateBuckets.get(key) || [];
  const recent = bucket.filter((ts) => now - ts <= AUTH_RATE_LIMIT_WINDOW_MS);

  if (recent.length >= AUTH_RATE_LIMIT_MAX_ATTEMPTS) {
    res.status(429).json({ message: "尝试过于频繁，请稍后再试" });
    authRateBuckets.set(key, recent);
    return false;
  }

  recent.push(now);
  authRateBuckets.set(key, recent);
  return true;
}

function clearAuthRateLimit(req, username) {
  authRateBuckets.delete(authRateLimitKey(req, username));
}

function requireAuth(req, res, next) {
  pruneExpiredSessions();

  const token = extractSessionToken(req);
  if (!token) {
    res.status(401).json({ message: "未登录" });
    return;
  }

  const row = db
    .prepare(
      `
      SELECT u.id, u.username, u.is_guest, s.token, s.csrf_token
           , CASE WHEN EXISTS (
               SELECT 1 FROM user_roles ur
               WHERE ur.user_id = u.id AND ur.role = 'admin'
             ) THEN 1 ELSE 0 END AS has_admin_role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?
      `,
    )
    .get(token, nowIso());

  if (!row) {
    res.status(401).json({ message: "登录状态已失效" });
    return;
  }

  req.authUser = {
    id: row.id,
    username: row.username,
    is_guest: Boolean(row.is_guest),
    has_admin_role: Boolean(row.has_admin_role),
  };
  req.authToken = row.token;
  req.authCsrfToken = row.csrf_token;
  next();
}

function requireCsrf(req, res, next) {
  const csrfHeader = extractCsrfHeader(req);

  if (!csrfHeader || !req.authCsrfToken || csrfHeader !== req.authCsrfToken) {
    res.status(403).json({ message: "CSRF 校验失败" });
    return;
  }

  next();
}

function extractSessionToken(req) {
  const cookieToken = readCookie(req, SESSION_COOKIE_NAME);
  if (cookieToken) {
    return cookieToken;
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return token || null;
  }

  const fallback = req.headers["x-auth-token"];
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }

  return null;
}

function extractCsrfHeader(req) {
  const value = req.headers[CSRF_HEADER_NAME];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function readCookie(req, name) {
  const rawCookie = req.headers.cookie;
  if (typeof rawCookie !== "string" || !rawCookie.trim()) {
    return null;
  }

  const chunks = rawCookie.split(";");
  for (const chunk of chunks) {
    const [rawKey, ...rawValue] = chunk.trim().split("=");
    if (!rawKey || rawValue.length === 0) {
      continue;
    }
    if (rawKey !== name) {
      continue;
    }

    try {
      return decodeURIComponent(rawValue.join("=") || "");
    } catch {
      return null;
    }
  }

  return null;
}

function setAuthCookies(res, session) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}; HttpOnly; Path=/; SameSite=${COOKIE_SAME_SITE}; Max-Age=${maxAgeSeconds}${secure}`,
      `${CSRF_COOKIE_NAME}=${encodeURIComponent(session.csrfToken)}; Path=/; SameSite=${COOKIE_SAME_SITE}; Max-Age=${maxAgeSeconds}${secure}`,
    ],
  );
}

function clearAuthCookies(res) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    [
      `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=${COOKIE_SAME_SITE}; Max-Age=0${secure}`,
      `${CSRF_COOKIE_NAME}=; Path=/; SameSite=${COOKIE_SAME_SITE}; Max-Age=0${secure}`,
    ],
  );
}


function createSession(userId) {
  pruneExpiredSessions();

  const token = randomToken();
  const csrfToken = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, csrf_token) VALUES (?, ?, ?, ?, ?)").run(
      token,
      userId,
      createdAt,
      expiresAt,
      csrfToken,
    );
  });
  tx();

  return {
    token,
    csrfToken,
  };
}

function rotateSession(oldToken) {
  pruneExpiredSessions();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomToken();
    const csrfToken = randomToken();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    try {
      const result = db
        .prepare(
          "UPDATE sessions SET token = ?, csrf_token = ?, created_at = ?, expires_at = ? WHERE token = ?",
        )
        .run(token, csrfToken, createdAt, expiresAt, oldToken);

      if (result.changes === 1) {
        return {
          token,
          csrfToken,
        };
      }
      return null;
    } catch {
      // Token collision is unlikely; retry with a new random token.
    }
  }

  return null;
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function createGuestUsername() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `guest_${randomToken().slice(0, 10)}`;
    const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(candidate);
    if (!exists) {
      return candidate;
    }
  }

  return `guest_${Date.now()}`;
}

function issuePasswordResetToken(userId, req) {
  pruneExpiredPasswordResetTokens();

  const token = randomToken();
  const tokenHash = hashTokenForStorage(token);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  const requestedIp = typeof req.ip === "string" ? req.ip : "";

  db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
  db.prepare(
    "INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at, requested_ip) VALUES (?, ?, ?, ?, NULL, ?)",
  ).run(tokenHash, userId, now, expiresAt, requestedIp);

  return token;
}

function consumePasswordResetToken(token) {
  pruneExpiredPasswordResetTokens();
  const tokenHash = hashTokenForStorage(token);
  const now = nowIso();

  const row = db
    .prepare(
      "SELECT token_hash, user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(tokenHash, now);

  if (!row) {
    return null;
  }

  db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?").run(now, tokenHash);
  return row;
}

function pruneExpiredPasswordResetTokens() {
  const now = nowIso();
  db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
}

function hashTokenForStorage(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function pruneExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}



function listStoriesForUser(userId) {
  const catalog = loadStoryCatalog();
  const stories = [];
  const generatedStoryBookMap = buildGeneratedStoryBookMap();
  const defaultBookMeta = resolveDefaultStoryBookMeta(generatedStoryBookMap);

  for (const entry of catalog.stories) {
    const story = loadStoryById(entry.id, catalog);
    if (!story) {
      continue;
    }

    const rows = db
      .prepare(
        "SELECT story_id, level_id, status, last_played_at FROM user_level_progress WHERE user_id = ? AND story_id = ?",
      )
      .all(userId, story.id);

    const validLevelIds = new Set(story.levels.map((item) => item.id));
    let completedLevels = 0;
    let lastLevelId = null;
    let lastPlayedAt = "";

    for (const row of rows) {
      if (!validLevelIds.has(row.level_id)) {
        continue;
      }

      if (row.status === "completed") {
        completedLevels += 1;
      }

      if (typeof row.last_played_at === "string" && row.last_played_at > lastPlayedAt) {
        lastPlayedAt = row.last_played_at;
        lastLevelId = row.level_id;
      }
    }

    const bookMeta = resolveStoryBookMeta(entry, story, generatedStoryBookMap, defaultBookMeta);

    stories.push({
      id: story.id,
      title: story.title,
      description: story.description,
      cover: story.cover,
      cover_missing: story.cover_missing,
      book_id: bookMeta.book_id,
      book_title: bookMeta.book_title,
      total_levels: story.levels.length,
      completed_levels: completedLevels,
      last_level_id: lastLevelId,
    });
  }

  return stories;
}


function getLevelProgressMap(userId, storyOrStoryId) {
  const story = typeof storyOrStoryId === "string" ? loadStoryById(storyOrStoryId) : storyOrStoryId;
  if (!story) {
    return {};
  }

  const rows = db
    .prepare(
      "SELECT story_id, level_id, status, best_time_ms, best_moves, attempts, last_played_at, completed_at, content_version FROM user_level_progress WHERE user_id = ? AND story_id = ?",
    )
    .all(userId, story.id);

  const rowMap = new Map(rows.map((row) => [row.level_id, row]));
  const map = {};

  for (const level of story.levels) {
    const row = rowMap.get(level.id);
    if (!row) {
      continue;
    }
    map[level.id] = serializeProgressRow(row);
  }

  return map;
}

function serializeProgressRow(row) {
  return {
    story_id: row.story_id,
    level_id: row.level_id,
    status: row.status,
    best_time_ms: row.best_time_ms ?? undefined,
    best_moves: row.best_moves ?? undefined,
    attempts: row.attempts ?? 0,
    last_played_at: row.last_played_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    content_version: normalizeContentVersion(row.content_version),
  };
}



function loadStoryCatalog() {
  if (!fs.existsSync(STORY_INDEX_FILE)) {
    throw new Error(`未找到故事索引文件: ${STORY_INDEX_FILE}`);
  }

  let payload;
  try {
    payload = readJson(STORY_INDEX_FILE);
  } catch {
    throw new Error("故事索引 JSON 解析失败");
  }

  if (!payload || !Array.isArray(payload.stories)) {
    throw new Error("故事索引格式不合法");
  }

  const idSet = new Set();
  const stories = [];

  for (const item of payload.stories) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.enabled === false) {
      continue;
    }

    const id = String(item.id || "").trim();
    const manifest = typeof item.manifest === "string" ? item.manifest.trim() : "";

    if (!id || !manifest) {
      throw new Error("故事索引中的 id/manifest 不能为空");
    }

    if (idSet.has(id)) {
      throw new Error(`故事索引中存在重复 id: ${id}`);
    }
    idSet.add(id);

    // 强约束索引模式：索引中声明的 manifest 必须存在。
    resolveManifestFsPath(manifest);

    const storyTitle = typeof item.title === "string" ? item.title : "";
    const storyBookTitle = normalizeShortText(item.book_title);
    const storyBookId = normalizeStoryBookId(item.book_id);

    stories.push({
      id,
      title: storyTitle,
      description: typeof item.description === "string" ? item.description : "",
      cover: typeof item.cover === "string" ? item.cover : "",
      manifest,
      book_id: storyBookId,
      book_title: storyBookTitle,
      order: Number.isFinite(item.order) ? Number(item.order) : Number.MAX_SAFE_INTEGER,
    });
  }

  return {
    stories: stories.sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.id.localeCompare(b.id);
    }),
  };
}

function resolveStoryBookMeta(entry, story, generatedStoryBookMap, defaultBookMeta) {
  const entryBookTitle = normalizeShortText(entry?.book_title);
  const storyBookTitle = normalizeShortText(story?.book_title);
  const explicitBookTitle = entryBookTitle || storyBookTitle;

  const entryBookId = normalizeStoryBookId(entry?.book_id);
  const storyBookId = normalizeStoryBookId(story?.book_id);
  const explicitBookId = entryBookId || storyBookId;

  const storyId = normalizeShortText(story?.id || entry?.id);
  const generatedBookMeta = storyId && generatedStoryBookMap instanceof Map
    ? generatedStoryBookMap.get(storyId)
    : null;

  const fallbackMeta = defaultBookMeta && typeof defaultBookMeta === "object"
    ? defaultBookMeta
    : { book_id: "liaozhai", book_title: "聊斋志异" };

  const finalBookTitle = explicitBookTitle
    || normalizeShortText(generatedBookMeta?.book_title)
    || normalizeShortText(fallbackMeta.book_title)
    || "聊斋志异";

  const finalBookId = explicitBookId
    || normalizeStoryBookId(generatedBookMeta?.book_id)
    || normalizeStoryBookId(fallbackMeta.book_id)
    || "liaozhai";

  return {
    book_id: finalBookId,
    book_title: finalBookTitle,
  };
}

function buildGeneratedStoryBookMap() {
  const map = new Map();

  const usageRows = listStoryBookLinksFromBooksDb();
  for (const row of usageRows) {
    const storyId = normalizeShortText(row?.story_id);
    if (!storyId || map.has(storyId)) {
      continue;
    }

    map.set(storyId, {
      book_id: normalizeStoryBookId(row?.book_id) || "liaozhai",
      book_title: normalizeShortText(row?.book_title) || "聊斋志异",
    });
  }

  let metaRows = [];
  try {
    metaRows = db
      .prepare(
        `
        SELECT result_story_id, book_id
        FROM generation_job_meta
        WHERE COALESCE(result_story_id, '') <> ''
          AND book_id IS NOT NULL
        ORDER BY COALESCE(updated_at, created_at) DESC
      `,
      )
      .all();
  } catch {
    metaRows = [];
  }

  for (const row of metaRows) {
    const storyId = normalizeShortText(row.result_story_id);
    if (!storyId || map.has(storyId)) {
      continue;
    }

    const bookMeta = getBookMetaById(row.book_id);
    map.set(storyId, {
      book_id: normalizeStoryBookId(bookMeta.book_id || row.book_id) || "liaozhai",
      book_title: normalizeShortText(bookMeta.book_title) || "聊斋志异",
    });
  }

  return map;
}

function listStoryBookLinksFromBooksDb() {
  try {
    const booksDatabase = getBooksDbOrThrow();
    return booksDatabase
      .prepare(
        `
        SELECT
          cu.generated_story_id AS story_id,
          c.book_id AS book_id,
          b.title AS book_title,
          cu.updated_at
        FROM chapter_usage cu
        JOIN chapters c ON c.id = cu.chapter_id
        JOIN books b ON b.id = c.book_id
        WHERE cu.usage_type = 'puzzle_story'
          AND cu.status = 'succeeded'
          AND COALESCE(cu.generated_story_id, '') <> ''
        ORDER BY COALESCE(cu.updated_at, cu.created_at) DESC, cu.id DESC
      `,
      )
      .all();
  } catch {
    return [];
  }
}

function resolveDefaultStoryBookMeta(generatedStoryBookMap) {
  if (generatedStoryBookMap instanceof Map && generatedStoryBookMap.size > 0) {
    const first = generatedStoryBookMap.values().next().value;
    if (first && typeof first === "object") {
      return {
        book_id: normalizeStoryBookId(first.book_id) || "liaozhai",
        book_title: normalizeShortText(first.book_title) || "聊斋志异",
      };
    }
  }

  const preferred = findPreferredBookMeta();
  if (preferred) {
    return preferred;
  }

  return {
    book_id: "liaozhai",
    book_title: "聊斋志异",
  };
}

function getBookMetaById(bookId) {
  const normalizedBookId = normalizePositiveInteger(bookId);
  if (!normalizedBookId) {
    return {
      book_id: "liaozhai",
      book_title: "聊斋志异",
    };
  }

  try {
    const booksDatabase = getBooksDbOrThrow();
    const row = booksDatabase
      .prepare("SELECT id, title FROM books WHERE id = ? LIMIT 1")
      .get(normalizedBookId);

    if (row) {
      return {
        book_id: String(row.id),
        book_title: String(row.title || ""),
      };
    }
  } catch {
    // ignore lookup errors and fallback
  }

  return {
    book_id: String(normalizedBookId),
    book_title: "聊斋志异",
  };
}

function findPreferredBookMeta() {
  try {
    const booksDatabase = getBooksDbOrThrow();
    const preferred = booksDatabase
      .prepare("SELECT id, title FROM books WHERE title LIKE ? ORDER BY id ASC LIMIT 1")
      .get("%聊斋%");

    if (preferred) {
      return {
        book_id: normalizeStoryBookId(preferred.id) || "liaozhai",
        book_title: normalizeShortText(preferred.title) || "聊斋志异",
      };
    }

    const first = booksDatabase.prepare("SELECT id, title FROM books ORDER BY id ASC LIMIT 1").get();
    if (first) {
      return {
        book_id: normalizeStoryBookId(first.id) || "liaozhai",
        book_title: normalizeShortText(first.title) || "聊斋志异",
      };
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeStoryBookId(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.slice(0, 48);
}


function loadStoryById(storyId, catalog) {
  const activeCatalog = catalog || loadStoryCatalog();
  const entry = activeCatalog.stories.find((item) => item.id === storyId);
  if (!entry) {
    return null;
  }

  const manifestPath = resolveManifestFsPath(entry.manifest);
  const payload = readJson(manifestPath);
  const levelOverrideMap = getLevelOverrideMap(entry.id);
  const timerPolicy = loadTimerPolicy();

  const levelsRaw = Array.isArray(payload.levels) ? payload.levels : [];
  const levels = levelsRaw.map(
    (level, index) => normalizeLevel(entry.manifest, level, index, levelOverrideMap, timerPolicy),
  );

  if (levels.length === 0) {
    throw new Error(`故事 ${storyId} 没有可用关卡`);
  }

  const coverCandidate = normalizeAssetPath(entry.manifest, payload.cover || entry.cover);
  const cover = doesAssetExist(coverCandidate)
    ? coverCandidate
    : levels.find((item) => !item.asset_missing)?.source_image || "";

  return {
    id: entry.id,
    title: payload.title || entry.title || entry.id,
    description: payload.description || entry.description || "",
    cover,
    cover_missing: !cover,
    story_overview_title: payload.story_overview_title || "",
    story_overview_paragraphs: Array.isArray(payload.story_overview_paragraphs)
      ? payload.story_overview_paragraphs.filter((item) => typeof item === "string")
      : [],
    default_bgm: normalizeAssetPath(entry.manifest, payload.default_bgm),
    levels,
  };
}

function normalizeLevel(manifestUrl, level, index, levelOverrideMap, timerPolicy) {
  const levelId = String(level?.id ?? `level_${String(index + 1).padStart(3, "0")}`);
  const sourceImage = normalizeAssetPath(manifestUrl, level?.source_image ?? level?.image);

  if (!sourceImage) {
    throw new Error(`关卡 ${levelId} 缺少图片配置`);
  }

  const rows = Number(level?.grid?.rows);
  const cols = Number(level?.grid?.cols);
  const override = levelOverrideMap instanceof Map ? levelOverrideMap.get(levelId) : undefined;
  const overrideRows = normalizePositiveInteger(override?.grid_rows);
  const overrideCols = normalizePositiveInteger(override?.grid_cols);
  const finalRows = overrideRows || rows;
  const finalCols = overrideCols || cols;

  if (!Number.isInteger(finalRows) || !Number.isInteger(finalCols) || finalRows <= 0 || finalCols <= 0) {
    throw new Error(`关卡 ${levelId} 的 grid 配置不合法`);
  }

  const difficulty = normalizeDifficulty(override?.difficulty ?? level?.difficulty);
  const finalTimeLimitSec = resolveLevelTimeLimitSec({
    rows: finalRows,
    cols: finalCols,
    difficulty,
    overrideTimeLimitSec: normalizePositiveInteger(override?.time_limit_sec),
    legacyTimeLimitSec: normalizePositiveInteger(level?.time_limit_sec),
    overrideDifficultyFactor: normalizePositiveNumber(override?.difficulty_factor),
    timerPolicy,
  });

  return {
    id: levelId,
    title: typeof level?.title === "string" ? level.title : levelId,
    description: typeof level?.description === "string" ? level.description : "",
    story_text: typeof level?.story_text === "string" ? level.story_text : undefined,
    grid: {
      rows: finalRows,
      cols: finalCols,
    },
    source_image: sourceImage,
    content_version: normalizeContentVersion(level?.content_version),
    legacy_ids: normalizeLegacyIds(level?.legacy_ids),
    asset_missing: !doesAssetExist(sourceImage),
    time_limit_sec: finalTimeLimitSec,
    difficulty,
    shuffle: level?.shuffle && typeof level.shuffle === "object" ? level.shuffle : undefined,
    audio: normalizeAudioMap(manifestUrl, level?.audio),
    mobile: level?.mobile && typeof level.mobile === "object" ? level.mobile : undefined,
  };
}

function getLevelOverrideMap(storyId) {
  if (typeof storyId !== "string" || !storyId.trim()) {
    return new Map();
  }

  try {
    const rows = db
      .prepare(
        `
        SELECT level_id, enabled, grid_rows, grid_cols, time_limit_sec, difficulty, difficulty_factor
        FROM level_overrides
        WHERE story_id = ?
      `,
      )
      .all(storyId.trim());

    const result = new Map();
    for (const row of rows) {
      if (Number(row.enabled) !== 1) {
        continue;
      }

      const levelId = String(row.level_id || "").trim();
      if (!levelId) {
        continue;
      }

      result.set(levelId, row);
    }
    return result;
  } catch {
    return new Map();
  }
}

function loadTimerPolicy() {
  try {
    const row = db
      .prepare("SELECT value_json FROM system_settings WHERE key = ? LIMIT 1")
      .get("timer_policy_v1");

    if (!row || typeof row.value_json !== "string" || !row.value_json.trim()) {
      return DEFAULT_TIMER_POLICY;
    }

    const payload = safeParseJsonObject(row.value_json);
    return normalizeTimerPolicy(payload);
  } catch {
    return DEFAULT_TIMER_POLICY;
  }
}

function normalizeTimerPolicy(payload) {
  if (!payload || typeof payload !== "object") {
    return DEFAULT_TIMER_POLICY;
  }

  const baseSeconds = normalizePositiveNumber(payload.base_seconds) || DEFAULT_TIMER_POLICY.base_seconds;
  const perPieceSeconds = normalizePositiveNumber(payload.per_piece_seconds) || DEFAULT_TIMER_POLICY.per_piece_seconds;
  const minSeconds = normalizePositiveInteger(payload.min_seconds) || DEFAULT_TIMER_POLICY.min_seconds;
  const maxSecondsRaw = normalizePositiveInteger(payload.max_seconds) || DEFAULT_TIMER_POLICY.max_seconds;
  const maxSeconds = Math.max(minSeconds, maxSecondsRaw);
  const factors = payload.difficulty_factor && typeof payload.difficulty_factor === "object"
    ? payload.difficulty_factor
    : {};

  return {
    base_seconds: baseSeconds,
    per_piece_seconds: perPieceSeconds,
    min_seconds: minSeconds,
    max_seconds: maxSeconds,
    difficulty_factor: {
      easy: normalizePositiveNumber(factors.easy) || DEFAULT_TIMER_POLICY.difficulty_factor.easy,
      normal: normalizePositiveNumber(factors.normal) || DEFAULT_TIMER_POLICY.difficulty_factor.normal,
      hard: normalizePositiveNumber(factors.hard) || DEFAULT_TIMER_POLICY.difficulty_factor.hard,
      nightmare: normalizePositiveNumber(factors.nightmare) || DEFAULT_TIMER_POLICY.difficulty_factor.nightmare,
    },
  };
}

function normalizeDifficulty(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "easy" || normalized === "hard" || normalized === "nightmare") {
    return normalized;
  }
  return "normal";
}

function resolveLevelTimeLimitSec({
  rows,
  cols,
  difficulty,
  overrideTimeLimitSec,
  legacyTimeLimitSec,
  overrideDifficultyFactor,
  timerPolicy,
}) {
  if (overrideTimeLimitSec) {
    return overrideTimeLimitSec;
  }

  const activePolicy = timerPolicy && typeof timerPolicy === "object"
    ? timerPolicy
    : DEFAULT_TIMER_POLICY;
  const pieceCount = Math.max(1, rows * cols);
  const base = activePolicy.base_seconds + (pieceCount * activePolicy.per_piece_seconds);
  const factor = overrideDifficultyFactor
    || activePolicy.difficulty_factor[normalizeDifficulty(difficulty)]
    || activePolicy.difficulty_factor.normal
    || 1;
  const computed = Math.round(base * factor);
  const computedClamped = clampInt(computed, activePolicy.min_seconds, activePolicy.max_seconds);

  if (legacyTimeLimitSec) {
    const normalizedLegacy = clampInt(legacyTimeLimitSec, activePolicy.min_seconds, activePolicy.max_seconds);
    return Math.max(normalizedLegacy, computedClamped);
  }

  return computedClamped;
}

function clampInt(value, minValue, maxValue) {
  const integerValue = Math.round(Number(value));
  const min = Math.round(Number(minValue));
  const max = Math.round(Number(maxValue));

  if (!Number.isFinite(integerValue)) {
    return min;
  }

  if (integerValue < min) {
    return min;
  }

  if (integerValue > max) {
    return max;
  }

  return integerValue;
}

function normalizeAudioMap(manifestUrl, audio) {
  if (!audio || typeof audio !== "object") {
    return undefined;
  }

  const resolved = {};
  for (const [key, value] of Object.entries(audio)) {
    if (typeof value !== "string") {
      continue;
    }
    const finalPath = normalizeAssetPath(manifestUrl, value);
    if (finalPath) {
      resolved[key] = finalPath;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function normalizeAssetPath(manifestUrl, assetPath) {
  if (typeof assetPath !== "string" || !assetPath.trim()) {
    return "";
  }

  const cleanPath = assetPath.trim();
  if (cleanPath.startsWith("/")) {
    return cleanPath;
  }

  const baseDir = path.posix.dirname(manifestUrl);
  const joined = path.posix.normalize(path.posix.join(baseDir, cleanPath));
  if (!joined.startsWith(`${STORY_PUBLIC_PREFIX}/`)) {
    throw new Error(`资源路径越界: ${assetPath}`);
  }

  return joined;
}

function resolveManifestFsPath(manifestUrl) {
  if (typeof manifestUrl !== "string" || !manifestUrl.trim()) {
    throw new Error("manifest 不能为空");
  }

  const normalizedUrl = manifestUrl.startsWith("/") ? manifestUrl : `${STORY_PUBLIC_PREFIX}/${manifestUrl}`;
  const normalizedFsPath = resolveStoryAssetFsPath(normalizedUrl);

  if (!normalizedFsPath) {
    throw new Error("manifest 路径越界");
  }

  if (!fs.existsSync(normalizedFsPath)) {
    throw new Error(`未找到 manifest: ${manifestUrl}`);
  }

  return normalizedFsPath;
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

function runProgressMaintenanceForUser(userId) {
  try {
    const catalog = loadStoryCatalog();
    for (const entry of catalog.stories) {
      const story = loadStoryById(entry.id, catalog);
      if (!story) {
        continue;
      }
      migrateLegacyProgressForStory(userId, story);
      reconcileProgressContentVersionForStory(userId, story);
    }
  } catch (error) {
    console.warn("progress maintenance failed:", asMessage(error, "unknown"));
  }
}

function reconcileProgressContentVersionForStory(userId, story) {
  const rows = db
    .prepare("SELECT level_id, content_version FROM user_level_progress WHERE user_id = ? AND story_id = ?")
    .all(userId, story.id);

  const versionByLevel = new Map(story.levels.map((level) => [level.id, normalizeContentVersion(level.content_version)]));

  for (const row of rows) {
    const targetVersion = versionByLevel.get(row.level_id);
    if (!targetVersion) {
      continue;
    }

    const currentVersion = normalizeContentVersion(row.content_version);
    if (currentVersion === targetVersion) {
      continue;
    }

    db.prepare(
      "UPDATE user_level_progress SET content_version = ?, save_state_json = NULL WHERE user_id = ? AND story_id = ? AND level_id = ?",
    ).run(targetVersion, userId, story.id, row.level_id);
  }
}

function migrateLegacyProgressForStory(userId, story) {
  for (const level of story.levels) {
    if (!Array.isArray(level.legacy_ids) || level.legacy_ids.length === 0) {
      continue;
    }

    for (const legacyId of level.legacy_ids) {
      if (!legacyId || legacyId === level.id) {
        continue;
      }

      const oldRow = db
        .prepare(
          "SELECT status, best_time_ms, best_moves, attempts, last_played_at, completed_at, save_state_json, content_version FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?",
        )
        .get(userId, story.id, legacyId);

      if (!oldRow) {
        continue;
      }

      db.prepare(
        `
        INSERT INTO user_level_progress (
          user_id,
          story_id,
          level_id,
          status,
          best_time_ms,
          best_moves,
          attempts,
          last_played_at,
          completed_at,
          save_state_json,
          content_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, story_id, level_id) DO UPDATE SET
          status = CASE
            WHEN user_level_progress.status = 'completed' THEN 'completed'
            WHEN excluded.status = 'completed' THEN 'completed'
            ELSE excluded.status
          END,
          best_time_ms = CASE
            WHEN excluded.best_time_ms IS NULL THEN user_level_progress.best_time_ms
            WHEN user_level_progress.best_time_ms IS NULL THEN excluded.best_time_ms
            WHEN excluded.best_time_ms < user_level_progress.best_time_ms THEN excluded.best_time_ms
            ELSE user_level_progress.best_time_ms
          END,
          best_moves = CASE
            WHEN excluded.best_moves IS NULL THEN user_level_progress.best_moves
            WHEN user_level_progress.best_moves IS NULL THEN excluded.best_moves
            WHEN excluded.best_moves < user_level_progress.best_moves THEN excluded.best_moves
            ELSE user_level_progress.best_moves
          END,
          attempts = user_level_progress.attempts + excluded.attempts,
          last_played_at = CASE
            WHEN user_level_progress.last_played_at IS NULL THEN excluded.last_played_at
            WHEN excluded.last_played_at IS NULL THEN user_level_progress.last_played_at
            WHEN excluded.last_played_at > user_level_progress.last_played_at THEN excluded.last_played_at
            ELSE user_level_progress.last_played_at
          END,
          completed_at = CASE
            WHEN user_level_progress.completed_at IS NOT NULL THEN user_level_progress.completed_at
            WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at
            ELSE NULL
          END,
          save_state_json = COALESCE(excluded.save_state_json, user_level_progress.save_state_json),
          content_version = user_level_progress.content_version
      `,
      ).run(
        userId,
        story.id,
        level.id,
        oldRow.status,
        oldRow.best_time_ms,
        oldRow.best_moves,
        oldRow.attempts,
        oldRow.last_played_at,
        oldRow.completed_at,
        oldRow.save_state_json,
        normalizeContentVersion(oldRow.content_version),
      );

      db.prepare("DELETE FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?").run(
        userId,
        story.id,
        legacyId,
      );
    }
  }
}

function normalizeLegacyIds(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = [...new Set(value.map((item) => String(item || "").trim()).filter((item) => item.length > 0))];
  return result.length > 0 ? result : undefined;
}

function normalizeContentVersion(value) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return 1;
  }
  return numberValue;
}

function doesAssetExist(assetUrl) {
  const filePath = resolvePublicAssetFsPath(assetUrl);
  if (!filePath) {
    return false;
  }

  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolvePublicAssetFsPath(assetUrl) {
  if (typeof assetUrl !== "string" || !assetUrl.trim()) {
    return "";
  }

  const value = assetUrl.trim();
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return "";
  }

  if (!value.startsWith("/")) {
    return "";
  }

  const storyAssetPath = resolveStoryAssetFsPath(value);
  if (storyAssetPath) {
    return storyAssetPath;
  }

  const [cleanPath] = value.split(/[?#]/, 1);
  const normalized = path.normalize(path.resolve(WEB_PUBLIC_DIR, cleanPath.slice(1)));
  if (!normalized.startsWith(path.normalize(WEB_PUBLIC_DIR))) {
    return "";
  }

  return normalized;
}

function resolveStoriesRootDir() {
  const configuredRoot = String(process.env.STORY_CONTENT_ROOT || "").trim();
  if (configuredRoot) {
    return resolveProjectPath(configuredRoot);
  }

  return path.normalize(DEFAULT_STORIES_ROOT_DIR);
}

function resolveProjectPath(value, fallback = "") {
  const raw = String(value || fallback || "").trim();
  if (!raw) {
    return "";
  }

  const resolved = path.isAbsolute(raw) ? raw : path.resolve(ROOT_DIR, raw);
  return path.normalize(resolved);
}

function ensureStoryIndexFile() {
  if (fs.existsSync(STORY_INDEX_FILE)) {
    return;
  }

  const normalizedStoriesRoot = path.normalize(STORIES_ROOT_DIR);
  const normalizedLegacyRoot = path.normalize(LEGACY_STORIES_ROOT_DIR);
  const legacyIndexPath = path.join(normalizedLegacyRoot, "index.json");

  if (normalizedStoriesRoot !== normalizedLegacyRoot && fs.existsSync(legacyIndexPath)) {
    fs.cpSync(normalizedLegacyRoot, normalizedStoriesRoot, { recursive: true });
    if (fs.existsSync(STORY_INDEX_FILE)) {
      return;
    }
  }

  const payload = {
    version: 1,
    stories: [],
  };
  fs.writeFileSync(STORY_INDEX_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function resolveStoryAssetFsPath(assetUrl) {
  if (typeof assetUrl !== "string" || !assetUrl.trim()) {
    return "";
  }

  const [cleanPath] = assetUrl.trim().split(/[?#]/, 1);
  if (!cleanPath.startsWith(`${STORY_PUBLIC_PREFIX}/`)) {
    return "";
  }

  const relativePath = cleanPath.slice(`${STORY_PUBLIC_PREFIX}/`.length);
  if (!relativePath) {
    return "";
  }

  const normalized = path.normalize(path.resolve(STORIES_ROOT_DIR, relativePath));
  if (!normalized.startsWith(path.normalize(STORIES_ROOT_DIR))) {
    return "";
  }

  return normalized;
}

function resolveSessionTtlMs() {
  const defaultMs = 1000 * 60 * 60 * 24 * 30;
  const rawDays = process.env.SESSION_TTL_DAYS;

  if (rawDays === undefined || rawDays === null || rawDays === "") {
    return defaultMs;
  }

  const days = Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) {
    return defaultMs;
  }

  return Math.max(60_000, Math.floor(days * 24 * 60 * 60 * 1000));
}

function resolveCookieSecure() {
  const rawValue = process.env.COOKIE_SECURE;

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return process.env.NODE_ENV === "production";
  }

  const normalized = String(rawValue).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function resolveCookieSameSite(cookieSecure) {
  const normalized = String(process.env.COOKIE_SAME_SITE || "Lax").trim().toLowerCase();

  if (normalized === "strict") {
    return "Strict";
  }

  if (normalized === "none") {
    return cookieSecure ? "None" : "Lax";
  }

  return "Lax";
}


function requireAdmin(req, res, next) {
  if (!isAdminUser(req.authUser)) {
    res.status(403).json({ message: "需要管理员权限" });
    return;
  }
  next();
}

function requireWorkerAuth(req, res, next) {
  if (!STORY_GENERATOR_WORKER_TOKEN) {
    res.status(503).json({ message: "worker token 未配置" });
    return;
  }

  const token = extractWorkerToken(req);
  if (!token || token !== STORY_GENERATOR_WORKER_TOKEN) {
    res.status(401).json({ message: "worker 鉴权失败" });
    return;
  }

  next();
}

function extractWorkerToken(req) {
  const headerToken = req.headers["x-worker-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return token || "";
  }

  return "";
}

function isAdminUser(user) {
  if (!user || !user.username) {
    return false;
  }

  if (Boolean(user.has_admin_role)) {
    return true;
  }

  const normalized = String(user.username).trim().toLowerCase();

  if (ADMIN_USERNAMES.size > 0) {
    return ADMIN_USERNAMES.has(normalized);
  }

  return process.env.NODE_ENV !== "production";
}

function normalizeAdminRole(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!MANAGED_ADMIN_ROLES.has(normalized)) {
    return "";
  }
  return normalized;
}

function getRolesByUserId(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    return [];
  }

  try {
    const rows = db
      .prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role ASC")
      .all(userId);
    return rows
      .map((item) => normalizeAdminRole(item.role))
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function getRolesByUserIds(userIds = []) {
  const normalizedIds = [...new Set(userIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
  if (normalizedIds.length === 0) {
    return new Map();
  }

  try {
    const placeholders = normalizedIds.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT user_id, role FROM user_roles WHERE user_id IN (${placeholders}) ORDER BY user_id ASC, role ASC`)
      .all(...normalizedIds);

    const result = new Map(normalizedIds.map((item) => [item, []]));
    for (const row of rows) {
      const userId = Number(row.user_id);
      const role = normalizeAdminRole(row.role);
      if (!role) {
        continue;
      }
      if (!result.has(userId)) {
        result.set(userId, []);
      }
      result.get(userId).push(role);
    }
    return result;
  } catch {
    return new Map(normalizedIds.map((item) => [item, []]));
  }
}

function countAdminUsers() {
  try {
    const row = db.prepare("SELECT COUNT(1) AS total FROM user_roles WHERE role = 'admin'").get();
    return Number(row?.total || 0);
  } catch {
    return 0;
  }
}

function serializeAdminUser(user, roles = []) {
  const userId = Number(user?.id || 0);
  const username = String(user?.username || "");
  const normalizedRoles = [...new Set(roles.map((item) => normalizeAdminRole(item)).filter((item) => item.length > 0))];

  return {
    id: userId,
    username,
    is_guest: Boolean(user?.is_guest),
    created_at: user?.created_at || null,
    last_login_at: user?.last_login_at || null,
    roles: normalizedRoles,
    best_time_level_count: normalizeNonNegativeInteger(user?.best_time_level_count, 0),
    fastest_level_time_ms: normalizePositiveInteger(user?.fastest_level_time_ms) || null,
    completed_level_count: normalizeNonNegativeInteger(user?.completed_level_count, 0),
    is_admin: isAdminUser({
      id: userId,
      username,
      is_guest: Boolean(user?.is_guest),
      has_admin_role: normalizedRoles.includes("admin"),
    }),
  };
}

function appendAdminAuditLog({ actorUserId, actorUsername, action, targetType, targetId, before, after, meta }) {
  try {
    db.prepare(
      `
      INSERT INTO admin_audit_logs (
        actor_user_id,
        actor_username_snapshot,
        action,
        target_type,
        target_id,
        before_json,
        after_json,
        meta_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      Number.isInteger(actorUserId) ? actorUserId : null,
      String(actorUsername || ""),
      String(action || ""),
      String(targetType || ""),
      String(targetId || ""),
      JSON.stringify(before && typeof before === "object" ? before : {}),
      JSON.stringify(after && typeof after === "object" ? after : {}),
      JSON.stringify(meta && typeof meta === "object" ? meta : {}),
      nowIso(),
    );
  } catch {
    // ignore audit write failure
  }
}

function getStoryLevelSource(storyId, levelId) {
  const normalizedStoryId = String(storyId || "").trim();
  const normalizedLevelId = String(levelId || "").trim();
  if (!normalizedStoryId || !normalizedLevelId) {
    return null;
  }

  const catalog = loadStoryCatalog();
  const entry = catalog.stories.find((item) => item.id === normalizedStoryId);
  if (!entry) {
    return null;
  }

  const manifestPath = resolveManifestFsPath(entry.manifest);
  const payload = readJson(manifestPath);
  const levelsRaw = Array.isArray(payload.levels) ? payload.levels : [];

  for (let index = 0; index < levelsRaw.length; index += 1) {
    const rawLevel = levelsRaw[index];
    const candidateId = String(rawLevel?.id ?? `level_${String(index + 1).padStart(3, "0")}`);
    if (candidateId === normalizedLevelId) {
      return {
        entry,
        raw_level: rawLevel,
        index,
      };
    }
  }

  return null;
}

function getLevelOverrideRecord(storyId, levelId) {
  const normalizedStoryId = String(storyId || "").trim();
  const normalizedLevelId = String(levelId || "").trim();
  if (!normalizedStoryId || !normalizedLevelId) {
    return null;
  }

  try {
    const row = db
      .prepare(
        `
        SELECT
          story_id,
          level_id,
          enabled,
          grid_rows,
          grid_cols,
          time_limit_sec,
          difficulty,
          difficulty_factor,
          content_version,
          extra_json,
          updated_by_user_id,
          created_at,
          updated_at
        FROM level_overrides
        WHERE story_id = ? AND level_id = ?
        LIMIT 1
      `,
      )
      .get(normalizedStoryId, normalizedLevelId);

    return row || null;
  } catch {
    return null;
  }
}

function buildSingleLevelOverrideMap(levelId, overrideRecord) {
  const result = new Map();
  if (!overrideRecord || Number(overrideRecord.enabled) !== 1) {
    return result;
  }

  result.set(String(levelId || "").trim(), overrideRecord);
  return result;
}

function serializeLevelOverrideConfig(overrideRecord) {
  if (!overrideRecord) {
    return null;
  }

  return {
    enabled: Number(overrideRecord.enabled) === 1,
    grid_rows: normalizePositiveInteger(overrideRecord.grid_rows) || null,
    grid_cols: normalizePositiveInteger(overrideRecord.grid_cols) || null,
    time_limit_sec: normalizePositiveInteger(overrideRecord.time_limit_sec) || null,
    difficulty: normalizeDifficultyOverride(overrideRecord.difficulty),
    difficulty_factor: normalizePositiveNumber(overrideRecord.difficulty_factor) || null,
    content_version: normalizePositiveInteger(overrideRecord.content_version) || null,
    updated_by_user_id: normalizePositiveInteger(overrideRecord.updated_by_user_id) || null,
    created_at: overrideRecord.created_at || null,
    updated_at: overrideRecord.updated_at || null,
  };
}

function extractAdminEffectiveLevelConfig(level) {
  const rows = Number(level?.grid?.rows || 0);
  const cols = Number(level?.grid?.cols || 0);

  return {
    grid_rows: rows,
    grid_cols: cols,
    piece_count: Math.max(0, rows * cols),
    time_limit_sec: normalizePositiveInteger(level?.time_limit_sec) || null,
    difficulty: normalizeDifficulty(level?.difficulty),
    content_version: normalizeContentVersion(level?.content_version),
  };
}

function buildAdminLevelConfigSnapshot(storyId, levelId, options = {}) {
  const source = getStoryLevelSource(storyId, levelId);
  if (!source) {
    return null;
  }

  const timerPolicy = loadTimerPolicy();
  const baseLevel = normalizeLevel(source.entry.manifest, source.raw_level, source.index, new Map(), timerPolicy);
  const persistedOverrideRecord = getLevelOverrideRecord(storyId, levelId);
  const effectiveLevel = normalizeLevel(
    source.entry.manifest,
    source.raw_level,
    source.index,
    buildSingleLevelOverrideMap(levelId, persistedOverrideRecord),
    timerPolicy,
  );

  const result = {
    story_id: storyId,
    level_id: levelId,
    level_title: String(baseLevel.title || levelId),
    base_config: extractAdminEffectiveLevelConfig(baseLevel),
    override_config: serializeLevelOverrideConfig(persistedOverrideRecord),
    effective_config: extractAdminEffectiveLevelConfig(effectiveLevel),
  };

  if (options.previewPatch !== undefined) {
    const previewOverrideRecord = mergeLevelOverrideRecord(
      persistedOverrideRecord,
      options.previewPatch || {},
      baseLevel.content_version,
    );
    const previewLevel = normalizeLevel(
      source.entry.manifest,
      source.raw_level,
      source.index,
      buildSingleLevelOverrideMap(levelId, previewOverrideRecord),
      timerPolicy,
    );

    result.preview_override_config = serializeLevelOverrideConfig(previewOverrideRecord);
    result.preview_effective_config = extractAdminEffectiveLevelConfig(previewLevel);
  }

  return result;
}

function getFirstDefinedField(payload, keys = []) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return payload[key];
    }
  }

  return undefined;
}

function normalizeDifficultyOverride(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!MANAGED_LEVEL_DIFFICULTIES.has(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeOptionalBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === 1 || value === "1") {
    return true;
  }

  if (value === 0 || value === "0") {
    return false;
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseAdminLevelConfigPatch(payload, options = {}) {
  const allowEmpty = Boolean(options.allowEmpty);
  const patch = {};
  let hasAny = false;

  const parseNullableInteger = (rawValue, fieldName, min, max) => {
    if (rawValue === undefined) {
      return;
    }
    hasAny = true;

    if (rawValue === null || rawValue === "") {
      patch[fieldName] = null;
      return;
    }

    const parsed = normalizePositiveInteger(rawValue);
    if (!parsed) {
      throw new Error(`${fieldName} 必须是正整数或 null`);
    }

    if (Number.isFinite(min) && parsed < min) {
      throw new Error(`${fieldName} 不能小于 ${min}`);
    }
    if (Number.isFinite(max) && parsed > max) {
      throw new Error(`${fieldName} 不能大于 ${max}`);
    }

    patch[fieldName] = parsed;
  };

  try {
    parseNullableInteger(getFirstDefinedField(payload, ["grid_rows", "rows"]), "grid_rows", 2, 20);
    parseNullableInteger(getFirstDefinedField(payload, ["grid_cols", "cols"]), "grid_cols", 2, 20);
    parseNullableInteger(getFirstDefinedField(payload, ["time_limit_sec", "time"]), "time_limit_sec", 30, 3600);
    parseNullableInteger(getFirstDefinedField(payload, ["content_version"]), "content_version", 1, Number.POSITIVE_INFINITY);

    const difficultyRaw = getFirstDefinedField(payload, ["difficulty"]);
    if (difficultyRaw !== undefined) {
      hasAny = true;
      const normalizedDifficulty = normalizeDifficultyOverride(difficultyRaw);
      if (normalizedDifficulty === "") {
        return {
          ok: false,
          message: "difficulty 必须是 easy/normal/hard/nightmare 或 null",
        };
      }
      patch.difficulty = normalizedDifficulty;
    }

    const factorRaw = getFirstDefinedField(payload, ["difficulty_factor"]);
    if (factorRaw !== undefined) {
      hasAny = true;
      if (factorRaw === null || factorRaw === "") {
        patch.difficulty_factor = null;
      } else {
        const parsedFactor = normalizePositiveNumber(factorRaw);
        if (!parsedFactor || parsedFactor > 5) {
          return {
            ok: false,
            message: "difficulty_factor 必须在 (0, 5] 或 null",
          };
        }
        patch.difficulty_factor = parsedFactor;
      }
    }

    const enabledRaw = getFirstDefinedField(payload, ["enabled"]);
    if (enabledRaw !== undefined) {
      hasAny = true;
      const parsedEnabled = normalizeOptionalBoolean(enabledRaw);
      if (parsedEnabled === undefined) {
        return {
          ok: false,
          message: "enabled 必须是 true/false",
        };
      }
      patch.enabled = parsedEnabled ? 1 : 0;
    }
  } catch (error) {
    return {
      ok: false,
      message: asMessage(error, "配置参数不合法"),
    };
  }

  if (!allowEmpty && !hasAny) {
    return {
      ok: false,
      message: "至少提供一个配置项",
    };
  }

  return {
    ok: true,
    patch,
  };
}

function mergeLevelOverrideRecord(existingRecord, patch, defaultContentVersion = 1) {
  const merged = {
    enabled: existingRecord ? (Number(existingRecord.enabled) === 1 ? 1 : 0) : 1,
    grid_rows: normalizePositiveInteger(existingRecord?.grid_rows) || null,
    grid_cols: normalizePositiveInteger(existingRecord?.grid_cols) || null,
    time_limit_sec: normalizePositiveInteger(existingRecord?.time_limit_sec) || null,
    difficulty: normalizeDifficultyOverride(existingRecord?.difficulty),
    difficulty_factor: normalizePositiveNumber(existingRecord?.difficulty_factor) || null,
    content_version: normalizePositiveInteger(existingRecord?.content_version) || normalizeContentVersion(defaultContentVersion),
    extra_json: typeof existingRecord?.extra_json === "string" && safeParseJsonObject(existingRecord.extra_json)
      ? existingRecord.extra_json
      : "{}",
    updated_by_user_id: normalizePositiveInteger(existingRecord?.updated_by_user_id) || null,
    created_at: existingRecord?.created_at || null,
    updated_at: existingRecord?.updated_at || null,
  };

  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(merged, key) && key !== "enabled") {
      continue;
    }
    merged[key] = value;
  }

  if ((merged.grid_rows === null && merged.grid_cols !== null)
    || (merged.grid_rows !== null && merged.grid_cols === null)) {
    throw new Error("grid_rows 与 grid_cols 必须同时设置或同时置空");
  }

  if (merged.difficulty === "") {
    throw new Error("difficulty 必须是 easy/normal/hard/nightmare 或 null");
  }

  if (merged.time_limit_sec !== null && (merged.time_limit_sec < 30 || merged.time_limit_sec > 3600)) {
    throw new Error("time_limit_sec 必须在 30-3600 范围内");
  }

  merged.enabled = Number(merged.enabled) === 1 ? 1 : 0;
  merged.content_version = normalizeContentVersion(merged.content_version);

  return merged;
}

function saveAdminLevelOverrideConfig(storyId, levelId, patch, actorUserId) {
  const existingRecord = getLevelOverrideRecord(storyId, levelId);
  const mergedRecord = mergeLevelOverrideRecord(existingRecord, patch);
  const now = nowIso();
  const createdAt = existingRecord?.created_at || now;

  db.prepare(
    `
    INSERT INTO level_overrides (
      story_id,
      level_id,
      enabled,
      grid_rows,
      grid_cols,
      time_limit_sec,
      difficulty,
      difficulty_factor,
      content_version,
      extra_json,
      updated_by_user_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(story_id, level_id) DO UPDATE SET
      enabled = excluded.enabled,
      grid_rows = excluded.grid_rows,
      grid_cols = excluded.grid_cols,
      time_limit_sec = excluded.time_limit_sec,
      difficulty = excluded.difficulty,
      difficulty_factor = excluded.difficulty_factor,
      content_version = excluded.content_version,
      extra_json = excluded.extra_json,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `,
  ).run(
    storyId,
    levelId,
    mergedRecord.enabled,
    mergedRecord.grid_rows,
    mergedRecord.grid_cols,
    mergedRecord.time_limit_sec,
    mergedRecord.difficulty,
    mergedRecord.difficulty_factor,
    mergedRecord.content_version,
    mergedRecord.extra_json,
    Number.isInteger(actorUserId) ? actorUserId : null,
    createdAt,
    now,
  );

  return getLevelOverrideRecord(storyId, levelId);
}

function hasAdminRoleByUserId(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    return false;
  }

  try {
    const row = db
      .prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin' LIMIT 1")
      .get(userId);
    return Boolean(row);
  } catch {
    return false;
  }
}

function buildAuthUserPayload(user) {
  const userId = Number(user?.id || 0);
  const username = String(user?.username || "");
  const isGuest = Boolean(user?.is_guest);
  const hasAdminRole = user && Object.prototype.hasOwnProperty.call(user, "has_admin_role")
    ? Boolean(user.has_admin_role)
    : hasAdminRoleByUserId(userId);

  return {
    id: userId,
    username,
    is_guest: isGuest,
    is_admin: isAdminUser({
      id: userId,
      username,
      is_guest: isGuest,
      has_admin_role: hasAdminRole,
    }),
  };
}

function normalizeTargetDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return nowIso().slice(0, 10);
  }

  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return "";
  }

  return text;
}

function normalizeRunId(value) {
  if (typeof value !== "string") {
    return "";
  }
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) {
    return "";
  }
  return cleaned.slice(0, 80);
}

function defaultGenerationRunId() {
  const stamp = nowIso().replace(/[^0-9]/g, "").slice(0, 14);
  return `admin_${stamp}_${randomToken().slice(0, 8)}`;
}

function buildGenerationSummaryFileName(targetDate, runId) {
  const normalizedDate = normalizeTargetDate(targetDate) || nowIso().slice(0, 10);
  const normalizedRunId = normalizeRunId(runId) || defaultGenerationRunId();
  return `story_${normalizedDate}_${normalizedRunId}.json`;
}

function normalizeStoryFile(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const resolved = path.isAbsolute(value) ? path.normalize(value) : path.normalize(path.resolve(ROOT_DIR, value));
  if (!resolved.startsWith(path.normalize(ROOT_DIR))) {
    return "";
  }

  try {
    if (!fs.statSync(resolved).isFile()) {
      return "";
    }
  } catch {
    return "";
  }

  return resolved;
}

function normalizeShortText(value) {
  if (typeof value !== "string") {
    return "";
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.slice(0, 120);
}

function normalizePositiveNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return undefined;
  }

  return numberValue;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    return fallback;
  }

  return numberValue;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getBooksDbOrThrow() {
  if (booksDb) {
    return booksDb;
  }

  if (!fs.existsSync(RESOLVED_BOOK_INGEST_DB_PATH)) {
    throw new Error(`未找到书籍数据库: ${RESOLVED_BOOK_INGEST_DB_PATH}`);
  }

  booksDb = new Database(RESOLVED_BOOK_INGEST_DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  return booksDb;
}

function materializeChapterTextToFile(chapterId, runId) {
  const booksDatabase = getBooksDbOrThrow();
  const row = booksDatabase
    .prepare(
      `
      SELECT c.id, c.book_id, b.title AS book_title, c.chapter_index, c.chapter_title, c.chapter_text, c.char_count
      FROM chapters c
      JOIN books b ON b.id = c.book_id
      WHERE c.id = ?
    `,
    )
    .get(chapterId);

  if (!row || typeof row.chapter_text !== "string" || !row.chapter_text.trim()) {
    throw new Error(`chapter_id 不存在或正文为空: ${chapterId}`);
  }

  const chapterDir = path.join(STORY_GENERATOR_SUMMARY_DIR, "chapters");
  fs.mkdirSync(chapterDir, { recursive: true });

  const chapterFile = path.join(chapterDir, `${runId}_chapter_${Number(row.id)}.txt`);
  fs.writeFileSync(chapterFile, row.chapter_text, "utf-8");

  return {
    chapter_id: Number(row.id),
    book_id: Number(row.book_id),
    book_title: String(row.book_title || ""),
    chapter_index: Number(row.chapter_index),
    chapter_title: String(row.chapter_title || ""),
    char_count: Number(row.char_count || 0),
    story_file: chapterFile,
  };
}

function readRunEvents(eventLogFile, runId, limit = 20) {
  try {
    if (!eventLogFile || !fs.existsSync(eventLogFile)) {
      return [];
    }

    const lines = fs.readFileSync(eventLogFile, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const events = [];

    for (const line of lines) {
      try {
        const payload = JSON.parse(line);
        if (payload && payload.run_id === runId) {
          events.push(payload);
        }
      } catch {
        // ignore malformed lines
      }
    }

    return events.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

function normalizeUsername(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 32) {
    return "";
  }
  return normalized;
}

function normalizePassword(value) {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length < 6 || value.length > 64) {
    return "";
  }
  return value;
}

function normalizePositiveInteger(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return undefined;
  }

  return numberValue;
}

function normalizeIntegerInRange(value, minValue, maxValue) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) {
    return undefined;
  }

  if (numberValue < minValue || numberValue > maxValue) {
    return undefined;
  }

  return numberValue;
}

function normalizeGenerationJobStatus(value) {
  const text = String(value || "").trim();
  const allowed = new Set(["succeeded", "failed", "cancelled"]);
  return allowed.has(text) ? text : "";
}

function normalizeGenerationReviewStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "pending_review" || text === "published") {
    return text;
  }
  return "";
}

function isReviewModePayload(payload, dryRun = false) {
  if (dryRun) {
    return false;
  }
  return normalizeBoolean(payload?.review_mode);
}

function normalizeErrorMessage(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value).trim();
  if (!text) {
    return "";
  }
  return text.slice(0, 4000);
}

function splitCommandString(command) {
  const text = String(command || "").trim();
  if (!text) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens.filter((item) => item.length > 0);
}

function parsePythonCommand(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item || "").trim())
          .filter((item) => item.length > 0);
      }
    } catch {
      // ignore json parse failure and fallback to split
    }
  }

  return splitCommandString(raw);
}

function resolveStoryGeneratorPythonCommand(options = {}) {
  const explicitCmd = parsePythonCommand(options.explicitCmd);
  if (explicitCmd.length > 0) {
    return explicitCmd;
  }

  const explicitBin = String(options.explicitBin || "").trim();
  if (explicitBin) {
    return [explicitBin];
  }

  const localVenvPython = path.join(ROOT_DIR, ".venv", "bin", "python");
  if (fs.existsSync(localVenvPython)) {
    return [localVenvPython];
  }

  return ["python3"];
}

function normalizeAttempts(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function normalizeGenerationFlowStage(value) {
  const text = String(value || "").trim().toLowerCase();
  return GENERATION_FLOW_STAGES.has(text) ? text : "";
}

function normalizeGenerationSceneTextStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  return GENERATION_SCENE_TEXT_STATUSES.has(text) ? text : "pending";
}

function normalizeGenerationSceneImageStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "succeeded") {
    return "success";
  }
  return GENERATION_SCENE_IMAGE_STATUSES.has(text) ? text : "pending";
}

function normalizeGenerationSceneSourceKind(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "legacy" || text === "summary" || text === "review" || text === "manual" || text === "pipeline") {
    return text;
  }
  return "manual";
}

function normalizeGenerationSceneCharacters(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0)
    .slice(0, 40);
}

function resolveGenerationRunImagesDir(runId) {
  const safeRunId = normalizeRunId(runId) || `run_${randomToken().slice(0, 8)}`;
  const dir = path.join(STORIES_ROOT_DIR, ".generation_runs", safeRunId, "images");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runStoryGeneratorAtomicCommand(command, payload, options = {}) {
  const allowedCommands = new Set(["generate-text", "generate-image", "generate-images"]);
  const normalizedCommand = String(command || "").trim();
  if (!allowedCommands.has(normalizedCommand)) {
    return Promise.reject(new Error(`不支持的原子命令: ${normalizedCommand}`));
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
    : STORY_GENERATOR_ATOMIC_TIMEOUT_MS;
  const requestPayload = payload && typeof payload === "object" ? payload : {};
  const pythonCommand = Array.isArray(STORY_GENERATOR_PYTHON_CMD) && STORY_GENERATOR_PYTHON_CMD.length > 0
    ? STORY_GENERATOR_PYTHON_CMD
    : [STORY_GENERATOR_PYTHON_BIN || "python3"];
  const pythonExec = String(pythonCommand[0] || STORY_GENERATOR_PYTHON_BIN || "python3").trim() || "python3";
  const pythonArgs = pythonCommand.slice(1);

  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonExec,
      [...pythonArgs, "-m", STORY_GENERATOR_ATOMIC_MODULE, normalizedCommand],
      {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let finished = false;

    const done = (error, result = null) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutTimer);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }

      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 800);

      done(new Error(`原子命令超时: ${normalizedCommand} (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      done(new Error(`启动原子命令失败(${pythonCommand.join(" ")}): ${asMessage(error, "spawn failed")}`));
    });

    child.on("close", (code) => {
      if (finished) {
        return;
      }

      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      const parsedStdout = safeParseJsonObject(trimmedStdout);
      const stderrPayload = safeParseJsonObject(trimmedStderr);

      if (code === 0) {
        if (!parsedStdout || parsedStdout.ok !== true || !parsedStdout.result || typeof parsedStdout.result !== "object") {
          done(new Error(`原子命令输出不合法: ${normalizedCommand}`));
          return;
        }
        done(null, parsedStdout.result);
        return;
      }

      const errorMessage = String(parsedStdout.error || stderrPayload.error || trimmedStderr || trimmedStdout || "atomic command failed").trim();
      done(new Error(`原子命令失败(${normalizedCommand}): ${errorMessage}`));
    });

    try {
      child.stdin.write(JSON.stringify(requestPayload));
      child.stdin.end();
    } catch (error) {
      done(new Error(`写入原子命令输入失败: ${asMessage(error, "stdin write failed")}`));
    }
  });
}

function hasGenerationSceneRows(runId) {
  try {
    const row = db
      .prepare(
        `
        SELECT 1
        FROM generation_job_scenes
        WHERE run_id = ?
        LIMIT 1
      `,
      )
      .get(runId);
    return Boolean(row);
  } catch {
    return false;
  }
}

function serializeGenerationSceneRow(row) {
  if (!row) {
    return null;
  }

  return {
    run_id: String(row.run_id || ""),
    scene_index: Number(row.scene_index || 0),
    scene_id: row.scene_id === null || row.scene_id === undefined ? null : Number(row.scene_id),
    title: String(row.title || ""),
    description: String(row.description || ""),
    story_text: String(row.story_text || ""),
    image_prompt: String(row.image_prompt || ""),
    mood: String(row.mood || ""),
    characters: normalizeGenerationSceneCharacters(safeParseJsonArray(row.characters_json)),
    grid_rows: normalizeIntegerInRange(row.grid_rows, 2, 20) || 6,
    grid_cols: normalizeIntegerInRange(row.grid_cols, 2, 20) || 4,
    time_limit_sec: normalizeIntegerInRange(row.time_limit_sec, 30, 3600) || 180,
    text_status: normalizeGenerationSceneTextStatus(row.text_status),
    image_status: normalizeGenerationSceneImageStatus(row.image_status),
    image_url: String(row.image_url || ""),
    image_path: String(row.image_path || ""),
    error_message: String(row.error_message || ""),
    selected: Boolean(row.selected),
    deleted_at: row.deleted_at || null,
    source_kind: normalizeGenerationSceneSourceKind(row.source_kind),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function listGenerationScenes(runId, options = {}) {
  const includeDeleted = normalizeBoolean(options.include_deleted);
  try {
    const rows = db
      .prepare(
        `
        SELECT run_id, scene_index, scene_id,
               title, description, story_text,
               image_prompt, mood, characters_json,
               grid_rows, grid_cols, time_limit_sec,
               text_status, image_status,
               image_url, image_path, error_message,
               selected, deleted_at, source_kind,
               created_at, updated_at
        FROM generation_job_scenes
        WHERE run_id = ?
          ${includeDeleted ? "" : "AND deleted_at IS NULL"}
        ORDER BY scene_index ASC
      `,
      )
      .all(runId);

    return rows
      .map((row) => serializeGenerationSceneRow(row))
      .filter((item) => item !== null);
  } catch {
    return [];
  }
}

function listGenerationSceneAttempts(runId, sceneIndex = null) {
  try {
    let rows = [];
    if (Number.isInteger(sceneIndex) && sceneIndex > 0) {
      rows = db
        .prepare(
          `
          SELECT id, run_id, scene_index, attempt_no, status,
                 provider, model, image_prompt,
                 image_url, image_path, error_message,
                 latency_ms, created_at, started_at, ended_at, updated_at
          FROM generation_job_scene_image_attempts
          WHERE run_id = ? AND scene_index = ?
          ORDER BY attempt_no ASC
        `,
        )
        .all(runId, sceneIndex);
    } else {
      rows = db
        .prepare(
          `
          SELECT id, run_id, scene_index, attempt_no, status,
                 provider, model, image_prompt,
                 image_url, image_path, error_message,
                 latency_ms, created_at, started_at, ended_at, updated_at
          FROM generation_job_scene_image_attempts
          WHERE run_id = ?
          ORDER BY scene_index ASC, attempt_no ASC
        `,
        )
        .all(runId);
    }

    return rows.map((row) => ({
      id: Number(row.id || 0),
      run_id: String(row.run_id || ""),
      scene_index: Number(row.scene_index || 0),
      attempt_no: Number(row.attempt_no || 0),
      status: normalizeGenerationCandidateRetryStatus(row.status),
      provider: String(row.provider || ""),
      model: String(row.model || ""),
      image_prompt: String(row.image_prompt || ""),
      image_url: String(row.image_url || ""),
      image_path: String(row.image_path || ""),
      error_message: String(row.error_message || ""),
      latency_ms: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
      created_at: row.created_at || null,
      started_at: row.started_at || null,
      ended_at: row.ended_at || null,
      updated_at: row.updated_at || null,
    }));
  } catch {
    return [];
  }
}

function serializeGenerationSceneAttemptAsLegacyRetry(attempt) {
  if (!attempt) {
    return null;
  }

  const statusMap = {
    queued: "queued",
    running: "running",
    succeeded: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
  };

  return {
    retry_id: Number(attempt.id || 0),
    run_id: String(attempt.run_id || ""),
    scene_index: Number(attempt.scene_index || 0),
    status: statusMap[String(attempt.status || "").toLowerCase()] || "queued",
    requested_by: String(attempt.provider || "atomic_cli"),
    attempts: Number(attempt.attempt_no || 0),
    error_message: String(attempt.error_message || ""),
    created_at: attempt.created_at || null,
    started_at: attempt.started_at || null,
    ended_at: attempt.ended_at || null,
    updated_at: attempt.updated_at || null,
  };
}

function summarizeGenerationScenes(scenes) {
  const summary = {
    total: 0,
    text_ready: 0,
    text_failed: 0,
    images_success: 0,
    images_failed: 0,
    images_pending: 0,
    images_running: 0,
    selected: 0,
    ready_for_publish: 0,
    deleted: 0,
  };

  for (const scene of scenes) {
    summary.total += 1;
    if (scene.deleted_at || scene.text_status === "deleted") {
      summary.deleted += 1;
      continue;
    }

    if (scene.text_status === "ready") {
      summary.text_ready += 1;
    } else if (scene.text_status === "failed") {
      summary.text_failed += 1;
    }

    if (scene.image_status === "success") {
      summary.images_success += 1;
    } else if (scene.image_status === "failed" || scene.image_status === "skipped") {
      summary.images_failed += 1;
    } else if (scene.image_status === "running" || scene.image_status === "queued") {
      summary.images_running += 1;
    } else {
      summary.images_pending += 1;
    }

    if (scene.selected) {
      summary.selected += 1;
      if (scene.image_status === "success") {
        summary.ready_for_publish += 1;
      }
    }
  }

  return summary;
}

function serializeGenerationSceneAsLegacyCandidate(scene) {
  return {
    run_id: scene.run_id,
    scene_index: scene.scene_index,
    scene_id: scene.scene_id,
    title: scene.title,
    description: scene.description,
    story_text: scene.story_text,
    image_prompt: scene.image_prompt,
    mood: scene.mood,
    characters: scene.characters,
    grid_rows: scene.grid_rows,
    grid_cols: scene.grid_cols,
    time_limit_sec: scene.time_limit_sec,
    image_status: scene.image_status === "running" || scene.image_status === "queued" ? "pending" : scene.image_status,
    image_url: scene.image_url,
    image_path: scene.image_path,
    error_message: scene.error_message,
    selected: scene.selected,
    created_at: scene.created_at,
    updated_at: scene.updated_at,
  };
}

function summarizeLegacyCandidateCountsFromScenes(sceneSummary) {
  return {
    total: Number(sceneSummary.total || 0) - Number(sceneSummary.deleted || 0),
    success: Number(sceneSummary.images_success || 0),
    failed: Number(sceneSummary.images_failed || 0),
    pending: Number(sceneSummary.images_pending || 0) + Number(sceneSummary.images_running || 0),
    selected: Number(sceneSummary.selected || 0),
    ready_for_publish: Number(sceneSummary.ready_for_publish || 0),
  };
}

function refreshGenerationRunState(runId) {
  const existing = getGenerationJobByRunId(runId);
  if (!existing) {
    return null;
  }

  if (normalizeGenerationReviewStatus(existing.review_status) === "published") {
    db.prepare(
      `
      UPDATE generation_jobs
      SET status = 'succeeded',
          flow_stage = 'published',
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(nowIso(), runId);
    return getGenerationJobByRunId(runId);
  }

  const scenes = listGenerationScenes(runId, { include_deleted: true });
  const activeScenes = scenes.filter((scene) => !scene.deleted_at && scene.text_status !== "deleted");
  const now = nowIso();

  let nextFlowStage = normalizeGenerationFlowStage(existing.flow_stage);
  let nextStatus = String(existing.status || "running");
  let nextReviewStatus = normalizeGenerationReviewStatus(existing.review_status);
  let nextEndedAt = existing.ended_at || null;

  if (activeScenes.length === 0) {
    nextFlowStage = "text_ready";
    nextStatus = "running";
    nextReviewStatus = "";
    nextEndedAt = null;
  } else if (activeScenes.some((scene) => scene.text_status === "pending")) {
    nextFlowStage = "text_generating";
    nextStatus = "running";
    nextReviewStatus = "";
    nextEndedAt = null;
  } else if (activeScenes.some((scene) => scene.image_status === "running" || scene.image_status === "queued")) {
    nextFlowStage = "images_generating";
    nextStatus = "running";
    nextReviewStatus = "";
    nextEndedAt = null;
  } else if (activeScenes.some((scene) => scene.image_status === "pending")) {
    nextFlowStage = "text_ready";
    nextStatus = "running";
    nextReviewStatus = "";
    nextEndedAt = null;
  } else {
    nextFlowStage = "review_ready";
    nextStatus = "succeeded";
    nextReviewStatus = "pending_review";
    nextEndedAt = existing.ended_at || now;
  }

  db.prepare(
    `
    UPDATE generation_jobs
    SET status = ?,
        review_status = ?,
        flow_stage = ?,
        ended_at = ?,
        updated_at = ?
    WHERE run_id = ?
  `,
  ).run(nextStatus, nextReviewStatus, nextFlowStage, nextEndedAt, now, runId);

  return getGenerationJobByRunId(runId);
}

function createOrUpdateAtomicGenerationRun({
  runId,
  requestedBy,
  targetDate,
  storyFile,
  payload,
  logFile,
  eventLogFile,
  summaryPath,
}) {
  const now = nowIso();
  const existing = getGenerationJobByRunId(runId);

  const normalizedPayload = payload && typeof payload === "object" ? payload : {};
  const payloadJson = JSON.stringify(normalizedPayload);

  if (!existing) {
    db.prepare(
      `
      INSERT INTO generation_jobs (
        run_id, status, review_status, flow_stage,
        requested_by, target_date, story_file, dry_run,
        payload_json, log_file, event_log_file, summary_path,
        published_at, error_message, exit_code,
        created_at, started_at, ended_at, updated_at
      ) VALUES (?, 'running', '', 'text_generating', ?, ?, ?, 0, ?, ?, ?, ?, NULL, '', NULL, ?, ?, NULL, ?)
    `,
    ).run(
      runId,
      requestedBy,
      targetDate,
      storyFile || "",
      payloadJson,
      logFile,
      eventLogFile,
      summaryPath,
      now,
      now,
      now,
    );

    upsertGenerationJobMetaOnEnqueue({
      runId,
      requestedBy,
      payload: normalizedPayload,
      createdAt: now,
    });
  } else {
    db.prepare(
      `
      UPDATE generation_jobs
      SET status = 'running',
          review_status = CASE WHEN review_status = 'published' THEN 'published' ELSE '' END,
          flow_stage = CASE WHEN review_status = 'published' THEN 'published' ELSE 'text_generating' END,
          requested_by = COALESCE(NULLIF(?, ''), requested_by),
          target_date = ?,
          story_file = ?,
          payload_json = ?,
          log_file = ?,
          event_log_file = ?,
          summary_path = ?,
          error_message = '',
          exit_code = NULL,
          published_at = CASE WHEN review_status = 'published' THEN published_at ELSE NULL END,
          started_at = COALESCE(started_at, ?),
          ended_at = NULL,
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(
      requestedBy,
      targetDate,
      storyFile || "",
      payloadJson,
      logFile,
      eventLogFile,
      summaryPath,
      now,
      now,
      runId,
    );

    upsertGenerationJobMetaOnEnqueue({
      runId,
      requestedBy: requestedBy || existing.requested_by,
      payload: normalizedPayload,
      createdAt: existing.created_at || now,
    });
  }

  return getGenerationJobByRunId(runId);
}

function ensureGenerationRunWritable(runId) {
  const job = getGenerationJobByRunId(runId);
  if (!job) {
    return { job: null, message: "run_id 不存在", status: 404 };
  }

  if (normalizeGenerationReviewStatus(job.review_status) === "published") {
    const publishedAtHint = job.published_at ? `（${job.published_at}）` : "";
    return {
      job,
      message: `该任务已发布${publishedAtHint}，当前页面只读`,
      status: 409,
    };
  }

  return { job, message: "", status: 200 };
}

function getGenerationSceneByIndex(runId, sceneIndex, options = {}) {
  const includeDeleted = normalizeBoolean(options.include_deleted);
  try {
    const row = db
      .prepare(
        `
        SELECT run_id, scene_index, scene_id,
               title, description, story_text,
               image_prompt, mood, characters_json,
               grid_rows, grid_cols, time_limit_sec,
               text_status, image_status,
               image_url, image_path, error_message,
               selected, deleted_at, source_kind,
               created_at, updated_at
        FROM generation_job_scenes
        WHERE run_id = ?
          AND scene_index = ?
          ${includeDeleted ? "" : "AND deleted_at IS NULL"}
        LIMIT 1
      `,
      )
      .get(runId, sceneIndex);

    return serializeGenerationSceneRow(row);
  } catch {
    return null;
  }
}

function replaceGenerationScenes(runId, scenes, sourceKind = "pipeline") {
  const normalizedSourceKind = normalizeGenerationSceneSourceKind(sourceKind);
  const now = nowIso();

  const tx = db.transaction((inputScenes) => {
    db.prepare("DELETE FROM generation_job_scene_image_attempts WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM generation_job_scenes WHERE run_id = ?").run(runId);

    const insert = db.prepare(
      `
      INSERT INTO generation_job_scenes (
        run_id,
        scene_index,
        scene_id,
        title,
        description,
        story_text,
        image_prompt,
        mood,
        characters_json,
        grid_rows,
        grid_cols,
        time_limit_sec,
        text_status,
        image_status,
        image_url,
        image_path,
        error_message,
        selected,
        deleted_at,
        source_kind,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `,
    );

    for (const scene of inputScenes) {
      const sceneIndex = normalizePositiveInteger(scene.scene_index);
      if (!sceneIndex) {
        continue;
      }

      const textStatus = normalizeGenerationSceneTextStatus(scene.text_status || "ready");
      const imageStatus = normalizeGenerationSceneImageStatus(scene.image_status || "pending");
      insert.run(
        runId,
        sceneIndex,
        normalizePositiveInteger(scene.scene_id),
        String(scene.title || "").trim(),
        String(scene.description || "").trim(),
        String(scene.story_text || "").trim(),
        String(scene.image_prompt || "").trim(),
        String(scene.mood || "").trim(),
        JSON.stringify(normalizeGenerationSceneCharacters(scene.characters)),
        normalizeIntegerInRange(scene.grid_rows, 2, 20) || 6,
        normalizeIntegerInRange(scene.grid_cols, 2, 20) || 4,
        normalizeIntegerInRange(scene.time_limit_sec, 30, 3600) || 180,
        textStatus,
        imageStatus,
        String(scene.image_url || "").trim(),
        String(scene.image_path || "").trim(),
        String(scene.error_message || "").trim(),
        normalizeBoolean(scene.selected) ? 1 : 0,
        normalizedSourceKind,
        now,
        now,
      );
    }
  });

  tx(scenes);
  return listGenerationScenes(runId, { include_deleted: false });
}

function mapLegacyCandidateToSceneRow(candidate) {
  const imageStatus = normalizeGenerationSceneImageStatus(candidate?.image_status);
  const title = String(candidate?.title || "").trim();
  const storyText = String(candidate?.story_text || "").trim();
  const imagePrompt = String(candidate?.image_prompt || "").trim();

  return {
    scene_index: normalizePositiveInteger(candidate?.scene_index) || 0,
    scene_id: normalizePositiveInteger(candidate?.scene_id) || normalizePositiveInteger(candidate?.scene_index) || null,
    title,
    description: String(candidate?.description || "").trim(),
    story_text: storyText,
    image_prompt: imagePrompt,
    mood: String(candidate?.mood || "").trim(),
    characters: normalizeGenerationSceneCharacters(candidate?.characters),
    grid_rows: normalizeIntegerInRange(candidate?.grid_rows, 2, 20) || 6,
    grid_cols: normalizeIntegerInRange(candidate?.grid_cols, 2, 20) || 4,
    time_limit_sec: normalizeIntegerInRange(candidate?.time_limit_sec, 30, 3600) || 180,
    text_status: (title || storyText || imagePrompt) ? "ready" : "pending",
    image_status: imageStatus,
    image_url: String(candidate?.image_url || "").trim(),
    image_path: String(candidate?.image_path || "").trim(),
    error_message: String(candidate?.error_message || "").trim(),
    selected: normalizeBoolean(candidate?.selected) && imageStatus === "success",
  };
}

function materializeGenerationScenesFromLegacy(runId, job = null) {
  if (!runId || hasGenerationSceneRows(runId)) {
    return { materialized: false, count: 0 };
  }

  let legacyCandidates = listGenerationJobCandidates(runId);
  if (legacyCandidates.length === 0 && job && job.status === "succeeded") {
    syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
    legacyCandidates = listGenerationJobCandidates(runId);
  }

  if (legacyCandidates.length === 0) {
    return { materialized: false, count: 0 };
  }

  const scenes = legacyCandidates
    .map((item) => mapLegacyCandidateToSceneRow(item))
    .filter((item) => Number.isInteger(item.scene_index) && item.scene_index > 0);

  if (scenes.length === 0) {
    return { materialized: false, count: 0 };
  }

  replaceGenerationScenes(runId, scenes, "legacy");
  refreshGenerationRunState(runId);

  return { materialized: true, count: scenes.length };
}

function cancelGenerationRun(runId, reason = "cancelled by admin") {
  const tx = db.transaction(() => {
    const now = nowIso();
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      return null;
    }

    const flowStage = normalizeGenerationFlowStage(job.flow_stage);
    const reviewStatus = normalizeGenerationReviewStatus(job.review_status);
    if (reviewStatus === "published" || flowStage === "published") {
      throw new Error("已发布任务不允许取消");
    }

    if (job.status === "cancelled") {
      return getGenerationJobByRunId(runId);
    }

    db.prepare(
      `
      UPDATE generation_job_scene_image_attempts
      SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          error_message = CASE
            WHEN status IN ('queued', 'running') AND COALESCE(trim(error_message), '') = '' THEN ?
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(reason, now, now, runId);

    db.prepare(
      `
      UPDATE generation_job_scenes
      SET image_status = CASE
            WHEN image_status IN ('queued', 'running') THEN 'skipped'
            ELSE image_status
          END,
          selected = CASE
            WHEN image_status IN ('queued', 'running') THEN 0
            ELSE selected
          END,
          error_message = CASE
            WHEN image_status IN ('queued', 'running') THEN ?
            ELSE error_message
          END,
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(reason, now, runId);

    db.prepare(
      `
      UPDATE generation_candidate_image_retries
      SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          error_message = CASE
            WHEN status IN ('queued', 'running') AND COALESCE(trim(error_message), '') = '' THEN ?
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(reason, now, now, runId);

    db.prepare(
      `
      UPDATE generation_jobs
      SET status = 'cancelled',
          review_status = '',
          flow_stage = 'failed',
          error_message = CASE
            WHEN COALESCE(trim(error_message), '') = '' THEN ?
            ELSE error_message
          END,
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(reason, now, now, runId);

    return getGenerationJobByRunId(runId);
  });

  return tx();
}

function deleteGenerationRun(runId, options = {}) {
  const force = normalizeBoolean(options.force);
  const allowPublished = normalizeBoolean(options.allow_published);
  const purgeFiles = normalizeBoolean(options.purge_files);

  const tx = db.transaction(() => {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      return { deleted: false, job: null, removed_files: [] };
    }

    const reviewStatus = normalizeGenerationReviewStatus(job.review_status);
    const flowStage = normalizeGenerationFlowStage(job.flow_stage);
    if ((reviewStatus === "published" || flowStage === "published") && !allowPublished) {
      throw new Error("已发布任务默认不允许删除，请显式传 allow_published=true");
    }

    if (job.status === "running" && !force) {
      throw new Error("运行中任务不允许直接删除，请先取消或传 force=true");
    }

    db.prepare("DELETE FROM generation_job_scene_image_attempts WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM generation_job_scenes WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM generation_candidate_image_retries WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM generation_job_level_candidates WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM generation_job_meta WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM generation_jobs WHERE run_id = ?").run(runId);

    const removedFiles = [];
    if (purgeFiles) {
      const candidates = [job.log_file, job.event_log_file, job.summary_path]
        .map((item) => String(item || "").trim())
        .filter((item) => item.length > 0);

      for (const filePath of candidates) {
        try {
          const normalized = path.normalize(filePath);
          if (!normalized.startsWith(path.normalize(ROOT_DIR))) {
            continue;
          }
          if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
            fs.rmSync(normalized, { force: true });
            removedFiles.push(normalized);
          }
        } catch {
          // ignore file purge errors
        }
      }
    }

    return { deleted: true, job, removed_files: removedFiles };
  });

  return tx();
}

function nextGenerationSceneAttemptNo(runId, sceneIndex) {
  const row = db
    .prepare(
      `
      SELECT MAX(attempt_no) AS max_attempt_no
      FROM generation_job_scene_image_attempts
      WHERE run_id = ? AND scene_index = ?
    `,
    )
    .get(runId, sceneIndex);

  const current = Number(row?.max_attempt_no || 0);
  return Number.isInteger(current) && current > 0 ? current + 1 : 1;
}

function createGenerationSceneImageAttempt({
  runId,
  sceneIndex,
  provider,
  model,
  imagePrompt,
}) {
  const attemptNo = nextGenerationSceneAttemptNo(runId, sceneIndex);
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO generation_job_scene_image_attempts (
      run_id,
      scene_index,
      attempt_no,
      status,
      provider,
      model,
      image_prompt,
      error_message,
      created_at,
      started_at,
      updated_at
    ) VALUES (?, ?, ?, 'running', ?, ?, ?, '', ?, ?, ?)
  `,
  ).run(
    runId,
    sceneIndex,
    attemptNo,
    String(provider || "").trim(),
    String(model || "").trim(),
    String(imagePrompt || "").trim(),
    now,
    now,
    now,
  );

  return db
    .prepare(
      `
      SELECT id, run_id, scene_index, attempt_no, status,
             provider, model, image_prompt,
             image_url, image_path, error_message,
             latency_ms, created_at, started_at, ended_at, updated_at
      FROM generation_job_scene_image_attempts
      WHERE run_id = ? AND scene_index = ? AND attempt_no = ?
      LIMIT 1
    `,
    )
    .get(runId, sceneIndex, attemptNo);
}

function finalizeGenerationSceneImageAttempt({
  runId,
  sceneIndex,
  attemptNo,
  status,
  imageUrl,
  imagePath,
  errorMessage,
  latencyMs,
}) {
  const normalizedStatus = normalizeGenerationCandidateRetryStatus(status);
  const now = nowIso();

  db.prepare(
    `
    UPDATE generation_job_scene_image_attempts
    SET status = ?,
        image_url = ?,
        image_path = ?,
        error_message = ?,
        latency_ms = ?,
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?
    WHERE run_id = ?
      AND scene_index = ?
      AND attempt_no = ?
  `,
  ).run(
    normalizedStatus,
    String(imageUrl || "").trim(),
    String(imagePath || "").trim(),
    String(errorMessage || "").trim(),
    Number.isFinite(Number(latencyMs)) ? Math.max(0, Math.floor(Number(latencyMs))) : null,
    now,
    now,
    runId,
    sceneIndex,
    attemptNo,
  );
}

function setGenerationSceneImageRunning(runId, sceneIndex) {
  db.prepare(
    `
    UPDATE generation_job_scenes
    SET image_status = 'running',
        error_message = '',
        updated_at = ?
    WHERE run_id = ? AND scene_index = ?
  `,
  ).run(nowIso(), runId, sceneIndex);
}

function setGenerationSceneImageResult({ runId, sceneIndex, status, imageUrl, imagePath, errorMessage }) {
  const normalizedImageStatus = normalizeGenerationSceneImageStatus(status);
  const now = nowIso();
  const normalizedPath = String(imagePath || "").trim();
  const normalizedUrl = String(imageUrl || "").trim();
  const resolvedImageUrl = normalizedUrl || resolveStoryAssetUrlFromFsPath(normalizedPath);

  db.prepare(
    `
    UPDATE generation_job_scenes
    SET image_status = ?,
        image_url = ?,
        image_path = ?,
        error_message = ?,
        selected = CASE
          WHEN ? = 'success' THEN selected
          ELSE 0
        END,
        updated_at = ?
    WHERE run_id = ? AND scene_index = ?
  `,
  ).run(
    normalizedImageStatus,
    resolvedImageUrl,
    normalizedPath,
    normalizedImageStatus === "success" ? "" : String(errorMessage || "").trim(),
    normalizedImageStatus,
    now,
    runId,
    sceneIndex,
  );
}

function enqueueGenerationJob({ runId, requestedBy, targetDate, storyFile, dryRun, payload, logFile, eventLogFile, summaryPath }) {
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO generation_jobs (
      run_id, status, review_status, flow_stage, requested_by, target_date, story_file, dry_run,
      payload_json, log_file, event_log_file, summary_path,
      published_at, error_message, exit_code, created_at, started_at, ended_at, updated_at
    ) VALUES (?, 'queued', '', 'text_generating', ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', NULL, ?, NULL, NULL, ?)
  `,
  ).run(
    runId,
    requestedBy,
    targetDate,
    storyFile || "",
    dryRun ? 1 : 0,
    JSON.stringify(payload),
    logFile,
    eventLogFile,
    summaryPath,
    now,
    now,
  );

  upsertGenerationJobMetaOnEnqueue({
    runId,
    requestedBy,
    payload,
    createdAt: now,
  });

  cleanupGenerationJobs();
}

function upsertGenerationJobMetaOnEnqueue({ runId, requestedBy, payload, createdAt }) {
  try {
    const requestedByUser = db
      .prepare("SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1")
      .get(String(requestedBy || "").trim());

    const chapterId = normalizePositiveInteger(payload?.chapter_id) || null;
    const bookId = normalizePositiveInteger(payload?.book_id) || null;
    const usageId = normalizePositiveInteger(payload?.usage_id) || null;
    const storyId = normalizeShortText(payload?.story_id) || null;
    const now = createdAt || nowIso();

    db.prepare(
      `
      INSERT INTO generation_job_meta (
        run_id,
        requested_by_user_id,
        chapter_id,
        book_id,
        usage_id,
        result_story_id,
        job_kind,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'story_generation', ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        requested_by_user_id = COALESCE(excluded.requested_by_user_id, generation_job_meta.requested_by_user_id),
        chapter_id = COALESCE(excluded.chapter_id, generation_job_meta.chapter_id),
        book_id = COALESCE(excluded.book_id, generation_job_meta.book_id),
        usage_id = COALESCE(excluded.usage_id, generation_job_meta.usage_id),
        result_story_id = CASE
          WHEN COALESCE(excluded.result_story_id, '') <> '' THEN excluded.result_story_id
          ELSE generation_job_meta.result_story_id
        END,
        updated_at = excluded.updated_at
    `,
    ).run(
      runId,
      Number.isInteger(requestedByUser?.id) ? Number(requestedByUser.id) : null,
      chapterId,
      bookId,
      usageId,
      storyId,
      now,
      now,
    );
  } catch {
    // ignore meta sync errors to keep main queue flow available
  }
}

function upsertGenerationJobMetaOnComplete({ runId, status, storyId, updatedAt }) {
  try {
    const normalizedStatus = String(status || "").trim();
    if (normalizedStatus !== "succeeded") {
      return;
    }

    let resolvedStoryId = normalizeShortText(storyId);
    if (!resolvedStoryId) {
      const row = db
        .prepare("SELECT payload_json FROM generation_jobs WHERE run_id = ? LIMIT 1")
        .get(runId);
      const payload = safeParseJsonObject(row?.payload_json);
      resolvedStoryId = normalizeShortText(payload?.story_id);
    }

    if (!resolvedStoryId) {
      return;
    }

    db.prepare(
      `
      UPDATE generation_job_meta
      SET result_story_id = ?,
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(resolvedStoryId, updatedAt || nowIso(), runId);
  } catch {
    // ignore meta sync errors to keep main queue flow available
  }
}

function claimGenerationJob() {
  const now = nowIso();
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
      )
      .get();

    if (!row) {
      return null;
    }

    const updated = db
      .prepare(
        `
        UPDATE generation_jobs
        SET status = 'running',
            flow_stage = 'images_generating',
            started_at = COALESCE(started_at, ?),
            error_message = '',
            exit_code = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'queued'
      `,
      )
      .run(now, now, row.id);

    if (updated.changes !== 1) {
      return null;
    }

    const claimed = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE id = ?
      `,
      )
      .get(row.id);

    return claimed ? serializeGenerationJobRow(claimed, true) : null;
  });

  return tx();
}

function completeGenerationJobByRunId(runId, {
  status,
  exitCode,
  errorMessage,
  storyId,
  reviewStatus,
}) {
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE run_id = ?
      `,
      )
      .get(runId);

    if (!existing) {
      return null;
    }

    if (existing.status === "queued" || existing.status === "running") {
      const now = nowIso();
      const payload = safeParseJsonObject(existing.payload_json);
      const reviewMode = isReviewModePayload(payload, Boolean(existing.dry_run));
      const existingReviewStatus = normalizeGenerationReviewStatus(existing.review_status);

      let nextReviewStatus = existingReviewStatus;
      let nextPublishedAt = existing.published_at || null;
      let nextFlowStage = normalizeGenerationFlowStage(existing.flow_stage) || "text_generating";

      if (status !== "succeeded") {
        if (existingReviewStatus !== "published") {
          nextReviewStatus = "";
          nextPublishedAt = null;
        }
        nextFlowStage = "failed";
      } else if (existingReviewStatus === "published") {
        nextReviewStatus = "published";
        nextPublishedAt = existing.published_at || now;
        nextFlowStage = "published";
      } else if (reviewMode) {
        const requestedReviewStatus = normalizeGenerationReviewStatus(reviewStatus);
        nextReviewStatus = requestedReviewStatus || "pending_review";
        nextPublishedAt = nextReviewStatus === "published" ? (existing.published_at || now) : null;
        nextFlowStage = nextReviewStatus === "published" ? "published" : "review_ready";
      } else {
        nextReviewStatus = "";
        nextPublishedAt = null;
        nextFlowStage = "published";
      }

      db.prepare(
        `
        UPDATE generation_jobs
        SET status = ?,
            review_status = ?,
            flow_stage = ?,
            exit_code = ?,
            error_message = ?,
            published_at = ?,
            ended_at = COALESCE(ended_at, ?),
            updated_at = ?
        WHERE run_id = ?
      `,
      ).run(status, nextReviewStatus, nextFlowStage, exitCode, errorMessage, nextPublishedAt, now, now, runId);

      upsertGenerationJobMetaOnComplete({
        runId,
        status,
        storyId,
        updatedAt: now,
      });

      if (status === "succeeded") {
        syncGenerationJobCandidatesFromSummary(runId, existing.summary_path);
      }
    }

    const latest = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE run_id = ?
      `,
      )
      .get(runId);

    return latest ? serializeGenerationJobRow(latest, true) : null;
  });

  return tx();
}

function normalizeCandidateImageStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "success" || text === "failed" || text === "skipped") {
    return text;
  }
  return "pending";
}

function normalizeCandidateCharacters(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0)
    .slice(0, 20);
}

function normalizeGenerationCandidate(rawCandidate, fallbackIndex) {
  const sceneIndex = normalizePositiveInteger(rawCandidate?.scene_index) || fallbackIndex;
  const sceneId = normalizePositiveInteger(rawCandidate?.scene_id) || null;
  const imageStatus = normalizeCandidateImageStatus(rawCandidate?.image_status);
  const selectedRaw = rawCandidate?.selected;
  const selected = selectedRaw === undefined
    ? imageStatus === "success"
    : normalizeBoolean(selectedRaw);

  return {
    scene_index: sceneIndex,
    scene_id: sceneId,
    title: String(rawCandidate?.title || "").trim(),
    description: String(rawCandidate?.description || "").trim(),
    story_text: String(rawCandidate?.story_text || "").trim(),
    image_prompt: String(rawCandidate?.image_prompt || "").trim(),
    mood: String(rawCandidate?.mood || "").trim(),
    characters: normalizeCandidateCharacters(rawCandidate?.characters),
    grid_rows: normalizeIntegerInRange(rawCandidate?.grid_rows, 2, 20) || 6,
    grid_cols: normalizeIntegerInRange(rawCandidate?.grid_cols, 2, 20) || 4,
    time_limit_sec: normalizeIntegerInRange(rawCandidate?.time_limit_sec, 30, 3600) || 180,
    image_status: imageStatus,
    image_url: String(rawCandidate?.image_url || "").trim(),
    image_path: String(rawCandidate?.image_path || "").trim(),
    error_message: String(rawCandidate?.error_message || "").trim(),
    selected,
  };
}

function parseSceneIdFromLevelId(levelId, fallbackIndex) {
  const text = String(levelId || "").trim();
  if (!text) {
    return fallbackIndex;
  }

  const matched = text.match(/_(\d+)$/);
  if (!matched) {
    return fallbackIndex;
  }

  const parsed = normalizePositiveInteger(matched[1]);
  return parsed || fallbackIndex;
}

function resolveLegacyReviewManifestPath(summary) {
  const publishManifest = String(summary?.publish?.manifest || "").trim();
  if (publishManifest && fs.existsSync(publishManifest) && fs.statSync(publishManifest).isFile()) {
    return path.normalize(publishManifest);
  }

  const publishStoryId = normalizeGeneratedStoryId(summary?.publish?.story_id);
  const summaryStoryId = normalizeGeneratedStoryId(summary?.story_id);
  const targetStoryId = publishStoryId || summaryStoryId;
  if (!targetStoryId) {
    return "";
  }

  const manifestPath = path.join(STORIES_ROOT_DIR, targetStoryId, "story.json");
  if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
    return manifestPath;
  }

  return "";
}

function buildLegacyReviewCandidatesFromSummary(summary) {
  const manifestPath = resolveLegacyReviewManifestPath(summary);
  if (!manifestPath) {
    return [];
  }

  const manifestPayload = readJsonSafe(manifestPath);
  if (!manifestPayload || !Array.isArray(manifestPayload.levels) || manifestPayload.levels.length === 0) {
    return [];
  }

  const manifestDir = path.dirname(manifestPath);
  const normalizedManifestDir = path.normalize(manifestDir);
  const levels = manifestPayload.levels;

  return levels.map((level, index) => {
    const fallbackIndex = index + 1;
    const sourceImage = String(level?.source_image || "").trim();
    const relativeImagePath = sourceImage.replace(/^\/+/, "");

    let imagePath = "";
    if (relativeImagePath) {
      const resolvedImagePath = path.normalize(path.resolve(manifestDir, relativeImagePath));
      if (
        resolvedImagePath === normalizedManifestDir
        || resolvedImagePath.startsWith(`${normalizedManifestDir}${path.sep}`)
      ) {
        try {
          if (fs.existsSync(resolvedImagePath) && fs.statSync(resolvedImagePath).isFile()) {
            imagePath = resolvedImagePath;
          }
        } catch {
          imagePath = "";
        }
      }
    }

    const imageUrl = imagePath ? resolveStoryAssetUrlFromFsPath(imagePath) : "";
    const imageStatus = imagePath ? "success" : "failed";
    const gridRows = normalizeIntegerInRange(level?.grid?.rows, 2, 20) || 6;
    const gridCols = normalizeIntegerInRange(level?.grid?.cols, 2, 20) || 4;
    const timeLimitSec = normalizeIntegerInRange(level?.time_limit_sec, 30, 3600) || 180;

    return {
      scene_index: fallbackIndex,
      scene_id: parseSceneIdFromLevelId(level?.id, fallbackIndex),
      title: String(level?.title || "").trim(),
      description: String(level?.description || "").trim(),
      story_text: String(level?.story_text || "").trim(),
      image_prompt: "",
      mood: "",
      characters: [],
      grid_rows: gridRows,
      grid_cols: gridCols,
      time_limit_sec: timeLimitSec,
      image_status: imageStatus,
      image_url: imageUrl,
      image_path: imagePath,
      error_message: imagePath ? "" : "legacy_manifest_image_missing",
      selected: Boolean(imagePath),
    };
  });
}

function syncGenerationJobCandidatesFromSummary(runId, summaryPath) {
  const summary = readJsonSafe(summaryPath);
  if (!summary) {
    return { upserted: 0 };
  }

  const rawCandidates = Array.isArray(summary.candidates) && summary.candidates.length > 0
    ? summary.candidates
    : buildLegacyReviewCandidatesFromSummary(summary);

  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    return { upserted: 0 };
  }

  const candidates = rawCandidates
    .map((item, index) => normalizeGenerationCandidate(item, index + 1))
    .filter((item) => Number.isInteger(item.scene_index) && item.scene_index > 0);

  if (candidates.length === 0) {
    return { upserted: 0 };
  }

  const now = nowIso();
  try {
    const insert = db.prepare(
      `
      INSERT OR IGNORE INTO generation_job_level_candidates (
        run_id,
        scene_index,
        scene_id,
        title,
        description,
        story_text,
        image_prompt,
        mood,
        characters_json,
        grid_rows,
        grid_cols,
        time_limit_sec,
        image_status,
        image_url,
        image_path,
        error_message,
        selected,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );

    const tx = db.transaction((items) => {
      let inserted = 0;
      for (const item of items) {
        const result = insert.run(
          runId,
          item.scene_index,
          item.scene_id,
          item.title,
          item.description,
          item.story_text,
          item.image_prompt,
          item.mood,
          JSON.stringify(item.characters),
          item.grid_rows,
          item.grid_cols,
          item.time_limit_sec,
          item.image_status,
          item.image_url,
          item.image_path,
          item.error_message,
          item.selected ? 1 : 0,
          now,
          now,
        );
        inserted += Number(result?.changes || 0);
      }

      return inserted;
    });

    const inserted = tx(candidates);
    return { upserted: inserted };
  } catch {
    return { upserted: 0 };
  }
}

function listGenerationJobCandidates(runId) {
  try {
    const rows = db
      .prepare(
        `
        SELECT run_id, scene_index, scene_id, title, description, story_text,
               image_prompt, mood, characters_json, grid_rows, grid_cols,
               time_limit_sec, image_status, image_url, image_path,
               error_message, selected, created_at, updated_at
        FROM generation_job_level_candidates
        WHERE run_id = ?
        ORDER BY scene_index ASC
      `,
      )
      .all(runId);

    return rows.map((row) => ({
      run_id: row.run_id,
      scene_index: Number(row.scene_index),
      scene_id: row.scene_id === null || row.scene_id === undefined ? null : Number(row.scene_id),
      title: String(row.title || ""),
      description: String(row.description || ""),
      story_text: String(row.story_text || ""),
      image_prompt: String(row.image_prompt || ""),
      mood: String(row.mood || ""),
      characters: safeParseJsonArray(row.characters_json),
      grid_rows: Number(row.grid_rows || 6),
      grid_cols: Number(row.grid_cols || 4),
      time_limit_sec: Number(row.time_limit_sec || 180),
      image_status: String(row.image_status || "pending"),
      image_url: String(row.image_url || ""),
      image_path: String(row.image_path || ""),
      error_message: String(row.error_message || ""),
      selected: Boolean(row.selected),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    }));
  } catch {
    return [];
  }
}

function summarizeGenerationCandidates(candidates) {
  const summary = {
    total: 0,
    success: 0,
    failed: 0,
    pending: 0,
    selected: 0,
    ready_for_publish: 0,
  };

  for (const item of candidates) {
    summary.total += 1;
    if (item.image_status === "success") {
      summary.success += 1;
    } else if (item.image_status === "failed" || item.image_status === "skipped") {
      summary.failed += 1;
    } else {
      summary.pending += 1;
    }

    if (item.selected) {
      summary.selected += 1;
      if (item.image_status === "success") {
        summary.ready_for_publish += 1;
      }
    }
  }

  return summary;
}

function updateGenerationJobCandidate({ runId, sceneIndex, selected, gridRows, gridCols }) {
  const existing = db
    .prepare(
      `
      SELECT run_id, scene_index, scene_id, title, description, story_text,
             image_prompt, mood, characters_json, grid_rows, grid_cols,
             time_limit_sec, image_status, image_url, image_path,
             error_message, selected, created_at, updated_at
      FROM generation_job_level_candidates
      WHERE run_id = ? AND scene_index = ?
    `,
    )
    .get(runId, sceneIndex);

  if (!existing) {
    return null;
  }

  const nextSelected = selected === null ? Boolean(existing.selected) : Boolean(selected);
  const nextGridRows = gridRows ?? Number(existing.grid_rows || 6);
  const nextGridCols = gridCols ?? Number(existing.grid_cols || 4);

  db.prepare(
    `
    UPDATE generation_job_level_candidates
    SET selected = ?,
        grid_rows = ?,
        grid_cols = ?,
        updated_at = ?
    WHERE run_id = ? AND scene_index = ?
  `,
  ).run(nextSelected ? 1 : 0, nextGridRows, nextGridCols, nowIso(), runId, sceneIndex);

  return listGenerationJobCandidates(runId).find((item) => item.scene_index === sceneIndex) || null;
}

function normalizeGenerationCandidateRetryStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "queued" || text === "running" || text === "succeeded" || text === "failed" || text === "cancelled") {
    return text;
  }
  return "queued";
}

function serializeGenerationCandidateRetryRow(row) {
  if (!row) {
    return null;
  }

  return {
    retry_id: Number(row.id),
    run_id: String(row.run_id || ""),
    scene_index: Number(row.scene_index || 0),
    status: normalizeGenerationCandidateRetryStatus(row.status),
    requested_by: String(row.requested_by || ""),
    attempts: Number(row.attempts || 0),
    error_message: String(row.error_message || ""),
    created_at: row.created_at || null,
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    updated_at: row.updated_at || null,
  };
}

function resolveStoryAssetUrlFromFsPath(filePath) {
  const normalizedPath = path.normalize(String(filePath || "").trim());
  if (!normalizedPath) {
    return "";
  }

  const normalizedStoriesRoot = path.normalize(STORIES_ROOT_DIR);
  if (normalizedPath !== normalizedStoriesRoot && !normalizedPath.startsWith(`${normalizedStoriesRoot}${path.sep}`)) {
    return "";
  }

  const relativePath = path.relative(normalizedStoriesRoot, normalizedPath);
  if (!relativePath || relativePath.startsWith("..")) {
    return "";
  }

  return `${STORY_PUBLIC_PREFIX}/${relativePath.split(path.sep).join("/")}`;
}

function enqueueGenerationCandidateImageRetry({ runId, sceneIndex, requestedBy }) {
  const now = nowIso();
  const tx = db.transaction(() => {
    const candidate = db
      .prepare(
        `
        SELECT run_id, scene_index, image_prompt
        FROM generation_job_level_candidates
        WHERE run_id = ? AND scene_index = ?
      `,
      )
      .get(runId, sceneIndex);

    if (!candidate) {
      throw new Error("候选关卡不存在");
    }

    if (!String(candidate.image_prompt || "").trim()) {
      throw new Error("候选关卡缺少 image_prompt");
    }

    db.prepare(
      `
      UPDATE generation_job_level_candidates
      SET image_status = 'pending',
          selected = 0,
          error_message = '',
          updated_at = ?
      WHERE run_id = ? AND scene_index = ?
    `,
    ).run(now, runId, sceneIndex);

    db.prepare(
      `
      UPDATE generation_candidate_image_retries
      SET status = 'cancelled',
          error_message = CASE
            WHEN COALESCE(trim(error_message), '') = '' THEN 'superseded by new retry request'
            ELSE error_message
          END,
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE run_id = ?
        AND scene_index = ?
        AND status IN ('queued', 'running')
    `,
    ).run(now, now, runId, sceneIndex);

    const inserted = db
      .prepare(
        `
        INSERT INTO generation_candidate_image_retries (
          run_id,
          scene_index,
          status,
          requested_by,
          attempts,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, 'queued', ?, 0, '', ?, ?)
      `,
      )
      .run(runId, sceneIndex, String(requestedBy || "").trim(), now, now);

    const retryId = Number(inserted.lastInsertRowid);
    const retryRow = db
      .prepare(
        `
        SELECT id, run_id, scene_index, status, requested_by, attempts, error_message,
               created_at, started_at, ended_at, updated_at
        FROM generation_candidate_image_retries
        WHERE id = ?
      `,
      )
      .get(retryId);

    return {
      retry_id: retryId,
      retry: serializeGenerationCandidateRetryRow(retryRow),
      candidate: listGenerationJobCandidates(runId).find((item) => item.scene_index === sceneIndex) || null,
    };
  });

  return tx();
}

function claimGenerationCandidateImageRetry() {
  const now = nowIso();
  const tx = db.transaction(() => {
    const queued = db
      .prepare(
        `
        SELECT id, run_id, scene_index
        FROM generation_candidate_image_retries
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
      )
      .get();

    if (!queued) {
      return null;
    }

    const updated = db
      .prepare(
        `
        UPDATE generation_candidate_image_retries
        SET status = 'running',
            attempts = attempts + 1,
            started_at = COALESCE(started_at, ?),
            error_message = '',
            updated_at = ?
        WHERE id = ?
          AND status = 'queued'
      `,
      )
      .run(now, now, queued.id);

    if (updated.changes !== 1) {
      return null;
    }

    const claimed = db
      .prepare(
        `
        SELECT r.id AS retry_id,
               r.run_id,
               r.scene_index,
               r.status,
               r.requested_by,
               r.attempts,
               r.error_message,
               r.created_at,
               r.started_at,
               r.ended_at,
               r.updated_at,
               c.scene_id,
               c.title,
               c.description,
               c.story_text,
               c.image_prompt,
               c.mood,
               c.characters_json,
               c.grid_rows,
               c.grid_cols,
               c.time_limit_sec,
               g.target_date,
               g.payload_json,
               g.event_log_file
        FROM generation_candidate_image_retries r
        JOIN generation_job_level_candidates c
          ON c.run_id = r.run_id
         AND c.scene_index = r.scene_index
        JOIN generation_jobs g
          ON g.run_id = r.run_id
        WHERE r.id = ?
        LIMIT 1
      `,
      )
      .get(queued.id);

    if (!claimed) {
      return null;
    }

    const payload = safeParseJsonObject(claimed.payload_json);
    const outputRoot = resolveProjectPath(
      payload.output_root || payload.story_output_root || payload.story_content_root,
      STORY_GENERATOR_OUTPUT_ROOT,
    );

    return {
      retry_id: Number(claimed.retry_id),
      run_id: String(claimed.run_id || ""),
      scene_index: Number(claimed.scene_index || 0),
      scene_id: Number(claimed.scene_id || claimed.scene_index || 0),
      title: String(claimed.title || ""),
      description: String(claimed.description || ""),
      story_text: String(claimed.story_text || ""),
      image_prompt: String(claimed.image_prompt || ""),
      mood: String(claimed.mood || ""),
      characters: safeParseJsonArray(claimed.characters_json),
      grid_rows: normalizeIntegerInRange(claimed.grid_rows, 2, 20) || 6,
      grid_cols: normalizeIntegerInRange(claimed.grid_cols, 2, 20) || 4,
      time_limit_sec: normalizeIntegerInRange(claimed.time_limit_sec, 30, 3600) || 180,
      target_date: String(claimed.target_date || ""),
      image_size: String(payload.image_size || "2K"),
      timeout_sec: normalizePositiveNumber(payload.timeout_sec) || 120,
      poll_seconds: normalizePositiveNumber(payload.poll_seconds) || 2.5,
      poll_attempts: normalizePositiveInteger(payload.poll_attempts) || 40,
      watermark: normalizeBoolean(payload.watermark),
      output_root: outputRoot,
      event_log_file: String(claimed.event_log_file || ""),
    };
  });

  return tx();
}

function completeGenerationCandidateImageRetry({ retryId, status, imageUrl, imagePath, errorMessage }) {
  const normalizedStatus = normalizeGenerationCandidateRetryStatus(status);
  if (!normalizedStatus || normalizedStatus === "queued" || normalizedStatus === "running") {
    throw new Error("重试任务状态不合法");
  }

  const now = nowIso();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `
        SELECT id, run_id, scene_index, status
        FROM generation_candidate_image_retries
        WHERE id = ?
      `,
      )
      .get(retryId);

    if (!existing) {
      return null;
    }

    const normalizedImagePath = String(imagePath || "").trim();
    const normalizedImageUrl = String(imageUrl || "").trim();
    const resolvedImageUrl = normalizedImageUrl || resolveStoryAssetUrlFromFsPath(normalizedImagePath);

    if (normalizedStatus === "succeeded") {
      if (!normalizedImagePath) {
        throw new Error("重试成功时缺少 image_path");
      }

      db.prepare(
        `
        UPDATE generation_job_level_candidates
        SET image_status = 'success',
            image_url = ?,
            image_path = ?,
            error_message = '',
            selected = 1,
            updated_at = ?
        WHERE run_id = ? AND scene_index = ?
      `,
      ).run(resolvedImageUrl, normalizedImagePath, now, existing.run_id, existing.scene_index);
    } else {
      db.prepare(
        `
        UPDATE generation_job_level_candidates
        SET image_status = 'failed',
            error_message = ?,
            selected = 0,
            updated_at = ?
        WHERE run_id = ? AND scene_index = ?
      `,
      ).run(errorMessage || "retry failed", now, existing.run_id, existing.scene_index);
    }

    db.prepare(
      `
      UPDATE generation_candidate_image_retries
      SET status = ?,
          error_message = ?,
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE id = ?
    `,
    ).run(normalizedStatus, normalizedStatus === "succeeded" ? "" : errorMessage, now, now, retryId);

    const retry = db
      .prepare(
        `
        SELECT id, run_id, scene_index, status, requested_by, attempts, error_message,
               created_at, started_at, ended_at, updated_at
        FROM generation_candidate_image_retries
        WHERE id = ?
      `,
      )
      .get(retryId);

    return {
      retry: serializeGenerationCandidateRetryRow(retry),
      candidate: listGenerationJobCandidates(existing.run_id).find((item) => item.scene_index === Number(existing.scene_index)) || null,
    };
  });

  return tx();
}

function normalizeGeneratedStoryId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized;
}

function resolveGenerationPublishStoryId({ runId, job, summary }) {
  const summaryStoryId = normalizeGeneratedStoryId(summary?.story_id);
  if (summaryStoryId) {
    return summaryStoryId;
  }

  const payloadStoryId = normalizeGeneratedStoryId(job?.payload?.story_id);
  if (payloadStoryId) {
    return payloadStoryId;
  }

  const dateStamp = String(job?.target_date || "")
    .replace(/[^0-9]/g, "")
    .slice(0, 8);
  const runPart = normalizeGeneratedStoryId(runId).slice(0, 24) || randomToken().slice(0, 6);
  return normalizeGeneratedStoryId(`story-${dateStamp || "unknown"}-${runPart}`) || `story-${Date.now()}`;
}

function resolveCandidateImageSourcePath(candidate) {
  const directPath = String(candidate?.image_path || "").trim();
  if (directPath) {
    try {
      const normalized = path.normalize(directPath);
      if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
        return normalized;
      }
    } catch {
      // fallback to image_url
    }
  }

  const imageUrl = String(candidate?.image_url || "").trim();
  if (imageUrl) {
    try {
      const fromUrl = resolveStoryAssetFsPath(imageUrl);
      if (fromUrl && fs.existsSync(fromUrl) && fs.statSync(fromUrl).isFile()) {
        return fromUrl;
      }
    } catch {
      return "";
    }
  }

  return "";
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomToken().slice(0, 6)}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function upsertStoryIndexEntry({
  indexFile,
  storyId,
  title,
  description,
  cover,
  manifest,
  bookId,
  bookTitle,
}) {
  let payload = { version: 1, stories: [] };
  if (fs.existsSync(indexFile)) {
    const existing = readJsonSafe(indexFile);
    if (existing && typeof existing === "object") {
      payload = {
        ...payload,
        ...existing,
      };
    }
  }

  const stories = Array.isArray(payload.stories) ? payload.stories.filter((item) => item && typeof item === "object") : [];
  const filteredStories = stories.filter((item) => String(item.id || "") !== storyId);
  const maxOrder = filteredStories.reduce((max, item) => {
    const order = Number(item.order);
    return Number.isFinite(order) ? Math.max(max, order) : max;
  }, 0);

  const entry = {
    id: storyId,
    title,
    description,
    cover,
    manifest,
    order: maxOrder + 1,
  };

  const normalizedBookId = normalizeStoryBookId(bookId);
  const normalizedBookTitle = normalizeShortText(bookTitle);
  if (normalizedBookId) {
    entry.book_id = normalizedBookId;
  }
  if (normalizedBookTitle) {
    entry.book_title = normalizedBookTitle;
  }

  filteredStories.push(entry);
  payload.version = Number(payload.version) || 1;
  payload.stories = filteredStories.sort((first, second) => {
    const firstOrder = Number.isFinite(Number(first.order)) ? Number(first.order) : Number.MAX_SAFE_INTEGER;
    const secondOrder = Number.isFinite(Number(second.order)) ? Number(second.order) : Number.MAX_SAFE_INTEGER;
    if (firstOrder !== secondOrder) {
      return firstOrder - secondOrder;
    }
    return String(first.id || "").localeCompare(String(second.id || ""));
  });

  writeJsonAtomic(indexFile, payload);
}

function appendRunEvent(eventLogFile, payload) {
  if (!eventLogFile) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(eventLogFile), { recursive: true });
    const line = JSON.stringify(payload);
    fs.appendFileSync(eventLogFile, `${line}\n`, "utf-8");
  } catch {
    // ignore event append failures
  }
}

function publishSelectedGenerationCandidates({ runId, job, summary, selectedCandidates }) {
  const sortedCandidates = [...selectedCandidates].sort((first, second) => first.scene_index - second.scene_index);
  if (sortedCandidates.length === 0) {
    throw new Error("没有可发布的候选关卡");
  }

  const missingSceneIndexes = [];
  const copiedScenes = [];
  const storyId = resolveGenerationPublishStoryId({ runId, job, summary });
  const stagingDir = path.join(STORY_GENERATOR_OUTPUT_ROOT, `.staging_${storyId}_${runId}`);
  const stagingImagesDir = path.join(stagingDir, "images");

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingImagesDir, { recursive: true });

  for (let index = 0; index < sortedCandidates.length; index += 1) {
    const candidate = sortedCandidates[index];
    const sourcePath = resolveCandidateImageSourcePath(candidate);
    if (!sourcePath) {
      missingSceneIndexes.push(candidate.scene_index);
      continue;
    }

    const ext = path.extname(sourcePath).toLowerCase();
    const safeExt = ext === ".jpg" || ext === ".jpeg" || ext === ".webp" ? ext : ".png";
    const fileName = `scene_${String(index + 1).padStart(3, "0")}${safeExt}`;
    const targetPath = path.join(stagingImagesDir, fileName);

    fs.copyFileSync(sourcePath, targetPath);
    copiedScenes.push({
      candidate,
      file_name: fileName,
      source_path: sourcePath,
    });
  }

  if (missingSceneIndexes.length > 0) {
    throw new Error(`候选图片缺失，scene_index=${missingSceneIndexes.join(", ")}`);
  }

  if (copiedScenes.length === 0) {
    throw new Error("没有可用图片可发布");
  }

  const firstImageName = copiedScenes[0].file_name;
  const coverExt = path.extname(firstImageName) || ".png";
  const coverName = `cover${coverExt}`;
  fs.copyFileSync(path.join(stagingImagesDir, firstImageName), path.join(stagingDir, coverName));

  const storyTitle = String(summary?.title || "").trim() || storyId;
  const storyDescription = String(summary?.description || "").trim();
  const overviewTitle = String(summary?.story_overview_title || "").trim();
  const overviewParagraphs = Array.isArray(summary?.story_overview_paragraphs)
    ? summary.story_overview_paragraphs.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
    : [];

  const levels = copiedScenes.map((item, index) => ({
    id: `${storyId}_${String(index + 1).padStart(2, "0")}`,
    title: item.candidate.title || `关卡 ${index + 1}`,
    description: item.candidate.description || item.candidate.title || `关卡 ${index + 1}`,
    story_text: item.candidate.story_text || item.candidate.description || item.candidate.title || "",
    grid: {
      rows: normalizeIntegerInRange(item.candidate.grid_rows, 2, 20) || 6,
      cols: normalizeIntegerInRange(item.candidate.grid_cols, 2, 20) || 4,
    },
    source_image: `images/${item.file_name}`,
    content_version: 1,
    time_limit_sec: normalizeIntegerInRange(item.candidate.time_limit_sec, 30, 3600) || 180,
    shuffle: {
      seed: 1000 + index + 1,
      mode: "grid_shuffle",
    },
    mobile: {
      preferred_orientation: "portrait",
      orientation_hint: "本关建议竖屏体验",
    },
  }));

  const manifestPayload = {
    id: storyId,
    title: storyTitle,
    description: storyDescription,
    cover: coverName,
    story_overview_title: overviewTitle,
    story_overview_paragraphs: overviewParagraphs,
    levels,
  };

  writeJsonAtomic(path.join(stagingDir, "story.json"), manifestPayload);

  const finalStoryDir = path.join(STORY_GENERATOR_OUTPUT_ROOT, storyId);
  fs.rmSync(finalStoryDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, finalStoryDir);

  const manifestUrl = `${STORY_PUBLIC_PREFIX}/${storyId}/story.json`;
  const coverUrl = `${STORY_PUBLIC_PREFIX}/${storyId}/${coverName}`;
  const indexFiles = [...new Set([STORY_INDEX_FILE, STORY_GENERATOR_INDEX_FILE].filter((item) => Boolean(item)))];

  for (const indexFile of indexFiles) {
    upsertStoryIndexEntry({
      indexFile,
      storyId,
      title: manifestPayload.title,
      description: manifestPayload.description,
      cover: coverUrl,
      manifest: manifestUrl,
      bookId: job?.payload?.book_id ?? summary?.book_id,
      bookTitle: job?.payload?.book_title ?? summary?.book_title,
    });
  }

  const now = nowIso();
  const nextPayload = {
    ...(job?.payload && typeof job.payload === "object" ? job.payload : {}),
    story_id: storyId,
    review_mode: true,
    published_at: now,
  };

  db.prepare(
    `
    UPDATE generation_jobs
    SET payload_json = ?,
        status = 'succeeded',
        review_status = 'published',
        flow_stage = 'published',
        published_at = COALESCE(published_at, ?),
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?
    WHERE run_id = ?
  `,
  ).run(JSON.stringify(nextPayload), now, now, now, runId);

  db.prepare(
    `
    INSERT INTO generation_job_meta (
      run_id,
      result_story_id,
      job_kind,
      created_at,
      updated_at
    ) VALUES (?, ?, 'story_generation', ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      result_story_id = excluded.result_story_id,
      updated_at = excluded.updated_at
  `,
  ).run(runId, storyId, now, now);

  if (job.summary_path) {
    const nextSummary = {
      ...(summary && typeof summary === "object" ? summary : {}),
      story_id: storyId,
      generated_scenes: levels.length,
      review_mode: true,
      review_status: "published",
      published_at: now,
      publish: {
        mode: "selected",
        story_id: storyId,
        story_dir: finalStoryDir,
        manifest: path.join(finalStoryDir, "story.json"),
        level_count: levels.length,
        selected_count: selectedCandidates.length,
        published_at: now,
      },
    };
    writeJsonAtomic(job.summary_path, nextSummary);
  }

  appendRunEvent(job.event_log_file, {
    ts: now,
    event: "publish.selected.completed",
    run_id: runId,
    story_id: storyId,
    level_count: levels.length,
    selected_count: selectedCandidates.length,
    manifest: manifestUrl,
  });

  return {
    story_id: storyId,
    manifest: manifestUrl,
    cover: coverUrl,
    level_count: levels.length,
    selected_count: selectedCandidates.length,
    published_at: now,
  };
}

function listGenerationJobs(limit = 50) {
  const rows = db
    .prepare(
      `
      SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
             review_status, flow_stage, log_file, event_log_file, summary_path,
             published_at, error_message, exit_code,
             created_at, started_at, ended_at, updated_at
      FROM generation_jobs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(limit);

  return rows.map(serializeGenerationJobRow);
}

function getGenerationJobByRunId(runId) {
  const row = db
    .prepare(
      `
      SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
             review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
             published_at, error_message, exit_code,
             created_at, started_at, ended_at, updated_at
      FROM generation_jobs
      WHERE run_id = ?
    `,
    )
    .get(runId);

  if (!row) {
    return null;
  }

  return serializeGenerationJobRow(row, true);
}

function serializeGenerationJobRow(row, includePayload = false) {
  const payload = includePayload ? safeParseJsonObject(row.payload_json) : undefined;
  const reviewStatus = normalizeGenerationReviewStatus(row.review_status);
  const flowStage = normalizeGenerationFlowStage(row.flow_stage);

  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    run_id: row.run_id,
    status: row.status,
    requested_by: row.requested_by,
    target_date: row.target_date,
    story_file: row.story_file || "",
    dry_run: Boolean(row.dry_run),
    review_status: reviewStatus,
    flow_stage: flowStage,
    log_file: row.log_file,
    event_log_file: row.event_log_file,
    summary_path: row.summary_path,
    published_at: row.published_at || null,
    error_message: row.error_message || "",
    exit_code: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    created_at: row.created_at,
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    updated_at: row.updated_at,
    ...(includePayload ? { payload } : {}),
  };
}

function safeParseJsonObject(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function safeParseJsonArray(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => String(item || "").trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getGeneratedChapterMap(chapterIds = []) {
  const wanted = new Set(
    chapterIds
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0),
  );
  const map = new Map();
  if (wanted.size === 0) {
    return map;
  }

  const rows = db
    .prepare(
      `
      SELECT run_id, payload_json, summary_path, created_at, ended_at
      FROM generation_jobs
      WHERE status = 'succeeded'
      ORDER BY COALESCE(ended_at, created_at) DESC, id DESC
    `,
    )
    .all();

  for (const row of rows) {
    const payload = safeParseJsonObject(row.payload_json);
    const chapterId = Number(payload.chapter_id);
    if (!Number.isInteger(chapterId) || chapterId <= 0) {
      continue;
    }
    if (!wanted.has(chapterId) || map.has(chapterId)) {
      continue;
    }

    const summary = readJsonSafe(row.summary_path);
    const summaryStoryId = summary && typeof summary.story_id === "string" ? summary.story_id : "";
    const payloadStoryId = typeof payload.story_id === "string" ? payload.story_id : "";

    map.set(chapterId, {
      run_id: String(row.run_id || ""),
      story_id: summaryStoryId || payloadStoryId || "",
      generated_at: row.ended_at || row.created_at || null,
    });

    if (map.size >= wanted.size) {
      break;
    }
  }

  return map;
}

function cleanupGenerationJobs() {
  const rows = db.prepare("SELECT id FROM generation_jobs ORDER BY created_at DESC, id DESC").all();
  if (rows.length <= MAX_GENERATION_JOBS) {
    return;
  }

  const keepIds = new Set(rows.slice(0, MAX_GENERATION_JOBS).map((item) => Number(item.id)));
  const removable = rows
    .slice(MAX_GENERATION_JOBS)
    .map((item) => Number(item.id))
    .filter((id) => !keepIds.has(id));

  if (removable.length === 0) {
    return;
  }

  const placeholders = removable.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM generation_jobs
      WHERE id IN (${placeholders})
        AND status NOT IN ('queued', 'running')`,
  ).run(...removable);
}

function markStaleGenerationJobsAsFailed(database) {
  const now = nowIso();
  database.prepare(
    `
    UPDATE generation_jobs
    SET status = 'failed',
        flow_stage = 'failed',
        error_message = CASE
          WHEN error_message IS NULL OR length(trim(error_message)) = 0 THEN 'worker interrupted before completion'
          ELSE error_message
        END,
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?
    WHERE status = 'running'
  `,
  ).run(now, now);
}

function readTailLines(filePath, limit = 80) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return [];
    }

    const lines = fs
      .readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return lines.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

function asMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}
