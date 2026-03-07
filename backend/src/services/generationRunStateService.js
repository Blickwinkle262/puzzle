export function createGenerationRunStateService(options = {}) {
  const {
    db,
    nowIso,
    listGenerationScenes,
    getGenerationJobByRunId,
    normalizeGenerationFlowStage,
    normalizeGenerationReviewStatus,
    upsertGenerationJobMetaOnEnqueue,
  } = options;

  function refreshGenerationRunState(runId) {
    const existing = getGenerationJobByRunId(runId);
    if (!existing) {
      return null;
    }

    if (normalizeGenerationReviewStatus(existing.review_status) === "published") {
      db.prepare(
        `
      UPDATE generation_jobs
      SET status = 'succeeded',
          flow_stage = 'published',
          updated_at = ?
      WHERE run_id = ?
    `,
      ).run(nowIso(), runId);
      return getGenerationJobByRunId(runId);
    }

    const scenes = listGenerationScenes(runId, { include_deleted: true });
    const activeScenes = scenes.filter((scene) => !scene.deleted_at && scene.text_status !== "deleted");
    const now = nowIso();

    let nextFlowStage = normalizeGenerationFlowStage(existing.flow_stage);
    let nextStatus = String(existing.status || "running");
    let nextReviewStatus = normalizeGenerationReviewStatus(existing.review_status);
    let nextEndedAt = existing.ended_at || null;

    if (activeScenes.length === 0) {
      nextFlowStage = "text_ready";
      nextStatus = "running";
      nextReviewStatus = "";
      nextEndedAt = null;
    } else if (activeScenes.some((scene) => scene.text_status === "pending")) {
      nextFlowStage = "text_generating";
      nextStatus = "running";
      nextReviewStatus = "";
      nextEndedAt = null;
    } else if (activeScenes.some((scene) => scene.image_status === "running" || scene.image_status === "queued")) {
      nextFlowStage = "images_generating";
      nextStatus = "running";
      nextReviewStatus = "";
      nextEndedAt = null;
    } else if (activeScenes.some((scene) => scene.image_status === "pending")) {
      nextFlowStage = "text_ready";
      nextStatus = "running";
      nextReviewStatus = "";
      nextEndedAt = null;
    } else {
      nextFlowStage = "review_ready";
      nextStatus = "succeeded";
      nextReviewStatus = "pending_review";
      nextEndedAt = existing.ended_at || now;
    }

    db.prepare(
      `
    UPDATE generation_jobs
    SET status = ?,
        review_status = ?,
        flow_stage = ?,
        ended_at = ?,
        updated_at = ?
    WHERE run_id = ?
  `,
    ).run(nextStatus, nextReviewStatus, nextFlowStage, nextEndedAt, now, runId);

    return getGenerationJobByRunId(runId);
  }

  function createOrUpdateAtomicGenerationRun({
    runId,
    requestedBy,
    targetDate,
    storyFile,
    payload,
    logFile,
    eventLogFile,
    summaryPath,
  }) {
    const now = nowIso();
    const existing = getGenerationJobByRunId(runId);

    const normalizedPayload = payload && typeof payload === "object" ? payload : {};
    const payloadJson = JSON.stringify(normalizedPayload);

    if (!existing) {
      db.prepare(
        `
      INSERT INTO generation_jobs (
        run_id, status, review_status, flow_stage,
        requested_by, target_date, story_file, dry_run,
        payload_json, log_file, event_log_file, summary_path,
        published_at, error_message, exit_code,
        created_at, started_at, ended_at, updated_at
      ) VALUES (?, 'running', '', 'text_generating', ?, ?, ?, 0, ?, ?, ?, ?, NULL, '', NULL, ?, ?, NULL, ?)
    `,
      ).run(
        runId,
        requestedBy,
        targetDate,
        storyFile || "",
        payloadJson,
        logFile,
        eventLogFile,
        summaryPath,
        now,
        now,
        now,
      );

      upsertGenerationJobMetaOnEnqueue({
        runId,
        requestedBy,
        payload: normalizedPayload,
        createdAt: now,
      });
    } else {
      db.prepare(
        `
      UPDATE generation_jobs
      SET status = 'running',
          review_status = CASE WHEN review_status = 'published' THEN 'published' ELSE '' END,
          flow_stage = CASE WHEN review_status = 'published' THEN 'published' ELSE 'text_generating' END,
          requested_by = COALESCE(NULLIF(?, ''), requested_by),
          target_date = ?,
          story_file = ?,
          payload_json = ?,
          log_file = ?,
          event_log_file = ?,
          summary_path = ?,
          error_message = '',
          exit_code = NULL,
          published_at = CASE WHEN review_status = 'published' THEN published_at ELSE NULL END,
          started_at = COALESCE(started_at, ?),
          ended_at = NULL,
          updated_at = ?
      WHERE run_id = ?
    `,
      ).run(
        requestedBy,
        targetDate,
        storyFile || "",
        payloadJson,
        logFile,
        eventLogFile,
        summaryPath,
        now,
        now,
        runId,
      );

      upsertGenerationJobMetaOnEnqueue({
        runId,
        requestedBy: requestedBy || existing.requested_by,
        payload: normalizedPayload,
        createdAt: existing.created_at || now,
      });
    }

    return getGenerationJobByRunId(runId);
  }

  function ensureGenerationRunWritable(runId) {
    const job = getGenerationJobByRunId(runId);
    if (!job) {
      return { job: null, message: "run_id 不存在", status: 404 };
    }

    if (normalizeGenerationReviewStatus(job.review_status) === "published") {
      const publishedAtHint = job.published_at ? `（${job.published_at}）` : "";
      return {
        job,
        message: `该任务已发布${publishedAtHint}，当前页面只读`,
        status: 409,
      };
    }

    return { job, message: "", status: 200 };
  }

  return {
    createOrUpdateAtomicGenerationRun,
    ensureGenerationRunWritable,
    refreshGenerationRunState,
  };
}
