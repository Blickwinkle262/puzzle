export function normalizeTargetDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return new Date().toISOString().slice(0, 10);
  }

  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return "";
  }

  return text;
}

export function normalizeRunId(value) {
  if (typeof value !== "string") {
    return "";
  }
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) {
    return "";
  }
  return cleaned.slice(0, 80);
}

export function normalizeShortText(value) {
  if (typeof value !== "string") {
    return "";
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.slice(0, 120);
}

export function normalizePositiveNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return undefined;
  }

  return numberValue;
}

export function normalizeNonNegativeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    return fallback;
  }

  return numberValue;
}

export function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function normalizeUsername(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 32) {
    return "";
  }
  return normalized;
}

export function normalizePassword(value) {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length < 6 || value.length > 64) {
    return "";
  }
  return value;
}

export function normalizeStrongPassword(value) {
  const normalized = normalizePassword(value);
  if (!normalized) {
    return "";
  }
  return normalized;
}

export function normalizePositiveInteger(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return undefined;
  }

  return numberValue;
}

export function normalizeIntegerInRange(value, minValue, maxValue) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) {
    return undefined;
  }

  if (numberValue < minValue || numberValue > maxValue) {
    return undefined;
  }

  return numberValue;
}

export function normalizeGenerationJobStatus(value) {
  const text = String(value || "").trim();
  const allowed = new Set(["succeeded", "failed", "cancelled"]);
  return allowed.has(text) ? text : "";
}

export function normalizeGenerationReviewStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "pending_review" || text === "published") {
    return text;
  }
  return "";
}

export function normalizeAttempts(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}
