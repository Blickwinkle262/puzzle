export function registerGenerationReviewRetryRoutes(app, deps) {
  const {
    appendRunEvent,
    asMessage,
    createGenerationSceneImageAttempt,
    db,
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
    requireAdmin,
    requireAuth,
    requireCsrf,
    resolveGenerationRunImagesDir,
    resolveStoryAssetUrlFromFsPath,
    runStoryGeneratorAtomicCommand,
    serializeGenerationSceneAsLegacyCandidate,
    serializeGenerationSceneAttemptAsLegacyRetry,
    setGenerationSceneImageResult,
    setGenerationSceneImageRunning,
    syncGenerationJobCandidatesFromSummary,
  } = deps;

  app.post(
    "/api/admin/generation-jobs/:runId/candidates/:sceneIndex/retry-image",
    requireAuth,
    requireCsrf,
    requireAdmin,
    async (req, res) => {
      const runId = String(req.params.runId || "").trim();
      const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
      if (!runId || !sceneIndex) {
        res.status(400).json({ message: "run_id 或 scene_index 不合法" });
        return;
      }

      try {
        const job = getGenerationJobByRunId(runId);
        if (!job) {
          res.status(404).json({ message: "run_id 不存在" });
          return;
        }

        if (job.status !== "succeeded") {
          res.status(409).json({ message: "仅支持对 succeeded 任务执行重试" });
          return;
        }

        if (job.review_status === "published") {
          res.status(409).json({ message: "该任务已发布，审核页不允许继续重试" });
          return;
        }

        if (hasGenerationSceneRows(runId)) {
          const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
          if (!scene) {
            res.status(404).json({ message: "候选关卡不存在" });
            return;
          }

          if (!scene.image_prompt) {
            res.status(400).json({ message: "该候选缺少 image_prompt，无法重试" });
            return;
          }

          const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
          const now = nowIso();
          db.prepare(
            `
            UPDATE generation_jobs
            SET status = 'running',
                review_status = '',
                flow_stage = 'images_generating',
                error_message = '',
                exit_code = NULL,
                ended_at = NULL,
                updated_at = ?
            WHERE run_id = ?
          `,
          ).run(now, runId);

          const attemptRow = createGenerationSceneImageAttempt({
            runId,
            sceneIndex,
            provider: req.authUser?.username || "admin_retry",
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

          res.json({
            ok: true,
            retry_id: Number(latestAttempt?.id || 0),
            retry: serializeGenerationSceneAttemptAsLegacyRetry(latestAttempt),
            candidate: latestScene ? serializeGenerationSceneAsLegacyCandidate(latestScene) : null,
            job: latestJob,
          });
          return;
        }

        syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
        const candidate = listGenerationJobCandidates(runId).find((item) => item.scene_index === sceneIndex) || null;
        if (!candidate) {
          res.status(404).json({ message: "候选关卡不存在" });
          return;
        }

        if (!candidate.image_prompt) {
          res.status(400).json({ message: "该候选缺少 image_prompt，无法重试" });
          return;
        }

        const queued = enqueueGenerationCandidateImageRetry({
          runId,
          sceneIndex,
          requestedBy: req.authUser?.username || "",
        });

        appendRunEvent(job.event_log_file, {
          ts: nowIso(),
          event: "review.retry.queued",
          run_id: runId,
          scene_index: sceneIndex,
          retry_id: queued.retry_id,
        });

        res.json({
          ok: true,
          retry_id: queued.retry_id,
          retry: queued.retry,
          candidate: queued.candidate,
        });
      } catch (error) {
        res.status(500).json({ message: asMessage(error, "创建重试任务失败") });
      }
    },
  );
}
