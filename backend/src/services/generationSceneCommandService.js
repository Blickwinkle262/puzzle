export function createGenerationSceneCommandService(options = {}) {
  const {
    ensureGenerationRunWritable,
    getGenerationSceneByIndex,
    normalizeBoolean,
    normalizeIntegerInRange,
    nowIso,
    updateSceneDraftRow,
    cancelRunningSceneAttemptsForPromptUpdate,
    markSceneAsDeleted,
    cancelRunningSceneAttemptsForDelete,
    runSceneCommandTransaction,
  } = options;

  function updateGenerationSceneDraft({ runId, sceneIndex, payload = {} }) {
    const writable = ensureGenerationRunWritable(runId);
    if (writable.status !== 200) {
      return { status: writable.status, message: writable.message };
    }

    const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
    if (!scene) {
      return { status: 404, message: "scene 不存在" };
    }

    const nextTitle = payload?.title !== undefined ? String(payload.title || "").trim().slice(0, 500) : null;
    const nextDescription = payload?.description !== undefined ? String(payload.description || "").trim().slice(0, 2000) : null;
    const nextStoryText = payload?.story_text !== undefined ? String(payload.story_text || "").trim().slice(0, 20000) : null;
    const nextPrompt = payload?.image_prompt !== undefined ? String(payload.image_prompt || "").trim().slice(0, 12000) : null;
    const hasSelected = payload?.selected !== undefined;
    const nextSelected = hasSelected ? normalizeBoolean(payload?.selected) : null;
    const nextRows = payload?.grid_rows !== undefined ? normalizeIntegerInRange(payload?.grid_rows, 2, 20) : null;
    const nextCols = payload?.grid_cols !== undefined ? normalizeIntegerInRange(payload?.grid_cols, 2, 20) : null;
    const nextTimeLimit = payload?.time_limit_sec !== undefined ? normalizeIntegerInRange(payload?.time_limit_sec, 30, 3600) : null;

    if ((payload?.grid_rows !== undefined && !nextRows)
      || (payload?.grid_cols !== undefined && !nextCols)
      || (payload?.time_limit_sec !== undefined && !nextTimeLimit)) {
      return { status: 400, message: "rows/cols/time_limit_sec 参数非法" };
    }

    const changedPrompt = nextPrompt !== null && nextPrompt !== scene.image_prompt;
    const hasUpdate = nextTitle !== null
      || nextDescription !== null
      || nextStoryText !== null
      || nextPrompt !== null
      || hasSelected
      || nextRows !== null
      || nextCols !== null
      || nextTimeLimit !== null;

    if (!hasUpdate) {
      return { status: 400, message: "没有可更新字段" };
    }

    const now = nowIso();
    runSceneCommandTransaction(() => {
      updateSceneDraftRow({
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
      });

      if (changedPrompt) {
        cancelRunningSceneAttemptsForPromptUpdate({ runId, sceneIndex, now });
      }
    });

    return { status: 200 };
  }

  function deleteGenerationSceneDraft({ runId, sceneIndex }) {
    const writable = ensureGenerationRunWritable(runId);
    if (writable.status !== 200) {
      return { status: writable.status, message: writable.message };
    }

    const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
    if (!scene) {
      return { status: 404, message: "scene 不存在" };
    }

    const now = nowIso();
    runSceneCommandTransaction(() => {
      markSceneAsDeleted({ runId, sceneIndex, now });
      cancelRunningSceneAttemptsForDelete({ runId, sceneIndex, now });
    });

    return { status: 200 };
  }

  return {
    deleteGenerationSceneDraft,
    updateGenerationSceneDraft,
  };
}
