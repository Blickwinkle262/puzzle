export function registerAdminLlmRoutes(app, deps) {
  const {
    asMessage,
    createLlmProvider,
    deleteLlmProvider,
    fetchLlmProviderModels,
    getLlmGlobalProfile,
    getLlmProviderById,
    getLlmUserProfile,
    listAdminLlmEnvKeys,
    listLlmProviderModels,
    listLlmProviders,
    requireAdmin,
    requireAuth,
    requireCsrf,
    resolveLlmRuntimeSettings,
    saveLlmGlobalProfile,
    saveLlmProviderKey,
    saveLlmUserProfile,
    serializeRuntimeLlmState,
    testLlmProviderConnection,
    updateLlmProvider,
  } = deps;

  function normalizeField(value, maxLength = 260) {
    return String(value || "").trim().slice(0, maxLength);
  }

  function normalizePositiveInteger(value) {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
      return 0;
    }
    return num;
  }

  function inferErrorStatus(error, fallback = 400) {
    const message = asMessage(error, "");
    if (message.includes("不存在") || message.includes("未找到")) {
      return 404;
    }
    if (message.includes("引用") || message.includes("绑定")) {
      return 409;
    }
    if (message.includes("不合法") || message.includes("不能为空")) {
      return 400;
    }
    return fallback;
  }

  app.get("/api/admin/llm/env-keys", requireAuth, requireAdmin, (_req, res) => {
    try {
      res.json({
        ok: true,
        key_options: listAdminLlmEnvKeys(),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 API Key 选项失败") });
    }
  });

  app.get("/api/admin/llm/providers", requireAuth, requireAdmin, (_req, res) => {
    try {
      res.json({
        ok: true,
        providers: listLlmProviders(),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 providers 失败") });
    }
  });

  app.post("/api/admin/llm/providers", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    try {
      const provider = createLlmProvider(req.body, req.authUser?.id || null);
      res.status(201).json({
        ok: true,
        provider,
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "创建 provider 失败") });
    }
  });

  app.get("/api/admin/llm/providers/:providerId", requireAuth, requireAdmin, (req, res) => {
    const providerId = normalizePositiveInteger(req.params.providerId);
    if (!providerId) {
      res.status(400).json({ message: "provider_id 不合法" });
      return;
    }

    try {
      const provider = getLlmProviderById(providerId, { allowDisabled: true });
      if (!provider) {
        res.status(404).json({ message: "provider 不存在" });
        return;
      }
      res.json({
        ok: true,
        provider,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 provider 详情失败") });
    }
  });

  app.put("/api/admin/llm/providers/:providerId", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const providerId = normalizePositiveInteger(req.params.providerId);
    if (!providerId) {
      res.status(400).json({ message: "provider_id 不合法" });
      return;
    }

    try {
      const provider = updateLlmProvider(providerId, req.body, req.authUser?.id || null);
      res.json({
        ok: true,
        provider,
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "更新 provider 失败") });
    }
  });

  app.delete("/api/admin/llm/providers/:providerId", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const providerId = normalizePositiveInteger(req.params.providerId);
    if (!providerId) {
      res.status(400).json({ message: "provider_id 不合法" });
      return;
    }

    try {
      const deleted = deleteLlmProvider(providerId, req.authUser?.id || null);
      res.json({
        ok: true,
        deleted_provider_id: deleted?.id || providerId,
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "删除 provider 失败") });
    }
  });

  app.put("/api/admin/llm/providers/:providerId/key", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const providerId = normalizePositiveInteger(req.params.providerId);
    if (!providerId) {
      res.status(400).json({ message: "provider_id 不合法" });
      return;
    }

    try {
      const provider = saveLlmProviderKey(providerId, req.body, req.authUser?.id || null);
      res.json({
        ok: true,
        provider,
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "更新 provider key 失败") });
    }
  });

  app.get("/api/admin/llm/providers/:providerId/models", requireAuth, requireAdmin, (req, res) => {
    const providerId = normalizePositiveInteger(req.params.providerId);
    if (!providerId) {
      res.status(400).json({ message: "provider_id 不合法" });
      return;
    }

    try {
      const provider = getLlmProviderById(providerId, { allowDisabled: true });
      if (!provider) {
        res.status(404).json({ message: "provider 不存在" });
        return;
      }

      const modelType = normalizeField(req.query?.type || "", 32);
      res.json({
        ok: true,
        provider,
        models: listLlmProviderModels(providerId, modelType),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 provider models 失败") });
    }
  });

  app.post("/api/admin/llm/providers/:providerId/models/fetch", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
    const providerId = normalizePositiveInteger(req.params.providerId);
    if (!providerId) {
      res.status(400).json({ message: "provider_id 不合法" });
      return;
    }

    try {
      const result = await fetchLlmProviderModels(providerId, req.body, req.authUser?.id || null);
      res.json({
        ok: true,
        fetch: result,
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "拉取 provider models 失败") });
    }
  });

  app.post("/api/admin/llm/providers/:providerId/test", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
    const providerId = normalizePositiveInteger(req.params.providerId);
    if (!providerId) {
      res.status(400).json({ message: "provider_id 不合法" });
      return;
    }

    try {
      const result = await testLlmProviderConnection(providerId, req.body);
      res.json({
        ok: true,
        test: result,
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "provider 连通性测试失败") });
    }
  });

  app.get("/api/admin/llm/global/profile", requireAuth, requireAdmin, (_req, res) => {
    try {
      const profile = getLlmGlobalProfile();
      res.json({
        ok: true,
        profile,
        effective: serializeRuntimeLlmState(resolveLlmRuntimeSettings()),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 global profile 失败") });
    }
  });

  app.put("/api/admin/llm/global/profile", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    try {
      const profile = saveLlmGlobalProfile(req.body, req.authUser?.id || null);
      res.json({
        ok: true,
        profile,
        effective: serializeRuntimeLlmState(resolveLlmRuntimeSettings()),
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "保存 global profile 失败") });
    }
  });

  app.get("/api/admin/llm/users/:userId/profile", requireAuth, requireAdmin, (req, res) => {
    const userId = normalizePositiveInteger(req.params.userId);
    if (!userId) {
      res.status(400).json({ message: "user_id 不合法" });
      return;
    }

    try {
      const profile = getLlmUserProfile(userId);
      res.json({
        ok: true,
        profile,
        effective: serializeRuntimeLlmState(resolveLlmRuntimeSettings({ userId })),
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "读取用户 profile 失败") });
    }
  });

  app.put("/api/admin/llm/users/:userId/profile", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const userId = normalizePositiveInteger(req.params.userId);
    if (!userId) {
      res.status(400).json({ message: "user_id 不合法" });
      return;
    }

    try {
      const profile = saveLlmUserProfile(userId, req.body, req.authUser?.id || null);
      res.json({
        ok: true,
        profile,
        effective: serializeRuntimeLlmState(resolveLlmRuntimeSettings({ userId })),
      });
    } catch (error) {
      res.status(inferErrorStatus(error, 500)).json({ message: asMessage(error, "保存用户 profile 失败") });
    }
  });
}
