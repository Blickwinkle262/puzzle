const GENERATION_FLOW_STAGES = new Set([
  "",
  "text_generating",
  "text_ready",
  "images_generating",
  "review_ready",
  "published",
  "failed",
]);

const GENERATION_SCENE_TEXT_STATUSES = new Set(["pending", "ready", "failed", "deleted"]);
const GENERATION_SCENE_IMAGE_STATUSES = new Set(["pending", "queued", "running", "success", "failed", "skipped"]);

export function normalizeGenerationFlowStage(value) {
  const text = String(value || "").trim().toLowerCase();
  return GENERATION_FLOW_STAGES.has(text) ? text : "";
}

export function normalizeGenerationSceneTextStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  return GENERATION_SCENE_TEXT_STATUSES.has(text) ? text : "pending";
}

export function normalizeGenerationSceneImageStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "succeeded") {
    return "success";
  }
  return GENERATION_SCENE_IMAGE_STATUSES.has(text) ? text : "pending";
}

export function normalizeGenerationSceneSourceKind(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "legacy" || text === "summary" || text === "review" || text === "manual" || text === "pipeline") {
    return text;
  }
  return "manual";
}

export function normalizeGenerationSceneCharacters(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0)
    .slice(0, 40);
}

export function normalizeCandidateImageStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "success" || text === "failed" || text === "skipped") {
    return text;
  }
  return "pending";
}

export function normalizeCandidateCharacters(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0)
    .slice(0, 20);
}

export function normalizeGenerationCandidateRetryStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "queued" || text === "running" || text === "succeeded" || text === "failed" || text === "cancelled") {
    return text;
  }
  return "queued";
}
