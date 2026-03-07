import path from "node:path";

export function createProjectPathResolver(rootDir) {
  const normalizedRoot = path.resolve(String(rootDir || process.cwd()));

  return function resolveProjectPath(value, fallback = "") {
    const raw = String(value || fallback || "").trim();
    if (!raw) {
      return "";
    }

    const resolved = path.isAbsolute(raw) ? raw : path.resolve(normalizedRoot, raw);
    return path.normalize(resolved);
  };
}

export function isPathInside(basePath, targetPath) {
  const normalizedBase = path.resolve(String(basePath || ""));
  const normalizedTarget = path.resolve(String(targetPath || ""));
  const relative = path.relative(normalizedBase, normalizedTarget);

  if (!relative) {
    return true;
  }

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
