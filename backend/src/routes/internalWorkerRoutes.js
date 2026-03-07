export function registerInternalWorkerRoutes(app, deps) {
  const {
    appendRunEvent,
    asMessage,
    claimGenerationCandidateImageRetry,
    claimGenerationJob,
    completeGenerationCandidateImageRetry,
    completeGenerationJobByRunId,
    getGenerationJobByRunId,
    normalizeErrorMessage,
    normalizeGenerationJobStatus,
    normalizeGenerationReviewStatus,
    normalizePositiveInteger,
    normalizeShortText,
    nowIso,
    requireWorkerAuth,
  } = deps;

  app.post("/api/internal/generation-jobs/claim", requireWorkerAuth, (_req, res) => {
    try {
      const job = claimGenerationJob();
      res.json({ job });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "领取任务失败") });
    }
  });

  app.post("/api/internal/generation-jobs/:runId/complete", requireWorkerAuth, (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      res.status(400).json({ message: "run_id 不能为空" });
      return;
    }

    const status = normalizeGenerationJobStatus(req.body?.status);
    if (!status) {
      res.status(400).json({ message: "status 必须是 succeeded/failed/cancelled" });
      return;
    }

    const rawExitCode = req.body?.exit_code;
    let exitCode = null;
    if (rawExitCode !== undefined && rawExitCode !== null && String(rawExitCode).trim() !== "") {
      const parsedExitCode = Number(rawExitCode);
      if (!Number.isInteger(parsedExitCode)) {
        res.status(400).json({ message: "exit_code 必须是整数或 null" });
        return;
      }
      exitCode = parsedExitCode;
    }

    const errorMessage = normalizeErrorMessage(req.body?.error_message);
    const storyId = normalizeShortText(req.body?.story_id);
    const reviewStatus = normalizeGenerationReviewStatus(req.body?.review_status);

    try {
      const job = completeGenerationJobByRunId(runId, {
        status,
        exitCode,
        errorMessage,
        storyId,
        reviewStatus,
      });
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }
      res.json({ job });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "更新任务状态失败") });
    }
  });

  app.post("/api/internal/generation-candidate-retries/claim", requireWorkerAuth, (_req, res) => {
    try {
      const task = claimGenerationCandidateImageRetry();
      res.json({ task });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "领取重试任务失败") });
    }
  });

  app.post("/api/internal/generation-candidate-retries/:retryId/complete", requireWorkerAuth, (req, res) => {
    const retryId = normalizePositiveInteger(req.params.retryId);
    if (!retryId) {
      res.status(400).json({ message: "retry_id 不合法" });
      return;
    }

    const status = String(req.body?.status || "").trim();
    if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
      res.status(400).json({ message: "status 必须是 succeeded/failed/cancelled" });
      return;
    }

    const imageUrl = String(req.body?.image_url || "").trim();
    const imagePath = String(req.body?.image_path || "").trim();
    const errorMessage = normalizeErrorMessage(req.body?.error_message);

    try {
      const result = completeGenerationCandidateImageRetry({
        retryId,
        status,
        imageUrl,
        imagePath,
        errorMessage,
      });

      if (!result) {
        res.status(404).json({ message: "retry_id 不存在" });
        return;
      }

      const runId = String(result.retry?.run_id || "").trim();
      if (runId) {
        const job = getGenerationJobByRunId(runId);
        appendRunEvent(job?.event_log_file, {
          ts: nowIso(),
          event: "review.retry.completed",
          run_id: runId,
          retry_id: Number(result.retry?.retry_id || 0),
          scene_index: Number(result.retry?.scene_index || 0),
          status: String(result.retry?.status || status),
          error_message: String(result.retry?.error_message || ""),
        });
      }

      res.json({ ok: true, retry: result.retry, candidate: result.candidate });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "更新重试任务失败") });
    }
  });
}
