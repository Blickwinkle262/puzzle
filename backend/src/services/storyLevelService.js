import fs from "node:fs";
import path from "node:path";

export function createStoryLevelService(options = {}) {
  const {
    db,
    storyPublicPrefix,
    defaultTimerPolicy,
    resolveStoryAssetFsPath,
    doesAssetExist,
    normalizePositiveInteger,
    normalizePositiveNumber,
    normalizeContentVersion,
    normalizeLegacyIds,
    safeParseJsonObject,
  } = options;

  function normalizeLevel(manifestUrl, level, index, levelOverrideMap, timerPolicy) {
    const levelId = String(level?.id ?? `level_${String(index + 1).padStart(3, "0")}`);
    const sourceImage = normalizeAssetPath(manifestUrl, level?.source_image ?? level?.image);

    if (!sourceImage) {
      throw new Error(`关卡 ${levelId} 缺少图片配置`);
    }

    const rows = Number(level?.grid?.rows);
    const cols = Number(level?.grid?.cols);
    const override = levelOverrideMap instanceof Map ? levelOverrideMap.get(levelId) : undefined;
    const overrideRows = normalizePositiveInteger(override?.grid_rows);
    const overrideCols = normalizePositiveInteger(override?.grid_cols);
    const finalRows = overrideRows || rows;
    const finalCols = overrideCols || cols;

    if (!Number.isInteger(finalRows) || !Number.isInteger(finalCols) || finalRows <= 0 || finalCols <= 0) {
      throw new Error(`关卡 ${levelId} 的 grid 配置不合法`);
    }

    const difficulty = normalizeDifficulty(override?.difficulty ?? level?.difficulty);
    const finalTimeLimitSec = resolveLevelTimeLimitSec({
      rows: finalRows,
      cols: finalCols,
      difficulty,
      overrideTimeLimitSec: normalizePositiveInteger(override?.time_limit_sec),
      legacyTimeLimitSec: normalizePositiveInteger(level?.time_limit_sec),
      overrideDifficultyFactor: normalizePositiveNumber(override?.difficulty_factor),
      timerPolicy,
    });

    return {
      id: levelId,
      title: typeof level?.title === "string" ? level.title : levelId,
      description: typeof level?.description === "string" ? level.description : "",
      story_text: typeof level?.story_text === "string" ? level.story_text : undefined,
      grid: {
        rows: finalRows,
        cols: finalCols,
      },
      source_image: sourceImage,
      content_version: normalizeContentVersion(level?.content_version),
      legacy_ids: normalizeLegacyIds(level?.legacy_ids),
      asset_missing: !doesAssetExist(sourceImage),
      time_limit_sec: finalTimeLimitSec,
      difficulty,
      shuffle: level?.shuffle && typeof level.shuffle === "object" ? level.shuffle : undefined,
      audio: normalizeAudioMap(manifestUrl, level?.audio),
      mobile: level?.mobile && typeof level.mobile === "object" ? level.mobile : undefined,
    };
  }

  function getLevelOverrideMap(storyId) {
    if (typeof storyId !== "string" || !storyId.trim()) {
      return new Map();
    }

    try {
      const rows = db
        .prepare(
          `
        SELECT level_id, enabled, grid_rows, grid_cols, time_limit_sec, difficulty, difficulty_factor
        FROM level_overrides
        WHERE story_id = ?
      `,
        )
        .all(storyId.trim());

      const result = new Map();
      for (const row of rows) {
        if (Number(row.enabled) !== 1) {
          continue;
        }

        const levelId = String(row.level_id || "").trim();
        if (!levelId) {
          continue;
        }

        result.set(levelId, row);
      }
      return result;
    } catch {
      return new Map();
    }
  }

  function loadTimerPolicy() {
    try {
      const row = db
        .prepare("SELECT value_json FROM system_settings WHERE key = ? LIMIT 1")
        .get("timer_policy_v1");

      if (!row || typeof row.value_json !== "string" || !row.value_json.trim()) {
        return defaultTimerPolicy;
      }

      const payload = safeParseJsonObject(row.value_json);
      return normalizeTimerPolicy(payload);
    } catch {
      return defaultTimerPolicy;
    }
  }

  function normalizeTimerPolicy(payload) {
    if (!payload || typeof payload !== "object") {
      return defaultTimerPolicy;
    }

    const baseSeconds = normalizePositiveNumber(payload.base_seconds) || defaultTimerPolicy.base_seconds;
    const perPieceSeconds = normalizePositiveNumber(payload.per_piece_seconds) || defaultTimerPolicy.per_piece_seconds;
    const minSeconds = normalizePositiveInteger(payload.min_seconds) || defaultTimerPolicy.min_seconds;
    const maxSecondsRaw = normalizePositiveInteger(payload.max_seconds) || defaultTimerPolicy.max_seconds;
    const maxSeconds = Math.max(minSeconds, maxSecondsRaw);
    const factors = payload.difficulty_factor && typeof payload.difficulty_factor === "object"
      ? payload.difficulty_factor
      : {};

    return {
      base_seconds: baseSeconds,
      per_piece_seconds: perPieceSeconds,
      min_seconds: minSeconds,
      max_seconds: maxSeconds,
      difficulty_factor: {
        easy: normalizePositiveNumber(factors.easy) || defaultTimerPolicy.difficulty_factor.easy,
        normal: normalizePositiveNumber(factors.normal) || defaultTimerPolicy.difficulty_factor.normal,
        hard: normalizePositiveNumber(factors.hard) || defaultTimerPolicy.difficulty_factor.hard,
        nightmare: normalizePositiveNumber(factors.nightmare) || defaultTimerPolicy.difficulty_factor.nightmare,
      },
    };
  }

  function normalizeDifficulty(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "easy" || normalized === "hard" || normalized === "nightmare") {
      return normalized;
    }
    return "normal";
  }

  function resolveLevelTimeLimitSec({
    rows,
    cols,
    difficulty,
    overrideTimeLimitSec,
    legacyTimeLimitSec,
    overrideDifficultyFactor,
    timerPolicy,
  }) {
    if (overrideTimeLimitSec) {
      return overrideTimeLimitSec;
    }

    const activePolicy = timerPolicy && typeof timerPolicy === "object"
      ? timerPolicy
      : defaultTimerPolicy;
    const pieceCount = Math.max(1, rows * cols);
    const base = activePolicy.base_seconds + (pieceCount * activePolicy.per_piece_seconds);
    const factor = overrideDifficultyFactor
      || activePolicy.difficulty_factor[normalizeDifficulty(difficulty)]
      || activePolicy.difficulty_factor.normal
      || 1;
    const computed = Math.round(base * factor);
    const computedClamped = clampInt(computed, activePolicy.min_seconds, activePolicy.max_seconds);

    if (legacyTimeLimitSec) {
      const normalizedLegacy = clampInt(legacyTimeLimitSec, activePolicy.min_seconds, activePolicy.max_seconds);
      return Math.max(normalizedLegacy, computedClamped);
    }

    return computedClamped;
  }

  function clampInt(value, minValue, maxValue) {
    const integerValue = Math.round(Number(value));
    const min = Math.round(Number(minValue));
    const max = Math.round(Number(maxValue));

    if (!Number.isFinite(integerValue)) {
      return min;
    }

    if (integerValue < min) {
      return min;
    }

    if (integerValue > max) {
      return max;
    }

    return integerValue;
  }

  function normalizeAudioMap(manifestUrl, audio) {
    if (!audio || typeof audio !== "object") {
      return undefined;
    }

    const resolved = {};
    for (const [key, value] of Object.entries(audio)) {
      if (typeof value !== "string") {
        continue;
      }
      const finalPath = normalizeAssetPath(manifestUrl, value);
      if (finalPath) {
        resolved[key] = finalPath;
      }
    }

    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  function normalizeAssetPath(manifestUrl, assetPath) {
    if (typeof assetPath !== "string" || !assetPath.trim()) {
      return "";
    }

    const cleanPath = assetPath.trim();
    if (cleanPath.startsWith("/")) {
      return cleanPath;
    }

    const baseDir = path.posix.dirname(manifestUrl);
    const joined = path.posix.normalize(path.posix.join(baseDir, cleanPath));
    if (!joined.startsWith(`${storyPublicPrefix}/`)) {
      throw new Error(`资源路径越界: ${assetPath}`);
    }

    return joined;
  }

  function resolveManifestFsPath(manifestUrl) {
    if (typeof manifestUrl !== "string" || !manifestUrl.trim()) {
      throw new Error("manifest 不能为空");
    }

    const normalizedUrl = manifestUrl.startsWith("/") ? manifestUrl : `${storyPublicPrefix}/${manifestUrl}`;
    const normalizedFsPath = resolveStoryAssetFsPath(normalizedUrl);

    if (!normalizedFsPath) {
      throw new Error("manifest 路径越界");
    }

    if (!fs.existsSync(normalizedFsPath)) {
      throw new Error(`未找到 manifest: ${manifestUrl}`);
    }

    return normalizedFsPath;
  }

  function readJson(filePath) {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  }

  return {
    getLevelOverrideMap,
    loadTimerPolicy,
    normalizeAssetPath,
    normalizeDifficulty,
    normalizeLevel,
    readJson,
    resolveManifestFsPath,
  };
}
