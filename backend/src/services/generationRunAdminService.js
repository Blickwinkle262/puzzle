import fs from "node:fs";
import path from "node:path";

export function createGenerationRunAdminService(options = {}) {
  const {
    db,
    rootDir,
    isPathInside,
    nowIso,
    normalizeBoolean,
    getGenerationJobByRunId,
    normalizeGenerationFlowStage,
    normalizeGenerationReviewStatus,
  } = options;

  function cancelGenerationRun(runId, reason = "cancelled by admin") {
    const tx = db.transaction(() => {
      const now = nowIso();
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        return null;
      }

      const flowStage = normalizeGenerationFlowStage(job.flow_stage);
      const reviewStatus = normalizeGenerationReviewStatus(job.review_status);
      if (reviewStatus === "published" || flowStage === "published") {
        throw new Error("已发布任务不允许取消");
      }

      if (job.status === "cancelled") {
        return getGenerationJobByRunId(runId);
      }

      db.prepare(
        `
      UPDATE generation_job_scene_image_attempts
      SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          error_message = CASE
            WHEN status IN ('queued', 'running') AND COALESCE(trim(error_message), '') = '' THEN ?
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ?
    `,
      ).run(reason, now, now, runId);

      db.prepare(
        `
      UPDATE generation_job_scenes
      SET image_status = CASE
            WHEN image_status IN ('queued', 'running') THEN 'skipped'
            ELSE image_status
          END,
          selected = CASE
            WHEN image_status IN ('queued', 'running') THEN 0
            ELSE selected
          END,
          error_message = CASE
            WHEN image_status IN ('queued', 'running') THEN ?
            ELSE error_message
          END,
          updated_at = ?
      WHERE run_id = ?
    `,
      ).run(reason, now, runId);

      db.prepare(
        `
      UPDATE generation_candidate_image_retries
      SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          error_message = CASE
            WHEN status IN ('queued', 'running') AND COALESCE(trim(error_message), '') = '' THEN ?
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ?
    `,
      ).run(reason, now, now, runId);

      db.prepare(
        `
      UPDATE generation_jobs
      SET status = 'cancelled',
          review_status = '',
          flow_stage = 'failed',
          error_message = CASE
            WHEN COALESCE(trim(error_message), '') = '' THEN ?
            ELSE error_message
          END,
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE run_id = ?
    `,
      ).run(reason, now, now, runId);

      return getGenerationJobByRunId(runId);
    });

    return tx();
  }

  function deleteGenerationRun(runId, options = {}) {
    const force = normalizeBoolean(options.force);
    const allowPublished = normalizeBoolean(options.allow_published);
    const purgeFiles = normalizeBoolean(options.purge_files);

    const tx = db.transaction(() => {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        return { deleted: false, job: null, removed_files: [] };
      }

      const reviewStatus = normalizeGenerationReviewStatus(job.review_status);
      const flowStage = normalizeGenerationFlowStage(job.flow_stage);
      if ((reviewStatus === "published" || flowStage === "published") && !allowPublished) {
        throw new Error("已发布任务默认不允许删除，请显式传 allow_published=true");
      }

      if (job.status === "running" && !force) {
        throw new Error("运行中任务不允许直接删除，请先取消或传 force=true");
      }

      db.prepare("DELETE FROM generation_job_scene_image_attempts WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM generation_job_scenes WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM generation_candidate_image_retries WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM generation_job_level_candidates WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM generation_job_meta WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM generation_jobs WHERE run_id = ?").run(runId);

      const removedFiles = [];
      if (purgeFiles) {
        const candidates = [job.log_file, job.event_log_file, job.summary_path]
          .map((item) => String(item || "").trim())
          .filter((item) => item.length > 0);

        for (const filePath of candidates) {
          try {
            const normalized = path.resolve(filePath);
            if (!isPathInside(rootDir, normalized)) {
              continue;
            }
            if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
              fs.rmSync(normalized, { force: true });
              removedFiles.push(normalized);
            }
          } catch {
            // ignore file purge errors
          }
        }
      }

      return { deleted: true, job, removed_files: removedFiles };
    });

    return tx();
  }

  return {
    cancelGenerationRun,
    deleteGenerationRun,
  };
}
