import fs from "node:fs";
import path from "node:path";

export function splitCommandString(command) {
  const text = String(command || "").trim();
  if (!text) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens.filter((item) => item.length > 0);
}

export function parsePythonCommand(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item || "").trim())
          .filter((item) => item.length > 0);
      }
    } catch {
      // ignore json parse failure and fallback to split
    }
  }

  return splitCommandString(raw);
}

export function resolveStoryGeneratorPythonCommand(options = {}) {
  const explicitCmd = parsePythonCommand(options.explicitCmd);
  if (explicitCmd.length > 0) {
    return explicitCmd;
  }

  const explicitBin = String(options.explicitBin || "").trim();
  if (explicitBin) {
    return [explicitBin];
  }

  const rootDir = String(options.rootDir || "").trim();
  if (rootDir) {
    const localVenvPython = path.join(rootDir, ".venv", "bin", "python");
    if (fs.existsSync(localVenvPython)) {
      return [localVenvPython];
    }
  }

  return ["python3"];
}
