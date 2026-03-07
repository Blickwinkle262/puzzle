import crypto from "node:crypto";

export function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function hashSessionToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }

  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashTokenForStorage(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function authRateLimitKey(req, username) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown").trim();
  const name = (username || "").toLowerCase();
  return `${ip}|${name}`;
}

function registerRateLimitKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").trim();
}

function passwordResetRateLimitKey(req, options = {}) {
  const action = String(options.action || "default").trim().toLowerCase();
  const subject = String(options.subject || "").trim().toLowerCase();
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown").trim();
  return `${action}|${ip}|${subject}`;
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

export function createAuthSessionService(options = {}) {
  const {
    db,
    nowIso,
    sessionCookieName,
    csrfCookieName,
    csrfHeaderName,
    sessionTtlMs,
    cookieSecure,
    cookieSameSite,
    resetTokenTtlMs,
    authRateLimitWindowMs,
    authRateLimitMaxAttempts,
    authRateLimitCleanupInterval,
    registerRateLimitWindowMs,
    registerRateLimitMaxAttempts,
    registerRateLimitCleanupInterval,
    forgotPasswordRateLimitWindowMs,
    forgotPasswordRateLimitMaxAttempts,
    passwordResetRateLimitCleanupInterval,
  } = options;

  const authRateBuckets = new Map();
  let authRateLimitHits = 0;
  const registerRateBuckets = new Map();
  let registerRateLimitHits = 0;
  const passwordResetRateBuckets = new Map();
  let passwordResetRateLimitHits = 0;

  function pruneAuthRateLimitBuckets(now = Date.now()) {
    for (const [key, bucket] of authRateBuckets.entries()) {
      if (!Array.isArray(bucket) || bucket.length === 0) {
        authRateBuckets.delete(key);
        continue;
      }

      const recent = bucket.filter((ts) => Number.isFinite(ts) && now - ts <= authRateLimitWindowMs);
      if (recent.length === 0) {
        authRateBuckets.delete(key);
        continue;
      }

      authRateBuckets.set(key, recent);
    }
  }

  function passAuthRateLimit(req, username, res) {
    const key = authRateLimitKey(req, username);
    const now = Date.now();

    authRateLimitHits += 1;
    if (authRateLimitHits % authRateLimitCleanupInterval === 0) {
      pruneAuthRateLimitBuckets(now);
    }

    const bucket = authRateBuckets.get(key) || [];
    const recent = bucket.filter((ts) => now - ts <= authRateLimitWindowMs);

    if (recent.length >= authRateLimitMaxAttempts) {
      res.status(429).json({ message: "尝试过于频繁，请稍后再试" });
      authRateBuckets.set(key, recent);
      return false;
    }

    recent.push(now);
    authRateBuckets.set(key, recent);
    return true;
  }

  function pruneRegisterRateLimitBuckets(now = Date.now()) {
    for (const [key, bucket] of registerRateBuckets.entries()) {
      if (!Array.isArray(bucket) || bucket.length === 0) {
        registerRateBuckets.delete(key);
        continue;
      }

      const recent = bucket.filter((ts) => Number.isFinite(ts) && now - ts <= registerRateLimitWindowMs);
      if (recent.length === 0) {
        registerRateBuckets.delete(key);
        continue;
      }

      registerRateBuckets.set(key, recent);
    }
  }

  function passRegisterRateLimit(req, res) {
    const key = registerRateLimitKey(req);
    const now = Date.now();

    registerRateLimitHits += 1;
    if (registerRateLimitHits % registerRateLimitCleanupInterval === 0) {
      pruneRegisterRateLimitBuckets(now);
    }

    const bucket = registerRateBuckets.get(key) || [];
    const recent = bucket.filter((ts) => now - ts <= registerRateLimitWindowMs);

    if (recent.length >= registerRateLimitMaxAttempts) {
      res.status(429).json({ message: "注册过于频繁，请稍后再试" });
      registerRateBuckets.set(key, recent);
      return false;
    }

    recent.push(now);
    registerRateBuckets.set(key, recent);
    return true;
  }

  function prunePasswordResetRateLimitBuckets(now = Date.now()) {
    for (const [key, value] of passwordResetRateBuckets.entries()) {
      if (!value || typeof value !== "object") {
        passwordResetRateBuckets.delete(key);
        continue;
      }

      const windowMs = Number.isFinite(Number(value.windowMs))
        ? Number(value.windowMs)
        : forgotPasswordRateLimitWindowMs;
      const events = Array.isArray(value.events) ? value.events : [];
      const recent = events.filter((ts) => Number.isFinite(ts) && now - ts <= windowMs);

      if (recent.length === 0) {
        passwordResetRateBuckets.delete(key);
        continue;
      }

      passwordResetRateBuckets.set(key, {
        windowMs,
        events: recent,
      });
    }
  }

  function passPasswordResetRateLimit(req, options = {}) {
    const windowMs = Number.isFinite(Number(options.windowMs))
      ? Math.max(1000, Math.floor(Number(options.windowMs)))
      : forgotPasswordRateLimitWindowMs;
    const maxAttempts = Number.isFinite(Number(options.maxAttempts))
      ? Math.max(1, Math.floor(Number(options.maxAttempts)))
      : forgotPasswordRateLimitMaxAttempts;
    const key = passwordResetRateLimitKey(req, options);
    const now = Date.now();

    passwordResetRateLimitHits += 1;
    if (passwordResetRateLimitHits % passwordResetRateLimitCleanupInterval === 0) {
      prunePasswordResetRateLimitBuckets(now);
    }

    const bucket = passwordResetRateBuckets.get(key) || { windowMs, events: [] };
    const events = Array.isArray(bucket.events) ? bucket.events : [];
    const recent = events.filter((ts) => now - ts <= windowMs);

    if (recent.length >= maxAttempts) {
      passwordResetRateBuckets.set(key, { windowMs, events: recent });
      return false;
    }

    recent.push(now);
    passwordResetRateBuckets.set(key, { windowMs, events: recent });
    return true;
  }

  function clearAuthRateLimit(req, username) {
    authRateBuckets.delete(authRateLimitKey(req, username));
  }

  function extractSessionToken(req) {
    const cookieToken = readCookie(req, sessionCookieName);
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
    const value = req.headers[csrfHeaderName];
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
  }

  function setAuthCookies(res, session) {
    const secure = cookieSecure ? "; Secure" : "";
    const maxAgeSeconds = Math.floor(sessionTtlMs / 1000);
    res.setHeader(
      "Set-Cookie",
      [
        `${sessionCookieName}=${encodeURIComponent(session.token)}; HttpOnly; Path=/; SameSite=${cookieSameSite}; Max-Age=${maxAgeSeconds}${secure}`,
        `${csrfCookieName}=${encodeURIComponent(session.csrfToken)}; Path=/; SameSite=${cookieSameSite}; Max-Age=${maxAgeSeconds}${secure}`,
      ],
    );
  }

  function clearAuthCookies(res) {
    const secure = cookieSecure ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      [
        `${sessionCookieName}=; HttpOnly; Path=/; SameSite=${cookieSameSite}; Max-Age=0${secure}`,
        `${csrfCookieName}=; Path=/; SameSite=${cookieSameSite}; Max-Age=0${secure}`,
      ],
    );
  }

  function pruneExpiredSessions() {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  }

  function requireAuth(req, res, next) {
    pruneExpiredSessions();

    const token = extractSessionToken(req);
    const tokenHash = hashSessionToken(token);
    if (!token) {
      res.status(401).json({ message: "未登录" });
      return;
    }

    const row = db
      .prepare(
        `
      SELECT u.id, u.username, u.is_guest, s.csrf_token
           , CASE WHEN EXISTS (
               SELECT 1 FROM user_roles ur
               WHERE ur.user_id = u.id AND ur.role = 'admin'
             ) THEN 1 ELSE 0 END AS has_admin_role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE (s.token_hash = ? OR s.token = ?) AND s.expires_at > ?
      `,
      )
      .get(tokenHash, token, nowIso());

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
    req.authToken = token;
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

  function createSession(userId) {
    pruneExpiredSessions();

    const token = randomToken();
    const tokenHash = hashSessionToken(token);
    const csrfToken = randomToken();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      db.prepare("INSERT INTO sessions (token, token_hash, user_id, created_at, expires_at, csrf_token) VALUES (?, ?, ?, ?, ?, ?)").run(
        token,
        tokenHash,
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
    const oldTokenHash = hashSessionToken(oldToken);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomToken();
      const tokenHash = hashSessionToken(token);
      const csrfToken = randomToken();
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();

      try {
        const result = db
          .prepare(
            "UPDATE sessions SET token = ?, token_hash = ?, csrf_token = ?, created_at = ?, expires_at = ? WHERE token_hash = ? OR token = ?",
          )
          .run(token, tokenHash, csrfToken, createdAt, expiresAt, oldTokenHash, oldToken);

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

  function pruneExpiredPasswordResetTokens() {
    const now = nowIso();
    db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
  }

  function issuePasswordResetToken(userId, req) {
    pruneExpiredPasswordResetTokens();

    const token = randomToken();
    const tokenHash = hashTokenForStorage(token);
    const now = nowIso();
    const expiresAt = new Date(Date.now() + resetTokenTtlMs).toISOString();
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

  return {
    clearAuthCookies,
    clearAuthRateLimit,
    consumePasswordResetToken,
    createGuestUsername,
    createSession,
    extractCsrfHeader,
    extractSessionToken,
    issuePasswordResetToken,
    passAuthRateLimit,
    passPasswordResetRateLimit,
    passRegisterRateLimit,
    pruneExpiredSessions,
    requireAuth,
    requireCsrf,
    rotateSession,
    setAuthCookies,
  };
}
