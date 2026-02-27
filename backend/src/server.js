import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const WEB_PUBLIC_DIR = path.join(ROOT_DIR, "web", "public");
const STORIES_ROOT_DIR = path.join(WEB_PUBLIC_DIR, "content", "stories");
const STORY_INDEX_FILE = path.join(STORIES_ROOT_DIR, "index.json");

const DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "puzzle_session";
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || "puzzle_csrf";
const CSRF_HEADER_NAME = String(process.env.CSRF_HEADER_NAME || "x-csrf-token").toLowerCase();
const SESSION_TTL_MS = resolveSessionTtlMs();
const COOKIE_SECURE = resolveCookieSecure();
const COOKIE_SAME_SITE = resolveCookieSameSite(COOKIE_SECURE);
const VALID_PROGRESS_STATUS = new Set(["not_started", "in_progress", "completed"]);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
initializeSchema(db);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: nowIso() });
});

app.post("/api/auth/register", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = normalizePassword(req.body?.password);

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
  const session = createSession(userId);
  setAuthCookies(res, session);

  res.status(201).json({
    user: {
      id: userId,
      username,
    },
  });
});

app.post("/api/auth/login", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = normalizePassword(req.body?.password);

  if (!username || !password) {
    res.status(400).json({ message: "用户名和密码不能为空" });
    return;
  }

  const user = db
    .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ message: "用户名或密码错误" });
    return;
  }

  const now = nowIso();
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, user.id);

  const session = createSession(user.id);
  setAuthCookies(res, session);

  res.json({
    user: {
      id: user.id,
      username: user.username,
    },
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
    user: {
      id: req.authUser.id,
      username: req.authUser.username,
    },
    refreshed_at: nowIso(),
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.authUser.id,
      username: req.authUser.username,
    },
  });
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

    migrateLegacyProgressForStory(req.authUser.id, story);
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

    migrateLegacyProgressForStory(req.authUser.id, story);
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

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_progress_user_story ON user_level_progress(user_id, story_id);
  `);

  ensureSessionColumns(database);
}

function ensureSessionColumns(database) {
  const columns = database.prepare("PRAGMA table_info(sessions)").all();
  const hasCsrfToken = columns.some((column) => column.name === "csrf_token");

  if (!hasCsrfToken) {
    database.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT");
  }

  database.prepare("DELETE FROM sessions WHERE csrf_token IS NULL OR length(csrf_token) = 0").run();
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
      SELECT u.id, u.username, s.token, s.csrf_token
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

    return decodeURIComponent(rawValue.join("=") || "");
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

  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, csrf_token) VALUES (?, ?, ?, ?, ?)").run(
    token,
    userId,
    createdAt,
    expiresAt,
    csrfToken,
  );

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

function pruneExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}


function listStoriesForUser(userId) {
  const catalog = loadStoryCatalog();
  const stories = [];

  for (const entry of catalog.stories) {
    const story = loadStoryById(entry.id);
    if (!story) {
      continue;
    }

    migrateLegacyProgressForStory(userId, story);

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
      "SELECT story_id, level_id, status, best_time_ms, best_moves, attempts, last_played_at, completed_at, save_state_json, content_version FROM user_level_progress WHERE user_id = ? AND story_id = ?",
    )
    .all(userId, story.id);

  const rowMap = new Map(rows.map((row) => [row.level_id, row]));
  const map = {};

  for (const level of story.levels) {
    const row = rowMap.get(level.id);
    if (!row) {
      continue;
    }

    const compatibleRow = ensureProgressCompatibility(userId, story.id, level, row);
    map[level.id] = serializeProgressRow(compatibleRow);
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
  const discovered = discoverStoryEntriesFromFolders();
  const indexEntries = loadStoryIndexEntries();

  const entriesById = new Map(discovered.map((entry) => [entry.id, entry]));

  for (const indexEntry of indexEntries) {
    if (!indexEntry.enabled) {
      entriesById.delete(indexEntry.id);
      continue;
    }

    const existing = entriesById.get(indexEntry.id);
    if (existing) {
      entriesById.set(indexEntry.id, {
        ...existing,
        title: indexEntry.title || existing.title,
        description: indexEntry.description || existing.description,
        cover: indexEntry.cover || existing.cover,
        manifest: indexEntry.manifest || existing.manifest,
        order: indexEntry.order,
      });
      continue;
    }

    if (!indexEntry.manifest) {
      continue;
    }

    entriesById.set(indexEntry.id, {
      id: indexEntry.id,
      title: indexEntry.title,
      description: indexEntry.description,
      cover: indexEntry.cover,
      manifest: indexEntry.manifest,
      order: indexEntry.order,
    });
  }

  const stories = [...entriesById.values()].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.id.localeCompare(b.id);
  });

  return {
    stories,
  };
}


function loadStoryById(storyId) {
  const catalog = loadStoryCatalog();
  const entry = catalog.stories.find((item) => item.id === storyId);
  if (!entry) {
    return null;
  }

  const manifestPath = resolveManifestFsPath(entry.manifest);
  const payload = readJson(manifestPath);

  const levelsRaw = Array.isArray(payload.levels) ? payload.levels : [];
  const levels = levelsRaw.map((level, index) => normalizeLevel(entry.manifest, level, index));

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


function normalizeLevel(manifestUrl, level, index) {
  const levelId = String(level?.id ?? `level_${String(index + 1).padStart(3, "0")}`);
  const sourceImage = normalizeAssetPath(manifestUrl, level?.source_image ?? level?.image);

  if (!sourceImage) {
    throw new Error(`关卡 ${levelId} 缺少图片配置`);
  }

  const rows = Number(level?.grid?.rows);
  const cols = Number(level?.grid?.cols);

  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
    throw new Error(`关卡 ${levelId} 的 grid 配置不合法`);
  }

  return {
    id: levelId,
    title: typeof level?.title === "string" ? level.title : levelId,
    description: typeof level?.description === "string" ? level.description : "",
    story_text: typeof level?.story_text === "string" ? level.story_text : undefined,
    grid: {
      rows,
      cols,
    },
    source_image: sourceImage,
    content_version: normalizeContentVersion(level?.content_version),
    legacy_ids: normalizeLegacyIds(level?.legacy_ids),
    asset_missing: !doesAssetExist(sourceImage),
    time_limit_sec: normalizePositiveInteger(level?.time_limit_sec),
    shuffle: level?.shuffle && typeof level.shuffle === "object" ? level.shuffle : undefined,
    audio: normalizeAudioMap(manifestUrl, level?.audio),
    mobile: level?.mobile && typeof level.mobile === "object" ? level.mobile : undefined,
  };
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
  if (!joined.startsWith("/content/stories/")) {
    throw new Error(`资源路径越界: ${assetPath}`);
  }

  return joined;
}

function resolveManifestFsPath(manifestUrl) {
  if (typeof manifestUrl !== "string" || !manifestUrl.trim()) {
    throw new Error("manifest 不能为空");
  }

  const normalizedUrl = manifestUrl.startsWith("/") ? manifestUrl : `/content/stories/${manifestUrl}`;
  const fsPath = path.resolve(WEB_PUBLIC_DIR, normalizedUrl.slice(1));
  const normalizedFsPath = path.normalize(fsPath);

  if (!normalizedFsPath.startsWith(path.normalize(STORIES_ROOT_DIR))) {
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

function loadStoryIndexEntries() {
  if (!fs.existsSync(STORY_INDEX_FILE)) {
    return [];
  }

  const payload = readJson(STORY_INDEX_FILE);
  if (!payload || !Array.isArray(payload.stories)) {
    return [];
  }

  return payload.stories
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || "").trim(),
      title: typeof item.title === "string" ? item.title : "",
      description: typeof item.description === "string" ? item.description : "",
      cover: typeof item.cover === "string" ? item.cover : "",
      manifest: typeof item.manifest === "string" ? item.manifest : "",
      order: Number.isFinite(item.order) ? Number(item.order) : Number.MAX_SAFE_INTEGER,
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.id);
}

function discoverStoryEntriesFromFolders() {
  if (!fs.existsSync(STORIES_ROOT_DIR)) {
    return [];
  }

  const folders = fs
    .readdirSync(STORIES_ROOT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const stories = [];
  for (const folderName of folders) {
    const manifestFsPath = path.join(STORIES_ROOT_DIR, folderName, "story.json");
    if (!fs.existsSync(manifestFsPath)) {
      continue;
    }

    let payload;
    try {
      payload = readJson(manifestFsPath);
    } catch {
      continue;
    }

    const storyId = String(payload?.id || folderName).trim();
    if (!storyId) {
      continue;
    }

    stories.push({
      id: storyId,
      title: typeof payload?.title === "string" ? payload.title : "",
      description: typeof payload?.description === "string" ? payload.description : "",
      cover: typeof payload?.cover === "string" ? payload.cover : "",
      manifest: `/content/stories/${folderName}/story.json`,
      order: Number.MAX_SAFE_INTEGER,
    });
  }

  return stories;
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

function ensureProgressCompatibility(userId, storyId, level, row) {
  const targetVersion = normalizeContentVersion(level.content_version);
  const currentVersion = normalizeContentVersion(row.content_version);

  if (targetVersion === currentVersion) {
    return row;
  }

  db.prepare(
    "UPDATE user_level_progress SET content_version = ?, save_state_json = NULL WHERE user_id = ? AND story_id = ? AND level_id = ?",
  ).run(targetVersion, userId, storyId, level.id);

  return {
    ...row,
    content_version: targetVersion,
    save_state_json: null,
  };
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

  const [cleanPath] = value.split(/[?#]/, 1);
  const normalized = path.normalize(path.resolve(WEB_PUBLIC_DIR, cleanPath.slice(1)));
  if (!normalized.startsWith(path.normalize(WEB_PUBLIC_DIR))) {
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
  const normalized = value.trim();
  if (normalized.length < 6 || normalized.length > 64) {
    return "";
  }
  return normalized;
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

function normalizeAttempts(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
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
