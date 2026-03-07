import path from "node:path";

export function registerRunGenerateTextRoutes(app, deps) {
  const {
    STORY_GENERATOR_LOG_DIR,
    STORY_GENERATOR_SUMMARY_DIR,
    asMessage,
    buildGenerationSummaryFileName,
    createOrUpdateAtomicGenerationRun,
    db,
    ensureGenerationRunWritable,
    getGenerationJobByRunId,
    listGenerationScenes,
    materializeChapterTextToFile,
    normalizeGenerationSceneCharacters,
    normalizeIntegerInRange,
    normalizePositiveInteger,
    normalizeRunId,
    normalizeStoryFile,
    normalizeTargetDate,
    nowIso,
    refreshGenerationRunState,
    replaceGenerationScenes,
    requireAdmin,
    requireAuth,
    requireCsrf,
    runStoryGeneratorAtomicCommand,
    summarizeGenerationScenes,
    writeJsonAtomic,
  } = deps;

  app.post("/api/runs/:runId/generate-text", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    if (!runId) {
      res.status(400).json({ message: "run_id 不合法" });
      return;
    }

    const writable = ensureGenerationRunWritable(runId);
    if (writable.status !== 200 && writable.status !== 404) {
      res.status(writable.status).json({ message: writable.message });
      return;
    }

    const targetDate = normalizeTargetDate(req.body?.target_date || writable.job?.target_date);
    if (!targetDate) {
      res.status(400).json({ message: "target_date 必须是 YYYY-MM-DD" });
      return;
    }

    const chapterId = normalizePositiveInteger(req.body?.chapter_id);
    if (req.body?.chapter_id !== undefined && !chapterId) {
      res.status(400).json({ message: "chapter_id 必须是正整数" });
      return;
    }

    const inputStoryFile = normalizeStoryFile(req.body?.story_file);
    if (req.body?.story_file !== undefined && !inputStoryFile) {
      res.status(400).json({ message: "story_file 无效或不存在" });
      return;
    }

    if (chapterId && inputStoryFile) {
      res.status(400).json({ message: "chapter_id 与 story_file 只能二选一" });
      return;
    }

    const requestedSceneCount = normalizePositiveInteger(req.body?.scene_count);
    if (req.body?.scene_count !== undefined && (!requestedSceneCount || requestedSceneCount < 6)) {
      res.status(400).json({ message: "scene_count 必须是 >= 6 的正整数" });
      return;
    }

    let chapterSource = null;
    let storyFile = inputStoryFile || writable.job?.story_file || "";

    try {
      if (chapterId) {
        chapterSource = materializeChapterTextToFile(chapterId, runId);
        storyFile = chapterSource.story_file;
      }
    } catch (error) {
      const message = asMessage(error, "读取章节失败");
      res.status(message.includes("不存在") ? 404 : 400).json({ message });
      return;
    }

    if (!storyFile) {
      res.status(400).json({ message: "缺少 story_file，请选择 chapter 或传入 story_file" });
      return;
    }

    const existingPayload = writable.job?.payload && typeof writable.job.payload === "object"
      ? writable.job.payload
      : {};
    let candidateScenes = normalizePositiveInteger(req.body?.candidate_scenes)
      || normalizePositiveInteger(existingPayload.candidate_scenes)
      || requestedSceneCount
      || 12;
    let minScenes = normalizePositiveInteger(req.body?.min_scenes)
      || normalizePositiveInteger(existingPayload.min_scenes)
      || Math.max(6, candidateScenes - 2);
    let maxScenes = normalizePositiveInteger(req.body?.max_scenes)
      || normalizePositiveInteger(existingPayload.max_scenes)
      || requestedSceneCount
      || candidateScenes;

    if (requestedSceneCount) {
      candidateScenes = requestedSceneCount;
      minScenes = Math.max(6, requestedSceneCount - 2);
      maxScenes = requestedSceneCount;
    }

    if (maxScenes < minScenes) {
      res.status(400).json({ message: "max_scenes 必须 >= min_scenes" });
      return;
    }

    if (candidateScenes < maxScenes) {
      res.status(400).json({ message: "candidate_scenes 必须 >= max_scenes" });
      return;
    }

    const logFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.log`);
    const eventLogFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.events.jsonl`);
    const summaryPath = path.join(STORY_GENERATOR_SUMMARY_DIR, buildGenerationSummaryFileName(targetDate, runId));

    const mergedPayload = {
      ...existingPayload,
      run_id: runId,
      target_date: targetDate,
      story_file: storyFile,
      review_mode: true,
      dry_run: false,
      chapter_id: chapterSource?.chapter_id || chapterId || normalizePositiveInteger(existingPayload.chapter_id) || null,
      chapter_title: chapterSource?.chapter_title || String(existingPayload.chapter_title || ""),
      chapter_index: chapterSource?.chapter_index ?? normalizePositiveInteger(existingPayload.chapter_index) ?? null,
      chapter_char_count: chapterSource?.char_count ?? normalizePositiveInteger(existingPayload.chapter_char_count) ?? null,
      book_id: chapterSource?.book_id ?? normalizePositiveInteger(existingPayload.book_id) ?? null,
      book_title: chapterSource?.book_title || String(existingPayload.book_title || ""),
      candidate_scenes: candidateScenes,
      min_scenes: minScenes,
      max_scenes: maxScenes,
      scene_count: maxScenes,
      log_file: logFile,
      event_log_file: eventLogFile,
      summary_path: summaryPath,
    };

    try {
      createOrUpdateAtomicGenerationRun({
        runId,
        requestedBy: req.authUser.username,
        targetDate,
        storyFile,
        payload: mergedPayload,
        logFile,
        eventLogFile,
        summaryPath,
      });

      db.prepare("DELETE FROM generation_job_scene_image_attempts WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM generation_job_scenes WHERE run_id = ?").run(runId);

      const atomicResult = await runStoryGeneratorAtomicCommand("generate-text", {
        story_file: storyFile,
        target_date: targetDate,
        scene_count: maxScenes,
        candidate_scenes: candidateScenes,
        min_scenes: minScenes,
        max_scenes: maxScenes,
        max_source_chars: normalizePositiveInteger(req.body?.max_source_chars)
          || normalizePositiveInteger(existingPayload.max_source_chars)
          || 12000,
        base_url: String(req.body?.base_url || existingPayload.base_url || "").trim() || undefined,
        text_model: String(req.body?.text_model || existingPayload.text_model || "").trim() || undefined,
        prompts_dir: String(req.body?.prompts_dir || existingPayload.prompts_dir || "").trim() || undefined,
        system_prompt_file: String(req.body?.system_prompt_file || existingPayload.system_prompt_file || "").trim() || undefined,
        user_prompt_template_file: String(req.body?.user_prompt_template_file || existingPayload.user_prompt_template_file || "").trim() || undefined,
        image_prompt_suffix_file: String(req.body?.image_prompt_suffix_file || existingPayload.image_prompt_suffix_file || "").trim() || undefined,
      });

      const scenes = Array.isArray(atomicResult?.scenes)
        ? atomicResult.scenes
        : [];
      if (scenes.length === 0) {
        throw new Error("文本生成结果为空（scenes=0）");
      }

      const sceneRows = scenes.map((item, index) => ({
        scene_index: normalizePositiveInteger(item.scene_index) || index + 1,
        scene_id: normalizePositiveInteger(item.scene_id) || normalizePositiveInteger(item.scene_index) || index + 1,
        title: String(item.title || "").trim(),
        description: String(item.description || "").trim(),
        story_text: String(item.story_text || "").trim(),
        image_prompt: String(item.image_prompt || "").trim(),
        mood: String(item.mood || "").trim(),
        characters: normalizeGenerationSceneCharacters(item.characters),
        grid_rows: normalizeIntegerInRange(item.grid_rows, 2, 20) || 6,
        grid_cols: normalizeIntegerInRange(item.grid_cols, 2, 20) || 4,
        time_limit_sec: normalizeIntegerInRange(item.time_limit_sec, 30, 3600) || 180,
        text_status: "ready",
        image_status: "pending",
        image_url: "",
        image_path: "",
        error_message: "",
        selected: true,
      }));

      const storedScenes = replaceGenerationScenes(runId, sceneRows, "pipeline");

      const now = nowIso();
      const nextPayload = {
        ...mergedPayload,
        title: String(atomicResult.title || "").trim(),
        description: String(atomicResult.description || "").trim(),
        story_overview_title: String(atomicResult.story_overview_title || "").trim(),
        story_overview_paragraphs: Array.isArray(atomicResult.story_overview_paragraphs)
          ? atomicResult.story_overview_paragraphs.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
          : [],
        source_file: String(atomicResult.source_file || "").trim() || storyFile,
      };

      db.prepare(
        `
        UPDATE generation_jobs
        SET status = 'running',
            review_status = '',
            flow_stage = 'text_ready',
            payload_json = ?,
            error_message = '',
            exit_code = NULL,
            published_at = NULL,
            ended_at = NULL,
            updated_at = ?
        WHERE run_id = ?
      `,
      ).run(JSON.stringify(nextPayload), now, runId);

      writeJsonAtomic(summaryPath, {
        run_id: runId,
        target_date: targetDate,
        review_mode: true,
        review_status: "pending_review",
        title: String(atomicResult.title || "").trim(),
        description: String(atomicResult.description || "").trim(),
        story_overview_title: String(atomicResult.story_overview_title || "").trim(),
        story_overview_paragraphs: Array.isArray(atomicResult.story_overview_paragraphs)
          ? atomicResult.story_overview_paragraphs.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
          : [],
        source_file: String(atomicResult.source_file || "").trim(),
        total_scenes: storedScenes.length,
        generated_scenes: 0,
        candidate_counts: {
          total: storedScenes.length,
          success: 0,
          failed: 0,
          selected: storedScenes.length,
        },
        candidates: storedScenes.map((scene) => ({
          scene_index: scene.scene_index,
          scene_id: scene.scene_id,
          title: scene.title,
          description: scene.description,
          story_text: scene.story_text,
          image_prompt: scene.image_prompt,
          mood: scene.mood,
          characters: scene.characters,
          grid_rows: scene.grid_rows,
          grid_cols: scene.grid_cols,
          time_limit_sec: scene.time_limit_sec,
          image_status: "pending",
          image_url: "",
          image_path: "",
          error_message: "",
          selected: scene.selected,
        })),
      });

      const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
      const latestScenes = listGenerationScenes(runId, { include_deleted: true });
      res.json({
        ok: true,
        run_id: runId,
        job: latestJob,
        scenes: latestScenes,
        counts: summarizeGenerationScenes(latestScenes),
      });
    } catch (error) {
      const now = nowIso();
      db.prepare(
        `
        UPDATE generation_jobs
        SET status = 'failed',
            review_status = '',
            flow_stage = 'failed',
            error_message = ?,
            exit_code = 1,
            ended_at = COALESCE(ended_at, ?),
            updated_at = ?
        WHERE run_id = ?
      `,
      ).run(asMessage(error, "文本生成失败"), now, now, runId);

      res.status(500).json({ message: asMessage(error, "文本生成失败") });
    }
  });
}
