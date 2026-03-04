import crypto from "node:crypto";
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

const authRateBuckets = new Map();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(STORY_PUBLIC_PREFIX, express.static(STORIES_ROOT_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: nowIso() });
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
  const logFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.log`);
  const eventLogFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.events.jsonl`);
  const summaryPath = path.join(STORY_GENERATOR_SUMMARY_DIR, `story_${targetDate}.json`);

  const payload = {
    run_id: runId,
    target_date: targetDate,
    story_file: storyFile || "",
    dry_run: dryRun,
    output_root: STORY_GENERATOR_OUTPUT_ROOT,
    index_file: STORY_GENERATOR_INDEX_FILE,
    summary_output_dir: STORY_GENERATOR_SUMMARY_DIR,
    log_file: logFile,
    event_log_file: eventLogFile,
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

  try {
    const job = completeGenerationJobByRunId(runId, {
      status,
      exitCode,
      errorMessage,
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
    const summary = readJsonSafe(job.summary_path);

    res.json({
      ...job,
      events,
      log_tail: logTail,
      summary,
    });
  } catch (error) {
    res.status(500).json({ message: asMessage(error, "读取任务详情失败") });
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
        SELECT u.id, u.username, u.is_guest, u.created_at, u.last_login_at
        FROM users u
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

    stories.push({
      id: story.id,
      title: story.title,
      description: story.description,
      cover: story.cover,
      cover_missing: story.cover_missing,
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

    stories.push({
      id,
      title: typeof item.title === "string" ? item.title : "",
      description: typeof item.description === "string" ? item.description : "",
      cover: typeof item.cover === "string" ? item.cover : "",
      manifest,
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

  if (legacyTimeLimitSec) {
    return legacyTimeLimitSec;
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

  return clampInt(computed, activePolicy.min_seconds, activePolicy.max_seconds);
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

function normalizeGenerationJobStatus(value) {
  const text = String(value || "").trim();
  const allowed = new Set(["succeeded", "failed", "cancelled"]);
  return allowed.has(text) ? text : "";
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

function normalizeAttempts(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function enqueueGenerationJob({ runId, requestedBy, targetDate, storyFile, dryRun, payload, logFile, eventLogFile, summaryPath }) {
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO generation_jobs (
      run_id, status, requested_by, target_date, story_file, dry_run,
      payload_json, log_file, event_log_file, summary_path,
      error_message, exit_code, created_at, started_at, ended_at, updated_at
    ) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, NULL, NULL, ?)
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

  cleanupGenerationJobs();
}

function claimGenerationJob() {
  const now = nowIso();
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               payload_json, log_file, event_log_file, summary_path, error_message, exit_code,
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
               payload_json, log_file, event_log_file, summary_path, error_message, exit_code,
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

function completeGenerationJobByRunId(runId, { status, exitCode, errorMessage }) {
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               payload_json, log_file, event_log_file, summary_path, error_message, exit_code,
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
      db.prepare(
        `
        UPDATE generation_jobs
        SET status = ?,
            exit_code = ?,
            error_message = ?,
            ended_at = COALESCE(ended_at, ?),
            updated_at = ?
        WHERE run_id = ?
      `,
      ).run(status, exitCode, errorMessage, now, now, runId);
    }

    const latest = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               payload_json, log_file, event_log_file, summary_path, error_message, exit_code,
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

function listGenerationJobs(limit = 50) {
  const rows = db
    .prepare(
      `
      SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
             log_file, event_log_file, summary_path, error_message, exit_code,
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
             payload_json, log_file, event_log_file, summary_path, error_message, exit_code,
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

  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    run_id: row.run_id,
    status: row.status,
    requested_by: row.requested_by,
    target_date: row.target_date,
    story_file: row.story_file || "",
    dry_run: Boolean(row.dry_run),
    log_file: row.log_file,
    event_log_file: row.event_log_file,
    summary_path: row.summary_path,
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
