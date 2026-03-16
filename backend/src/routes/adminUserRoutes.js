export function registerAdminUserRoutes(app, deps) {
  const {
    appendAdminAuditLog,
    asMessage,
    countAdminUsers,
    db,
    getRolesByUserId,
    getRolesByUserIds,
    normalizeAdminRole,
    normalizePositiveInteger,
    normalizeShortText,
    nowIso,
    requireAdmin,
    requireAuth,
    requireCsrf,
    resetUserPasswordAndSessions,
    serializeAdminUser,
  } = deps;

  app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
    try {
      const limit = Math.min(100, normalizePositiveInteger(req.query?.limit) || 10);
      const keyword = normalizeShortText(req.query?.keyword);
      const role = normalizeAdminRole(req.query?.role);
      const pageInput = normalizePositiveInteger(req.query?.page);
      const rawOffset = Number(req.query?.offset);
      const offset = Number.isInteger(rawOffset) && rawOffset >= 0
        ? rawOffset
        : pageInput
          ? (pageInput - 1) * limit
          : 0;
      const page = Math.floor(offset / limit) + 1;

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
      const total = Number(totalRow?.total || 0);

      const summaryRow = db
        .prepare(
          `
          SELECT
            COUNT(1) AS total_users,
            SUM(CASE WHEN u.is_guest = 1 THEN 1 ELSE 0 END) AS guest_users,
            SUM(
              CASE WHEN EXISTS (
                SELECT 1 FROM user_roles ur_admin
                WHERE ur_admin.user_id = u.id AND ur_admin.role = 'admin'
              ) THEN 1 ELSE 0 END
            ) AS admin_users,
            SUM(
              CASE WHEN EXISTS (
                SELECT 1 FROM password_reset_requests pr_pending
                WHERE pr_pending.user_id = u.id AND pr_pending.status = 'pending'
              ) THEN 1 ELSE 0 END
            ) AS pending_reset_users
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
            COALESCE(stats.completed_level_count, 0) AS completed_level_count,
            COALESCE(reset_stats.pending_password_reset_count, 0) AS pending_password_reset_count,
            reset_stats.last_password_reset_requested_at AS last_password_reset_requested_at
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
          LEFT JOIN (
            SELECT
              user_id,
              COUNT(1) AS pending_password_reset_count,
              MAX(requested_at) AS last_password_reset_requested_at
            FROM password_reset_requests
            WHERE status = 'pending'
            GROUP BY user_id
          ) AS reset_stats ON reset_stats.user_id = u.id
          WHERE ${whereClause}
          ORDER BY u.id DESC
          LIMIT ?
          OFFSET ?
        `,
        )
        .all(...params, limit, offset);

      const rolesByUserId = getRolesByUserIds(users.map((item) => Number(item.id)));
      const hasMore = offset + users.length < total;

      res.json({
        total,
        has_more: hasMore,
        summary: {
          total_users: Number(summaryRow?.total_users || 0),
          guest_users: Number(summaryRow?.guest_users || 0),
          admin_users: Number(summaryRow?.admin_users || 0),
          pending_reset_users: Number(summaryRow?.pending_reset_users || 0),
        },
        filters: {
          limit,
          offset,
          page,
          keyword: keyword || "",
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

  app.post("/api/admin/users/:id/password-reset/approve", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const userId = normalizePositiveInteger(req.params.id);
    if (!userId) {
      res.status(400).json({ message: "用户 id 不合法" });
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

      const requestRow = db
        .prepare(
          `
          SELECT id, requested_password_hash, requested_by_username, requested_at
          FROM password_reset_requests
          WHERE user_id = ? AND status = 'pending'
          ORDER BY requested_at DESC, id DESC
          LIMIT 1
        `,
        )
        .get(userId);

      if (!requestRow) {
        res.status(404).json({ message: "该用户暂无待审批的密码重置申请" });
        return;
      }

      const requestedPasswordHash = String(requestRow.requested_password_hash || "").trim();
      if (!requestedPasswordHash) {
        res.status(500).json({ message: "审批申请数据异常，请让用户重新提交" });
        return;
      }

      const now = nowIso();
      const tx = db.transaction(() => {
        resetUserPasswordAndSessions({
          userId,
          passwordHash: requestedPasswordHash,
          now,
        });

        db.prepare(
          `
          UPDATE password_reset_requests
          SET status = 'approved', reviewed_at = ?, reviewed_by_user_id = ?, review_note = ?
          WHERE id = ?
        `,
        ).run(now, req.authUser.id, note || "", requestRow.id);
      });

      tx();

      appendAdminAuditLog({
        actorUserId: req.authUser.id,
        actorUsername: req.authUser.username,
        action: "user.password_reset.approve",
        targetType: "user",
        targetId: String(userId),
        before: {
          request_id: Number(requestRow.id),
          status: "pending",
          requested_by_username: String(requestRow.requested_by_username || ""),
          requested_at: requestRow.requested_at || null,
        },
        after: {
          request_id: Number(requestRow.id),
          status: "approved",
          approved_at: now,
        },
        meta: {
          note: note || "",
        },
      });

      res.json({
        ok: true,
        request_id: Number(requestRow.id),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "审批密码重置失败") });
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
}
