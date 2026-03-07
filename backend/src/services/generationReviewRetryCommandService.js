import { AppError } from "../utils/appError.js";

export function createGenerationReviewRetryCommandService(options = {}) {
  const {
    appendRunEvent,
    asMessage,
    createGenerationSceneImageAttempt,
    enqueueGenerationCandidateImageRetry,
    finalizeGenerationSceneImageAttempt,
    getGenerationJobByRunId,
    getGenerationSceneByIndex,
    hasGenerationSceneRows,
    listGenerationJobCandidates,
    listGenerationSceneAttempts,
    nextGenerationSceneAttemptNo,
    normalizeBoolean,
    normalizeGenerationSceneImageStatus,
    normalizePositiveInteger,
    normalizePositiveNumber,
    nowIso,
    refreshGenerationRunState,
    resolveGenerationRunImagesDir,
    resolveStoryAssetUrlFromFsPath,
    runStoryGeneratorAtomicCommand,
    serializeGenerationSceneAsLegacyCandidate,
    serializeGenerationSceneAttemptAsLegacyRetry,
    setGenerationSceneImageResult,
    setGenerationSceneImageRunning,
    syncGenerationJobCandidatesFromSummary,
    markGenerationJobAsRetryingImages,
  } = options;

  async function retryGenerationCandidateImage({ runId, sceneIndex, requestedBy }) {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      throw new AppError(404, "review_retry_run_not_found", "run_id 不存在");
    }

    if (job.status !== "succeeded") {
      throw new AppError(409, "review_retry_invalid_status", "仅支持对 succeeded 任务执行重试");
    }

    if (job.review_status === "published") {
      throw new AppError(409, "review_retry_already_published", "该任务已发布，审核页不允许继续重试");
    }

    if (hasGenerationSceneRows(runId)) {
      const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
      if (!scene) {
        throw new AppError(404, "review_retry_scene_not_found", "候选关卡不存在");
      }

      if (!scene.image_prompt) {
        throw new AppError(400, "review_retry_missing_prompt", "该候选缺少 image_prompt，无法重试");
      }

      const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
      const now = nowIso();
      markGenerationJobAsRetryingImages({ runId, now });

      const attemptRow = createGenerationSceneImageAttempt({
        runId,
        sceneIndex,
        provider: requestedBy || "admin_retry",
        model: String(payload.image_model || "").trim(),
        imagePrompt: scene.image_prompt,
      });
      const attemptNo = Number(attemptRow?.attempt_no || nextGenerationSceneAttemptNo(runId, sceneIndex));
      setGenerationSceneImageRunning(runId, sceneIndex);
      const startedAtMs = Date.now();

      try {
        const atomicResult = await runStoryGeneratorAtomicCommand("generate-image", {
          target_date: job.target_date || now.slice(0, 10),
          images_dir: resolveGenerationRunImagesDir(runId),
          base_url: String(payload.base_url || "").trim() || undefined,
          image_model: String(payload.image_model || "").trim() || undefined,
          image_size: String(payload.image_size || "").trim() || undefined,
          watermark: normalizeBoolean(payload.watermark),
          concurrency: 1,
          timeout_sec: normalizePositiveNumber(payload.timeout_sec) || 120,
          poll_seconds: normalizePositiveNumber(payload.poll_seconds) || 2.5,
          poll_attempts: normalizePositiveInteger(payload.poll_attempts) || 40,
          scene: {
            scene_index: scene.scene_index,
            scene_id: scene.scene_id || scene.scene_index,
            title: scene.title,
            description: scene.description,
            story_text: scene.story_text,
            image_prompt: scene.image_prompt,
            mood: scene.mood,
            characters: scene.characters,
            grid_rows: scene.grid_rows,
            grid_cols: scene.grid_cols,
            time_limit_sec: scene.time_limit_sec,
          },
        });

        const firstResult = Array.isArray(atomicResult?.results) && atomicResult.results.length > 0
          ? atomicResult.results[0]
          : null;

        const imageStatus = normalizeGenerationSceneImageStatus(firstResult?.status || "failed");
        const imagePath = String(firstResult?.image_path || "").trim();
        const imageUrl = String(firstResult?.image_url || "").trim() || resolveStoryAssetUrlFromFsPath(imagePath);
        const errorMessage = imageStatus === "success"
          ? ""
          : String(firstResult?.error_message || "retry image generation failed").trim();

        finalizeGenerationSceneImageAttempt({
          runId,
          sceneIndex,
          attemptNo,
          status: imageStatus === "success" ? "succeeded" : "failed",
          imageUrl,
          imagePath,
          errorMessage,
          latencyMs: Date.now() - startedAtMs,
        });

        setGenerationSceneImageResult({
          runId,
          sceneIndex,
          status: imageStatus,
          imageUrl,
          imagePath,
          errorMessage,
        });
      } catch (retryError) {
        const errorMessage = asMessage(retryError, "retry image generation failed");
        finalizeGenerationSceneImageAttempt({
          runId,
          sceneIndex,
          attemptNo,
          status: "failed",
          imageUrl: "",
          imagePath: "",
          errorMessage,
          latencyMs: Date.now() - startedAtMs,
        });
        setGenerationSceneImageResult({
          runId,
          sceneIndex,
          status: "failed",
          imageUrl: "",
          imagePath: "",
          errorMessage,
        });
      }

      const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
      const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
      const attempts = listGenerationSceneAttempts(runId, sceneIndex);
      const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

      appendRunEvent(job.event_log_file, {
        ts: nowIso(),
        event: "review.retry.completed",
        run_id: runId,
        scene_index: sceneIndex,
        retry_id: Number(latestAttempt?.id || 0),
        status: String(latestAttempt?.status || ""),
        error_message: String(latestAttempt?.error_message || ""),
      });

      return {
        ok: true,
        retry_id: Number(latestAttempt?.id || 0),
        retry: serializeGenerationSceneAttemptAsLegacyRetry(latestAttempt),
        candidate: latestScene ? serializeGenerationSceneAsLegacyCandidate(latestScene) : null,
        job: latestJob,
      };
    }

    syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
    const candidate = listGenerationJobCandidates(runId).find((item) => item.scene_index === sceneIndex) || null;
    if (!candidate) {
      throw new AppError(404, "review_retry_candidate_not_found", "候选关卡不存在");
    }

    if (!candidate.image_prompt) {
      throw new AppError(400, "review_retry_missing_prompt", "该候选缺少 image_prompt，无法重试");
    }

    const queued = enqueueGenerationCandidateImageRetry({
      runId,
      sceneIndex,
      requestedBy: requestedBy || "",
    });

    appendRunEvent(job.event_log_file, {
      ts: nowIso(),
      event: "review.retry.queued",
      run_id: runId,
      scene_index: sceneIndex,
      retry_id: queued.retry_id,
    });

    return {
      ok: true,
      retry_id: queued.retry_id,
      retry: queued.retry,
      candidate: queued.candidate,
    };
  }

  return {
    retryGenerationCandidateImage,
  };
}
