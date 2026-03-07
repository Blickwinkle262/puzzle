export function createPlayerProgressService(options = {}) {
  const {
    asMessage,
    db,
    loadStoryCatalog,
    loadStoryById,
    buildGeneratedStoryBookMap,
    resolveDefaultStoryBookMeta,
    resolveStoryBookMeta,
    normalizeContentVersion,
  } = options;

  function listStoriesForUser(userId) {
    const catalog = loadStoryCatalog();
    const stories = [];
    const generatedStoryBookMap = buildGeneratedStoryBookMap();
    const defaultBookMeta = resolveDefaultStoryBookMeta(generatedStoryBookMap);

    for (const entry of catalog.stories) {
      const story = loadStoryById(entry.id, catalog);
      if (!story) {
        continue;
      }

      const rows = db
        .prepare(
          "SELECT story_id, level_id, status, last_played_at FROM user_level_progress WHERE user_id = ? AND story_id = ?",
        )
        .all(userId, story.id);

      const validLevelIds = new Set(story.levels.map((item) => item.id));
      let completedLevels = 0;
      let lastLevelId = null;
      let lastPlayedAt = "";

      for (const row of rows) {
        if (!validLevelIds.has(row.level_id)) {
          continue;
        }

        if (row.status === "completed") {
          completedLevels += 1;
        }

        if (typeof row.last_played_at === "string" && row.last_played_at > lastPlayedAt) {
          lastPlayedAt = row.last_played_at;
          lastLevelId = row.level_id;
        }
      }

      const bookMeta = resolveStoryBookMeta(entry, story, generatedStoryBookMap, defaultBookMeta);

      stories.push({
        id: story.id,
        title: story.title,
        description: story.description,
        cover: story.cover,
        cover_missing: story.cover_missing,
        book_id: bookMeta.book_id,
        book_title: bookMeta.book_title,
        total_levels: story.levels.length,
        completed_levels: completedLevels,
        last_level_id: lastLevelId,
      });
    }

    return stories;
  }

  function getLevelProgressMap(userId, storyOrStoryId) {
    const story = typeof storyOrStoryId === "string" ? loadStoryById(storyOrStoryId) : storyOrStoryId;
    if (!story) {
      return {};
    }

    const rows = db
      .prepare(
        "SELECT story_id, level_id, status, best_time_ms, best_moves, attempts, last_played_at, completed_at, content_version FROM user_level_progress WHERE user_id = ? AND story_id = ?",
      )
      .all(userId, story.id);

    const rowMap = new Map(rows.map((row) => [row.level_id, row]));
    const map = {};

    for (const level of story.levels) {
      const row = rowMap.get(level.id);
      if (!row) {
        continue;
      }
      map[level.id] = serializeProgressRow(row);
    }

    return map;
  }

  function serializeProgressRow(row) {
    return {
      story_id: row.story_id,
      level_id: row.level_id,
      status: row.status,
      best_time_ms: row.best_time_ms ?? undefined,
      best_moves: row.best_moves ?? undefined,
      attempts: row.attempts ?? 0,
      last_played_at: row.last_played_at ?? undefined,
      completed_at: row.completed_at ?? undefined,
      content_version: normalizeContentVersion(row.content_version),
    };
  }

  function runProgressMaintenanceForUser(userId) {
    try {
      const catalog = loadStoryCatalog();
      for (const entry of catalog.stories) {
        const story = loadStoryById(entry.id, catalog);
        if (!story) {
          continue;
        }
        migrateLegacyProgressForStory(userId, story);
        reconcileProgressContentVersionForStory(userId, story);
      }
    } catch (error) {
      console.warn("progress maintenance failed:", asMessage(error, "unknown"));
    }
  }

  function reconcileProgressContentVersionForStory(userId, story) {
    const rows = db
      .prepare("SELECT level_id, content_version FROM user_level_progress WHERE user_id = ? AND story_id = ?")
      .all(userId, story.id);

    const versionByLevel = new Map(story.levels.map((level) => [level.id, normalizeContentVersion(level.content_version)]));

    for (const row of rows) {
      const targetVersion = versionByLevel.get(row.level_id);
      if (!targetVersion) {
        continue;
      }

      const currentVersion = normalizeContentVersion(row.content_version);
      if (currentVersion === targetVersion) {
        continue;
      }

      db.prepare(
        "UPDATE user_level_progress SET content_version = ?, save_state_json = NULL WHERE user_id = ? AND story_id = ? AND level_id = ?",
      ).run(targetVersion, userId, story.id, row.level_id);
    }
  }

  function migrateLegacyProgressForStory(userId, story) {
    for (const level of story.levels) {
      if (!Array.isArray(level.legacy_ids) || level.legacy_ids.length === 0) {
        continue;
      }

      for (const legacyId of level.legacy_ids) {
        if (!legacyId || legacyId === level.id) {
          continue;
        }

        const oldRow = db
          .prepare(
            "SELECT status, best_time_ms, best_moves, attempts, last_played_at, completed_at, save_state_json, content_version FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?",
          )
          .get(userId, story.id, legacyId);

        if (!oldRow) {
          continue;
        }

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
          last_played_at = CASE
            WHEN user_level_progress.last_played_at IS NULL THEN excluded.last_played_at
            WHEN excluded.last_played_at IS NULL THEN user_level_progress.last_played_at
            WHEN excluded.last_played_at > user_level_progress.last_played_at THEN excluded.last_played_at
            ELSE user_level_progress.last_played_at
          END,
          completed_at = CASE
            WHEN user_level_progress.completed_at IS NOT NULL THEN user_level_progress.completed_at
            WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at
            ELSE NULL
          END,
          save_state_json = COALESCE(excluded.save_state_json, user_level_progress.save_state_json),
          content_version = user_level_progress.content_version
      `,
        ).run(
          userId,
          story.id,
          level.id,
          oldRow.status,
          oldRow.best_time_ms,
          oldRow.best_moves,
          oldRow.attempts,
          oldRow.last_played_at,
          oldRow.completed_at,
          oldRow.save_state_json,
          normalizeContentVersion(oldRow.content_version),
        );

        db.prepare("DELETE FROM user_level_progress WHERE user_id = ? AND story_id = ? AND level_id = ?").run(
          userId,
          story.id,
          legacyId,
        );
      }
    }
  }

  return {
    getLevelProgressMap,
    listStoriesForUser,
    runProgressMaintenanceForUser,
    serializeProgressRow,
  };
}
