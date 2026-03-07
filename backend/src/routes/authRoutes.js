import bcrypt from "bcryptjs";

export function registerAuthRoutes(app, deps) {
  const {
    ADMIN_BOOTSTRAP_TOKEN,
    ADMIN_USERNAMES,
    FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
    FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MS,
    PUBLIC_REGISTRATION_ENABLED,
    RESET_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
    RESET_PASSWORD_RATE_LIMIT_WINDOW_MS,
    buildAuthUserPayload,
    clearAuthCookies,
    clearAuthRateLimit,
    consumePasswordResetToken,
    createGuestUsername,
    createSession,
    db,
    extractCsrfHeader,
    extractSessionToken,
    hashSessionToken,
    issuePasswordResetToken,
    normalizePassword,
    normalizeStrongPassword,
    normalizeUsername,
    nowIso,
    passAuthRateLimit,
    passPasswordResetRateLimit,
    passRegisterRateLimit,
    pruneExpiredSessions,
    randomToken,
    requireAuth,
    requireCsrf,
    rotateSession,
    runProgressMaintenanceForUser,
    setAuthCookies,
  } = deps;

  app.post("/api/auth/register", (req, res) => {
    if (!PUBLIC_REGISTRATION_ENABLED) {
      res.status(403).json({ message: "当前环境已关闭公开注册，请联系管理员创建账号" });
      return;
    }

    if (!passRegisterRateLimit(req, res)) {
      return;
    }

    const username = normalizeUsername(req.body?.username);
    const password = normalizeStrongPassword(req.body?.password);

    if (!passAuthRateLimit(req, username, res)) {
      return;
    }

    if (!username) {
      res.status(400).json({ message: "用户名不能为空" });
      return;
    }

    if (!password) {
      res.status(400).json({ message: "密码至少 10 位，且包含字母、数字和符号" });
      return;
    }

    if (ADMIN_USERNAMES.has(username.toLowerCase())) {
      const bootstrapToken = typeof req.body?.admin_bootstrap_token === "string"
        ? req.body.admin_bootstrap_token.trim()
        : "";

      if (!ADMIN_BOOTSTRAP_TOKEN || bootstrapToken !== ADMIN_BOOTSTRAP_TOKEN) {
        res.status(403).json({ message: "该用户名受保护，请联系管理员创建账号" });
        return;
      }
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
    if (!passRegisterRateLimit(req, res)) {
      return;
    }

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
    const tokenHash = hashSessionToken(token);
    if (!token) {
      clearAuthCookies(res);
      res.status(204).end();
      return;
    }

    const row = db
      .prepare(
        "SELECT token, token_hash, csrf_token FROM sessions WHERE (token_hash = ? OR token = ?) AND expires_at > ?",
      )
      .get(tokenHash, token, nowIso());

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

    db.prepare("DELETE FROM sessions WHERE token_hash = ? OR token = ?").run(row.token_hash || tokenHash, row.token || token);
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
    const password = normalizeStrongPassword(req.body?.password);

    if (!username) {
      res.status(400).json({ message: "用户名不能为空" });
      return;
    }

    if (!password) {
      res.status(400).json({ message: "密码至少 10 位，且包含字母、数字和符号" });
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
    const newPassword = normalizeStrongPassword(req.body?.new_password);

    if (!currentPassword) {
      res.status(400).json({ message: "当前密码不能为空" });
      return;
    }

    if (!newPassword) {
      res.status(400).json({ message: "新密码至少 10 位，且包含字母、数字和符号" });
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

    const safeResponse = {
      message: "如果账号存在，重置方式已生成",
    };

    if (!username) {
      res.status(200).json(safeResponse);
      return;
    }

    if (
      !passPasswordResetRateLimit(req, {
        action: "forgot",
        subject: username.toLowerCase(),
        maxAttempts: FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
        windowMs: FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MS,
      })
    ) {
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
    const newPassword = normalizeStrongPassword(req.body?.new_password);

    if (
      !passPasswordResetRateLimit(req, {
        action: "reset",
        maxAttempts: RESET_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
        windowMs: RESET_PASSWORD_RATE_LIMIT_WINDOW_MS,
      })
    ) {
      res.status(429).json({ message: "重置请求过于频繁，请稍后再试" });
      return;
    }

    if (!token || !newPassword) {
      res.status(400).json({ message: "重置码不能为空，且新密码至少 10 位并包含字母、数字和符号" });
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
}
