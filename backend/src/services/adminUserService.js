export function createAdminUserService(options = {}) {
  const {
    db,
    nowIso,
    adminUsernames,
    adminUsernameFallbackEnabled,
    managedAdminRoles,
    normalizeNonNegativeInteger,
    normalizePositiveInteger,
  } = options;

  function isAdminUser(user) {
    if (!user || !user.username) {
      return false;
    }

    if (Boolean(user.has_admin_role)) {
      return true;
    }

    if (!adminUsernameFallbackEnabled) {
      return false;
    }

    const normalized = String(user.username).trim().toLowerCase();

    if (adminUsernames.size > 0) {
      return adminUsernames.has(normalized);
    }

    return process.env.NODE_ENV !== "production";
  }

  function requireAdmin(req, res, next) {
    if (!isAdminUser(req.authUser)) {
      res.status(403).json({ message: "需要管理员权限" });
      return;
    }
    next();
  }

  function normalizeAdminRole(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!managedAdminRoles.has(normalized)) {
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
      pending_password_reset_count: normalizeNonNegativeInteger(user?.pending_password_reset_count, 0),
      last_password_reset_requested_at: user?.last_password_reset_requested_at || null,
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

  return {
    appendAdminAuditLog,
    buildAuthUserPayload,
    countAdminUsers,
    getRolesByUserId,
    getRolesByUserIds,
    normalizeAdminRole,
    requireAdmin,
    serializeAdminUser,
  };
}
