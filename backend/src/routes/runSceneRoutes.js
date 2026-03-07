import { AppError } from "../utils/appError.js";

export function registerRunSceneRoutes(app, deps) {
  const {
    deleteGenerationSceneDraft,
    getGenerationJobByRunId,
    getGenerationSceneByIndex,
    listGenerationScenes,
    normalizePositiveInteger,
    normalizeRunId,
    refreshGenerationRunState,
    requireAdmin,
    requireAuth,
    requireCsrf,
    summarizeGenerationScenes,
    updateGenerationSceneDraft,
  } = deps;

  const route = (handler) => (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };

  app.patch("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, route((req, res) => {
    const runId = normalizeRunId(req.params.runId);
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      throw new AppError(400, "run_scene_invalid_params", "run_id 或 scene_index 不合法");
    }

    const result = updateGenerationSceneDraft({
      runId,
      sceneIndex,
      payload: req.body,
    });

    if (result.status !== 200) {
      throw new AppError(
        result.status,
        "run_scene_update_rejected",
        result.message || "更新场景草稿失败",
      );
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
  }));

  app.delete("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, route((req, res) => {
    const runId = normalizeRunId(req.params.runId);
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      throw new AppError(400, "run_scene_invalid_params", "run_id 或 scene_index 不合法");
    }

    const result = deleteGenerationSceneDraft({
      runId,
      sceneIndex,
    });

    if (result.status !== 200) {
      throw new AppError(
        result.status,
        "run_scene_delete_rejected",
        result.message || "删除场景草稿失败",
      );
    }

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
    });
  }));
}
