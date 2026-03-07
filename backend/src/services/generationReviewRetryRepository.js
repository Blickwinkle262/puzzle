export function createGenerationReviewRetryRepository(options = {}) {
  const { db } = options;

  function markGenerationJobAsRetryingImages({ runId, now }) {
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
  }

  return {
    markGenerationJobAsRetryingImages,
  };
}
