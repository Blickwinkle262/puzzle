import { AppError } from "../utils/appError.js";

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
    createPasswordResetApprovalRequest,
    createGuestUsername,
    createSession,
    createUserRecord,
    deleteSessionByToken,
    findLoginUserByUsername,
    findLogoutSession,
    findUserIdByUsername,
    findUserPasswordProfileById,
    isUsernameTaken,
    extractCsrfHeader,
    extractSessionToken,
    hashPassword,
    hashSessionToken,
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
    resetUserPasswordAndSessions,
    rotateSession,
    runProgressMaintenanceForUser,
    setAuthCookies,
    touchUserLastLogin,
    updateUserPassword,
    upgradeGuestUserCredentials,
    verifyPassword,
  } = deps;

  const route = (handler) => (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };

  const isPasswordSameAsUsername = (password, username) =>
    String(password || "").trim().toLowerCase() === String(username || "").trim().toLowerCase();

  app.post("/api/auth/register", route(async (req, res) => {
    if (!PUBLIC_REGISTRATION_ENABLED) {
      throw new AppError(403, "auth_register_disabled", "当前环境已关闭公开注册，请联系管理员创建账号");
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
      throw new AppError(400, "auth_register_missing_username", "用户名不能为空");
    }

    if (!password) {
      throw new AppError(400, "auth_register_weak_password", "密码至少 6 位");
    }

    if (isPasswordSameAsUsername(password, username)) {
      throw new AppError(400, "auth_register_password_same_as_username", "密码不能与用户名相同");
    }

    if (ADMIN_USERNAMES.has(username.toLowerCase())) {
      const bootstrapToken = typeof req.body?.admin_bootstrap_token === "string"
        ? req.body.admin_bootstrap_token.trim()
        : "";

      if (!ADMIN_BOOTSTRAP_TOKEN || bootstrapToken !== ADMIN_BOOTSTRAP_TOKEN) {
        throw new AppError(403, "auth_register_protected_username", "该用户名受保护，请联系管理员创建账号");
      }
    }

    const exists = isUsernameTaken(username);
    if (exists) {
      throw new AppError(409, "auth_register_username_exists", "用户名已存在");
    }

    const passwordHash = await hashPassword(password);
    const now = nowIso();

    const userId = createUserRecord({ username, passwordHash, now });
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
  }));

  app.post("/api/auth/login", route(async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = normalizePassword(req.body?.password);

    if (!passAuthRateLimit(req, username, res)) {
      return;
    }

    if (!username || !password) {
      throw new AppError(400, "auth_login_missing_credentials", "用户名和密码不能为空");
    }

    const user = findLoginUserByUsername(username);

    const verified = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !verified) {
      throw new AppError(401, "auth_login_invalid_credentials", "用户名或密码错误");
    }

    const now = nowIso();
    touchUserLastLogin({ userId: user.id, now });

    clearAuthRateLimit(req, user.username);
    const session = createSession(user.id);
    runProgressMaintenanceForUser(user.id);
    setAuthCookies(res, session);

    res.json({
      user: buildAuthUserPayload(user),
    });
  }));

  app.post("/api/auth/guest-login", route(async (req, res) => {
    if (!passRegisterRateLimit(req, res)) {
      return;
    }

    if (!passAuthRateLimit(req, "guest", res)) {
      return;
    }

    const username = createGuestUsername();
    const passwordHash = await hashPassword(randomToken());
    const now = nowIso();

    const userId = createUserRecord({ username, passwordHash, isGuest: true, now });
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
  }));

  app.post("/api/auth/logout", route((req, res) => {
    pruneExpiredSessions();

    const token = extractSessionToken(req);
    const tokenHash = hashSessionToken(token);
    if (!token) {
      clearAuthCookies(res);
      res.status(204).end();
      return;
    }

    const row = findLogoutSession({ tokenHash, token, now: nowIso() });

    if (!row) {
      clearAuthCookies(res);
      res.status(204).end();
      return;
    }

    const csrfHeader = extractCsrfHeader(req);
    if (!csrfHeader || csrfHeader !== row.csrf_token) {
      throw new AppError(403, "auth_logout_csrf_failed", "CSRF 校验失败");
    }

    deleteSessionByToken({ tokenHash: row.token_hash || tokenHash, token: row.token || token });
    clearAuthCookies(res);
    res.status(204).end();
  }));

  app.post("/api/auth/refresh", requireAuth, requireCsrf, route((req, res) => {
    const rotated = rotateSession(req.authToken);
    if (!rotated) {
      throw new AppError(401, "auth_refresh_invalid_session", "登录状态已失效");
    }

    setAuthCookies(res, rotated);
    res.json({
      user: buildAuthUserPayload(req.authUser),
      refreshed_at: nowIso(),
    });
  }));

  app.post("/api/auth/guest-upgrade", requireAuth, requireCsrf, route(async (req, res) => {
    if (!req.authUser.is_guest) {
      throw new AppError(400, "auth_guest_upgrade_not_guest", "当前账号不是游客模式");
    }

    const username = normalizeUsername(req.body?.username);
    const password = normalizeStrongPassword(req.body?.password);

    if (!username) {
      throw new AppError(400, "auth_guest_upgrade_missing_username", "用户名不能为空");
    }

    if (!password) {
      throw new AppError(400, "auth_guest_upgrade_weak_password", "密码至少 6 位");
    }

    if (isPasswordSameAsUsername(password, username)) {
      throw new AppError(400, "auth_guest_upgrade_password_same_as_username", "密码不能与用户名相同");
    }

    const exists = isUsernameTaken(username, { excludeUserId: req.authUser.id });
    if (exists) {
      throw new AppError(409, "auth_guest_upgrade_username_exists", "用户名已存在");
    }

    const passwordHash = await hashPassword(password);
    const now = nowIso();
    upgradeGuestUserCredentials({
      userId: req.authUser.id,
      username,
      passwordHash,
      now,
    });

    res.json({
      user: buildAuthUserPayload({
        id: req.authUser.id,
        username,
        is_guest: false,
      }),
    });
  }));

  app.post("/api/auth/change-password", requireAuth, requireCsrf, route(async (req, res) => {
    const currentPassword = typeof req.body?.current_password === "string" ? req.body.current_password : "";
    const newPassword = normalizeStrongPassword(req.body?.new_password);

    if (!currentPassword) {
      throw new AppError(400, "auth_change_password_missing_current", "当前密码不能为空");
    }

    if (!newPassword) {
      throw new AppError(400, "auth_change_password_weak_new", "新密码至少 6 位");
    }

    const row = findUserPasswordProfileById(req.authUser.id);
    const verified = row ? await verifyPassword(currentPassword, row.password_hash) : false;
    if (!row || !verified) {
      throw new AppError(401, "auth_change_password_invalid_current", "当前密码错误");
    }

    if (isPasswordSameAsUsername(newPassword, row.username)) {
      throw new AppError(400, "auth_change_password_same_as_username", "新密码不能与用户名相同");
    }

    const passwordHash = await hashPassword(newPassword);
    const now = nowIso();
    updateUserPassword({ userId: req.authUser.id, passwordHash, now });

    const session = createSession(req.authUser.id);
    setAuthCookies(res, session);

    res.json({
      user: buildAuthUserPayload({
        id: req.authUser.id,
        username: row.username,
        is_guest: Boolean(row.is_guest),
      }),
    });
  }));

  app.post("/api/auth/forgot-password", route(async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const newPassword = normalizeStrongPassword(req.body?.new_password);

    const safeResponse = {
      message: "如果账号存在，重置申请已提交，请联系管理员审批",
    };

    if (!username) {
      throw new AppError(400, "auth_forgot_password_missing_username", "用户名不能为空");
    }

    if (!newPassword) {
      throw new AppError(400, "auth_forgot_password_weak_new", "新密码至少 6 位");
    }

    if (isPasswordSameAsUsername(newPassword, username)) {
      throw new AppError(400, "auth_forgot_password_same_as_username", "新密码不能与用户名相同");
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

    const userId = findUserIdByUsername(username);
    if (!userId) {
      res.status(200).json(safeResponse);
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    const now = nowIso();
    createPasswordResetApprovalRequest({
      userId,
      requestedByUsername: username,
      passwordHash,
      requestedIp: String(req.ip || req.socket?.remoteAddress || "").trim(),
      now,
    });

    res.status(200).json(safeResponse);
  }));

  app.post("/api/auth/reset-password", route(async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const newPassword = normalizeStrongPassword(req.body?.new_password);

    if (
      !passPasswordResetRateLimit(req, {
        action: "reset",
        maxAttempts: RESET_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
        windowMs: RESET_PASSWORD_RATE_LIMIT_WINDOW_MS,
      })
    ) {
      throw new AppError(429, "auth_reset_password_rate_limited", "重置请求过于频繁，请稍后再试");
    }

    if (!token || !newPassword) {
      throw new AppError(400, "auth_reset_password_invalid_input", "重置码不能为空，且新密码至少 6 位");
    }

    const resetRow = consumePasswordResetToken(token);
    if (!resetRow) {
      throw new AppError(400, "auth_reset_password_invalid_token", "重置码无效或已过期");
    }

    const userPasswordProfile = findUserPasswordProfileById(resetRow.user_id);
    if (!userPasswordProfile || !userPasswordProfile.username) {
      throw new AppError(400, "auth_reset_password_invalid_token", "重置码无效或已过期");
    }

    if (isPasswordSameAsUsername(newPassword, userPasswordProfile.username)) {
      throw new AppError(400, "auth_reset_password_same_as_username", "新密码不能与用户名相同");
    }

    const passwordHash = await hashPassword(newPassword);
    const now = nowIso();
    resetUserPasswordAndSessions({ userId: resetRow.user_id, passwordHash, now });

    clearAuthCookies(res);
    res.status(204).end();
  }));

  app.get("/api/auth/me", requireAuth, route((req, res) => {
    res.json({
      user: buildAuthUserPayload(req.authUser),
    });
  }));
}
