export function createGenerationReviewRepository(options = {}) {
  const { db } = options;

  function updateSceneCandidateSelectionAndGrid({
    runId,
    sceneIndex,
    hasSelected,
    selectedValue,
    gridRows,
    gridCols,
    now,
  }) {
    db.prepare(
      `
      UPDATE generation_job_scenes
      SET selected = CASE WHEN ? IS NULL THEN selected ELSE ? END,
          grid_rows = COALESCE(?, grid_rows),
          grid_cols = COALESCE(?, grid_cols),
          updated_at = ?
      WHERE run_id = ? AND scene_index = ?
    `,
    ).run(
      hasSelected ? 1 : null,
      hasSelected && selectedValue ? 1 : 0,
      gridRows,
      gridCols,
      now,
      runId,
      sceneIndex,
    );
  }

  function markGenerationJobAsPublished({ runId, now }) {
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
  }

  return {
    markGenerationJobAsPublished,
    updateSceneCandidateSelectionAndGrid,
  };
}
