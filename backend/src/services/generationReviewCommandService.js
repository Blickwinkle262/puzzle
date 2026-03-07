export function createGenerationReviewCommandService(options = {}) {
  const {
    getGenerationJobByRunId,
    getGenerationSceneByIndex,
    hasGenerationSceneRows,
    isReviewModePayload,
    listGenerationJobCandidates,
    listGenerationScenes,
    nowIso,
    publishSelectedGenerationCandidates,
    readJsonSafe,
    refreshGenerationRunState,
    serializeGenerationSceneAsLegacyCandidate,
    summarizeGenerationCandidates,
    summarizeGenerationScenes,
    summarizeLegacyCandidateCountsFromScenes,
    syncGenerationJobCandidatesFromSummary,
    updateGenerationJobCandidate,
    markGenerationJobAsPublished,
    updateSceneCandidateSelectionAndGrid,
  } = options;

  function updateReviewCandidateConfig({ runId, sceneIndex, hasSelected, selectedValue, gridRows, gridCols }) {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      return { status: 404, message: "run_id 不存在" };
    }

    if (job.status !== "succeeded") {
      return { status: 409, message: "仅支持修改已完成任务的候选配置" };
    }

    if (job.review_status === "published") {
      return { status: 409, message: "该任务已发布，审核页不允许继续修改" };
    }

    if (hasGenerationSceneRows(runId)) {
      const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
      if (!scene) {
        return { status: 404, message: "候选关卡不存在" };
      }

      const now = nowIso();
      updateSceneCandidateSelectionAndGrid({
        runId,
        sceneIndex,
        hasSelected,
        selectedValue,
        gridRows,
        gridCols,
        now,
      });

      refreshGenerationRunState(runId);
      const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });

      return {
        status: 200,
        payload: {
          ok: true,
          candidate: latestScene ? serializeGenerationSceneAsLegacyCandidate(latestScene) : null,
        },
      };
    }

    const updated = updateGenerationJobCandidate({
      runId,
      sceneIndex,
      selected: hasSelected ? selectedValue : null,
      gridRows,
      gridCols,
    });

    if (!updated) {
      return { status: 404, message: "候选关卡不存在" };
    }

    return {
      status: 200,
      payload: {
        ok: true,
        candidate: updated,
      },
    };
  }

  function publishSelectedReviewCandidates({ runId }) {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      return { status: 404, message: "run_id 不存在" };
    }

    if (job.status !== "succeeded") {
      return { status: 409, message: "仅支持发布 succeeded 状态的任务" };
    }

    if (!isReviewModePayload(job.payload, job.dry_run)) {
      return { status: 409, message: "仅 review_mode 任务支持审核发布" };
    }

    if (job.review_status === "published") {
      const publishedAtHint = job.published_at ? `（${job.published_at}）` : "";
      return { status: 409, message: `该任务已发布${publishedAtHint}` };
    }

    if (job.dry_run) {
      return { status: 409, message: "dry_run 任务不支持发布" };
    }

    if (hasGenerationSceneRows(runId)) {
      const scenes = listGenerationScenes(runId, { include_deleted: false });
      const selectedCandidates = scenes.filter((item) => item.selected && item.image_status === "success");
      if (selectedCandidates.length === 0) {
        return { status: 400, message: "没有可发布的关卡，请先勾选至少一个成功关卡" };
      }

      const summary = readJsonSafe(job.summary_path) || {};
      const published = publishSelectedGenerationCandidates({
        runId,
        job,
        summary,
        selectedCandidates,
      });

      const now = nowIso();
      markGenerationJobAsPublished({ runId, now });

      const latestScenes = listGenerationScenes(runId, { include_deleted: true });
      return {
        status: 200,
        payload: {
          ok: true,
          run_id: runId,
          ...published,
          counts: summarizeLegacyCandidateCountsFromScenes(summarizeGenerationScenes(latestScenes)),
        },
      };
    }

    syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
    const allCandidates = listGenerationJobCandidates(runId);
    const selectedCandidates = allCandidates.filter((item) => item.selected && item.image_status === "success");
    if (selectedCandidates.length === 0) {
      return { status: 400, message: "没有可发布的关卡，请先勾选至少一个成功关卡" };
    }

    const summary = readJsonSafe(job.summary_path) || {};
    const published = publishSelectedGenerationCandidates({
      runId,
      job,
      summary,
      selectedCandidates,
    });

    const latestCandidates = listGenerationJobCandidates(runId);
    return {
      status: 200,
      payload: {
        ok: true,
        run_id: runId,
        ...published,
        counts: summarizeGenerationCandidates(latestCandidates),
      },
    };
  }

  return {
    publishSelectedReviewCandidates,
    updateReviewCandidateConfig,
  };
}
