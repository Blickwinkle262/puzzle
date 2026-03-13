function normalizeParagraphsPayload(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
      .slice(0, 24);
  }

  if (typeof value === "string") {
    return value
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 24);
  }

  return [];
}

export function registerAdminStoryRoutes(app, deps) {
  const {
    appendAdminAuditLog,
    asMessage,
    buildAdminStoryMetaSnapshot,
    normalizeShortText,
    requireAdmin,
    requireAuth,
    requireCsrf,
    saveAdminStoryMetaOverride,
  } = deps;

  app.get("/api/admin/stories/:storyId/meta", requireAuth, requireAdmin, (req, res) => {
    const storyId = normalizeShortText(req.params?.storyId || "");
    if (!storyId) {
      res.status(400).json({ message: "storyId 不能为空" });
      return;
    }

    try {
      const snapshot = buildAdminStoryMetaSnapshot(storyId);
      if (!snapshot) {
        res.status(404).json({ message: "故事不存在" });
        return;
      }

      res.json({
        ok: true,
        ...snapshot,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取故事配置失败") });
    }
  });

  app.put("/api/admin/stories/:storyId/meta", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const storyId = normalizeShortText(req.params?.storyId || "");
    if (!storyId) {
      res.status(400).json({ message: "storyId 不能为空" });
      return;
    }

    const payload = {
      book_id: normalizeShortText(req.body?.book_id || ""),
      description: typeof req.body?.description === "string" ? req.body.description : "",
      story_overview_title: typeof req.body?.story_overview_title === "string" ? req.body.story_overview_title : "",
      story_overview_paragraphs: normalizeParagraphsPayload(req.body?.story_overview_paragraphs),
    };

    if (!payload.book_id) {
      res.status(400).json({ message: "book_id 不能为空" });
      return;
    }

    try {
      const beforeSnapshot = buildAdminStoryMetaSnapshot(storyId);
      if (!beforeSnapshot) {
        res.status(404).json({ message: "故事不存在" });
        return;
      }

      const afterSnapshot = saveAdminStoryMetaOverride(storyId, payload, req.authUser.id);
      if (!afterSnapshot) {
        res.status(500).json({ message: "更新后读取故事配置失败" });
        return;
      }

      appendAdminAuditLog({
        actorUserId: req.authUser.id,
        actorUsername: req.authUser.username,
        action: "story.meta.update",
        targetType: "story",
        targetId: storyId,
        before: beforeSnapshot,
        after: afterSnapshot,
        meta: {
          patch: payload,
        },
      });

      res.json({
        ok: true,
        ...afterSnapshot,
      });
    } catch (error) {
      const message = asMessage(error, "更新故事配置失败");
      if (message.includes("book_id") || message.includes("不存在") || message.includes("不能为空")) {
        res.status(400).json({ message });
        return;
      }
      res.status(500).json({ message });
    }
  });
}

