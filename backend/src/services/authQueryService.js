export function createAuthQueryService(options = {}) {
  const { db } = options;

  function isUsernameTaken(username, options = {}) {
    const excludeUserId = Number.isFinite(Number(options.excludeUserId))
      ? Number(options.excludeUserId)
      : 0;

    const row = excludeUserId > 0
      ? db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(username, excludeUserId)
      : db.prepare("SELECT id FROM users WHERE username = ?").get(username);

    return Boolean(row);
  }

  function findLoginUserByUsername(username) {
    return db
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
  }

  function findLogoutSession({ tokenHash, token, now }) {
    return db
      .prepare(
        "SELECT token, token_hash, csrf_token FROM sessions WHERE (token_hash = ? OR token = ?) AND expires_at > ?",
      )
      .get(tokenHash, token, now);
  }

  function findUserPasswordProfileById(userId) {
    return db.prepare("SELECT password_hash, username, is_guest FROM users WHERE id = ?").get(userId);
  }

  function findUserIdByUsername(username) {
    const row = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    return row ? Number(row.id) : 0;
  }

  return {
    findLoginUserByUsername,
    findLogoutSession,
    findUserIdByUsername,
    findUserPasswordProfileById,
    isUsernameTaken,
  };
}
