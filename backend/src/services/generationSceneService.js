export function createGenerationSceneService(options = {}) {
  const {
    db,
    nowIso,
    normalizeBoolean,
    normalizeIntegerInRange,
    normalizePositiveInteger,
    normalizeGenerationCandidateRetryStatus,
    normalizeGenerationSceneCharacters,
    normalizeGenerationSceneImageStatus,
    normalizeGenerationSceneSourceKind,
    normalizeGenerationSceneTextStatus,
    safeParseJsonArray,
  } = options;

  function hasGenerationSceneRows(runId) {
    try {
      const row = db
        .prepare(
          `
        SELECT 1
        FROM generation_job_scenes
        WHERE run_id = ?
        LIMIT 1
      `,
        )
        .get(runId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  function serializeGenerationSceneRow(row) {
    if (!row) {
      return null;
    }

    return {
      run_id: String(row.run_id || ""),
      scene_index: Number(row.scene_index || 0),
      scene_id: row.scene_id === null || row.scene_id === undefined ? null : Number(row.scene_id),
      title: String(row.title || ""),
      description: String(row.description || ""),
      story_text: String(row.story_text || ""),
      image_prompt: String(row.image_prompt || ""),
      mood: String(row.mood || ""),
      characters: normalizeGenerationSceneCharacters(safeParseJsonArray(row.characters_json)),
      grid_rows: normalizeIntegerInRange(row.grid_rows, 2, 20) || 6,
      grid_cols: normalizeIntegerInRange(row.grid_cols, 2, 20) || 4,
      time_limit_sec: normalizeIntegerInRange(row.time_limit_sec, 30, 3600) || 180,
      text_status: normalizeGenerationSceneTextStatus(row.text_status),
      image_status: normalizeGenerationSceneImageStatus(row.image_status),
      image_url: String(row.image_url || ""),
      image_path: String(row.image_path || ""),
      error_message: String(row.error_message || ""),
      selected: Boolean(row.selected),
      deleted_at: row.deleted_at || null,
      source_kind: normalizeGenerationSceneSourceKind(row.source_kind),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    };
  }

  function listGenerationScenes(runId, options = {}) {
    const includeDeleted = normalizeBoolean(options.include_deleted);
    try {
      const rows = db
        .prepare(
          `
        SELECT run_id, scene_index, scene_id,
               title, description, story_text,
               image_prompt, mood, characters_json,
               grid_rows, grid_cols, time_limit_sec,
               text_status, image_status,
               image_url, image_path, error_message,
               selected, deleted_at, source_kind,
               created_at, updated_at
        FROM generation_job_scenes
        WHERE run_id = ?
          ${includeDeleted ? "" : "AND deleted_at IS NULL"}
        ORDER BY scene_index ASC
      `,
        )
        .all(runId);

      return rows
        .map((row) => serializeGenerationSceneRow(row))
        .filter((item) => item !== null);
    } catch {
      return [];
    }
  }

  function listGenerationSceneAttempts(runId, sceneIndex = null) {
    try {
      let rows = [];
      if (Number.isInteger(sceneIndex) && sceneIndex > 0) {
        rows = db
          .prepare(
            `
          SELECT id, run_id, scene_index, attempt_no, status,
                 provider, model, image_prompt,
                 image_url, image_path, error_message,
                 latency_ms, created_at, started_at, ended_at, updated_at
          FROM generation_job_scene_image_attempts
          WHERE run_id = ? AND scene_index = ?
          ORDER BY attempt_no ASC
        `,
          )
          .all(runId, sceneIndex);
      } else {
        rows = db
          .prepare(
            `
          SELECT id, run_id, scene_index, attempt_no, status,
                 provider, model, image_prompt,
                 image_url, image_path, error_message,
                 latency_ms, created_at, started_at, ended_at, updated_at
          FROM generation_job_scene_image_attempts
          WHERE run_id = ?
          ORDER BY scene_index ASC, attempt_no ASC
        `,
          )
          .all(runId);
      }

      return rows.map((row) => ({
        id: Number(row.id || 0),
        run_id: String(row.run_id || ""),
        scene_index: Number(row.scene_index || 0),
        attempt_no: Number(row.attempt_no || 0),
        status: normalizeGenerationCandidateRetryStatus(row.status),
        provider: String(row.provider || ""),
        model: String(row.model || ""),
        image_prompt: String(row.image_prompt || ""),
        image_url: String(row.image_url || ""),
        image_path: String(row.image_path || ""),
        error_message: String(row.error_message || ""),
        latency_ms: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
        created_at: row.created_at || null,
        started_at: row.started_at || null,
        ended_at: row.ended_at || null,
        updated_at: row.updated_at || null,
      }));
    } catch {
      return [];
    }
  }

  function serializeGenerationSceneAttemptAsLegacyRetry(attempt) {
    if (!attempt) {
      return null;
    }

    const statusMap = {
      queued: "queued",
      running: "running",
      succeeded: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
    };

    return {
      retry_id: Number(attempt.id || 0),
      run_id: String(attempt.run_id || ""),
      scene_index: Number(attempt.scene_index || 0),
      status: statusMap[String(attempt.status || "").toLowerCase()] || "queued",
      requested_by: String(attempt.provider || "atomic_cli"),
      attempts: Number(attempt.attempt_no || 0),
      error_message: String(attempt.error_message || ""),
      created_at: attempt.created_at || null,
      started_at: attempt.started_at || null,
      ended_at: attempt.ended_at || null,
      updated_at: attempt.updated_at || null,
    };
  }

  function summarizeGenerationScenes(scenes) {
    const summary = {
      total: 0,
      text_ready: 0,
      text_failed: 0,
      images_success: 0,
      images_failed: 0,
      images_pending: 0,
      images_running: 0,
      selected: 0,
      ready_for_publish: 0,
      deleted: 0,
    };

    for (const scene of scenes) {
      summary.total += 1;
      if (scene.deleted_at || scene.text_status === "deleted") {
        summary.deleted += 1;
        continue;
      }

      if (scene.text_status === "ready") {
        summary.text_ready += 1;
      } else if (scene.text_status === "failed") {
        summary.text_failed += 1;
      }

      if (scene.image_status === "success") {
        summary.images_success += 1;
      } else if (scene.image_status === "failed" || scene.image_status === "skipped") {
        summary.images_failed += 1;
      } else if (scene.image_status === "running" || scene.image_status === "queued") {
        summary.images_running += 1;
      } else {
        summary.images_pending += 1;
      }

      if (scene.selected) {
        summary.selected += 1;
        if (scene.image_status === "success") {
          summary.ready_for_publish += 1;
        }
      }
    }

    return summary;
  }

  function serializeGenerationSceneAsLegacyCandidate(scene) {
    return {
      run_id: scene.run_id,
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
      image_status: scene.image_status === "running" || scene.image_status === "queued" ? "pending" : scene.image_status,
      image_url: scene.image_url,
      image_path: scene.image_path,
      error_message: scene.error_message,
      selected: scene.selected,
      created_at: scene.created_at,
      updated_at: scene.updated_at,
    };
  }

  function summarizeLegacyCandidateCountsFromScenes(sceneSummary) {
    return {
      total: Number(sceneSummary.total || 0) - Number(sceneSummary.deleted || 0),
      success: Number(sceneSummary.images_success || 0),
      failed: Number(sceneSummary.images_failed || 0),
      pending: Number(sceneSummary.images_pending || 0) + Number(sceneSummary.images_running || 0),
      selected: Number(sceneSummary.selected || 0),
      ready_for_publish: Number(sceneSummary.ready_for_publish || 0),
    };
  }

  function getGenerationSceneByIndex(runId, sceneIndex, options = {}) {
    const includeDeleted = normalizeBoolean(options.include_deleted);
    try {
      const row = db
        .prepare(
          `
        SELECT run_id, scene_index, scene_id,
               title, description, story_text,
               image_prompt, mood, characters_json,
               grid_rows, grid_cols, time_limit_sec,
               text_status, image_status,
               image_url, image_path, error_message,
               selected, deleted_at, source_kind,
               created_at, updated_at
        FROM generation_job_scenes
        WHERE run_id = ?
          AND scene_index = ?
          ${includeDeleted ? "" : "AND deleted_at IS NULL"}
        LIMIT 1
      `,
        )
        .get(runId, sceneIndex);

      return serializeGenerationSceneRow(row);
    } catch {
      return null;
    }
  }

  function replaceGenerationScenes(runId, scenes, sourceKind = "pipeline") {
    const normalizedSourceKind = normalizeGenerationSceneSourceKind(sourceKind);
    const now = nowIso();

    const tx = db.transaction((inputScenes) => {
      db.prepare("DELETE FROM generation_job_scene_image_attempts WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM generation_job_scenes WHERE run_id = ?").run(runId);

      const insert = db.prepare(
        `
      INSERT INTO generation_job_scenes (
        run_id,
        scene_index,
        scene_id,
        title,
        description,
        story_text,
        image_prompt,
        mood,
        characters_json,
        grid_rows,
        grid_cols,
        time_limit_sec,
        text_status,
        image_status,
        image_url,
        image_path,
        error_message,
        selected,
        deleted_at,
        source_kind,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `,
      );

      for (const scene of inputScenes) {
        const sceneIndex = normalizePositiveInteger(scene.scene_index);
        if (!sceneIndex) {
          continue;
        }

        const textStatus = normalizeGenerationSceneTextStatus(scene.text_status || "ready");
        const imageStatus = normalizeGenerationSceneImageStatus(scene.image_status || "pending");
        insert.run(
          runId,
          sceneIndex,
          normalizePositiveInteger(scene.scene_id),
          String(scene.title || "").trim(),
          String(scene.description || "").trim(),
          String(scene.story_text || "").trim(),
          String(scene.image_prompt || "").trim(),
          String(scene.mood || "").trim(),
          JSON.stringify(normalizeGenerationSceneCharacters(scene.characters)),
          normalizeIntegerInRange(scene.grid_rows, 2, 20) || 6,
          normalizeIntegerInRange(scene.grid_cols, 2, 20) || 4,
          normalizeIntegerInRange(scene.time_limit_sec, 30, 3600) || 180,
          textStatus,
          imageStatus,
          String(scene.image_url || "").trim(),
          String(scene.image_path || "").trim(),
          String(scene.error_message || "").trim(),
          normalizeBoolean(scene.selected) ? 1 : 0,
          normalizedSourceKind,
          now,
          now,
        );
      }
    });

    tx(scenes);
    return listGenerationScenes(runId, { include_deleted: false });
  }

  return {
    getGenerationSceneByIndex,
    hasGenerationSceneRows,
    listGenerationSceneAttempts,
    listGenerationScenes,
    replaceGenerationScenes,
    serializeGenerationSceneAsLegacyCandidate,
    serializeGenerationSceneAttemptAsLegacyRetry,
    summarizeGenerationScenes,
    summarizeLegacyCandidateCountsFromScenes,
  };
}
