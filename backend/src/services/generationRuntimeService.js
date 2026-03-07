import fs from "node:fs";
import path from "node:path";

export function createGenerationRuntimeService(options = {}) {
  const {
    rootDir,
    storiesRootDir,
    normalizeBoolean,
    normalizeRunId,
    normalizeTargetDate,
    nowIso,
    randomToken,
    isPathInside,
  } = options;

  function defaultGenerationRunId() {
    const stamp = nowIso().replace(/[^0-9]/g, "").slice(0, 14);
    return `admin_${stamp}_${randomToken().slice(0, 8)}`;
  }

  function buildGenerationSummaryFileName(targetDate, runId) {
    const normalizedDate = normalizeTargetDate(targetDate) || nowIso().slice(0, 10);
    const normalizedRunId = normalizeRunId(runId) || defaultGenerationRunId();
    return `story_${normalizedDate}_${normalizedRunId}.json`;
  }

  function normalizeStoryFile(value) {
    if (typeof value !== "string" || !value.trim()) {
      return "";
    }

    const resolved = path.isAbsolute(value) ? path.normalize(value) : path.normalize(path.resolve(rootDir, value));
    if (!isPathInside(rootDir, resolved)) {
      return "";
    }

    try {
      if (!fs.statSync(resolved).isFile()) {
        return "";
      }
    } catch {
      return "";
    }

    return resolved;
  }

  function readRunEvents(eventLogFile, runId, limit = 20) {
    try {
      if (!eventLogFile || !fs.existsSync(eventLogFile)) {
        return [];
      }

      const lines = fs.readFileSync(eventLogFile, "utf-8").split(/\r?\n/).filter((line) => line.trim().length > 0);
      const events = [];

      for (const line of lines) {
        try {
          const payload = JSON.parse(line);
          if (payload && payload.run_id === runId) {
            events.push(payload);
          }
        } catch {
          // ignore malformed lines
        }
      }

      return events.slice(-Math.max(1, limit));
    } catch {
      return [];
    }
  }

  function isReviewModePayload(payload, dryRun = false) {
    if (dryRun) {
      return false;
    }
    return normalizeBoolean(payload?.review_mode);
  }

  function normalizeErrorMessage(value) {
    if (value === null || value === undefined) {
      return "";
    }
    const text = String(value).trim();
    if (!text) {
      return "";
    }
    return text.slice(0, 4000);
  }

  function resolveGenerationRunImagesDir(runId) {
    const safeRunId = normalizeRunId(runId) || `run_${randomToken().slice(0, 8)}`;
    const dir = path.join(storiesRootDir, ".generation_runs", safeRunId, "images");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  return {
    buildGenerationSummaryFileName,
    defaultGenerationRunId,
    isReviewModePayload,
    normalizeErrorMessage,
    normalizeStoryFile,
    readRunEvents,
    resolveGenerationRunImagesDir,
  };
}
