export function createGenerationLegacySceneService(options = {}) {
  const {
    hasGenerationSceneRows,
    listGenerationJobCandidates,
    normalizeBoolean,
    normalizeIntegerInRange,
    normalizePositiveInteger,
    normalizeGenerationSceneCharacters,
    normalizeGenerationSceneImageStatus,
    refreshGenerationRunState,
    replaceGenerationScenes,
    syncGenerationJobCandidatesFromSummary,
  } = options;

  function mapLegacyCandidateToSceneRow(candidate) {
    const imageStatus = normalizeGenerationSceneImageStatus(candidate?.image_status);
    const title = String(candidate?.title || "").trim();
    const storyText = String(candidate?.story_text || "").trim();
    const imagePrompt = String(candidate?.image_prompt || "").trim();

    return {
      scene_index: normalizePositiveInteger(candidate?.scene_index) || 0,
      scene_id: normalizePositiveInteger(candidate?.scene_id) || normalizePositiveInteger(candidate?.scene_index) || null,
      title,
      description: String(candidate?.description || "").trim(),
      story_text: storyText,
      image_prompt: imagePrompt,
      mood: String(candidate?.mood || "").trim(),
      characters: normalizeGenerationSceneCharacters(candidate?.characters),
      grid_rows: normalizeIntegerInRange(candidate?.grid_rows, 2, 20) || 6,
      grid_cols: normalizeIntegerInRange(candidate?.grid_cols, 2, 20) || 4,
      time_limit_sec: normalizeIntegerInRange(candidate?.time_limit_sec, 30, 3600) || 180,
      text_status: (title || storyText || imagePrompt) ? "ready" : "pending",
      image_status: imageStatus,
      image_url: String(candidate?.image_url || "").trim(),
      image_path: String(candidate?.image_path || "").trim(),
      error_message: String(candidate?.error_message || "").trim(),
      selected: normalizeBoolean(candidate?.selected) && imageStatus === "success",
    };
  }

  function materializeGenerationScenesFromLegacy(runId, job = null) {
    if (!runId || hasGenerationSceneRows(runId)) {
      return { materialized: false, count: 0 };
    }

    let legacyCandidates = listGenerationJobCandidates(runId);
    if (legacyCandidates.length === 0 && job && job.status === "succeeded") {
      syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
      legacyCandidates = listGenerationJobCandidates(runId);
    }

    if (legacyCandidates.length === 0) {
      return { materialized: false, count: 0 };
    }

    const scenes = legacyCandidates
      .map((item) => mapLegacyCandidateToSceneRow(item))
      .filter((item) => Number.isInteger(item.scene_index) && item.scene_index > 0);

    if (scenes.length === 0) {
      return { materialized: false, count: 0 };
    }

    replaceGenerationScenes(runId, scenes, "legacy");
    refreshGenerationRunState(runId);

    return { materialized: true, count: scenes.length };
  }

  return {
    materializeGenerationScenesFromLegacy,
  };
}
