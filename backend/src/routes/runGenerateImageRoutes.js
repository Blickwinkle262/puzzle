export function registerRunGenerateImageRoutes(app, deps) {
  const {
    asMessage,
    createGenerationSceneImageAttempt,
    db,
    ensureGenerationRunWritable,
    finalizeGenerationSceneImageAttempt,
    getGenerationJobByRunId,
    getGenerationSceneByIndex,
    listGenerationSceneAttempts,
    listGenerationScenes,
    nextGenerationSceneAttemptNo,
    normalizeBoolean,
    normalizeGenerationSceneImageStatus,
    normalizePositiveInteger,
    normalizePositiveNumber,
    normalizeRunId,
    nowIso,
    refreshGenerationRunState,
    resolveLlmRuntimeSettings,
    requireAdmin,
    requireAuth,
    requireCsrf,
    resolveGenerationRunImagesDir,
    resolveStoryAssetUrlFromFsPath,
    runStoryGeneratorAtomicCommand,
    setGenerationSceneImageResult,
    setGenerationSceneImageRunning,
    summarizeGenerationScenes,
  } = deps;

  app.post("/api/runs/:runId/scenes/:sceneIndex/generate-image", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
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

    if (scene.text_status !== "ready") {
      res.status(409).json({ message: "scene 文案未就绪，无法生成图片" });
      return;
    }

    const payload = writable.job?.payload && typeof writable.job.payload === "object" ? writable.job.payload : {};
    const runtimeLlm = resolveLlmRuntimeSettings({
      userId: req.authUser?.id,
      purpose: "image",
    });
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
      provider: "atomic_cli",
      model: String(req.body?.image_model || payload.image_model || runtimeLlm.image_model || "").trim(),
      imagePrompt: scene.image_prompt,
    });
    const attemptNo = Number(attemptRow?.attempt_no || nextGenerationSceneAttemptNo(runId, sceneIndex));
    setGenerationSceneImageRunning(runId, sceneIndex);

    const startedAtMs = Date.now();

    try {
      const atomicResult = await runStoryGeneratorAtomicCommand("generate-image", {
        target_date: writable.job?.target_date || now.slice(0, 10),
        images_dir: resolveGenerationRunImagesDir(runId),
        base_url: String(req.body?.base_url || payload.base_url || runtimeLlm.api_base_url || "").trim() || undefined,
        image_model: String(req.body?.image_model || payload.image_model || runtimeLlm.image_model || "").trim() || undefined,
        image_size: String(req.body?.image_size || payload.image_size || "").trim() || undefined,
        watermark: req.body?.watermark !== undefined ? normalizeBoolean(req.body?.watermark) : normalizeBoolean(payload.watermark),
        concurrency: 1,
        timeout_sec: normalizePositiveNumber(req.body?.timeout_sec) || normalizePositiveNumber(payload.timeout_sec) || 120,
        poll_seconds: normalizePositiveNumber(req.body?.poll_seconds) || normalizePositiveNumber(payload.poll_seconds) || 2.5,
        poll_attempts: normalizePositiveInteger(req.body?.poll_attempts) || normalizePositiveInteger(payload.poll_attempts) || 40,
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
      }, {
        llmRuntime: runtimeLlm,
        userId: req.authUser?.id,
      });

      const firstResult = Array.isArray(atomicResult?.results) && atomicResult.results.length > 0
        ? atomicResult.results[0]
        : null;

      const imageStatus = normalizeGenerationSceneImageStatus(firstResult?.status || "failed");
      const imagePath = String(firstResult?.image_path || "").trim();
      const imageUrl = String(firstResult?.image_url || "").trim() || resolveStoryAssetUrlFromFsPath(imagePath);
      const errorMessage = imageStatus === "success"
        ? ""
        : String(firstResult?.error_message || "image generation failed").trim();

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

      const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
      const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
      const attempts = listGenerationSceneAttempts(runId, sceneIndex);

      res.json({
        ok: true,
        run_id: runId,
        job: latestJob,
        scene: latestScene,
        attempt: attempts.length > 0 ? attempts[attempts.length - 1] : null,
        counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
      });
    } catch (error) {
      const errorMessage = asMessage(error, "生成图片失败");
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
      refreshGenerationRunState(runId);
      res.status(500).json({ message: errorMessage });
    }
  });

  app.post("/api/runs/:runId/scenes/generate-images-batch", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    if (!runId) {
      res.status(400).json({ message: "run_id 不合法" });
      return;
    }

    const writable = ensureGenerationRunWritable(runId);
    if (writable.status !== 200) {
      res.status(writable.status).json({ message: writable.message });
      return;
    }

    const payload = writable.job?.payload && typeof writable.job.payload === "object" ? writable.job.payload : {};
    const runtimeLlm = resolveLlmRuntimeSettings({
      userId: req.authUser?.id,
      purpose: "image",
    });
    const sceneIndexList = Array.isArray(req.body?.scene_indexes)
      ? req.body.scene_indexes.map((item) => normalizePositiveInteger(item)).filter((item) => Boolean(item))
      : [];
    const sceneIndexSet = new Set(sceneIndexList);

    const allScenes = listGenerationScenes(runId, { include_deleted: false });
    const targetScenes = allScenes
      .filter((scene) => scene.text_status === "ready")
      .filter((scene) => sceneIndexSet.size === 0 || sceneIndexSet.has(scene.scene_index))
      .filter((scene) => scene.image_status === "pending" || scene.image_status === "failed" || scene.image_status === "skipped");

    if (targetScenes.length === 0) {
      res.status(400).json({ message: "没有可生成图片的 scene" });
      return;
    }

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

    const attemptsBySceneIndex = new Map();
    for (const scene of targetScenes) {
      const attemptRow = createGenerationSceneImageAttempt({
        runId,
        sceneIndex: scene.scene_index,
        provider: "atomic_cli_batch",
        model: String(req.body?.image_model || payload.image_model || runtimeLlm.image_model || "").trim(),
        imagePrompt: scene.image_prompt,
      });
      attemptsBySceneIndex.set(scene.scene_index, Number(attemptRow?.attempt_no || 1));
      setGenerationSceneImageRunning(runId, scene.scene_index);
    }

    const startedAtMs = Date.now();

    try {
      const atomicResult = await runStoryGeneratorAtomicCommand("generate-images", {
        target_date: writable.job?.target_date || now.slice(0, 10),
        images_dir: resolveGenerationRunImagesDir(runId),
        base_url: String(req.body?.base_url || payload.base_url || runtimeLlm.api_base_url || "").trim() || undefined,
        image_model: String(req.body?.image_model || payload.image_model || runtimeLlm.image_model || "").trim() || undefined,
        image_size: String(req.body?.image_size || payload.image_size || "").trim() || undefined,
        watermark: req.body?.watermark !== undefined ? normalizeBoolean(req.body?.watermark) : normalizeBoolean(payload.watermark),
        concurrency: normalizePositiveInteger(req.body?.concurrency) || normalizePositiveInteger(payload.concurrency) || 3,
        timeout_sec: normalizePositiveNumber(req.body?.timeout_sec) || normalizePositiveNumber(payload.timeout_sec) || 120,
        poll_seconds: normalizePositiveNumber(req.body?.poll_seconds) || normalizePositiveNumber(payload.poll_seconds) || 2.5,
        poll_attempts: normalizePositiveInteger(req.body?.poll_attempts) || normalizePositiveInteger(payload.poll_attempts) || 40,
        scenes: targetScenes.map((scene) => ({
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
        })),
      }, {
        llmRuntime: runtimeLlm,
        userId: req.authUser?.id,
      });

      const resultRows = Array.isArray(atomicResult?.results) ? atomicResult.results : [];
      const resultBySceneIndex = new Map();
      for (const item of resultRows) {
        const sceneIndex = normalizePositiveInteger(item.scene_index);
        if (sceneIndex) {
          resultBySceneIndex.set(sceneIndex, item);
        }
      }

      for (const scene of targetScenes) {
        const result = resultBySceneIndex.get(scene.scene_index) || null;
        const imageStatus = normalizeGenerationSceneImageStatus(result?.status || "failed");
        const imagePath = String(result?.image_path || "").trim();
        const imageUrl = String(result?.image_url || "").trim() || resolveStoryAssetUrlFromFsPath(imagePath);
        const errorMessage = imageStatus === "success"
          ? ""
          : String(result?.error_message || "image generation failed").trim();
        const attemptNo = Number(attemptsBySceneIndex.get(scene.scene_index) || 1);

        finalizeGenerationSceneImageAttempt({
          runId,
          sceneIndex: scene.scene_index,
          attemptNo,
          status: imageStatus === "success" ? "succeeded" : "failed",
          imageUrl,
          imagePath,
          errorMessage,
          latencyMs: Date.now() - startedAtMs,
        });

        setGenerationSceneImageResult({
          runId,
          sceneIndex: scene.scene_index,
          status: imageStatus,
          imageUrl,
          imagePath,
          errorMessage,
        });
      }

      const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
      const latestScenes = listGenerationScenes(runId, { include_deleted: true });

      res.json({
        ok: true,
        run_id: runId,
        job: latestJob,
        scenes: latestScenes,
        counts: summarizeGenerationScenes(latestScenes),
        processed: targetScenes.length,
      });
    } catch (error) {
      const errorMessage = asMessage(error, "批量生成图片失败");
      for (const scene of targetScenes) {
        const attemptNo = Number(attemptsBySceneIndex.get(scene.scene_index) || 1);
        finalizeGenerationSceneImageAttempt({
          runId,
          sceneIndex: scene.scene_index,
          attemptNo,
          status: "failed",
          imageUrl: "",
          imagePath: "",
          errorMessage,
          latencyMs: Date.now() - startedAtMs,
        });
        setGenerationSceneImageResult({
          runId,
          sceneIndex: scene.scene_index,
          status: "failed",
          imageUrl: "",
          imagePath: "",
          errorMessage,
        });
      }

      refreshGenerationRunState(runId);
      res.status(500).json({ message: errorMessage });
    }
  });
}
