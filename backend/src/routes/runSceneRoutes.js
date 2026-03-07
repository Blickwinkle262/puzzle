export function registerRunSceneRoutes(app, deps) {
  const {
    db,
    ensureGenerationRunWritable,
    getGenerationJobByRunId,
    getGenerationSceneByIndex,
    listGenerationScenes,
    normalizeBoolean,
    normalizeIntegerInRange,
    normalizePositiveInteger,
    normalizeRunId,
    nowIso,
    refreshGenerationRunState,
    requireAdmin,
    requireAuth,
    requireCsrf,
    summarizeGenerationScenes,
  } = deps;

  app.patch("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      res.status(400).json({ message: "run_id 或 scene_index 不合法" });
      return;
    }

    const writable = ensureGenerationRunWritable(runId);
    if (writable.status !== 200) {
      res.status(writable.status).json({ message: writable.message });
      return;
    }

    const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
    if (!scene) {
      res.status(404).json({ message: "scene 不存在" });
      return;
    }

    const nextTitle = req.body?.title !== undefined ? String(req.body.title || "").trim().slice(0, 500) : null;
    const nextDescription = req.body?.description !== undefined ? String(req.body.description || "").trim().slice(0, 2000) : null;
    const nextStoryText = req.body?.story_text !== undefined ? String(req.body.story_text || "").trim().slice(0, 20000) : null;
    const nextPrompt = req.body?.image_prompt !== undefined ? String(req.body.image_prompt || "").trim().slice(0, 12000) : null;
    const hasSelected = req.body?.selected !== undefined;
    const nextSelected = hasSelected ? normalizeBoolean(req.body?.selected) : null;
    const nextRows = req.body?.grid_rows !== undefined ? normalizeIntegerInRange(req.body?.grid_rows, 2, 20) : null;
    const nextCols = req.body?.grid_cols !== undefined ? normalizeIntegerInRange(req.body?.grid_cols, 2, 20) : null;
    const nextTimeLimit = req.body?.time_limit_sec !== undefined ? normalizeIntegerInRange(req.body?.time_limit_sec, 30, 3600) : null;

    if ((req.body?.grid_rows !== undefined && !nextRows)
      || (req.body?.grid_cols !== undefined && !nextCols)
      || (req.body?.time_limit_sec !== undefined && !nextTimeLimit)) {
      res.status(400).json({ message: "rows/cols/time_limit_sec 参数非法" });
      return;
    }

    const changedPrompt = nextPrompt !== null && nextPrompt !== scene.image_prompt;
    const hasUpdate = nextTitle !== null
      || nextDescription !== null
      || nextStoryText !== null
      || nextPrompt !== null
      || hasSelected
      || nextRows !== null
      || nextCols !== null
      || nextTimeLimit !== null;

    if (!hasUpdate) {
      res.status(400).json({ message: "没有可更新字段" });
      return;
    }

    const now = nowIso();
    db.prepare(
      `
      UPDATE generation_job_scenes
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          story_text = COALESCE(?, story_text),
          image_prompt = COALESCE(?, image_prompt),
          selected = CASE WHEN ? IS NULL THEN selected ELSE ? END,
          grid_rows = COALESCE(?, grid_rows),
          grid_cols = COALESCE(?, grid_cols),
          time_limit_sec = COALESCE(?, time_limit_sec),
          image_status = CASE WHEN ? = 1 THEN 'pending' ELSE image_status END,
          image_url = CASE WHEN ? = 1 THEN '' ELSE image_url END,
          image_path = CASE WHEN ? = 1 THEN '' ELSE image_path END,
          error_message = CASE WHEN ? = 1 THEN '' ELSE error_message END,
          updated_at = ?
      WHERE run_id = ?
        AND scene_index = ?
        AND deleted_at IS NULL
    `,
    ).run(
      nextTitle,
      nextDescription,
      nextStoryText,
      nextPrompt,
      hasSelected ? 1 : null,
      hasSelected && nextSelected ? 1 : 0,
      nextRows,
      nextCols,
      nextTimeLimit,
      changedPrompt ? 1 : 0,
      changedPrompt ? 1 : 0,
      changedPrompt ? 1 : 0,
      changedPrompt ? 1 : 0,
      now,
      runId,
      sceneIndex,
    );

    if (changedPrompt) {
      db.prepare(
        `
        UPDATE generation_job_scene_image_attempts
        SET status = CASE
              WHEN status IN ('queued', 'running') THEN 'cancelled'
              ELSE status
            END,
            error_message = CASE
              WHEN status IN ('queued', 'running') THEN 'prompt updated before completion'
              ELSE error_message
            END,
            ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
            updated_at = ?
        WHERE run_id = ? AND scene_index = ?
      `,
      ).run(now, now, runId, sceneIndex);
    }

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      scene: latestScene,
      counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
    });
  });

  app.delete("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      res.status(400).json({ message: "run_id 或 scene_index 不合法" });
      return;
    }

    const writable = ensureGenerationRunWritable(runId);
    if (writable.status !== 200) {
      res.status(writable.status).json({ message: writable.message });
      return;
    }

    const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
    if (!scene) {
      res.status(404).json({ message: "scene 不存在" });
      return;
    }

    const now = nowIso();
    db.prepare(
      `
      UPDATE generation_job_scenes
      SET text_status = 'deleted',
          image_status = 'skipped',
          selected = 0,
          deleted_at = COALESCE(deleted_at, ?),
          updated_at = ?
      WHERE run_id = ?
        AND scene_index = ?
    `,
    ).run(now, now, runId, sceneIndex);

    db.prepare(
      `
      UPDATE generation_job_scene_image_attempts
      SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          error_message = CASE
            WHEN status IN ('queued', 'running') THEN 'scene deleted'
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ? AND scene_index = ?
    `,
    ).run(now, now, runId, sceneIndex);

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
    });
  });
}
