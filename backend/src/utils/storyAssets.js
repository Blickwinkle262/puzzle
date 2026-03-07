import fs from "node:fs";
import path from "node:path";

export function normalizeLegacyIds(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = [...new Set(value.map((item) => String(item || "").trim()).filter((item) => item.length > 0))];
  return result.length > 0 ? result : undefined;
}

export function normalizeContentVersion(value) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return 1;
  }
  return normalized;
}

export function createStoryAssetUtils(options = {}) {
  const {
    webPublicDir,
    storyPublicPrefix,
    storiesRootDir,
    isPathInside,
  } = options;

  function resolveStoryAssetFsPath(assetUrl) {
    if (typeof assetUrl !== "string" || !assetUrl.trim()) {
      return "";
    }

    const [cleanPath] = assetUrl.trim().split(/[?#]/, 1);
    if (!cleanPath.startsWith(`${storyPublicPrefix}/`)) {
      return "";
    }

    const relativePath = cleanPath.slice(`${storyPublicPrefix}/`.length);
    if (!relativePath) {
      return "";
    }

    const normalized = path.normalize(path.resolve(storiesRootDir, relativePath));
    if (!isPathInside(storiesRootDir, normalized)) {
      return "";
    }

    return normalized;
  }

  function resolvePublicAssetFsPath(assetUrl) {
    if (typeof assetUrl !== "string" || !assetUrl.trim()) {
      return "";
    }

    const value = assetUrl.trim();
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return "";
    }

    if (!value.startsWith("/")) {
      return "";
    }

    const storyAssetPath = resolveStoryAssetFsPath(value);
    if (storyAssetPath) {
      return storyAssetPath;
    }

    const [cleanPath] = value.split(/[?#]/, 1);
    const normalized = path.normalize(path.resolve(webPublicDir, cleanPath.slice(1)));
    if (!isPathInside(webPublicDir, normalized)) {
      return "";
    }

    return normalized;
  }

  function doesAssetExist(assetUrl) {
    const filePath = resolvePublicAssetFsPath(assetUrl);
    if (!filePath) {
      return false;
    }

    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  return {
    doesAssetExist,
    resolvePublicAssetFsPath,
    resolveStoryAssetFsPath,
  };
}
