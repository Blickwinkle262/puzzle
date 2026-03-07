export function createGenerationSceneRepository(options = {}) {
  const { db } = options;

  function runSceneCommandTransaction(handler) {
    const tx = db.transaction(handler);
    return tx();
  }

  function updateSceneDraftRow({
    runId,
    sceneIndex,
    nextTitle,
    nextDescription,
    nextStoryText,
    nextPrompt,
    hasSelected,
    nextSelected,
    nextRows,
    nextCols,
    nextTimeLimit,
    changedPrompt,
    now,
  }) {
    db.prepare(
      `
      UPDATE generation_job_scenes
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          story_text = COALESCE(?, story_text),
          image_prompt = COALESCE(?, image_prompt),
          selected = CASE WHEN ? IS NULL THEN selected ELSE ? END,
          grid_rows = COALESCE(?, grid_rows),
          grid_cols = COALESCE(?, grid_cols),
          time_limit_sec = COALESCE(?, time_limit_sec),
          image_status = CASE WHEN ? = 1 THEN 'pending' ELSE image_status END,
          image_url = CASE WHEN ? = 1 THEN '' ELSE image_url END,
          image_path = CASE WHEN ? = 1 THEN '' ELSE image_path END,
          error_message = CASE WHEN ? = 1 THEN '' ELSE error_message END,
          updated_at = ?
      WHERE run_id = ?
        AND scene_index = ?
        AND deleted_at IS NULL
    `,
    ).run(
      nextTitle,
      nextDescription,
      nextStoryText,
      nextPrompt,
      hasSelected ? 1 : null,
      hasSelected && nextSelected ? 1 : 0,
      nextRows,
      nextCols,
      nextTimeLimit,
      changedPrompt ? 1 : 0,
      changedPrompt ? 1 : 0,
      changedPrompt ? 1 : 0,
      changedPrompt ? 1 : 0,
      now,
      runId,
      sceneIndex,
    );
  }

  function cancelRunningSceneAttemptsForPromptUpdate({ runId, sceneIndex, now }) {
    db.prepare(
      `
      UPDATE generation_job_scene_image_attempts
      SET status = CASE
            WHEN status IN ('queued', 'running') THEN 'cancelled'
            ELSE status
          END,
          error_message = CASE
            WHEN status IN ('queued', 'running') THEN 'prompt updated before completion'
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ? AND scene_index = ?
    `,
    ).run(now, now, runId, sceneIndex);
  }

  function markSceneAsDeleted({ runId, sceneIndex, now }) {
    db.prepare(
      `
      UPDATE generation_job_scenes
      SET text_status = 'deleted',
          image_status = 'skipped',
          selected = 0,
          deleted_at = COALESCE(deleted_at, ?),
          updated_at = ?
      WHERE run_id = ?
        AND scene_index = ?
    `,
    ).run(now, now, runId, sceneIndex);
  }

  function cancelRunningSceneAttemptsForDelete({ runId, sceneIndex, now }) {
    db.prepare(
      `
      UPDATE generation_job_scene_image_attempts
      SET status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          error_message = CASE
            WHEN status IN ('queued', 'running') THEN 'scene deleted'
            ELSE error_message
          END,
          ended_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(ended_at, ?) ELSE ended_at END,
          updated_at = ?
      WHERE run_id = ? AND scene_index = ?
    `,
    ).run(now, now, runId, sceneIndex);
  }

  return {
    cancelRunningSceneAttemptsForDelete,
    cancelRunningSceneAttemptsForPromptUpdate,
    markSceneAsDeleted,
    runSceneCommandTransaction,
    updateSceneDraftRow,
  };
}
