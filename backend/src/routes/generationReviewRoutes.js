import { AppError } from "../utils/appError.js";

export function registerGenerationReviewRoutes(app, deps) {
  const {
    getGenerationJobByRunId,
    hasGenerationSceneRows,
    listGenerationJobCandidates,
    listGenerationScenes,
    materializeGenerationScenesFromLegacy,
    normalizeBoolean,
    normalizeIntegerInRange,
    normalizePositiveInteger,
    publishSelectedReviewCandidates,
    requireAdmin,
    requireAuth,
    requireCsrf,
    serializeGenerationSceneAsLegacyCandidate,
    summarizeGenerationCandidates,
    summarizeGenerationScenes,
    summarizeLegacyCandidateCountsFromScenes,
    syncGenerationJobCandidatesFromSummary,
    updateReviewCandidateConfig,
  } = deps;

  const route = (handler) => (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };

  app.get("/api/admin/generation-jobs/:runId/review", requireAuth, requireAdmin, route((req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      throw new AppError(400, "review_invalid_run_id", "run_id 不能为空");
    }

    const job = getGenerationJobByRunId(runId);
    if (!job) {
      throw new AppError(404, "review_run_not_found", "run_id 不存在");
    }

    materializeGenerationScenesFromLegacy(runId, job);

    if (hasGenerationSceneRows(runId)) {
      const scenes = listGenerationScenes(runId, { include_deleted: false });
      const sceneCounts = summarizeGenerationScenes(scenes);
      const candidates = scenes.map((scene) => serializeGenerationSceneAsLegacyCandidate(scene));
      const counts = summarizeLegacyCandidateCountsFromScenes(sceneCounts);

      res.json({
        job,
        candidates,
        scenes,
        counts,
        scene_counts: sceneCounts,
        publish: {
          review_status: job.review_status,
          published_at: job.published_at,
        },
      });
      return;
    }

    if (job.status === "succeeded") {
      syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
    }

    const candidates = listGenerationJobCandidates(runId);
    const counts = summarizeGenerationCandidates(candidates);
    res.json({
      job,
      candidates,
      counts,
      publish: {
        review_status: job.review_status,
        published_at: job.published_at,
      },
    });
  }));

  app.patch("/api/admin/generation-jobs/:runId/candidates/:sceneIndex", requireAuth, requireCsrf, requireAdmin, route((req, res) => {
    const runId = String(req.params.runId || "").trim();
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      throw new AppError(400, "review_invalid_params", "run_id 或 scene_index 不合法");
    }

    const selectedRaw = req.body?.selected;
    const hasSelected = selectedRaw !== undefined;
    const selectedValue = hasSelected ? normalizeBoolean(selectedRaw) : null;

    const rowsRaw = req.body?.grid_rows;
    const colsRaw = req.body?.grid_cols;
    const hasRows = rowsRaw !== undefined;
    const hasCols = colsRaw !== undefined;

    const gridRows = hasRows ? normalizeIntegerInRange(rowsRaw, 2, 20) : null;
    const gridCols = hasCols ? normalizeIntegerInRange(colsRaw, 2, 20) : null;

    if ((hasRows && !gridRows) || (hasCols && !gridCols)) {
      throw new AppError(400, "review_invalid_grid", "grid_rows/grid_cols 必须在 2~20 之间");
    }

    if (!hasSelected && !hasRows && !hasCols) {
      throw new AppError(400, "review_missing_update_fields", "至少需要更新 selected 或 grid_rows/grid_cols");
    }

    const result = updateReviewCandidateConfig({
      runId,
      sceneIndex,
      hasSelected,
      selectedValue,
      gridRows,
      gridCols,
    });

    if (result.status !== 200) {
      throw new AppError(
        result.status,
        "review_candidate_update_rejected",
        result.message || "更新候选关卡失败",
      );
    }

    res.json(result.payload);
  }));

  app.post("/api/admin/generation-jobs/:runId/publish-selected", requireAuth, requireCsrf, requireAdmin, route((req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      throw new AppError(400, "review_invalid_run_id", "run_id 不能为空");
    }

    const result = publishSelectedReviewCandidates({ runId });
    if (result.status !== 200) {
      throw new AppError(
        result.status,
        "review_publish_rejected",
        result.message || "发布选中关卡失败",
      );
    }

    res.json(result.payload);
  }));
}
