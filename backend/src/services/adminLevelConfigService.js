export function createAdminLevelConfigService(options = {}) {
  const {
    asMessage,
    db,
    loadStoryCatalog,
    resolveManifestFsPath,
    readJson,
    loadTimerPolicy,
    normalizeLevel,
    normalizeDifficulty,
    normalizePositiveInteger,
    normalizePositiveNumber,
    normalizeContentVersion,
    nowIso,
    safeParseJsonObject,
    managedLevelDifficulties,
  } = options;

  function getStoryLevelSource(storyId, levelId) {
    const normalizedStoryId = String(storyId || "").trim();
    const normalizedLevelId = String(levelId || "").trim();
    if (!normalizedStoryId || !normalizedLevelId) {
      return null;
    }

    const catalog = loadStoryCatalog();
    const entry = catalog.stories.find((item) => item.id === normalizedStoryId);
    if (!entry) {
      return null;
    }

    const manifestPath = resolveManifestFsPath(entry.manifest);
    const payload = readJson(manifestPath);
    const levelsRaw = Array.isArray(payload.levels) ? payload.levels : [];

    for (let index = 0; index < levelsRaw.length; index += 1) {
      const rawLevel = levelsRaw[index];
      const candidateId = String(rawLevel?.id ?? `level_${String(index + 1).padStart(3, "0")}`);
      if (candidateId === normalizedLevelId) {
        return {
          entry,
          raw_level: rawLevel,
          index,
        };
      }
    }

    return null;
  }

  function getLevelOverrideRecord(storyId, levelId) {
    const normalizedStoryId = String(storyId || "").trim();
    const normalizedLevelId = String(levelId || "").trim();
    if (!normalizedStoryId || !normalizedLevelId) {
      return null;
    }

    try {
      const row = db
        .prepare(
          `
        SELECT
          story_id,
          level_id,
          enabled,
          grid_rows,
          grid_cols,
          time_limit_sec,
          difficulty,
          difficulty_factor,
          content_version,
          extra_json,
          updated_by_user_id,
          created_at,
          updated_at
        FROM level_overrides
        WHERE story_id = ? AND level_id = ?
        LIMIT 1
      `,
        )
        .get(normalizedStoryId, normalizedLevelId);

      return row || null;
    } catch {
      return null;
    }
  }

  function buildSingleLevelOverrideMap(levelId, overrideRecord) {
    const result = new Map();
    if (!overrideRecord || Number(overrideRecord.enabled) !== 1) {
      return result;
    }

    result.set(String(levelId || "").trim(), overrideRecord);
    return result;
  }

  function normalizeDifficultyOverride(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }

    const normalized = String(value).trim().toLowerCase();
    if (!managedLevelDifficulties.has(normalized)) {
      return "";
    }
    return normalized;
  }

  function serializeLevelOverrideConfig(overrideRecord) {
    if (!overrideRecord) {
      return null;
    }

    return {
      enabled: Number(overrideRecord.enabled) === 1,
      grid_rows: normalizePositiveInteger(overrideRecord.grid_rows) || null,
      grid_cols: normalizePositiveInteger(overrideRecord.grid_cols) || null,
      time_limit_sec: normalizePositiveInteger(overrideRecord.time_limit_sec) || null,
      difficulty: normalizeDifficultyOverride(overrideRecord.difficulty),
      difficulty_factor: normalizePositiveNumber(overrideRecord.difficulty_factor) || null,
      content_version: normalizePositiveInteger(overrideRecord.content_version) || null,
      updated_by_user_id: normalizePositiveInteger(overrideRecord.updated_by_user_id) || null,
      created_at: overrideRecord.created_at || null,
      updated_at: overrideRecord.updated_at || null,
    };
  }

  function extractAdminEffectiveLevelConfig(level) {
    const rows = Number(level?.grid?.rows || 0);
    const cols = Number(level?.grid?.cols || 0);

    return {
      grid_rows: rows,
      grid_cols: cols,
      piece_count: Math.max(0, rows * cols),
      time_limit_sec: normalizePositiveInteger(level?.time_limit_sec) || null,
      difficulty: normalizeDifficulty(level?.difficulty),
      content_version: normalizeContentVersion(level?.content_version),
    };
  }

  function mergeLevelOverrideRecord(existingRecord, patch, defaultContentVersion = 1) {
    const merged = {
      enabled: existingRecord ? (Number(existingRecord.enabled) === 1 ? 1 : 0) : 1,
      grid_rows: normalizePositiveInteger(existingRecord?.grid_rows) || null,
      grid_cols: normalizePositiveInteger(existingRecord?.grid_cols) || null,
      time_limit_sec: normalizePositiveInteger(existingRecord?.time_limit_sec) || null,
      difficulty: normalizeDifficultyOverride(existingRecord?.difficulty),
      difficulty_factor: normalizePositiveNumber(existingRecord?.difficulty_factor) || null,
      content_version: normalizePositiveInteger(existingRecord?.content_version) || normalizeContentVersion(defaultContentVersion),
      extra_json: typeof existingRecord?.extra_json === "string" && safeParseJsonObject(existingRecord.extra_json)
        ? existingRecord.extra_json
        : "{}",
      updated_by_user_id: normalizePositiveInteger(existingRecord?.updated_by_user_id) || null,
      created_at: existingRecord?.created_at || null,
      updated_at: existingRecord?.updated_at || null,
    };

    for (const [key, value] of Object.entries(patch || {})) {
      if (!Object.prototype.hasOwnProperty.call(merged, key) && key !== "enabled") {
        continue;
      }
      merged[key] = value;
    }

    if ((merged.grid_rows === null && merged.grid_cols !== null)
      || (merged.grid_rows !== null && merged.grid_cols === null)) {
      throw new Error("grid_rows 与 grid_cols 必须同时设置或同时置空");
    }

    if (merged.difficulty === "") {
      throw new Error("difficulty 必须是 easy/normal/hard/nightmare 或 null");
    }

    if (merged.time_limit_sec !== null && (merged.time_limit_sec < 30 || merged.time_limit_sec > 3600)) {
      throw new Error("time_limit_sec 必须在 30-3600 范围内");
    }

    merged.enabled = Number(merged.enabled) === 1 ? 1 : 0;
    merged.content_version = normalizeContentVersion(merged.content_version);

    return merged;
  }

  function buildAdminLevelConfigSnapshot(storyId, levelId, options = {}) {
    const source = getStoryLevelSource(storyId, levelId);
    if (!source) {
      return null;
    }

    const timerPolicy = loadTimerPolicy();
    const baseLevel = normalizeLevel(source.entry.manifest, source.raw_level, source.index, new Map(), timerPolicy);
    const persistedOverrideRecord = getLevelOverrideRecord(storyId, levelId);
    const effectiveLevel = normalizeLevel(
      source.entry.manifest,
      source.raw_level,
      source.index,
      buildSingleLevelOverrideMap(levelId, persistedOverrideRecord),
      timerPolicy,
    );

    const result = {
      story_id: storyId,
      level_id: levelId,
      level_title: String(baseLevel.title || levelId),
      base_config: extractAdminEffectiveLevelConfig(baseLevel),
      override_config: serializeLevelOverrideConfig(persistedOverrideRecord),
      effective_config: extractAdminEffectiveLevelConfig(effectiveLevel),
    };

    if (options.previewPatch !== undefined) {
      const previewOverrideRecord = mergeLevelOverrideRecord(
        persistedOverrideRecord,
        options.previewPatch || {},
        baseLevel.content_version,
      );
      const previewLevel = normalizeLevel(
        source.entry.manifest,
        source.raw_level,
        source.index,
        buildSingleLevelOverrideMap(levelId, previewOverrideRecord),
        timerPolicy,
      );

      result.preview_override_config = serializeLevelOverrideConfig(previewOverrideRecord);
      result.preview_effective_config = extractAdminEffectiveLevelConfig(previewLevel);
    }

    return result;
  }

  function getFirstDefinedField(payload, keys = []) {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        return payload[key];
      }
    }

    return undefined;
  }

  function normalizeOptionalBoolean(value) {
    if (typeof value === "boolean") {
      return value;
    }

    if (value === 1 || value === "1") {
      return true;
    }

    if (value === 0 || value === "0") {
      return false;
    }

    const normalized = String(value ?? "").trim().toLowerCase();
    if (["true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "off"].includes(normalized)) {
      return false;
    }

    return undefined;
  }

  function parseAdminLevelConfigPatch(payload, options = {}) {
    const allowEmpty = Boolean(options.allowEmpty);
    const patch = {};
    let hasAny = false;

    const parseNullableInteger = (rawValue, fieldName, min, max) => {
      if (rawValue === undefined) {
        return;
      }
      hasAny = true;

      if (rawValue === null || rawValue === "") {
        patch[fieldName] = null;
        return;
      }

      const parsed = normalizePositiveInteger(rawValue);
      if (!parsed) {
        throw new Error(`${fieldName} 必须是正整数或 null`);
      }

      if (Number.isFinite(min) && parsed < min) {
        throw new Error(`${fieldName} 不能小于 ${min}`);
      }
      if (Number.isFinite(max) && parsed > max) {
        throw new Error(`${fieldName} 不能大于 ${max}`);
      }

      patch[fieldName] = parsed;
    };

    try {
      parseNullableInteger(getFirstDefinedField(payload, ["grid_rows", "rows"]), "grid_rows", 2, 20);
      parseNullableInteger(getFirstDefinedField(payload, ["grid_cols", "cols"]), "grid_cols", 2, 20);
      parseNullableInteger(getFirstDefinedField(payload, ["time_limit_sec", "time"]), "time_limit_sec", 30, 3600);
      parseNullableInteger(getFirstDefinedField(payload, ["content_version"]), "content_version", 1, Number.POSITIVE_INFINITY);

      const difficultyRaw = getFirstDefinedField(payload, ["difficulty"]);
      if (difficultyRaw !== undefined) {
        hasAny = true;
        const normalizedDifficulty = normalizeDifficultyOverride(difficultyRaw);
        if (normalizedDifficulty === "") {
          return {
            ok: false,
            message: "difficulty 必须是 easy/normal/hard/nightmare 或 null",
          };
        }
        patch.difficulty = normalizedDifficulty;
      }

      const factorRaw = getFirstDefinedField(payload, ["difficulty_factor"]);
      if (factorRaw !== undefined) {
        hasAny = true;
        if (factorRaw === null || factorRaw === "") {
          patch.difficulty_factor = null;
        } else {
          const parsedFactor = normalizePositiveNumber(factorRaw);
          if (!parsedFactor || parsedFactor > 5) {
            return {
              ok: false,
              message: "difficulty_factor 必须在 (0, 5] 或 null",
            };
          }
          patch.difficulty_factor = parsedFactor;
        }
      }

      const enabledRaw = getFirstDefinedField(payload, ["enabled"]);
      if (enabledRaw !== undefined) {
        hasAny = true;
        const parsedEnabled = normalizeOptionalBoolean(enabledRaw);
        if (parsedEnabled === undefined) {
          return {
            ok: false,
            message: "enabled 必须是 true/false",
          };
        }
        patch.enabled = parsedEnabled ? 1 : 0;
      }
    } catch (error) {
      return {
        ok: false,
        message: asMessage(error, "配置参数不合法"),
      };
    }

    if (!allowEmpty && !hasAny) {
      return {
        ok: false,
        message: "至少提供一个配置项",
      };
    }

    return {
      ok: true,
      patch,
    };
  }

  function saveAdminLevelOverrideConfig(storyId, levelId, patch, actorUserId) {
    const existingRecord = getLevelOverrideRecord(storyId, levelId);
    const mergedRecord = mergeLevelOverrideRecord(existingRecord, patch);
    const now = nowIso();
    const createdAt = existingRecord?.created_at || now;

    db.prepare(
      `
    INSERT INTO level_overrides (
      story_id,
      level_id,
      enabled,
      grid_rows,
      grid_cols,
      time_limit_sec,
      difficulty,
      difficulty_factor,
      content_version,
      extra_json,
      updated_by_user_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(story_id, level_id) DO UPDATE SET
      enabled = excluded.enabled,
      grid_rows = excluded.grid_rows,
      grid_cols = excluded.grid_cols,
      time_limit_sec = excluded.time_limit_sec,
      difficulty = excluded.difficulty,
      difficulty_factor = excluded.difficulty_factor,
      content_version = excluded.content_version,
      extra_json = excluded.extra_json,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `,
    ).run(
      storyId,
      levelId,
      mergedRecord.enabled,
      mergedRecord.grid_rows,
      mergedRecord.grid_cols,
      mergedRecord.time_limit_sec,
      mergedRecord.difficulty,
      mergedRecord.difficulty_factor,
      mergedRecord.content_version,
      mergedRecord.extra_json,
      Number.isInteger(actorUserId) ? actorUserId : null,
      createdAt,
      now,
    );

    return getLevelOverrideRecord(storyId, levelId);
  }

  return {
    buildAdminLevelConfigSnapshot,
    parseAdminLevelConfigPatch,
    saveAdminLevelOverrideConfig,
    serializeLevelOverrideConfig,
  };
}
