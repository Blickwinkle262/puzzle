export function registerAdminLevelRoutes(app, deps) {
  const {
    appendAdminAuditLog,
    asMessage,
    buildAdminLevelConfigSnapshot,
    loadStoryById,
    normalizeShortText,
    parseAdminLevelConfigPatch,
    randomToken,
    requireAdmin,
    requireAuth,
    requireCsrf,
    saveAdminLevelOverrideConfig,
    serializeLevelOverrideConfig,
  } = deps;

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
}
