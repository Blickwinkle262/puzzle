import fs from "node:fs";

function readTextIfExists(filePath) {
  const target = String(filePath || "").trim();
  if (!target) {
    return "";
  }
  try {
    return fs.readFileSync(target, "utf-8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

function sanitizeRunPayloadForResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const next = { ...payload };

  if (typeof next.chapter_text_override === "string") {
    if (!next.chapter_text_override_chars) {
      next.chapter_text_override_chars = next.chapter_text_override.length;
    }
    next.has_chapter_text_override = Boolean(next.chapter_text_override_file || next.chapter_text_override.length > 0);
    delete next.chapter_text_override;
  }

  if (typeof next.system_prompt_text === "string") {
    if (!next.system_prompt_chars) {
      next.system_prompt_chars = next.system_prompt_text.length;
    }
    next.has_system_prompt_override = Boolean(next.system_prompt_file || next.system_prompt_text.length > 0);
    delete next.system_prompt_text;
  }

  if (typeof next.user_prompt_template_text === "string") {
    if (!next.user_prompt_template_chars) {
      next.user_prompt_template_chars = next.user_prompt_template_text.length;
    }
    next.has_user_prompt_template_override = Boolean(next.user_prompt_template_file || next.user_prompt_template_text.length > 0);
    delete next.user_prompt_template_text;
  }

  if (typeof next.image_prompt_suffix_text === "string") {
    if (!next.image_prompt_suffix_chars) {
      next.image_prompt_suffix_chars = next.image_prompt_suffix_text.length;
    }
    next.has_image_prompt_suffix_override = Boolean(next.image_prompt_suffix_file || next.image_prompt_suffix_text.length > 0);
    delete next.image_prompt_suffix_text;
  }

  return next;
}

export function registerRunLifecycleRoutes(app, deps) {
  const {
    asMessage,
    cancelGenerationRun,
    db,
    deleteGenerationRun,
    ensureGenerationRunWritable,
    getGenerationJobByRunId,
    hasGenerationSceneRows,
    listGenerationJobCandidates,
    listGenerationJobs,
    listGenerationSceneAttempts,
    listGenerationScenes,
    materializeGenerationScenesFromLegacy,
    normalizeGenerationSceneImageStatus,
    normalizeRunId,
    nowIso,
    publishSelectedGenerationCandidates,
    readJsonSafe,
    requireAdmin,
    requireAuth,
    requireCsrf,
    summarizeGenerationScenes,
    syncGenerationJobCandidatesFromSummary,
  } = deps;

  app.get("/api/runs", requireAuth, requireAdmin, (_req, res) => {
    try {
      const runs = listGenerationJobs(60);
      res.json({ runs });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 runs 失败") });
    }
  });

  app.get("/api/runs/:runId", requireAuth, requireAdmin, (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    if (!runId) {
      res.status(400).json({ message: "run_id 不合法" });
      return;
    }

    try {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      const payload = job.payload && typeof job.payload === "object"
        ? sanitizeRunPayloadForResponse(job.payload)
        : undefined;
      const safeJob = payload ? { ...job, payload } : job;

      materializeGenerationScenesFromLegacy(runId, job);

      const scenes = listGenerationScenes(runId, { include_deleted: true });
      const attempts = listGenerationSceneAttempts(runId);
      const attemptsByScene = {};
      for (const item of attempts) {
        const key = String(item.scene_index || 0);
        const bucket = attemptsByScene[key] || [];
        bucket.push(item);
        attemptsByScene[key] = bucket;
      }

      let compatibleScenes = scenes;
      if (compatibleScenes.length === 0 && !hasGenerationSceneRows(runId)) {
        if (job.status === "succeeded") {
          syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
        }

        const legacyCandidates = listGenerationJobCandidates(runId);
        if (legacyCandidates.length > 0) {
          compatibleScenes = legacyCandidates.map((item) => ({
            ...item,
            text_status: "ready",
            image_status: normalizeGenerationSceneImageStatus(item.image_status),
            deleted_at: null,
            source_kind: "legacy",
          }));
        }
      }

      res.json({
        job: safeJob,
        scenes: compatibleScenes,
        counts: summarizeGenerationScenes(compatibleScenes),
        attempts_by_scene: attemptsByScene,
        attempts,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 run 详情失败") });
    }
  });

  app.get("/api/runs/:runId/overrides", requireAuth, requireAdmin, (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    if (!runId) {
      res.status(400).json({ message: "run_id 不合法" });
      return;
    }

    try {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      const payload = job.payload && typeof job.payload === "object"
        ? job.payload
        : {};

      const chapterTextOverride = typeof payload.chapter_text_override === "string"
        ? payload.chapter_text_override
        : readTextIfExists(payload.chapter_text_override_file);
      const systemPromptText = typeof payload.system_prompt_text === "string"
        ? payload.system_prompt_text
        : readTextIfExists(payload.system_prompt_file);
      const userPromptTemplateText = typeof payload.user_prompt_template_text === "string"
        ? payload.user_prompt_template_text
        : readTextIfExists(payload.user_prompt_template_file);
      const imagePromptSuffixText = typeof payload.image_prompt_suffix_text === "string"
        ? payload.image_prompt_suffix_text
        : readTextIfExists(payload.image_prompt_suffix_file);

      res.json({
        ok: true,
        run_id: runId,
        overrides: {
          chapter_text_override: chapterTextOverride,
          chapter_text_override_chars: chapterTextOverride.length,
          system_prompt_text: systemPromptText,
          system_prompt_chars: systemPromptText.length,
          user_prompt_template_text: userPromptTemplateText,
          user_prompt_template_chars: userPromptTemplateText.length,
          image_prompt_suffix_text: imagePromptSuffixText,
          image_prompt_suffix_chars: imagePromptSuffixText.length,
        },
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 run overrides 失败") });
    }
  });

  app.post("/api/runs/:runId/publish", requireAuth, requireCsrf, requireAdmin, (req, res) => {
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

    const job = writable.job;
    if (!job) {
      res.status(404).json({ message: "run_id 不存在" });
      return;
    }

    const scenes = listGenerationScenes(runId, { include_deleted: false });
    const selectedScenes = scenes.filter((scene) => scene.selected && scene.image_status === "success");
    if (selectedScenes.length === 0) {
      res.status(400).json({ message: "没有可发布关卡，请先选择至少一个成功 scene" });
      return;
    }

    try {
      const summary = readJsonSafe(job.summary_path) || {};
      const published = publishSelectedGenerationCandidates({
        runId,
        job,
        summary,
        selectedCandidates: selectedScenes,
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
        job: getGenerationJobByRunId(runId),
        counts: summarizeGenerationScenes(latestScenes),
        scenes: latestScenes,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "发布失败") });
    }
  });

  app.post("/api/runs/:runId/cancel", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    if (!runId) {
      res.status(400).json({ message: "run_id 不合法" });
      return;
    }

    try {
      const job = cancelGenerationRun(runId, String(req.body?.reason || "").trim() || "cancelled by admin");
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      res.json({
        ok: true,
        run_id: runId,
        job,
        counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
      });
    } catch (error) {
      const message = asMessage(error, "取消任务失败");
      const status = message.includes("不允许") ? 409 : 500;
      res.status(status).json({ message });
    }
  });

  app.delete("/api/runs/:runId", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const runId = normalizeRunId(req.params.runId);
    if (!runId) {
      res.status(400).json({ message: "run_id 不合法" });
      return;
    }

    try {
      const result = deleteGenerationRun(runId, {
        force: req.body?.force,
        allow_published: req.body?.allow_published,
        purge_files: req.body?.purge_files,
      });

      if (!result.deleted) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      res.json({
        ok: true,
        run_id: runId,
        removed_files: result.removed_files,
      });
    } catch (error) {
      const message = asMessage(error, "删除任务失败");
      const status = message.includes("不允许") || message.includes("请先") ? 409 : 500;
      res.status(status).json({ message });
    }
  });
}
