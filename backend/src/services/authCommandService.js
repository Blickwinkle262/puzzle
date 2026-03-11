export function createAuthCommandService(options = {}) {
  const { db } = options;

  function createUserRecord({ username, passwordHash, isGuest = false, now }) {
    const result = db
      .prepare(
        "INSERT INTO users (username, password_hash, is_guest, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(username, passwordHash, isGuest ? 1 : 0, now, now);

    return Number(result.lastInsertRowid);
  }

  function touchUserLastLogin({ userId, now }) {
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
  }

  function deleteSessionByToken({ tokenHash, token }) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ? OR token = ?").run(tokenHash, token);
  }

  function upgradeGuestUserCredentials({ userId, username, passwordHash, now }) {
    db.prepare("UPDATE users SET username = ?, password_hash = ?, is_guest = 0, last_login_at = ? WHERE id = ?").run(
      username,
      passwordHash,
      now,
      userId,
    );
  }

  function updateUserPassword({ userId, passwordHash, now }) {
    db.prepare("UPDATE users SET password_hash = ?, last_login_at = ? WHERE id = ?").run(passwordHash, now, userId);
  }

  function resetUserPasswordAndSessions({ userId, passwordHash, now }) {
    const tx = db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, last_login_at = ? WHERE id = ?").run(passwordHash, now, userId);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    });
    tx();
  }

  function createPasswordResetApprovalRequest({ userId, requestedByUsername, passwordHash, requestedIp = "", now }) {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM password_reset_requests WHERE user_id = ? AND status = 'pending'").run(userId);

      const result = db
        .prepare(
          `
          INSERT INTO password_reset_requests (
            user_id,
            requested_by_username,
            requested_password_hash,
            status,
            requested_at,
            requested_ip
          ) VALUES (?, ?, ?, 'pending', ?, ?)
        `,
        )
        .run(userId, String(requestedByUsername || ""), String(passwordHash || ""), now, String(requestedIp || ""));

      return Number(result.lastInsertRowid || 0);
    });

    return tx();
  }

  return {
    createPasswordResetApprovalRequest,
    createUserRecord,
    deleteSessionByToken,
    resetUserPasswordAndSessions,
    touchUserLastLogin,
    updateUserPassword,
    upgradeGuestUserCredentials,
  };
}
