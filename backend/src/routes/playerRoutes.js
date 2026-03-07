export function registerPlayerRoutes(app, deps) {
  const {
    VALID_PROGRESS_STATUS,
    asMessage,
    db,
    getLevelProgressMap,
    listStoriesForUser,
    loadStoryById,
    normalizeAttempts,
    normalizeContentVersion,
    normalizePositiveInteger,
    nowIso,
    requireAuth,
    requireCsrf,
    serializeProgressRow,
  } = deps;

  app.get("/api/stories", requireAuth, (req, res) => {
    try {
      const stories = listStoriesForUser(req.authUser.id);
      res.json({ stories });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取故事列表失败") });
    }
  });

  app.get("/api/stories/:storyId", requireAuth, (req, res) => {
    try {
      const story = loadStoryById(req.params.storyId);
      if (!story) {
        res.status(404).json({ message: "故事不存在" });
        return;
      }

      const levelProgress = getLevelProgressMap(req.authUser.id, story);
      res.json({
        story: {
          ...story,
          level_progress: levelProgress,
        },
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取故事详情失败") });
    }
  });

  app.get("/api/stories/:storyId/levels/:levelId", requireAuth, (req, res) => {
    try {
      const story = loadStoryById(req.params.storyId);
      if (!story) {
        res.status(404).json({ message: "故事不存在" });
        return;
      }

      const level = story.levels.find((item) => item.id === req.params.levelId);
      if (!level) {
        res.status(404).json({ message: "关卡不存在" });
        return;
      }

      const levelProgress = getLevelProgressMap(req.authUser.id, story);

      res.json({
        level,
        progress: levelProgress[level.id] ?? {
          status: "not_started",
        },
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取关卡失败") });
    }
  });

  app.put("/api/progress/levels/:levelId", requireAuth, requireCsrf, (req, res) => {
    const levelId = String(req.params.levelId || "").trim();
    const storyId = String(req.body?.story_id || "").trim();
    const status = String(req.body?.status || "in_progress").trim();

    if (!levelId || !storyId) {
      res.status(400).json({ message: "story_id 与 levelId 不能为空" });
      return;
    }

    if (!VALID_PROGRESS_STATUS.has(status)) {
      res.status(400).json({ message: "status 不合法" });
      return;
    }

    const story = loadStoryById(storyId);
    if (!story) {
      res.status(404).json({ message: "故事不存在" });
      return;
    }

    const levelConfig = story.levels.find((item) => item.id === levelId);
    if (!levelConfig) {
      res.status(404).json({ message: "关卡不存在" });
      return;
    }

    if (levelConfig.asset_missing) {
      res.status(409).json({ message: "关卡资源缺失，暂不可写入进度" });
      return;
    }

    const attemptsIncrement = normalizeAttempts(req.body?.attempts_increment, status === "in_progress" ? 1 : 0);
    const bestTimeMs = normalizePositiveInteger(req.body?.best_time_ms);
    const bestMoves = normalizePositiveInteger(req.body?.best_moves);
    const contentVersion = Number.isInteger(req.body?.content_version)
      ? Number(req.body.content_version)
      : normalizeContentVersion(levelConfig.content_version);

    const existing = db
      .prepare(
        "SELECT status, best_time_ms, best_moves, attempts, save_state_json, completed_at FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?",
      )
      .get(req.authUser.id, storyId, levelId);

    const now = nowIso();

    let saveStateJson = existing?.save_state_json ?? null;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "save_state_json")) {
      const raw = req.body.save_state_json;
      if (raw === null) {
        saveStateJson = null;
      } else if (typeof raw === "string") {
        saveStateJson = raw;
      } else {
        saveStateJson = JSON.stringify(raw);
      }
    }

    const completedAt =
      status === "completed" ? existing?.completed_at ?? now : existing?.completed_at ?? null;

    db.prepare(
      `
      INSERT INTO user_level_progress (
        user_id,
        story_id,
        level_id,
        status,
        best_time_ms,
        best_moves,
        attempts,
        last_played_at,
        completed_at,
        save_state_json,
        content_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, story_id, level_id) DO UPDATE SET
        status = CASE
          WHEN user_level_progress.status = 'completed' THEN 'completed'
          WHEN excluded.status = 'completed' THEN 'completed'
          ELSE excluded.status
        END,
        best_time_ms = CASE
          WHEN excluded.best_time_ms IS NULL THEN user_level_progress.best_time_ms
          WHEN user_level_progress.best_time_ms IS NULL THEN excluded.best_time_ms
          WHEN excluded.best_time_ms < user_level_progress.best_time_ms THEN excluded.best_time_ms
          ELSE user_level_progress.best_time_ms
        END,
        best_moves = CASE
          WHEN excluded.best_moves IS NULL THEN user_level_progress.best_moves
          WHEN user_level_progress.best_moves IS NULL THEN excluded.best_moves
          WHEN excluded.best_moves < user_level_progress.best_moves THEN excluded.best_moves
          ELSE user_level_progress.best_moves
        END,
        attempts = user_level_progress.attempts + excluded.attempts,
        last_played_at = excluded.last_played_at,
        completed_at = CASE
          WHEN user_level_progress.completed_at IS NOT NULL THEN user_level_progress.completed_at
          WHEN excluded.status = 'completed' THEN excluded.completed_at
          ELSE NULL
        END,
        save_state_json = excluded.save_state_json,
        content_version = excluded.content_version
    `,
    ).run(
      req.authUser.id,
      storyId,
      levelId,
      status,
      bestTimeMs,
      bestMoves,
      attemptsIncrement,
      now,
      completedAt,
      saveStateJson,
      contentVersion,
    );

    const row = db
      .prepare(
        "SELECT story_id, level_id, status, best_time_ms, best_moves, attempts, last_played_at, completed_at FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?",
      )
      .get(req.authUser.id, storyId, levelId);

    res.json({
      progress: serializeProgressRow(row),
    });
  });
}
