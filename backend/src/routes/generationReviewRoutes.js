export function registerGenerationReviewRoutes(app, deps) {
  const {
    asMessage,
    db,
    getGenerationJobByRunId,
    getGenerationSceneByIndex,
    hasGenerationSceneRows,
    isReviewModePayload,
    listGenerationJobCandidates,
    listGenerationScenes,
    materializeGenerationScenesFromLegacy,
    normalizeBoolean,
    normalizeIntegerInRange,
    normalizePositiveInteger,
    nowIso,
    publishSelectedGenerationCandidates,
    readJsonSafe,
    refreshGenerationRunState,
    requireAdmin,
    requireAuth,
    requireCsrf,
    serializeGenerationSceneAsLegacyCandidate,
    summarizeGenerationCandidates,
    summarizeGenerationScenes,
    summarizeLegacyCandidateCountsFromScenes,
    syncGenerationJobCandidatesFromSummary,
    updateGenerationJobCandidate,
  } = deps;

  app.get("/api/admin/generation-jobs/:runId/review", requireAuth, requireAdmin, (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      res.status(400).json({ message: "run_id 不能为空" });
      return;
    }

    try {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
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
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取审核数据失败") });
    }
  });

  app.patch("/api/admin/generation-jobs/:runId/candidates/:sceneIndex", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const runId = String(req.params.runId || "").trim();
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      res.status(400).json({ message: "run_id 或 scene_index 不合法" });
      return;
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
      res.status(400).json({ message: "grid_rows/grid_cols 必须在 2~20 之间" });
      return;
    }

    if (!hasSelected && !hasRows && !hasCols) {
      res.status(400).json({ message: "至少需要更新 selected 或 grid_rows/grid_cols" });
      return;
    }

    try {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      if (job.status !== "succeeded") {
        res.status(409).json({ message: "仅支持修改已完成任务的候选配置" });
        return;
      }

      if (job.review_status === "published") {
        res.status(409).json({ message: "该任务已发布，审核页不允许继续修改" });
        return;
      }

      if (hasGenerationSceneRows(runId)) {
        const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
        if (!scene) {
          res.status(404).json({ message: "候选关卡不存在" });
          return;
        }

        const now = nowIso();
        db.prepare(
          `
          UPDATE generation_job_scenes
          SET selected = CASE WHEN ? IS NULL THEN selected ELSE ? END,
              grid_rows = COALESCE(?, grid_rows),
              grid_cols = COALESCE(?, grid_cols),
              updated_at = ?
          WHERE run_id = ? AND scene_index = ?
        `,
        ).run(
          hasSelected ? 1 : null,
          hasSelected && selectedValue ? 1 : 0,
          gridRows,
          gridCols,
          now,
          runId,
          sceneIndex,
        );

        refreshGenerationRunState(runId);
        const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
        res.json({
          ok: true,
          candidate: latestScene ? serializeGenerationSceneAsLegacyCandidate(latestScene) : null,
        });
        return;
      }

      const updated = updateGenerationJobCandidate({
        runId,
        sceneIndex,
        selected: hasSelected ? selectedValue : null,
        gridRows,
        gridCols,
      });

      if (!updated) {
        res.status(404).json({ message: "候选关卡不存在" });
        return;
      }

      res.json({ ok: true, candidate: updated });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "更新候选关卡失败") });
    }
  });

  app.post("/api/admin/generation-jobs/:runId/publish-selected", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      res.status(400).json({ message: "run_id 不能为空" });
      return;
    }

    try {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      if (job.status !== "succeeded") {
        res.status(409).json({ message: "仅支持发布 succeeded 状态的任务" });
        return;
      }

      if (!isReviewModePayload(job.payload, job.dry_run)) {
        res.status(409).json({ message: "仅 review_mode 任务支持审核发布" });
        return;
      }

      if (job.review_status === "published") {
        const publishedAtHint = job.published_at ? `（${job.published_at}）` : "";
        res.status(409).json({ message: `该任务已发布${publishedAtHint}` });
        return;
      }

      if (job.dry_run) {
        res.status(409).json({ message: "dry_run 任务不支持发布" });
        return;
      }

      if (hasGenerationSceneRows(runId)) {
        const scenes = listGenerationScenes(runId, { include_deleted: false });
        const selectedCandidates = scenes.filter((item) => item.selected && item.image_status === "success");
        if (selectedCandidates.length === 0) {
          res.status(400).json({ message: "没有可发布的关卡，请先勾选至少一个成功关卡" });
          return;
        }

        const summary = readJsonSafe(job.summary_path) || {};
        const published = publishSelectedGenerationCandidates({
          runId,
          job,
          summary,
          selectedCandidates,
        });

        const now = nowIso();
        db.prepare(
          `
          UPDATE generation_jobs
          SET status = 'succeeded',
              review_status = 'published',
              flow_stage = 'published',
              published_at = COALESCE(published_at, ?),
              ended_at = COALESCE(ended_at, ?),
              updated_at = ?
          WHERE run_id = ?
        `,
        ).run(now, now, now, runId);

        const latestScenes = listGenerationScenes(runId, { include_deleted: true });
        res.json({
          ok: true,
          run_id: runId,
          ...published,
          counts: summarizeLegacyCandidateCountsFromScenes(summarizeGenerationScenes(latestScenes)),
        });
        return;
      }

      syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
      const allCandidates = listGenerationJobCandidates(runId);
      const selectedCandidates = allCandidates.filter((item) => item.selected && item.image_status === "success");
      if (selectedCandidates.length === 0) {
        res.status(400).json({ message: "没有可发布的关卡，请先勾选至少一个成功关卡" });
        return;
      }

      const summary = readJsonSafe(job.summary_path) || {};
      const published = publishSelectedGenerationCandidates({
        runId,
        job,
        summary,
        selectedCandidates,
      });

      const latestCandidates = listGenerationJobCandidates(runId);
      res.json({
        ok: true,
        run_id: runId,
        ...published,
        counts: summarizeGenerationCandidates(latestCandidates),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "发布选中关卡失败") });
    }
  });
}
