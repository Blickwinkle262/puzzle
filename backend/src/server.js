import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import express from "express";

import {
  assertProductionRegistrationSafety,
  assertProductionWorkerToken,
  resolveAdminUsernameFallbackEnabled,
  resolveCookieSameSite,
  resolveCookieSecure,
  resolvePublicRegistrationEnabled,
  resolveSessionTtlMs,
  resolveTrustProxySetting,
} from "./config/runtime.js";
import { runMigrations } from "./migrate.js";
import { registerAdminLevelRoutes } from "./routes/adminLevelRoutes.js";
import { registerAdminLlmRoutes } from "./routes/adminLlmRoutes.js";
import { registerAdminLegacyGenerationRoutes } from "./routes/adminLegacyGenerationRoutes.js";
import { registerAdminStoryRoutes } from "./routes/adminStoryRoutes.js";
import { registerAdminUserRoutes } from "./routes/adminUserRoutes.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerGenerationReviewRetryRoutes } from "./routes/generationReviewRetryRoutes.js";
import { registerGenerationReviewRoutes } from "./routes/generationReviewRoutes.js";
import { registerInternalWorkerRoutes } from "./routes/internalWorkerRoutes.js";
import { registerPlayerRoutes } from "./routes/playerRoutes.js";
import { registerRunGenerateImageRoutes } from "./routes/runGenerateImageRoutes.js";
import { registerRunGenerateTextRoutes } from "./routes/runGenerateTextRoutes.js";
import { registerRunLifecycleRoutes } from "./routes/runLifecycleRoutes.js";
import { registerRunSceneRoutes } from "./routes/runSceneRoutes.js";
import { createAdminLevelConfigService } from "./services/adminLevelConfigService.js";
import { createAdminUserService } from "./services/adminUserService.js";
import { createAuthCommandService } from "./services/authCommandService.js";
import { createAuthQueryService } from "./services/authQueryService.js";
import { createAuthSessionService, hashSessionToken, randomToken } from "./services/authSessionService.js";
import { createPasswordHasherService } from "./services/passwordHasherService.js";
import { createGenerationLegacySceneService } from "./services/generationLegacySceneService.js";
import { createGenerationPublishService } from "./services/generationPublishService.js";
import { createGenerationRunAdminService } from "./services/generationRunAdminService.js";
import { createGenerationRunStateService } from "./services/generationRunStateService.js";
import { createGenerationSceneService } from "./services/generationSceneService.js";
import { createGenerationSceneRepository } from "./services/generationSceneRepository.js";
import { createGenerationSceneCommandService } from "./services/generationSceneCommandService.js";
import { createGenerationReviewRepository } from "./services/generationReviewRepository.js";
import { createGenerationReviewCommandService } from "./services/generationReviewCommandService.js";
import { createGenerationReviewRetryRepository } from "./services/generationReviewRetryRepository.js";
import { createGenerationReviewRetryCommandService } from "./services/generationReviewRetryCommandService.js";
import { createGenerationRuntimeService } from "./services/generationRuntimeService.js";
import { createPlayerProgressService } from "./services/playerProgressService.js";
import { createStoryCatalogService } from "./services/storyCatalogService.js";
import {
  normalizeCandidateCharacters,
  normalizeCandidateImageStatus,
  normalizeGenerationCandidateRetryStatus,
  normalizeGenerationFlowStage,
  normalizeGenerationSceneCharacters,
  normalizeGenerationSceneImageStatus,
  normalizeGenerationSceneSourceKind,
  normalizeGenerationSceneTextStatus,
} from "./utils/generationNormalize.js";
import {
  normalizeAttempts,
  normalizeBoolean,
  normalizeGenerationJobStatus,
  normalizeGenerationReviewStatus,
  normalizeIntegerInRange,
  normalizeNonNegativeInteger,
  normalizePassword,
  normalizePositiveInteger,
  normalizePositiveNumber,
  normalizeRunId,
  normalizeShortText,
  normalizeStrongPassword,
  normalizeTargetDate,
  normalizeUsername,
} from "./utils/normalize.js";
import {
  asMessage,
  nowIso,
  readJsonSafe,
  readTailLines,
  safeParseJsonArray,
  safeParseJsonObject,
} from "./utils/runtimeHelpers.js";
import { createProjectPathResolver, isPathInside } from "./utils/fsSafe.js";
import { resolveStoryGeneratorPythonCommand } from "./utils/pythonCommand.js";
import { createStoryAssetUtils, normalizeContentVersion, normalizeLegacyIds } from "./utils/storyAssets.js";
import { errorResponsePayload, isAppError } from "./utils/appError.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const resolveProjectPath = createProjectPathResolver(ROOT_DIR);
const WEB_PUBLIC_DIR = path.join(ROOT_DIR, "web", "public");
const STORY_PUBLIC_PREFIX = "/content/stories";
const DEFAULT_STORIES_ROOT_DIR = path.join(ROOT_DIR, "backend", "data", "generated", "content", "stories");
const LEGACY_STORIES_ROOT_DIR = path.join(WEB_PUBLIC_DIR, "content", "stories");
const STORIES_ROOT_DIR = resolveStoriesRootDir();
const STORY_INDEX_FILE = path.join(STORIES_ROOT_DIR, "index.json");

const DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "puzzle_session";
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || "puzzle_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const SESSION_TTL_MS = resolveSessionTtlMs();
const COOKIE_SECURE = resolveCookieSecure();
const COOKIE_SAME_SITE = resolveCookieSameSite(COOKIE_SECURE);
const VALID_PROGRESS_STATUS = new Set(["not_started", "in_progress", "completed"]);
const AUTH_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 10;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 20;
const AUTH_RATE_LIMIT_CLEANUP_INTERVAL = 200;
const REGISTER_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60;
const REGISTER_RATE_LIMIT_MAX_ATTEMPTS = 8;
const REGISTER_RATE_LIMIT_CLEANUP_INTERVAL = 120;
const FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 30;
const FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS = 8;
const RESET_PASSWORD_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 30;
const RESET_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS = 20;
const PASSWORD_RESET_RATE_LIMIT_CLEANUP_INTERVAL = 120;
const RESET_TOKEN_TTL_MS = 1000 * 60 * 30;
const GENERATED_ROOT_DIR = path.join(ROOT_DIR, "backend", "data", "generated");
const STORY_GENERATOR_OUTPUT_ROOT = resolveProjectPath(
  process.env.STORY_GENERATOR_OUTPUT_ROOT
    || process.env.STORY_GENERATION_OUTPUT_ROOT,
  path.join(GENERATED_ROOT_DIR, "content", "stories"),
);
const STORY_GENERATOR_INDEX_FILE = resolveProjectPath(
  process.env.STORY_GENERATOR_INDEX_FILE
    || process.env.STORY_GENERATION_INDEX_FILE,
  path.join(STORY_GENERATOR_OUTPUT_ROOT, "index.json"),
);
const STORY_GENERATOR_LOG_DIR = resolveProjectPath(
  process.env.STORY_GENERATOR_LOG_DIR
    || process.env.STORY_GENERATION_LOG_DIR,
  path.join(GENERATED_ROOT_DIR, "logs", "story_generator"),
);
const STORY_GENERATOR_SUMMARY_DIR = resolveProjectPath(
  process.env.STORY_GENERATOR_SUMMARY_DIR
    || process.env.STORY_GENERATION_SUMMARY_DIR,
  path.join(GENERATED_ROOT_DIR, "summaries", "story_generator"),
);
const ADMIN_USERNAMES = new Set(
  String(process.env.ADMIN_USERNAMES || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0),
);
const ADMIN_USERNAME_FALLBACK_ENABLED = resolveAdminUsernameFallbackEnabled();
const PUBLIC_REGISTRATION_ENABLED = resolvePublicRegistrationEnabled();
const ADMIN_BOOTSTRAP_TOKEN = String(process.env.ADMIN_BOOTSTRAP_TOKEN || "").trim();
assertProductionRegistrationSafety({
  publicRegistrationEnabled: PUBLIC_REGISTRATION_ENABLED,
  adminUsernameFallbackEnabled: ADMIN_USERNAME_FALLBACK_ENABLED,
  adminUsernames: ADMIN_USERNAMES,
});
const parsedMaxGenerationJobs = Number(process.env.MAX_GENERATION_JOBS || 100);
const MAX_GENERATION_JOBS = Number.isFinite(parsedMaxGenerationJobs) && parsedMaxGenerationJobs > 0
  ? Math.max(10, Math.floor(parsedMaxGenerationJobs))
  : 100;
const STORY_GENERATOR_WORKER_TOKEN = String(
  process.env.STORY_GENERATOR_WORKER_TOKEN
    || process.env.STORY_GENERATION_WORKER_TOKEN
    || "",
).trim();
assertProductionWorkerToken(STORY_GENERATOR_WORKER_TOKEN);
const STORY_GENERATOR_PYTHON_BIN = String(
  process.env.STORY_GENERATOR_PYTHON_BIN
    || process.env.STORY_GENERATION_PYTHON_BIN
    || process.env.PYTHON_BIN
    || "",
).trim();
const STORY_GENERATOR_PYTHON_CMD = resolveStoryGeneratorPythonCommand({
  explicitCmd: process.env.STORY_GENERATOR_PYTHON_CMD || process.env.STORY_GENERATION_PYTHON_CMD || "",
  explicitBin: STORY_GENERATOR_PYTHON_BIN,
  rootDir: ROOT_DIR,
});
const STORY_GENERATOR_ATOMIC_MODULE = "scripts.story_generator_pipeline.atomic_cli";
const parsedAtomicTimeoutMs = Number(
  process.env.STORY_GENERATOR_ATOMIC_TIMEOUT_MS
    || process.env.STORY_GENERATION_ATOMIC_TIMEOUT_MS
    || 1000 * 60 * 8,
);
const STORY_GENERATOR_ATOMIC_TIMEOUT_MS = Number.isFinite(parsedAtomicTimeoutMs) && parsedAtomicTimeoutMs > 0
  ? Math.floor(parsedAtomicTimeoutMs)
  : 1000 * 60 * 8;
const parsedBookSummaryTimeoutMs = Number(
  process.env.STORY_GENERATOR_BOOK_SUMMARY_TIMEOUT_MS
    || process.env.STORY_GENERATION_BOOK_SUMMARY_TIMEOUT_MS
    || process.env.BOOK_SUMMARY_TIMEOUT_MS
    || 1000 * 60 * 60,
);
const STORY_GENERATOR_BOOK_SUMMARY_TIMEOUT_MS = Number.isFinite(parsedBookSummaryTimeoutMs) && parsedBookSummaryTimeoutMs > 0
  ? Math.floor(parsedBookSummaryTimeoutMs)
  : 1000 * 60 * 60;
const LEGACY_GENERATE_STORY_CREATE_ENABLED = normalizeBoolean(
  process.env.GENERATION_LEGACY_CREATE_ENABLED
    || process.env.STORY_GENERATOR_LEGACY_CREATE_ENABLED
    || false,
);
const DEFAULT_TIMER_POLICY = Object.freeze({
  base_seconds: 45,
  per_piece_seconds: 4,
  min_seconds: 60,
  max_seconds: 600,
  difficulty_factor: {
    easy: 1.2,
    normal: 1.0,
    hard: 0.85,
    nightmare: 0.7,
  },
});
const MANAGED_ADMIN_ROLES = new Set(["admin", "editor", "level_designer", "operator"]);
const MANAGED_LEVEL_DIFFICULTIES = new Set(["easy", "normal", "hard", "nightmare"]);
const BOOK_INGEST_DB_PATH = resolveProjectPath(
  process.env.BOOK_INGEST_DB_PATH,
  path.join(ROOT_DIR, "scripts", "book_ingest", "data", "books.sqlite"),
);
const RESOLVED_BOOK_INGEST_DB_PATH = BOOK_INGEST_DB_PATH;
const BOOK_UPLOADS_DIR = path.join(path.dirname(RESOLVED_BOOK_INGEST_DB_PATH), "uploads");
let booksDb = null;

const LLM_RUNTIME_SETTING_KEY = "llm_runtime_v1";
const LLM_PROVIDER_KIND = "compatible";
const LLM_PROFILE_SCOPE_GLOBAL = "global";
const LLM_PROFILE_SCOPE_USER = "user";
const LLM_PROVIDER_KEY_SOURCE_ENV = "env";
const LLM_PROVIDER_KEY_SOURCE_CUSTOM = "custom";
const LLM_KEY_ENCRYPTION_PREFIX = "enc:v1";
const LLM_KEY_ENCRYPTION_SECRET = String(
  process.env.LLM_KEY_ENCRYPTION_SECRET
    || process.env.APP_SECRET
    || process.env.SESSION_SECRET
    || "puzzle-llm-key-default",
).trim();
const LLM_KEY_ENCRYPTION_BUFFER = crypto.createHash("sha256").update(LLM_KEY_ENCRYPTION_SECRET).digest();

function listLlmApiKeyCandidates() {
  const preferredKeys = [
    "AIHUBMIX_API_KEY",
    "STORY_GENERATOR_API_KEY",
    "STORY_GENERATION_API_KEY",
    "OPENAI_API_KEY",
  ];
  const dynamicPrefixes = [
    "AIHUBMIX_API_KEY_",
    "STORY_GENERATOR_API_KEY_",
    "STORY_GENERATION_API_KEY_",
    "OPENAI_API_KEY_",
  ];

  const options = [];
  const seen = new Set();

  const pushEnvKey = (rawKey) => {
    const key = String(rawKey || "").trim();
    if (!key || seen.has(key)) {
      return;
    }

    const value = String(process.env[key] || "").trim();
    if (!value) {
      return;
    }

    seen.add(key);
    options.push({
      key,
      label: key,
      configured: true,
    });
  };

  const configuredCandidates = String(process.env.LLM_API_KEY_CANDIDATES || "")
    .split(",")
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);

  configuredCandidates.forEach(pushEnvKey);
  preferredKeys.forEach(pushEnvKey);

  const envKeys = Object.keys(process.env || {}).sort((a, b) => a.localeCompare(b, "en"));
  for (const key of envKeys) {
    if (!dynamicPrefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    pushEnvKey(key);
  }

  return options;
}

function resolveDefaultLlmBaseUrl() {
  return String(
    process.env.STORY_GENERATOR_BASE_URL
      || process.env.STORY_GENERATION_BASE_URL
      || process.env.AIHUBMIX_BASE_URL
      || process.env.AIHUBMIX_OPENAI_BASE_URL
      || process.env.OPENAI_BASE_URL
      || "https://aihubmix.com/v1",
  ).trim();
}

function resolveDefaultLlmTextModel() {
  return String(
    process.env.STORY_GENERATOR_TEXT_MODEL
      || process.env.STORY_GENERATION_TEXT_MODEL
      || process.env.AIHUBMIX_TEXT_MODEL
      || "qwen3-next-80b-a3b-instruct",
  ).trim();
}

function resolveDefaultLlmSummaryModel() {
  return String(
    process.env.STORY_GENERATOR_SUMMARY_MODEL
      || process.env.STORY_GENERATION_SUMMARY_MODEL
      || process.env.AIHUBMIX_SUMMARY_MODEL
      || resolveDefaultLlmTextModel(),
  ).trim();
}

function resolveDefaultLlmImageModel() {
  return String(
    process.env.STORY_GENERATOR_IMAGE_MODEL
      || process.env.STORY_GENERATION_IMAGE_MODEL
      || process.env.AIHUBMIX_IMAGE_MODEL
      || "doubao/doubao-seedream-4-5-251128",
  ).trim();
}

function buildDefaultLlmConfig(keyOptions) {
  const options = Array.isArray(keyOptions) ? keyOptions : listLlmApiKeyCandidates();
  const defaultSelector = options.length > 0 ? String(options[0].key || "") : "";

  return {
    provider_kind: LLM_PROVIDER_KIND,
    api_base_url: resolveDefaultLlmBaseUrl(),
    api_key_selector: defaultSelector,
    text_model: resolveDefaultLlmTextModel(),
    summary_model: resolveDefaultLlmSummaryModel(),
    image_model: resolveDefaultLlmImageModel(),
    proxy_url: String(process.env.STORY_GENERATOR_PROXY_URL || process.env.HTTP_PROXY || "").trim(),
    no_proxy: String(process.env.STORY_GENERATOR_NO_PROXY || process.env.NO_PROXY || "").trim(),
  };
}

function normalizeLlmConfig(rawConfig, options = {}) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const keyOptions = Array.isArray(options.keyOptions) ? options.keyOptions : listLlmApiKeyCandidates();
  const fallback = options.fallback && typeof options.fallback === "object"
    ? options.fallback
    : buildDefaultLlmConfig(keyOptions);
  const keyOptionSet = new Set(keyOptions.map((item) => String(item.key || "").trim()).filter((item) => item.length > 0));

  const normalized = {
    provider_kind: String(source.provider_kind || fallback.provider_kind || LLM_PROVIDER_KIND).trim() || LLM_PROVIDER_KIND,
    api_base_url: String(source.api_base_url || fallback.api_base_url || "").trim(),
    api_key_selector: String(source.api_key_selector || fallback.api_key_selector || "").trim(),
    text_model: String(source.text_model || fallback.text_model || "").trim(),
    summary_model: String(source.summary_model || fallback.summary_model || "").trim(),
    image_model: String(source.image_model || fallback.image_model || "").trim(),
    proxy_url: String(source.proxy_url || fallback.proxy_url || "").trim(),
    no_proxy: String(source.no_proxy || fallback.no_proxy || "").trim(),
  };

  if (normalized.provider_kind !== LLM_PROVIDER_KIND) {
    normalized.provider_kind = LLM_PROVIDER_KIND;
  }

  if (normalized.api_key_selector && !keyOptionSet.has(normalized.api_key_selector)) {
    normalized.api_key_selector = "";
  }

  if (!normalized.api_key_selector && keyOptions.length > 0) {
    normalized.api_key_selector = String(keyOptions[0].key || "").trim();
  }

  if (!normalized.api_base_url) {
    normalized.api_base_url = fallback.api_base_url;
  }
  if (!normalized.text_model) {
    normalized.text_model = fallback.text_model;
  }
  if (!normalized.summary_model) {
    normalized.summary_model = fallback.summary_model || normalized.text_model;
  }
  if (!normalized.image_model) {
    normalized.image_model = fallback.image_model;
  }

  return normalized;
}

function readSystemSettingJson(key, fallbackValue = null) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    return fallbackValue;
  }

  try {
    const row = db.prepare("SELECT value_json FROM system_settings WHERE key = ? LIMIT 1").get(normalizedKey);
    if (!row || typeof row.value_json !== "string" || !row.value_json.trim()) {
      return fallbackValue;
    }
    const parsed = safeParseJsonObject(row.value_json);
    return parsed && typeof parsed === "object" ? parsed : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function writeSystemSettingJson(key, valueObject, updatedByUserId = null) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    throw new Error("setting key 不能为空");
  }

  const payload = valueObject && typeof valueObject === "object" ? valueObject : {};

  db.prepare(
    `
      INSERT INTO system_settings (key, value_json, updated_by_user_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = excluded.updated_at
    `,
  ).run(normalizedKey, JSON.stringify(payload), normalizePositiveInteger(updatedByUserId) || null, nowIso());
}

function getAdminLlmConfigState() {
  const keyOptions = listLlmApiKeyCandidates();
  const fallback = buildDefaultLlmConfig(keyOptions);
  const stored = readSystemSettingJson(LLM_RUNTIME_SETTING_KEY, null);
  const config = normalizeLlmConfig(stored, { fallback, keyOptions });

  return {
    ok: true,
    provider_kind: LLM_PROVIDER_KIND,
    config,
    key_options: keyOptions,
    selected_key_configured: Boolean(config.api_key_selector && keyOptions.some((item) => item.key === config.api_key_selector)),
  };
}

function saveAdminLlmConfig(patch, updatedByUserId = null) {
  const currentState = getAdminLlmConfigState();
  const mergedRaw = {
    ...currentState.config,
    ...(patch && typeof patch === "object" ? patch : {}),
  };
  const config = normalizeLlmConfig(mergedRaw, {
    fallback: currentState.config,
    keyOptions: currentState.key_options,
  });

  writeSystemSettingJson(LLM_RUNTIME_SETTING_KEY, config, updatedByUserId);
  return getAdminLlmConfigState();
}

function hasLlmProviderTables() {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_providers' LIMIT 1",
    ).get();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function hasLlmProfileTable() {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_user_profiles' LIMIT 1",
    ).get();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function hasLlmModelTable() {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_provider_models' LIMIT 1",
    ).get();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function hasLlmAuditTable() {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_audit_logs' LIMIT 1",
    ).get();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function appendLlmAuditLog({ userId = null, providerId = null, action = "", diff = {} }) {
  if (!hasLlmAuditTable()) {
    return;
  }

  const normalizedAction = String(action || "").trim().slice(0, 120);
  if (!normalizedAction) {
    return;
  }

  const payload = diff && typeof diff === "object" ? diff : {};
  try {
    db.prepare(
      `
      INSERT INTO llm_audit_logs (user_id, provider_id, action, diff_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(
      normalizePositiveInteger(userId) || null,
      normalizePositiveInteger(providerId) || null,
      normalizedAction,
      JSON.stringify(payload),
      nowIso(),
    );
  } catch {
    // ignore audit failures
  }
}

function encryptLlmApiKey(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", LLM_KEY_ENCRYPTION_BUFFER, iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    LLM_KEY_ENCRYPTION_PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptLlmApiKey(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (!raw.startsWith(`${LLM_KEY_ENCRYPTION_PREFIX}:`)) {
    return raw;
  }

  const parts = raw.split(":");
  if (parts.length !== 4) {
    return "";
  }

  try {
    const iv = Buffer.from(parts[1], "base64");
    const authTag = Buffer.from(parts[2], "base64");
    const encrypted = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", LLM_KEY_ENCRYPTION_BUFFER, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8").trim();
  } catch {
    return "";
  }
}

function normalizeLlmProviderKind(value) {
  return String(value || "").trim() === LLM_PROVIDER_KIND ? LLM_PROVIDER_KIND : LLM_PROVIDER_KIND;
}

function normalizeLlmProviderWritePatch(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const enabledRaw = source.enabled;
  const enabled = enabledRaw === undefined ? null : normalizeBoolean(enabledRaw);

  return {
    name: String(source.name || "").trim().slice(0, 80),
    provider_kind: normalizeLlmProviderKind(source.provider_kind),
    api_base_url: String(source.api_base_url || source.base_url || "").trim().slice(0, 400),
    proxy_url: String(source.proxy_url || "").trim().slice(0, 400),
    no_proxy_hosts: String(source.no_proxy_hosts || source.no_proxy || "").trim().slice(0, 500),
    enabled,
  };
}

function normalizeLlmProviderKeyWritePatch(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const rawKeySource = String(source.key_source || source.api_key_source || "").trim();
  const keySource = rawKeySource === LLM_PROVIDER_KEY_SOURCE_CUSTOM
    ? LLM_PROVIDER_KEY_SOURCE_CUSTOM
    : LLM_PROVIDER_KEY_SOURCE_ENV;

  return {
    key_source: keySource,
    env_key_name: String(source.env_key_name || source.api_key_selector || "").trim().slice(0, 120),
    api_key: String(source.api_key || source.custom_api_key || "").trim().slice(0, 5000),
  };
}

function normalizeLlmProfileWritePatch(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const legacyProviderId = normalizePositiveInteger(source.provider_id || source.providerId);
  const storyProviderId = normalizePositiveInteger(source.story_provider_id || source.storyProviderId || source.text_provider_id || source.textProviderId) || legacyProviderId;
  const summaryProviderId = normalizePositiveInteger(source.summary_provider_id || source.summaryProviderId)
    || storyProviderId
    || legacyProviderId;
  const imageProviderId = normalizePositiveInteger(source.text2image_provider_id || source.text2imageProviderId || source.image_provider_id || source.imageProviderId)
    || legacyProviderId;

  return {
    provider_id: storyProviderId || imageProviderId || summaryProviderId || legacyProviderId,
    story_provider_id: storyProviderId,
    summary_provider_id: summaryProviderId,
    text2image_provider_id: imageProviderId,
    story_prompt_model: String(source.story_prompt_model || source.text_model || "").trim().slice(0, 220),
    summary_model: String(source.summary_model || "").trim().slice(0, 220),
    text2image_model: String(source.text2image_model || source.image_model || "").trim().slice(0, 220),
  };
}

function maskLlmKeyLast4(last4) {
  const value = String(last4 || "").trim();
  if (!value) {
    return "";
  }
  return `****${value.slice(-4)}`;
}

function serializeLlmProviderRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    name: String(row.name || ""),
    provider_kind: normalizeLlmProviderKind(row.provider_kind),
    api_base_url: String(row.api_base_url || ""),
    proxy_url: String(row.proxy_url || ""),
    no_proxy_hosts: String(row.no_proxy_hosts || ""),
    enabled: Number(row.enabled || 0) === 1,
    owner_user_id: normalizePositiveInteger(row.owner_user_id) || null,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    models_count: normalizePositiveInteger(row.models_count) || 0,
    key: row.key_id
      ? {
        id: Number(row.key_id),
        key_source: String(row.key_source || LLM_PROVIDER_KEY_SOURCE_ENV),
        env_key_name: String(row.env_key_name || ""),
        key_last4: String(row.key_last4 || ""),
        key_masked: maskLlmKeyLast4(row.key_last4),
        has_key: Boolean(String(row.env_key_name || "").trim() || String(row.encrypted_key || "").trim()),
        is_active: Number(row.key_is_active || 0) === 1,
      }
      : null,
  };
}

function serializeLlmProfileRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    scope: String(row.scope || ""),
    user_id: normalizePositiveInteger(row.user_id) || null,
    provider_id: normalizePositiveInteger(row.provider_id) || null,
    story_provider_id: normalizePositiveInteger(row.story_provider_id) || normalizePositiveInteger(row.provider_id) || null,
    summary_provider_id: normalizePositiveInteger(row.summary_provider_id) || normalizePositiveInteger(row.story_provider_id) || normalizePositiveInteger(row.provider_id) || null,
    text2image_provider_id: normalizePositiveInteger(row.text2image_provider_id) || normalizePositiveInteger(row.provider_id) || null,
    provider_name: String(row.provider_name || ""),
    story_provider_name: String(row.story_provider_name || row.provider_name || ""),
    summary_provider_name: String(row.summary_provider_name || row.story_provider_name || row.provider_name || ""),
    text2image_provider_name: String(row.text2image_provider_name || row.provider_name || ""),
    provider_kind: String(row.provider_kind || LLM_PROVIDER_KIND),
    story_prompt_model: String(row.story_prompt_model || ""),
    text_model: String(row.story_prompt_model || ""),
    summary_model: String(row.summary_model || ""),
    text2image_model: String(row.text2image_model || ""),
    image_model: String(row.text2image_model || ""),
    is_default: Number(row.is_default || 0) === 1,
    updated_at: String(row.updated_at || ""),
  };
}

function serializeLlmProviderModelRow(row) {
  return {
    id: Number(row.id),
    provider_id: Number(row.provider_id),
    model_id: String(row.model_id || ""),
    model_type: String(row.model_type || "text"),
    enabled: Number(row.enabled || 0) === 1,
    fetched_at: String(row.fetched_at || ""),
  };
}

function findFirstConfiguredApiKeySelector(keyOptions) {
  const options = Array.isArray(keyOptions) ? keyOptions : [];
  const first = options.find((item) => {
    const key = String(item?.key || "").trim();
    return key.length > 0 && String(process.env[key] || "").trim().length > 0;
  });
  return first ? String(first.key || "") : "";
}

function buildEnvLlmRuntimeSettings() {
  const keyOptions = listLlmApiKeyCandidates();
  const fallback = buildDefaultLlmConfig(keyOptions);
  const preferredSelector = String(fallback.api_key_selector || "").trim();
  const configuredSelector = preferredSelector && String(process.env[preferredSelector] || "").trim()
    ? preferredSelector
    : findFirstConfiguredApiKeySelector(keyOptions);

  return {
    provider_id: null,
    provider_name: "env",
    profile_scope: "env",
    provider_kind: LLM_PROVIDER_KIND,
    api_base_url: String(fallback.api_base_url || "").trim(),
    api_key_selector: String(configuredSelector || "").trim(),
    api_key: configuredSelector ? String(process.env[configuredSelector] || "").trim() : "",
    text_model: String(fallback.text_model || "").trim(),
    summary_model: String(fallback.summary_model || fallback.text_model || "").trim(),
    image_model: String(fallback.image_model || "").trim(),
    proxy_url: String(fallback.proxy_url || "").trim(),
    no_proxy: String(fallback.no_proxy || "").trim(),
  };
}

function buildLegacyLlmRuntimePatch() {
  const state = getAdminLlmConfigState();
  const keyOptions = Array.isArray(state.key_options) ? state.key_options : [];
  const config = state.config && typeof state.config === "object" ? state.config : {};

  let apiKeySelector = String(config.api_key_selector || "").trim();
  let apiKey = apiKeySelector ? String(process.env[apiKeySelector] || "").trim() : "";
  if (!apiKey) {
    const fallbackSelector = findFirstConfiguredApiKeySelector(keyOptions);
    if (fallbackSelector) {
      apiKeySelector = fallbackSelector;
      apiKey = String(process.env[fallbackSelector] || "").trim();
    }
  }

  return {
    provider_kind: LLM_PROVIDER_KIND,
    api_base_url: String(config.api_base_url || "").trim(),
    api_key_selector: apiKeySelector,
    api_key: apiKey,
    text_model: String(config.text_model || "").trim(),
    summary_model: String(config.summary_model || config.text_model || "").trim(),
    image_model: String(config.image_model || "").trim(),
    proxy_url: String(config.proxy_url || "").trim(),
    no_proxy: String(config.no_proxy || "").trim(),
  };
}

function applyLlmRuntimePatch(runtimeState, patch) {
  const runtime = runtimeState && typeof runtimeState === "object" ? runtimeState : {};
  const source = patch && typeof patch === "object" ? patch : {};
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(source, key);

  const assignNonEmpty = (key) => {
    if (!hasOwn(key)) {
      return;
    }
    const value = String(source[key] || "").trim();
    if (value) {
      runtime[key] = value;
    }
  };

  const assignMaybeEmpty = (key) => {
    if (!hasOwn(key)) {
      return;
    }
    runtime[key] = String(source[key] || "").trim();
  };

  if (hasOwn("provider_id")) {
    runtime.provider_id = normalizePositiveInteger(source.provider_id) || null;
  }

  assignNonEmpty("provider_name");
  assignNonEmpty("profile_scope");
  assignNonEmpty("provider_kind");
  assignNonEmpty("api_base_url");
  assignMaybeEmpty("api_key_selector");
  assignMaybeEmpty("api_key");
  assignNonEmpty("text_model");
  assignNonEmpty("summary_model");
  assignNonEmpty("image_model");
  assignMaybeEmpty("proxy_url");
  assignMaybeEmpty("no_proxy");

  return runtime;
}

function extractLlmRuntimeInput(overrides) {
  const raw = overrides && typeof overrides === "object" ? overrides : {};
  const rootUserId = normalizePositiveInteger(raw.userId || raw.user_id);
  const rootProviderId = normalizePositiveInteger(raw.providerId || raw.provider_id);
  const nestedOverrides = raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {};

  const flatOverrides = { ...raw };
  delete flatOverrides.userId;
  delete flatOverrides.user_id;
  delete flatOverrides.providerId;
  delete flatOverrides.provider_id;
  delete flatOverrides.overrides;

  const mergedOverrides = {
    ...flatOverrides,
    ...nestedOverrides,
  };

  const normalizedOverrides = {
    provider_id: normalizePositiveInteger(mergedOverrides.provider_id || mergedOverrides.providerId),
    provider_kind: String(mergedOverrides.provider_kind || "").trim(),
    api_base_url: String(mergedOverrides.api_base_url || mergedOverrides.base_url || "").trim(),
    api_key_selector: String(mergedOverrides.api_key_selector || mergedOverrides.env_key_name || "").trim(),
    api_key: String(mergedOverrides.api_key || "").trim(),
    text_model: String(mergedOverrides.text_model || mergedOverrides.story_prompt_model || "").trim(),
    summary_model: String(mergedOverrides.summary_model || "").trim(),
    image_model: String(mergedOverrides.image_model || mergedOverrides.text2image_model || "").trim(),
    proxy_url: String(mergedOverrides.proxy_url || "").trim(),
    no_proxy: String(mergedOverrides.no_proxy || mergedOverrides.no_proxy_hosts || "").trim(),
  };

  return {
    userId: rootUserId,
    providerId: rootProviderId,
    overrides: normalizedOverrides,
  };
}

function getLlmProviderWithActiveKeyRow(providerId, options = {}) {
  if (!hasLlmProviderTables()) {
    return null;
  }

  const id = normalizePositiveInteger(providerId);
  if (!id) {
    return null;
  }

  const allowDisabled = Boolean(options.allowDisabled);
  const row = db.prepare(
    `
      SELECT p.id, p.name, p.provider_kind, p.api_base_url, p.proxy_url, p.no_proxy_hosts,
             p.enabled, p.owner_user_id, p.created_at, p.updated_at,
             k.id AS key_id, k.key_source, k.env_key_name, k.encrypted_key, k.key_last4,
             k.is_active AS key_is_active
      FROM llm_providers p
      LEFT JOIN llm_provider_keys k
        ON k.id = (
          SELECT k2.id
          FROM llm_provider_keys k2
          WHERE k2.provider_id = p.id
            AND k2.is_active = 1
          ORDER BY k2.updated_at DESC, k2.id DESC
          LIMIT 1
        )
      WHERE p.id = ?
      LIMIT 1
    `,
  ).get(id);

  if (!row) {
    return null;
  }
  if (!allowDisabled && Number(row.enabled || 0) !== 1) {
    return null;
  }

  return row;
}

function resolveLlmApiKeyFromProviderRow(providerRow) {
  if (!providerRow) {
    return {
      selector: "",
      apiKey: "",
    };
  }

  const keySource = String(providerRow.key_source || "").trim();
  if (keySource === LLM_PROVIDER_KEY_SOURCE_CUSTOM) {
    return {
      selector: "custom",
      apiKey: decryptLlmApiKey(providerRow.encrypted_key),
    };
  }

  const envKeyName = String(providerRow.env_key_name || "").trim();
  return {
    selector: envKeyName,
    apiKey: envKeyName ? String(process.env[envKeyName] || "").trim() : "",
  };
}

function resolveLlmProviderRuntimeSettings(providerId, options = {}) {
  const row = getLlmProviderWithActiveKeyRow(providerId, options);
  if (!row) {
    return null;
  }

  const resolvedKey = resolveLlmApiKeyFromProviderRow(row);
  return {
    provider_id: Number(row.id),
    provider_name: String(row.name || "").trim(),
    provider_kind: normalizeLlmProviderKind(row.provider_kind),
    api_base_url: String(row.api_base_url || "").trim(),
    api_key_selector: resolvedKey.selector,
    api_key: resolvedKey.apiKey,
    proxy_url: String(row.proxy_url || "").trim(),
    no_proxy: String(row.no_proxy_hosts || "").trim(),
  };
}

function getLlmProfileRow(scope, userId = null) {
  if (!hasLlmProfileTable()) {
    return null;
  }

  const normalizedScope = String(scope || "").trim() === LLM_PROFILE_SCOPE_USER
    ? LLM_PROFILE_SCOPE_USER
    : LLM_PROFILE_SCOPE_GLOBAL;

  if (normalizedScope === LLM_PROFILE_SCOPE_GLOBAL) {
    return db.prepare(
      `
        SELECT p.id, p.user_id, p.provider_id, p.story_prompt_model, p.text2image_model,
               p.summary_model, p.story_provider_id, p.summary_provider_id, p.text2image_provider_id,
               p.is_default, p.scope, p.created_at, p.updated_at,
               lp.name AS provider_name,
               lp.provider_kind AS provider_kind,
               lps.name AS story_provider_name,
               lpsum.name AS summary_provider_name,
               lpi.name AS text2image_provider_name
        FROM llm_user_profiles p
        LEFT JOIN llm_providers lp ON lp.id = p.provider_id
        LEFT JOIN llm_providers lps ON lps.id = COALESCE(p.story_provider_id, p.provider_id)
        LEFT JOIN llm_providers lpsum ON lpsum.id = COALESCE(p.summary_provider_id, p.story_provider_id, p.provider_id)
        LEFT JOIN llm_providers lpi ON lpi.id = COALESCE(p.text2image_provider_id, p.provider_id)
        WHERE p.scope = ?
        ORDER BY p.is_default DESC, p.updated_at DESC, p.id DESC
        LIMIT 1
      `,
    ).get(LLM_PROFILE_SCOPE_GLOBAL);
  }

  const normalizedUserId = normalizePositiveInteger(userId);
  if (!normalizedUserId) {
    return null;
  }

  return db.prepare(
    `
      SELECT p.id, p.user_id, p.provider_id, p.story_prompt_model, p.text2image_model,
             p.summary_model, p.story_provider_id, p.summary_provider_id, p.text2image_provider_id,
             p.is_default, p.scope, p.created_at, p.updated_at,
             lp.name AS provider_name,
             lp.provider_kind AS provider_kind,
             lps.name AS story_provider_name,
             lpsum.name AS summary_provider_name,
             lpi.name AS text2image_provider_name
      FROM llm_user_profiles p
      LEFT JOIN llm_providers lp ON lp.id = p.provider_id
      LEFT JOIN llm_providers lps ON lps.id = COALESCE(p.story_provider_id, p.provider_id)
      LEFT JOIN llm_providers lpsum ON lpsum.id = COALESCE(p.summary_provider_id, p.story_provider_id, p.provider_id)
      LEFT JOIN llm_providers lpi ON lpi.id = COALESCE(p.text2image_provider_id, p.provider_id)
      WHERE p.scope = ? AND p.user_id = ?
      ORDER BY p.is_default DESC, p.updated_at DESC, p.id DESC
      LIMIT 1
    `,
  ).get(LLM_PROFILE_SCOPE_USER, normalizedUserId);
}

function resolveLlmRuntimeFromProfileRow(profileRow, options = {}) {
  if (!profileRow) {
    return null;
  }

  const purpose = String(options.purpose || "text").trim();
  const storyProviderId = normalizePositiveInteger(profileRow.story_provider_id) || normalizePositiveInteger(profileRow.provider_id);
  const summaryProviderId = normalizePositiveInteger(profileRow.summary_provider_id) || storyProviderId || normalizePositiveInteger(profileRow.provider_id);
  const imageProviderId = normalizePositiveInteger(profileRow.text2image_provider_id) || normalizePositiveInteger(profileRow.provider_id);

  const providerId = purpose === "image"
    ? imageProviderId
    : purpose === "summary"
      ? summaryProviderId
      : storyProviderId;

  if (!providerId) {
    return null;
  }

  const providerRuntime = resolveLlmProviderRuntimeSettings(providerId, {
    allowDisabled: Boolean(options.allowDisabled),
  });
  if (!providerRuntime) {
    return null;
  }

  return {
    ...providerRuntime,
    profile_scope: String(profileRow.scope || "").trim(),
    text_model: String(profileRow.story_prompt_model || "").trim(),
    summary_model: String(profileRow.summary_model || "").trim(),
    image_model: String(profileRow.text2image_model || "").trim(),
  };
}

function resolveLlmRuntimeSettings(overrides = null) {
  const input = extractLlmRuntimeInput(overrides);
  const purpose = String(input.overrides.purpose || "text").trim() === "image"
    ? "image"
    : String(input.overrides.purpose || "text").trim() === "summary"
      ? "summary"
      : "text";

  const runtime = buildEnvLlmRuntimeSettings();
  applyLlmRuntimePatch(runtime, buildLegacyLlmRuntimePatch());

  const globalProfileRow = getLlmProfileRow(LLM_PROFILE_SCOPE_GLOBAL, null);
  const globalRuntimePatch = resolveLlmRuntimeFromProfileRow(globalProfileRow, { purpose });
  if (globalRuntimePatch) {
    applyLlmRuntimePatch(runtime, globalRuntimePatch);
  }

  if (input.userId) {
    const userProfileRow = getLlmProfileRow(LLM_PROFILE_SCOPE_USER, input.userId);
    const userRuntimePatch = resolveLlmRuntimeFromProfileRow(userProfileRow, { purpose });
    if (userRuntimePatch) {
      applyLlmRuntimePatch(runtime, userRuntimePatch);
    }
  }

  if (input.providerId) {
    const providerRuntimePatch = resolveLlmProviderRuntimeSettings(input.providerId, { allowDisabled: true });
    if (providerRuntimePatch) {
      applyLlmRuntimePatch(runtime, {
        ...providerRuntimePatch,
        profile_scope: "run_payload",
      });
    }
  }

  if (input.overrides.provider_id) {
    const providerRuntimePatch = resolveLlmProviderRuntimeSettings(input.overrides.provider_id, { allowDisabled: true });
    if (providerRuntimePatch) {
      applyLlmRuntimePatch(runtime, {
        ...providerRuntimePatch,
        profile_scope: "run_payload",
      });
    }
  }

  const stageProviderId = purpose === "image"
    ? normalizePositiveInteger(input.overrides.text2image_provider_id || input.overrides.image_provider_id)
    : purpose === "summary"
      ? normalizePositiveInteger(input.overrides.summary_provider_id)
      : normalizePositiveInteger(input.overrides.story_provider_id || input.overrides.text_provider_id);

  if (stageProviderId) {
    const providerRuntimePatch = resolveLlmProviderRuntimeSettings(stageProviderId, { allowDisabled: true });
    if (providerRuntimePatch) {
      applyLlmRuntimePatch(runtime, {
        ...providerRuntimePatch,
        profile_scope: "run_payload",
      });
    }
  }

  applyLlmRuntimePatch(runtime, input.overrides);

  runtime.provider_kind = normalizeLlmProviderKind(runtime.provider_kind);
  runtime.summary_model = String(runtime.summary_model || runtime.text_model || "").trim();
  runtime.api_base_url = String(runtime.api_base_url || "").trim();
  runtime.text_model = String(runtime.text_model || "").trim();
  runtime.image_model = String(runtime.image_model || "").trim();
  runtime.proxy_url = String(runtime.proxy_url || "").trim();
  runtime.no_proxy = String(runtime.no_proxy || "").trim();

  return runtime;
}

function buildLlmProxyEnv(runtimeSettings) {
  const runtime = runtimeSettings && typeof runtimeSettings === "object" ? runtimeSettings : {};
  const proxyUrl = String(runtime.proxy_url || "").trim();
  const noProxy = String(runtime.no_proxy || "").trim();

  const env = {};
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.all_proxy = proxyUrl;
  }
  if (noProxy) {
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}

async function testAdminLlmConnection(patch = null) {
  const runtime = resolveLlmRuntimeSettings(patch);
  if (!runtime.api_base_url) {
    throw new Error("api_base_url 不能为空");
  }
  if (!runtime.api_key) {
    throw new Error("未找到可用 API Key，请检查 env 与 api_key_selector");
  }

  const result = await runStoryGeneratorAtomicCommand("check-connection", {
    base_url: runtime.api_base_url,
    api_key: runtime.api_key,
    text_model: runtime.text_model,
    summary_model: runtime.summary_model,
    image_model: runtime.image_model,
  }, {
    llmRuntime: runtime,
  });

  return {
    provider_kind: runtime.provider_kind,
    api_base_url: runtime.api_base_url,
    api_key_selector: runtime.api_key_selector,
    text_model: runtime.text_model,
    summary_model: runtime.summary_model,
    image_model: runtime.image_model,
    proxy_url: runtime.proxy_url,
    no_proxy: runtime.no_proxy,
    key_available: Boolean(runtime.api_key),
    text_model_exists: Boolean(result?.text_model_exists),
    summary_model_exists: Boolean(result?.summary_model_exists),
    image_model_exists: Boolean(result?.image_model_exists),
    models_count: Number(result?.models_count || 0),
    models_preview: Array.isArray(result?.models_preview)
      ? result.models_preview.map((item) => String(item || "")).filter((item) => item.length > 0).slice(0, 12)
      : [],
  };
}

function inferLlmModelTypes(modelId) {
  const raw = String(modelId || "").trim().toLowerCase();
  if (!raw) {
    return {
      text: false,
      image: false,
      summary: false,
    };
  }

  const maybeImage = /(dall|seedream|flux|stable-diffusion|sdxl|image|vision-image|mj|midjourney)/.test(raw);
  const maybeText = /(gpt|qwen|claude|deepseek|glm|llama|gemini|chat|instruct|o\d)/.test(raw) || !maybeImage;

  return {
    text: maybeText,
    image: maybeImage,
    summary: maybeText,
  };
}

async function fetchAdminLlmModels(patch = null) {
  const runtime = resolveLlmRuntimeSettings(patch);
  if (!runtime.api_base_url) {
    throw new Error("api_base_url 不能为空");
  }
  if (!runtime.api_key) {
    throw new Error("未找到可用 API Key，请检查 env 与 api_key_selector");
  }

  const result = await runStoryGeneratorAtomicCommand("check-connection", {
    base_url: runtime.api_base_url,
    api_key: runtime.api_key,
    text_model: runtime.text_model,
    summary_model: runtime.summary_model,
    image_model: runtime.image_model,
  }, {
    llmRuntime: runtime,
  });

  const modelIds = Array.isArray(result?.models)
    ? result.models.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
    : [];
  const models = modelIds.map((id) => {
    const types = inferLlmModelTypes(id);
    return {
      id,
      text: types.text,
      image: types.image,
      summary: types.summary,
    };
  });

  return {
    provider_kind: runtime.provider_kind,
    api_base_url: runtime.api_base_url,
    api_key_selector: runtime.api_key_selector,
    text_model: runtime.text_model,
    summary_model: runtime.summary_model,
    image_model: runtime.image_model,
    proxy_url: runtime.proxy_url,
    no_proxy: runtime.no_proxy,
    key_available: Boolean(runtime.api_key),
    models_count: Number(result?.models_count || models.length),
    fetched_at: nowIso(),
    models,
  };
}

function serializeRuntimeLlmState(runtimeSettings) {
  const runtime = runtimeSettings && typeof runtimeSettings === "object" ? runtimeSettings : {};
  return {
    provider_id: normalizePositiveInteger(runtime.provider_id) || null,
    provider_name: String(runtime.provider_name || ""),
    profile_scope: String(runtime.profile_scope || ""),
    provider_kind: normalizeLlmProviderKind(runtime.provider_kind),
    api_base_url: String(runtime.api_base_url || ""),
    api_key_selector: String(runtime.api_key_selector || ""),
    key_available: Boolean(String(runtime.api_key || "").trim()),
    text_model: String(runtime.text_model || ""),
    summary_model: String(runtime.summary_model || ""),
    image_model: String(runtime.image_model || ""),
    proxy_url: String(runtime.proxy_url || ""),
    no_proxy: String(runtime.no_proxy || ""),
  };
}

function listAdminLlmEnvKeys() {
  return listLlmApiKeyCandidates();
}

function deriveLlmProviderNameFromBaseUrl(apiBaseUrl) {
  const baseUrl = String(apiBaseUrl || "").trim();
  if (!baseUrl) {
    return "system-default";
  }
  try {
    const parsed = new URL(baseUrl);
    const host = String(parsed.host || "").trim().toLowerCase();
    if (!host) {
      return "system-default";
    }
    if (host.includes("aihubmix")) {
      return "aihubmix-default";
    }
    if (host.includes("openai")) {
      return "openai-default";
    }
    return host.replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "system-default";
  } catch {
    return "system-default";
  }
}

function ensureLlmDefaultProviderBackfill() {
  if (!hasLlmProviderTables()) {
    return;
  }

  const now = nowIso();
  const keyOptions = listLlmApiKeyCandidates();
  const legacyState = getAdminLlmConfigState();
  const fallbackConfig = normalizeLlmConfig(legacyState?.config || {}, {
    keyOptions,
    fallback: buildDefaultLlmConfig(keyOptions),
  });
  const fallbackName = deriveLlmProviderNameFromBaseUrl(fallbackConfig.api_base_url);
  const fallbackEnvKey = String(fallbackConfig.api_key_selector || "").trim();

  const transaction = db.transaction(() => {
    const providerRows = db.prepare(
      "SELECT id, name, api_base_url, enabled, owner_user_id FROM llm_providers ORDER BY id ASC",
    ).all();

    const updateProviderStmt = db.prepare(
      "UPDATE llm_providers SET name = ?, api_base_url = ?, updated_at = ? WHERE id = ?",
    );

    let defaultProviderId = 0;
    if (providerRows.length === 0) {
      const insertResult = db.prepare(
        `
          INSERT INTO llm_providers (
            name, provider_kind, api_base_url, proxy_url, no_proxy_hosts,
            enabled, owner_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)
        `,
      ).run(
        fallbackName,
        LLM_PROVIDER_KIND,
        String(fallbackConfig.api_base_url || "").trim(),
        String(fallbackConfig.proxy_url || "").trim(),
        String(fallbackConfig.no_proxy || "").trim(),
        now,
        now,
      );

      defaultProviderId = normalizePositiveInteger(insertResult?.lastInsertRowid);
      if (defaultProviderId && fallbackEnvKey) {
        db.prepare(
          `
            INSERT INTO llm_provider_keys (
              provider_id, key_source, env_key_name, encrypted_key,
              key_last4, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, '', '', 1, ?, ?)
          `,
        ).run(defaultProviderId, LLM_PROVIDER_KEY_SOURCE_ENV, fallbackEnvKey, now, now);
      }
    } else {
      defaultProviderId = normalizePositiveInteger(providerRows[0]?.id);
      for (const row of providerRows) {
        const rowId = normalizePositiveInteger(row?.id);
        if (!rowId) {
          continue;
        }
        const currentName = String(row?.name || "").trim();
        const currentBaseUrl = String(row?.api_base_url || "").trim();
        const nextBaseUrl = currentBaseUrl || String(fallbackConfig.api_base_url || "").trim();
        const nextName = currentName || deriveLlmProviderNameFromBaseUrl(nextBaseUrl);

        if (nextName !== currentName || nextBaseUrl !== currentBaseUrl) {
          updateProviderStmt.run(nextName, nextBaseUrl, now, rowId);
        }
      }
    }

    if (!hasLlmProfileTable() || !defaultProviderId) {
      return;
    }

    const globalProfileRow = db.prepare(
      `
        SELECT id, provider_id, story_provider_id, summary_provider_id, text2image_provider_id
        FROM llm_user_profiles
        WHERE scope = ?
        ORDER BY is_default DESC, updated_at DESC, id DESC
        LIMIT 1
      `,
    ).get(LLM_PROFILE_SCOPE_GLOBAL);

    if (!globalProfileRow) {
      db.prepare(
        `
          INSERT INTO llm_user_profiles (
            user_id, provider_id, story_provider_id, summary_provider_id, text2image_provider_id,
            story_prompt_model, text2image_model, summary_model,
            is_default, scope, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `,
      ).run(
        null,
        defaultProviderId,
        defaultProviderId,
        defaultProviderId,
        defaultProviderId,
        String(fallbackConfig.text_model || "").trim(),
        String(fallbackConfig.image_model || "").trim(),
        String(fallbackConfig.summary_model || fallbackConfig.text_model || "").trim(),
        LLM_PROFILE_SCOPE_GLOBAL,
        now,
        now,
      );
      return;
    }

    const profileId = normalizePositiveInteger(globalProfileRow.id);
    if (!profileId) {
      return;
    }

    const providerId = normalizePositiveInteger(globalProfileRow.provider_id);
    const storyProviderId = normalizePositiveInteger(globalProfileRow.story_provider_id);
    const summaryProviderId = normalizePositiveInteger(globalProfileRow.summary_provider_id);
    const imageProviderId = normalizePositiveInteger(globalProfileRow.text2image_provider_id);
    if (providerId && storyProviderId && summaryProviderId && imageProviderId) {
      return;
    }

    const nextProviderId = providerId || defaultProviderId;
    const nextStoryProviderId = storyProviderId || nextProviderId;
    const nextSummaryProviderId = summaryProviderId || nextStoryProviderId || nextProviderId;
    const nextImageProviderId = imageProviderId || nextProviderId;
    db.prepare(
      `
        UPDATE llm_user_profiles
        SET provider_id = ?,
            story_provider_id = ?,
            summary_provider_id = ?,
            text2image_provider_id = ?,
            updated_at = ?
        WHERE id = ?
      `,
    ).run(nextProviderId, nextStoryProviderId, nextSummaryProviderId, nextImageProviderId, now, profileId);
  });

  try {
    transaction();
  } catch (error) {
    console.warn("[llm] ensure default provider backfill failed:", asMessage(error));
  }
}

function listLlmProviders() {
  if (!hasLlmProviderTables()) {
    return [];
  }

  const rows = hasLlmModelTable()
    ? db.prepare(
      `
        SELECT p.id, p.name, p.provider_kind, p.api_base_url, p.proxy_url, p.no_proxy_hosts,
               p.enabled, p.owner_user_id, p.created_at, p.updated_at,
               k.id AS key_id, k.key_source, k.env_key_name, k.encrypted_key, k.key_last4,
               k.is_active AS key_is_active,
               COALESCE(mc.model_count, 0) AS models_count
        FROM llm_providers p
        LEFT JOIN llm_provider_keys k
          ON k.id = (
            SELECT k2.id
            FROM llm_provider_keys k2
            WHERE k2.provider_id = p.id
              AND k2.is_active = 1
            ORDER BY k2.updated_at DESC, k2.id DESC
            LIMIT 1
          )
        LEFT JOIN (
          SELECT provider_id, COUNT(*) AS model_count
          FROM llm_provider_models
          WHERE enabled = 1
          GROUP BY provider_id
        ) mc ON mc.provider_id = p.id
        ORDER BY p.updated_at DESC, p.id DESC
      `,
    ).all()
    : db.prepare(
      `
        SELECT p.id, p.name, p.provider_kind, p.api_base_url, p.proxy_url, p.no_proxy_hosts,
               p.enabled, p.owner_user_id, p.created_at, p.updated_at,
               k.id AS key_id, k.key_source, k.env_key_name, k.encrypted_key, k.key_last4,
               k.is_active AS key_is_active,
               0 AS models_count
        FROM llm_providers p
        LEFT JOIN llm_provider_keys k
          ON k.id = (
            SELECT k2.id
            FROM llm_provider_keys k2
            WHERE k2.provider_id = p.id
              AND k2.is_active = 1
            ORDER BY k2.updated_at DESC, k2.id DESC
            LIMIT 1
          )
        ORDER BY p.updated_at DESC, p.id DESC
      `,
    ).all();

  return rows.map(serializeLlmProviderRow).filter(Boolean);
}

function getLlmProviderById(providerId, options = {}) {
  const row = getLlmProviderWithActiveKeyRow(providerId, {
    allowDisabled: options.allowDisabled,
  });
  if (!row) {
    return null;
  }

  const modelsCount = hasLlmModelTable()
    ? db.prepare(
      "SELECT COUNT(*) AS total FROM llm_provider_models WHERE provider_id = ? AND enabled = 1",
    ).get(Number(row.id))
    : { total: 0 };

  return serializeLlmProviderRow({
    ...row,
    models_count: Number(modelsCount?.total || 0),
  });
}

function createLlmProvider(payload, actorUserId = null) {
  if (!hasLlmProviderTables()) {
    throw new Error("llm provider 表尚未就绪，请先执行数据库迁移");
  }

  const patch = normalizeLlmProviderWritePatch(payload);
  if (!patch.name) {
    throw new Error("provider name 不能为空");
  }
  if (!patch.api_base_url) {
    throw new Error("api_base_url 不能为空");
  }

  const now = nowIso();
  const ownerUserId = normalizePositiveInteger(actorUserId) || null;
  const result = db.prepare(
    `
      INSERT INTO llm_providers (
        name, provider_kind, api_base_url, proxy_url, no_proxy_hosts,
        enabled, owner_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    patch.name,
    patch.provider_kind,
    patch.api_base_url,
    patch.proxy_url,
    patch.no_proxy_hosts,
    patch.enabled === null ? 1 : (patch.enabled ? 1 : 0),
    ownerUserId,
    now,
    now,
  );

  const providerId = normalizePositiveInteger(result?.lastInsertRowid);
  if (!providerId) {
    throw new Error("创建 provider 失败");
  }

  const keyPatch = normalizeLlmProviderKeyWritePatch(payload?.key || payload);
  const hasKeyPatch = Boolean(keyPatch.env_key_name || keyPatch.api_key);
  if (hasKeyPatch) {
    saveLlmProviderKey(providerId, payload?.key || payload, actorUserId);
  }

  appendLlmAuditLog({
    userId: actorUserId,
    providerId,
    action: "llm.provider.create",
    diff: {
      name: patch.name,
      provider_kind: patch.provider_kind,
    },
  });

  return getLlmProviderById(providerId, { allowDisabled: true });
}

function updateLlmProvider(providerId, payload, actorUserId = null) {
  if (!hasLlmProviderTables()) {
    throw new Error("llm provider 表尚未就绪，请先执行数据库迁移");
  }

  const id = normalizePositiveInteger(providerId);
  if (!id) {
    throw new Error("provider_id 不合法");
  }

  const currentRow = db.prepare(
    "SELECT id, name, provider_kind, api_base_url, proxy_url, no_proxy_hosts, enabled FROM llm_providers WHERE id = ? LIMIT 1",
  ).get(id);
  if (!currentRow) {
    throw new Error("provider 不存在");
  }

  const patch = normalizeLlmProviderWritePatch(payload);
  const nextName = patch.name || String(currentRow.name || "").trim();
  const nextBaseUrl = patch.api_base_url || String(currentRow.api_base_url || "").trim();
  if (!nextName) {
    throw new Error("provider name 不能为空");
  }
  if (!nextBaseUrl) {
    throw new Error("api_base_url 不能为空");
  }

  db.prepare(
    `
      UPDATE llm_providers
      SET name = ?,
          provider_kind = ?,
          api_base_url = ?,
          proxy_url = ?,
          no_proxy_hosts = ?,
          enabled = ?,
          updated_at = ?
      WHERE id = ?
    `,
  ).run(
    nextName,
    patch.provider_kind || normalizeLlmProviderKind(currentRow.provider_kind),
    nextBaseUrl,
    patch.proxy_url || String(currentRow.proxy_url || ""),
    patch.no_proxy_hosts || String(currentRow.no_proxy_hosts || ""),
    patch.enabled === null ? (Number(currentRow.enabled || 0) === 1 ? 1 : 0) : (patch.enabled ? 1 : 0),
    nowIso(),
    id,
  );

  const keyPatch = normalizeLlmProviderKeyWritePatch(payload?.key || payload);
  const shouldUpdateKey = Boolean(keyPatch.env_key_name || keyPatch.api_key || payload?.key_source || payload?.api_key_source);
  if (shouldUpdateKey) {
    saveLlmProviderKey(id, payload?.key || payload, actorUserId);
  }

  appendLlmAuditLog({
    userId: actorUserId,
    providerId: id,
    action: "llm.provider.update",
    diff: {
      name: nextName,
      provider_kind: patch.provider_kind,
      api_base_url: nextBaseUrl,
    },
  });

  return getLlmProviderById(id, { allowDisabled: true });
}

function deleteLlmProvider(providerId, actorUserId = null) {
  if (!hasLlmProviderTables()) {
    throw new Error("llm provider 表尚未就绪，请先执行数据库迁移");
  }

  const id = normalizePositiveInteger(providerId);
  if (!id) {
    throw new Error("provider_id 不合法");
  }

  const providerRow = db.prepare(
    "SELECT id, name FROM llm_providers WHERE id = ? LIMIT 1",
  ).get(id);
  if (!providerRow) {
    throw new Error("provider 不存在");
  }

  if (hasLlmProfileTable()) {
    const profileRef = db.prepare(
      `
        SELECT id, scope, user_id
        FROM llm_user_profiles
        WHERE provider_id = ?
           OR story_provider_id = ?
           OR summary_provider_id = ?
           OR text2image_provider_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
    ).get(id, id, id, id);

    if (profileRef) {
      const scopeLabel = String(profileRef.scope || "") === LLM_PROFILE_SCOPE_GLOBAL
        ? "global"
        : `user:${normalizePositiveInteger(profileRef.user_id) || "unknown"}`;
      throw new Error(`provider 正在被 profile(${scopeLabel}) 引用，请先解绑后再删除`);
    }
  }

  const now = nowIso();
  const runDelete = db.transaction(() => {
    if (hasLlmModelTable()) {
      db.prepare("DELETE FROM llm_provider_models WHERE provider_id = ?").run(id);
    }
    db.prepare("DELETE FROM llm_provider_keys WHERE provider_id = ?").run(id);
    db.prepare("UPDATE generation_jobs SET effective_provider_id = NULL WHERE effective_provider_id = ?").run(id);
    db.prepare("DELETE FROM llm_providers WHERE id = ?").run(id);
  });
  runDelete();

  appendLlmAuditLog({
    userId: actorUserId,
    providerId: id,
    action: "llm.provider.delete",
    diff: {
      id,
      name: String(providerRow.name || ""),
      deleted_at: now,
    },
  });

  return {
    id,
    name: String(providerRow.name || ""),
  };
}

function saveLlmProviderKey(providerId, payload, actorUserId = null) {
  if (!hasLlmProviderTables()) {
    throw new Error("llm provider 表尚未就绪，请先执行数据库迁移");
  }

  const id = normalizePositiveInteger(providerId);
  if (!id) {
    throw new Error("provider_id 不合法");
  }

  const providerRow = db.prepare("SELECT id FROM llm_providers WHERE id = ? LIMIT 1").get(id);
  if (!providerRow) {
    throw new Error("provider 不存在");
  }

  const patch = normalizeLlmProviderKeyWritePatch(payload);
  if (patch.key_source === LLM_PROVIDER_KEY_SOURCE_ENV) {
    if (!patch.env_key_name) {
      throw new Error("env_key_name 不能为空");
    }
  } else if (!patch.api_key) {
    throw new Error("custom key 不能为空");
  }

  const now = nowIso();
  const last4 = patch.key_source === LLM_PROVIDER_KEY_SOURCE_CUSTOM
    ? String(patch.api_key).slice(-4)
    : String(process.env[patch.env_key_name] || "").trim().slice(-4);

  const encryptedKey = patch.key_source === LLM_PROVIDER_KEY_SOURCE_CUSTOM
    ? encryptLlmApiKey(patch.api_key)
    : "";

  const transaction = db.transaction(() => {
    db.prepare("UPDATE llm_provider_keys SET is_active = 0, updated_at = ? WHERE provider_id = ?").run(now, id);
    db.prepare(
      `
        INSERT INTO llm_provider_keys (
          provider_id, key_source, env_key_name, encrypted_key,
          key_last4, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `,
    ).run(
      id,
      patch.key_source,
      patch.key_source === LLM_PROVIDER_KEY_SOURCE_ENV ? patch.env_key_name : "",
      encryptedKey,
      String(last4 || "").slice(-4),
      now,
      now,
    );
  });
  transaction();

  appendLlmAuditLog({
    userId: actorUserId,
    providerId: id,
    action: "llm.provider.key.update",
    diff: {
      key_source: patch.key_source,
      env_key_name: patch.key_source === LLM_PROVIDER_KEY_SOURCE_ENV ? patch.env_key_name : "",
      key_last4: String(last4 || "").slice(-4),
    },
  });

  return getLlmProviderById(id, { allowDisabled: true });
}

function listLlmProviderModels(providerId, modelType = "") {
  if (!hasLlmModelTable()) {
    return [];
  }

  const id = normalizePositiveInteger(providerId);
  if (!id) {
    return [];
  }

  const normalizedType = ["text", "summary", "image"].includes(String(modelType || "").trim())
    ? String(modelType || "").trim()
    : "";

  const rows = normalizedType
    ? db.prepare(
      `
        SELECT id, provider_id, model_id, model_type, enabled, fetched_at
        FROM llm_provider_models
        WHERE provider_id = ? AND enabled = 1 AND model_type = ?
        ORDER BY fetched_at DESC, model_id ASC
      `,
    ).all(id, normalizedType)
    : db.prepare(
      `
        SELECT id, provider_id, model_id, model_type, enabled, fetched_at
        FROM llm_provider_models
        WHERE provider_id = ? AND enabled = 1
        ORDER BY fetched_at DESC, model_type ASC, model_id ASC
      `,
    ).all(id);

  return rows.map(serializeLlmProviderModelRow);
}

function upsertLlmProfile(scope, userId, payload, actorUserId = null) {
  if (!hasLlmProfileTable()) {
    throw new Error("llm profile 表尚未就绪，请先执行数据库迁移");
  }

  const normalizedScope = String(scope || "").trim() === LLM_PROFILE_SCOPE_USER
    ? LLM_PROFILE_SCOPE_USER
    : LLM_PROFILE_SCOPE_GLOBAL;
  const normalizedUserId = normalizedScope === LLM_PROFILE_SCOPE_USER
    ? normalizePositiveInteger(userId)
    : null;
  if (normalizedScope === LLM_PROFILE_SCOPE_USER && !normalizedUserId) {
    throw new Error("user_id 不合法");
  }

  const patch = normalizeLlmProfileWritePatch(payload);
  const providerId = normalizePositiveInteger(patch.provider_id);
  const storyProviderId = normalizePositiveInteger(patch.story_provider_id);
  const summaryProviderId = normalizePositiveInteger(patch.summary_provider_id);
  const imageProviderId = normalizePositiveInteger(patch.text2image_provider_id);

  const removeProfile = !providerId && !storyProviderId && !summaryProviderId && !imageProviderId;
  const now = nowIso();

  const runWrite = db.transaction(() => {
    if (removeProfile) {
      if (normalizedScope === LLM_PROFILE_SCOPE_GLOBAL) {
        db.prepare("DELETE FROM llm_user_profiles WHERE scope = ?").run(LLM_PROFILE_SCOPE_GLOBAL);
      } else {
        db.prepare("DELETE FROM llm_user_profiles WHERE scope = ? AND user_id = ?").run(LLM_PROFILE_SCOPE_USER, normalizedUserId);
      }
      return;
    }

    const stageProviderIds = [storyProviderId, summaryProviderId, imageProviderId, providerId]
      .map((item) => normalizePositiveInteger(item))
      .filter((item, index, arr) => item && arr.indexOf(item) === index);
    for (const stageProviderId of stageProviderIds) {
      const providerRow = db.prepare("SELECT id FROM llm_providers WHERE id = ? LIMIT 1").get(stageProviderId);
      if (!providerRow) {
        throw new Error(`provider 不存在: ${stageProviderId}`);
      }
    }

    const normalizedStoryProviderId = storyProviderId || providerId;
    const normalizedSummaryProviderId = summaryProviderId || normalizedStoryProviderId || providerId;
    const normalizedImageProviderId = imageProviderId || providerId;
    const canonicalProviderId = providerId || normalizedStoryProviderId || normalizedImageProviderId || normalizedSummaryProviderId;

    if (normalizedScope === LLM_PROFILE_SCOPE_GLOBAL) {
      db.prepare("UPDATE llm_user_profiles SET is_default = 0, updated_at = ? WHERE scope = ?").run(now, LLM_PROFILE_SCOPE_GLOBAL);
      const existing = db.prepare(
        "SELECT id FROM llm_user_profiles WHERE scope = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
      ).get(LLM_PROFILE_SCOPE_GLOBAL);

      if (existing?.id) {
        db.prepare(
          `
            UPDATE llm_user_profiles
            SET provider_id = ?,
                story_provider_id = ?,
                summary_provider_id = ?,
                text2image_provider_id = ?,
                story_prompt_model = ?,
                text2image_model = ?,
                summary_model = ?,
                is_default = 1,
                updated_at = ?
            WHERE id = ?
          `,
        ).run(
          canonicalProviderId,
          normalizedStoryProviderId,
          normalizedSummaryProviderId,
          normalizedImageProviderId,
          patch.story_prompt_model,
          patch.text2image_model,
          patch.summary_model,
          now,
          Number(existing.id),
        );
      } else {
        db.prepare(
          `
            INSERT INTO llm_user_profiles (
              user_id, provider_id, story_provider_id, summary_provider_id, text2image_provider_id,
              story_prompt_model, text2image_model,
              summary_model, is_default, scope, created_at, updated_at
            ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `,
        ).run(
          canonicalProviderId,
          normalizedStoryProviderId,
          normalizedSummaryProviderId,
          normalizedImageProviderId,
          patch.story_prompt_model,
          patch.text2image_model,
          patch.summary_model,
          LLM_PROFILE_SCOPE_GLOBAL,
          now,
          now,
        );
      }
      return;
    }

    db.prepare(
      "UPDATE llm_user_profiles SET is_default = 0, updated_at = ? WHERE scope = ? AND user_id = ?",
    ).run(now, LLM_PROFILE_SCOPE_USER, normalizedUserId);

    const existing = db.prepare(
      "SELECT id FROM llm_user_profiles WHERE scope = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
    ).get(LLM_PROFILE_SCOPE_USER, normalizedUserId);

    if (existing?.id) {
      db.prepare(
        `
          UPDATE llm_user_profiles
          SET provider_id = ?,
              story_provider_id = ?,
              summary_provider_id = ?,
              text2image_provider_id = ?,
              story_prompt_model = ?,
              text2image_model = ?,
              summary_model = ?,
              is_default = 1,
              updated_at = ?
          WHERE id = ?
        `,
      ).run(
        canonicalProviderId,
        normalizedStoryProviderId,
        normalizedSummaryProviderId,
        normalizedImageProviderId,
        patch.story_prompt_model,
        patch.text2image_model,
        patch.summary_model,
        now,
        Number(existing.id),
      );
    } else {
      db.prepare(
        `
          INSERT INTO llm_user_profiles (
            user_id, provider_id, story_provider_id, summary_provider_id, text2image_provider_id,
            story_prompt_model, text2image_model,
            summary_model, is_default, scope, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `,
      ).run(
        normalizedUserId,
        canonicalProviderId,
        normalizedStoryProviderId,
        normalizedSummaryProviderId,
        normalizedImageProviderId,
        patch.story_prompt_model,
        patch.text2image_model,
        patch.summary_model,
        LLM_PROFILE_SCOPE_USER,
        now,
        now,
      );
    }
  });

  runWrite();

  appendLlmAuditLog({
    userId: actorUserId,
    providerId: providerId || null,
    action: normalizedScope === LLM_PROFILE_SCOPE_GLOBAL ? "llm.profile.global.update" : "llm.profile.user.update",
    diff: {
      scope: normalizedScope,
      user_id: normalizedUserId,
      provider_id: providerId,
      story_provider_id: storyProviderId,
      summary_provider_id: summaryProviderId,
      text2image_provider_id: imageProviderId,
      story_prompt_model: patch.story_prompt_model,
      summary_model: patch.summary_model,
      text2image_model: patch.text2image_model,
      reset: removeProfile,
    },
  });
}

function getLlmGlobalProfile() {
  return serializeLlmProfileRow(getLlmProfileRow(LLM_PROFILE_SCOPE_GLOBAL, null));
}

function getLlmUserProfile(userId) {
  const normalizedUserId = normalizePositiveInteger(userId);
  if (!normalizedUserId) {
    throw new Error("user_id 不合法");
  }

  const userRow = db.prepare("SELECT id FROM users WHERE id = ? LIMIT 1").get(normalizedUserId);
  if (!userRow) {
    throw new Error("用户不存在");
  }

  return serializeLlmProfileRow(getLlmProfileRow(LLM_PROFILE_SCOPE_USER, normalizedUserId));
}

function saveLlmGlobalProfile(payload, actorUserId = null) {
  upsertLlmProfile(LLM_PROFILE_SCOPE_GLOBAL, null, payload, actorUserId);
  return getLlmGlobalProfile();
}

function saveLlmUserProfile(userId, payload, actorUserId = null) {
  const normalizedUserId = normalizePositiveInteger(userId);
  if (!normalizedUserId) {
    throw new Error("user_id 不合法");
  }
  const userRow = db.prepare("SELECT id FROM users WHERE id = ? LIMIT 1").get(normalizedUserId);
  if (!userRow) {
    throw new Error("用户不存在");
  }

  upsertLlmProfile(LLM_PROFILE_SCOPE_USER, normalizedUserId, payload, actorUserId);
  return getLlmUserProfile(normalizedUserId);
}

function resolveProviderRuntimeForTest(providerId, payload = null) {
  const providerRuntime = resolveLlmProviderRuntimeSettings(providerId, { allowDisabled: true });
  if (!providerRuntime) {
    throw new Error("provider 不存在");
  }

  const runtime = buildEnvLlmRuntimeSettings();
  applyLlmRuntimePatch(runtime, providerRuntime);
  applyLlmRuntimePatch(runtime, extractLlmRuntimeInput(payload).overrides);
  if (!String(runtime.api_key || "").trim()) {
    const selector = String(runtime.api_key_selector || "").trim();
    if (selector) {
      runtime.api_key = String(process.env[selector] || "").trim();
    }
  }
  runtime.summary_model = String(runtime.summary_model || runtime.text_model || "").trim();
  return runtime;
}

async function testLlmProviderConnection(providerId, payload = null) {
  const runtime = resolveProviderRuntimeForTest(providerId, payload);
  if (!runtime.api_base_url) {
    throw new Error("api_base_url 不能为空");
  }
  if (!runtime.api_key) {
    throw new Error("未找到可用 API Key，请检查 provider key 配置");
  }

  const result = await runStoryGeneratorAtomicCommand("check-connection", {
    base_url: runtime.api_base_url,
    api_key: runtime.api_key,
    text_model: runtime.text_model,
    summary_model: runtime.summary_model,
    image_model: runtime.image_model,
  }, {
    llmRuntime: runtime,
  });

  return {
    ...serializeRuntimeLlmState(runtime),
    resolved_base_url: String(result?.base_url || runtime.api_base_url || "").trim(),
    text_model_exists: Boolean(result?.text_model_exists),
    summary_model_exists: Boolean(result?.summary_model_exists),
    image_model_exists: Boolean(result?.image_model_exists),
    models_count: Number(result?.models_count || 0),
    models_preview: Array.isArray(result?.models_preview)
      ? result.models_preview.map((item) => String(item || "").trim()).filter((item) => item.length > 0).slice(0, 12)
      : [],
  };
}

async function fetchLlmProviderModels(providerId, payload = null, actorUserId = null) {
  if (!hasLlmModelTable()) {
    throw new Error("llm provider models 表尚未就绪，请先执行数据库迁移");
  }

  const runtime = resolveProviderRuntimeForTest(providerId, payload);
  if (!runtime.api_base_url) {
    throw new Error("api_base_url 不能为空");
  }
  if (!runtime.api_key) {
    throw new Error("未找到可用 API Key，请检查 provider key 配置");
  }

  const result = await runStoryGeneratorAtomicCommand("check-connection", {
    base_url: runtime.api_base_url,
    api_key: runtime.api_key,
    text_model: runtime.text_model,
    summary_model: runtime.summary_model,
    image_model: runtime.image_model,
  }, {
    llmRuntime: runtime,
  });

  const modelIds = Array.isArray(result?.models)
    ? result.models.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
    : [];
  const providerIdInt = normalizePositiveInteger(providerId);

  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare("UPDATE llm_provider_models SET enabled = 0 WHERE provider_id = ?").run(providerIdInt);
    const upsertStmt = db.prepare(
      `
        INSERT INTO llm_provider_models (provider_id, model_id, model_type, enabled, fetched_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(provider_id, model_id, model_type) DO UPDATE SET
          enabled = excluded.enabled,
          fetched_at = excluded.fetched_at
      `,
    );

    for (const modelId of modelIds) {
      const types = inferLlmModelTypes(modelId);
      if (types.text) {
        upsertStmt.run(providerIdInt, modelId, "text", now);
      }
      if (types.summary) {
        upsertStmt.run(providerIdInt, modelId, "summary", now);
      }
      if (types.image) {
        upsertStmt.run(providerIdInt, modelId, "image", now);
      }
    }
  });
  transaction();

  appendLlmAuditLog({
    userId: actorUserId,
    providerId: providerIdInt,
    action: "llm.provider.models.fetch",
    diff: {
      models_count: modelIds.length,
    },
  });

  return {
    ...serializeRuntimeLlmState(runtime),
    resolved_base_url: String(result?.base_url || runtime.api_base_url || "").trim(),
    models_count: Number(result?.models_count || modelIds.length),
    fetched_at: now,
    models: modelIds.map((id) => {
      const types = inferLlmModelTypes(id);
      return {
        id,
        text: types.text,
        summary: types.summary,
        image: types.image,
      };
    }),
    cached_models: listLlmProviderModels(providerIdInt),
  };
}

const {
  doesAssetExist,
  resolvePublicAssetFsPath,
  resolveStoryAssetFsPath,
} = createStoryAssetUtils({
  webPublicDir: WEB_PUBLIC_DIR,
  storyPublicPrefix: STORY_PUBLIC_PREFIX,
  storiesRootDir: STORIES_ROOT_DIR,
  isPathInside,
});


fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(STORIES_ROOT_DIR, { recursive: true });
fs.mkdirSync(STORY_GENERATOR_LOG_DIR, { recursive: true });
fs.mkdirSync(STORY_GENERATOR_SUMMARY_DIR, { recursive: true });
fs.mkdirSync(BOOK_UPLOADS_DIR, { recursive: true });
ensureStoryIndexFile();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
initializeSchema(db);
runMigrations(db);
ensureLlmDefaultProviderBackfill();

if (LEGACY_GENERATE_STORY_CREATE_ENABLED) {
  console.warn(
    "[generation] legacy POST /api/admin/generate-story is enabled via GENERATION_LEGACY_CREATE_ENABLED=1; this is temporary compatibility mode.",
  );
}

const {
  buildAdminStoryMetaSnapshot,
  buildGeneratedStoryBookMap,
  listBooksForNavigation,
  loadStoryById,
  loadStoryCatalog,
  loadTimerPolicy,
  normalizeDifficulty,
  normalizeLevel,
  normalizeStoryBookId,
  readJson,
  resolveDefaultStoryBookMeta,
  resolveManifestFsPath,
  resolveStoryBookMeta,
  saveAdminStoryMetaOverride,
} = createStoryCatalogService({
  db,
  storyIndexFile: STORY_INDEX_FILE,
  storyPublicPrefix: STORY_PUBLIC_PREFIX,
  defaultTimerPolicy: DEFAULT_TIMER_POLICY,
  resolveStoryAssetFsPath,
  doesAssetExist,
  normalizeShortText,
  normalizePositiveInteger,
  normalizePositiveNumber,
  normalizeContentVersion,
  normalizeLegacyIds,
  safeParseJsonObject,
  getBooksDbOrThrow,
});

const {
  appendRunEvent,
  normalizeGeneratedStoryId,
  publishSelectedGenerationCandidates,
  resolveStoryAssetUrlFromFsPath,
  writeJsonAtomic,
} = createGenerationPublishService({
  db,
  storyPublicPrefix: STORY_PUBLIC_PREFIX,
  storiesRootDir: STORIES_ROOT_DIR,
  storyGeneratorOutputRoot: STORY_GENERATOR_OUTPUT_ROOT,
  storyIndexFile: STORY_INDEX_FILE,
  storyGeneratorIndexFile: STORY_GENERATOR_INDEX_FILE,
  resolveStoryAssetFsPath,
  readJsonSafe,
  normalizeIntegerInRange,
  normalizeStoryBookId,
  normalizeShortText,
  randomToken,
  nowIso,
  syncBooksGenerationLink,
});

const {
  buildAdminLevelConfigSnapshot,
  parseAdminLevelConfigPatch,
  saveAdminLevelOverrideConfig,
  serializeLevelOverrideConfig,
} = createAdminLevelConfigService({
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
  managedLevelDifficulties: MANAGED_LEVEL_DIFFICULTIES,
});

const {
  buildGenerationSummaryFileName,
  defaultGenerationRunId,
  isReviewModePayload,
  normalizeErrorMessage,
  normalizeStoryFile,
  readRunEvents,
  resolveGenerationRunImagesDir,
} = createGenerationRuntimeService({
  rootDir: ROOT_DIR,
  storiesRootDir: STORIES_ROOT_DIR,
  normalizeBoolean,
  normalizeRunId,
  normalizeTargetDate,
  nowIso,
  randomToken,
  isPathInside,
});

const {
  getGenerationSceneByIndex,
  hasGenerationSceneRows,
  listGenerationSceneAttempts,
  listGenerationScenes,
  replaceGenerationScenes,
  serializeGenerationSceneAsLegacyCandidate,
  serializeGenerationSceneAttemptAsLegacyRetry,
  summarizeGenerationScenes,
  summarizeLegacyCandidateCountsFromScenes,
} = createGenerationSceneService({
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
});

const {
  createOrUpdateAtomicGenerationRun,
  ensureGenerationRunWritable,
  refreshGenerationRunState,
} = createGenerationRunStateService({
  db,
  nowIso,
  listGenerationScenes,
  getGenerationJobByRunId,
  normalizeGenerationFlowStage,
  normalizeGenerationReviewStatus,
  upsertGenerationJobMetaOnEnqueue,
});

const {
  cancelRunningSceneAttemptsForDelete,
  cancelRunningSceneAttemptsForPromptUpdate,
  markSceneAsDeleted,
  runSceneCommandTransaction,
  updateSceneDraftRow,
} = createGenerationSceneRepository({
  db,
});

const {
  deleteGenerationSceneDraft,
  updateGenerationSceneDraft,
} = createGenerationSceneCommandService({
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
});

const {
  markGenerationJobAsPublished,
  updateSceneCandidateSelectionAndGrid,
} = createGenerationReviewRepository({
  db,
});

const {
  publishSelectedReviewCandidates,
  updateReviewCandidateConfig,
} = createGenerationReviewCommandService({
  getGenerationJobByRunId,
  getGenerationSceneByIndex,
  hasGenerationSceneRows,
  isReviewModePayload,
  listGenerationJobCandidates,
  listGenerationScenes,
  nowIso,
  publishSelectedGenerationCandidates,
  readJsonSafe,
  refreshGenerationRunState,
  serializeGenerationSceneAsLegacyCandidate,
  summarizeGenerationCandidates,
  summarizeGenerationScenes,
  summarizeLegacyCandidateCountsFromScenes,
  syncGenerationJobCandidatesFromSummary,
  updateGenerationJobCandidate,
  markGenerationJobAsPublished,
  updateSceneCandidateSelectionAndGrid,
});

const {
  markGenerationJobAsRetryingImages,
} = createGenerationReviewRetryRepository({
  db,
});

const {
  retryGenerationCandidateImage,
} = createGenerationReviewRetryCommandService({
  appendRunEvent,
  asMessage,
  createGenerationSceneImageAttempt,
  enqueueGenerationCandidateImageRetry,
  finalizeGenerationSceneImageAttempt,
  getGenerationJobByRunId,
  getGenerationSceneByIndex,
  hasGenerationSceneRows,
  listGenerationJobCandidates,
  listGenerationSceneAttempts,
  nextGenerationSceneAttemptNo,
  normalizeBoolean,
  normalizeGenerationSceneImageStatus,
  normalizePositiveInteger,
  normalizePositiveNumber,
  nowIso,
  refreshGenerationRunState,
  resolveLlmRuntimeSettings,
  resolveGenerationRunImagesDir,
  resolveStoryAssetUrlFromFsPath,
  runStoryGeneratorAtomicCommand,
  serializeGenerationSceneAsLegacyCandidate,
  serializeGenerationSceneAttemptAsLegacyRetry,
  setGenerationSceneImageResult,
  setGenerationSceneImageRunning,
  syncGenerationJobCandidatesFromSummary,
  markGenerationJobAsRetryingImages,
});

const {
  materializeGenerationScenesFromLegacy,
} = createGenerationLegacySceneService({
  hasGenerationSceneRows,
  listGenerationJobCandidates,
  normalizeBoolean,
  normalizeIntegerInRange,
  normalizePositiveInteger,
  normalizeGenerationSceneCharacters,
  normalizeGenerationSceneImageStatus,
  refreshGenerationRunState,
  replaceGenerationScenes,
  syncGenerationJobCandidatesFromSummary,
});

const {
  cancelGenerationRun,
  deleteGenerationRun,
} = createGenerationRunAdminService({
  db,
  rootDir: ROOT_DIR,
  isPathInside,
  nowIso,
  normalizeBoolean,
  getGenerationJobByRunId,
  normalizeGenerationFlowStage,
  normalizeGenerationReviewStatus,
});

const {
  appendAdminAuditLog,
  buildAuthUserPayload,
  countAdminUsers,
  getRolesByUserId,
  getRolesByUserIds,
  normalizeAdminRole,
  requireAdmin,
  serializeAdminUser,
} = createAdminUserService({
  db,
  nowIso,
  adminUsernames: ADMIN_USERNAMES,
  adminUsernameFallbackEnabled: ADMIN_USERNAME_FALLBACK_ENABLED,
  managedAdminRoles: MANAGED_ADMIN_ROLES,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
});

const {
  getLevelProgressMap,
  listStoriesForUser,
  runProgressMaintenanceForUser,
  serializeProgressRow,
} = createPlayerProgressService({
  asMessage,
  db,
  loadStoryCatalog,
  loadStoryById,
  buildGeneratedStoryBookMap,
  listBooksForNavigation,
  resolveDefaultStoryBookMeta,
  resolveStoryBookMeta,
  normalizeContentVersion,
});

const {
  clearAuthCookies,
  clearAuthRateLimit,
  consumePasswordResetToken,
  createGuestUsername,
  createSession,
  extractCsrfHeader,
  extractSessionToken,
  issuePasswordResetToken,
  passAuthRateLimit,
  passPasswordResetRateLimit,
  passRegisterRateLimit,
  pruneExpiredSessions,
  requireAuth,
  requireCsrf,
  rotateSession,
  setAuthCookies,
} = createAuthSessionService({
  db,
  nowIso,
  sessionCookieName: SESSION_COOKIE_NAME,
  csrfCookieName: CSRF_COOKIE_NAME,
  csrfHeaderName: CSRF_HEADER_NAME,
  sessionTtlMs: SESSION_TTL_MS,
  cookieSecure: COOKIE_SECURE,
  cookieSameSite: COOKIE_SAME_SITE,
  resetTokenTtlMs: RESET_TOKEN_TTL_MS,
  authRateLimitWindowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  authRateLimitMaxAttempts: AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  authRateLimitCleanupInterval: AUTH_RATE_LIMIT_CLEANUP_INTERVAL,
  registerRateLimitWindowMs: REGISTER_RATE_LIMIT_WINDOW_MS,
  registerRateLimitMaxAttempts: REGISTER_RATE_LIMIT_MAX_ATTEMPTS,
  registerRateLimitCleanupInterval: REGISTER_RATE_LIMIT_CLEANUP_INTERVAL,
  forgotPasswordRateLimitWindowMs: FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MS,
  forgotPasswordRateLimitMaxAttempts: FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
  passwordResetRateLimitCleanupInterval: PASSWORD_RESET_RATE_LIMIT_CLEANUP_INTERVAL,
});

const {
  createPasswordResetApprovalRequest,
  createUserRecord,
  deleteSessionByToken,
  resetUserPasswordAndSessions,
  touchUserLastLogin,
  updateUserPassword,
  upgradeGuestUserCredentials,
} = createAuthCommandService({
  db,
});

const {
  findLoginUserByUsername,
  findLogoutSession,
  findUserIdByUsername,
  findUserPasswordProfileById,
  isUsernameTaken,
} = createAuthQueryService({
  db,
});

const {
  hashPassword,
  verifyPassword,
} = createPasswordHasherService({
  rounds: process.env.AUTH_PASSWORD_HASH_ROUNDS,
});

const app = express();
app.set("trust proxy", resolveTrustProxySetting());
app.use(express.json({ limit: "1mb" }));
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (COOKIE_SECURE) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(STORY_PUBLIC_PREFIX, express.static(STORIES_ROOT_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    now: nowIso(),
    story_generator: {
      atomic_module: STORY_GENERATOR_ATOMIC_MODULE,
      legacy_create_enabled: LEGACY_GENERATE_STORY_CREATE_ENABLED,
    },
    security: {
      public_registration_enabled: PUBLIC_REGISTRATION_ENABLED,
      admin_username_fallback_enabled: ADMIN_USERNAME_FALLBACK_ENABLED,
    },
  });
});

registerAuthRoutes(app, {
  ADMIN_BOOTSTRAP_TOKEN,
  ADMIN_USERNAMES,
  FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
  FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MS,
  PUBLIC_REGISTRATION_ENABLED,
  RESET_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
  RESET_PASSWORD_RATE_LIMIT_WINDOW_MS,
  buildAuthUserPayload,
  clearAuthCookies,
  clearAuthRateLimit,
  consumePasswordResetToken,
  createPasswordResetApprovalRequest,
  createGuestUsername,
  createSession,
  createUserRecord,
  deleteSessionByToken,
  findLoginUserByUsername,
  findLogoutSession,
  findUserIdByUsername,
  findUserPasswordProfileById,
  isUsernameTaken,
  extractCsrfHeader,
  extractSessionToken,
  hashSessionToken,
  hashPassword,
  verifyPassword,
  issuePasswordResetToken,
  normalizePassword,
  normalizeStrongPassword,
  normalizeUsername,
  nowIso,
  passAuthRateLimit,
  passPasswordResetRateLimit,
  passRegisterRateLimit,
  pruneExpiredSessions,
  randomToken,
  requireAuth,
  requireCsrf,
  resetUserPasswordAndSessions,
  rotateSession,
  runProgressMaintenanceForUser,
  setAuthCookies,
  touchUserLastLogin,
  updateUserPassword,
  upgradeGuestUserCredentials,
});

registerAdminLlmRoutes(app, {
  asMessage,
  createLlmProvider,
  deleteLlmProvider,
  fetchLlmProviderModels,
  getLlmGlobalProfile,
  getLlmProviderById,
  getLlmUserProfile,
  listAdminLlmEnvKeys,
  listLlmProviderModels,
  listLlmProviders,
  requireAdmin,
  requireAuth,
  requireCsrf,
  resolveLlmRuntimeSettings,
  saveLlmGlobalProfile,
  saveLlmProviderKey,
  saveLlmUserProfile,
  serializeRuntimeLlmState,
  testLlmProviderConnection,
  updateLlmProvider,
});

registerAdminLegacyGenerationRoutes(app, {
  BOOK_UPLOADS_DIR,
  LEGACY_GENERATE_STORY_CREATE_ENABLED,
  RESOLVED_BOOK_INGEST_DB_PATH,
  STORY_GENERATOR_INDEX_FILE,
  STORY_GENERATOR_LOG_DIR,
  STORY_GENERATOR_OUTPUT_ROOT,
  STORY_GENERATOR_SUMMARY_DIR,
  asMessage,
  buildGenerationSummaryFileName,
  defaultGenerationRunId,
  enqueueGenerationJob,
  getBooksDbOrThrow,
  getGeneratedChapterMap,
  getGenerationJobByRunId,
  hasGenerationSceneRows,
  listGenerationJobCandidates,
  listGenerationJobs,
  listGenerationScenes,
  materializeChapterTextToFile,
  normalizeBoolean,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizePositiveNumber,
  normalizeRunId,
  normalizeShortText,
  normalizeStoryFile,
  normalizeTargetDate,
  readJsonSafe,
  readRunEvents,
  readTailLines,
  runBookIngestCommand,
  runBookSummaryCommand,
  requireAdmin,
  requireAuth,
  requireCsrf,
  safeParseJsonObject,
  serializeGenerationSceneAsLegacyCandidate,
  summarizeGenerationCandidates,
  summarizeGenerationScenes,
  summarizeLegacyCandidateCountsFromScenes,
  syncGenerationJobCandidatesFromSummary,
});

registerInternalWorkerRoutes(app, {
  appendRunEvent,
  asMessage,
  claimGenerationCandidateImageRetry,
  claimGenerationJob,
  completeGenerationCandidateImageRetry,
  completeGenerationJobByRunId,
  getGenerationJobByRunId,
  normalizeErrorMessage,
  normalizeGenerationJobStatus,
  normalizeGenerationReviewStatus,
  normalizePositiveInteger,
  normalizeShortText,
  nowIso,
  requireWorkerAuth,
});

registerRunLifecycleRoutes(app, {
  asMessage,
  cancelGenerationRun,
  db,
  deleteGenerationRun,
  ensureGenerationRunWritable,
  getGenerationJobByRunId,
  hasGenerationSceneRows,
  listGenerationJobCandidates,
  listGenerationJobs,
  listGenerationSceneAttempts,
  listGenerationScenes,
  materializeGenerationScenesFromLegacy,
  normalizeGenerationSceneImageStatus,
  normalizeRunId,
  nowIso,
  publishSelectedGenerationCandidates,
  readJsonSafe,
  requireAdmin,
  requireAuth,
  requireCsrf,
  summarizeGenerationScenes,
  syncGenerationJobCandidatesFromSummary,
});

registerRunGenerateTextRoutes(app, {
  STORY_GENERATOR_LOG_DIR,
  STORY_GENERATOR_SUMMARY_DIR,
  asMessage,
  buildGenerationSummaryFileName,
  createOrUpdateAtomicGenerationRun,
  db,
  ensureGenerationRunWritable,
  getGenerationJobByRunId,
  listGenerationScenes,
  materializeChapterTextToFile,
  normalizeGenerationSceneCharacters,
  normalizeIntegerInRange,
  normalizePositiveInteger,
  normalizeRunId,
  normalizeStoryFile,
  normalizeTargetDate,
  nowIso,
  refreshGenerationRunState,
  replaceGenerationScenes,
  requireAdmin,
  requireAuth,
  requireCsrf,
  runStoryGeneratorAtomicCommand,
  summarizeGenerationScenes,
  writeJsonAtomic,
  resolveLlmRuntimeSettings,
});

registerRunGenerateImageRoutes(app, {
  asMessage,
  createGenerationSceneImageAttempt,
  db,
  ensureGenerationRunWritable,
  finalizeGenerationSceneImageAttempt,
  getGenerationJobByRunId,
  getGenerationSceneByIndex,
  listGenerationSceneAttempts,
  listGenerationScenes,
  nextGenerationSceneAttemptNo,
  normalizeBoolean,
  normalizeGenerationSceneImageStatus,
  normalizePositiveInteger,
  normalizePositiveNumber,
  normalizeRunId,
  nowIso,
  refreshGenerationRunState,
  requireAdmin,
  requireAuth,
  requireCsrf,
  resolveGenerationRunImagesDir,
  resolveStoryAssetUrlFromFsPath,
  runStoryGeneratorAtomicCommand,
  resolveLlmRuntimeSettings,
  setGenerationSceneImageResult,
  setGenerationSceneImageRunning,
  summarizeGenerationScenes,
});

registerRunSceneRoutes(app, {
  createGenerationSceneImageAttempt,
  deleteGenerationSceneDraft,
  ensureGenerationRunWritable,
  finalizeGenerationSceneImageAttempt,
  getGenerationJobByRunId,
  getGenerationSceneByIndex,
  listGenerationSceneAttempts,
  listGenerationScenes,
  normalizePositiveInteger,
  normalizeRunId,
  refreshGenerationRunState,
  resolveGenerationRunImagesDir,
  resolveStoryAssetUrlFromFsPath,
  requireAdmin,
  requireAuth,
  requireCsrf,
  setGenerationSceneImageResult,
  summarizeGenerationScenes,
  updateGenerationSceneDraft,
});

registerGenerationReviewRoutes(app, {
  getGenerationJobByRunId,
  hasGenerationSceneRows,
  listGenerationJobCandidates,
  listGenerationScenes,
  materializeGenerationScenesFromLegacy,
  normalizeBoolean,
  normalizeIntegerInRange,
  normalizePositiveInteger,
  publishSelectedReviewCandidates,
  requireAdmin,
  requireAuth,
  requireCsrf,
  serializeGenerationSceneAsLegacyCandidate,
  summarizeGenerationCandidates,
  summarizeGenerationScenes,
  summarizeLegacyCandidateCountsFromScenes,
  syncGenerationJobCandidatesFromSummary,
  updateReviewCandidateConfig,
});

registerGenerationReviewRetryRoutes(app, {
  normalizePositiveInteger,
  requireAdmin,
  requireAuth,
  requireCsrf,
  retryGenerationCandidateImage,
});

registerAdminUserRoutes(app, {
  appendAdminAuditLog,
  asMessage,
  countAdminUsers,
  db,
  getRolesByUserId,
  getRolesByUserIds,
  normalizeAdminRole,
  normalizePositiveInteger,
  normalizeShortText,
  nowIso,
  requireAdmin,
  requireAuth,
  requireCsrf,
  resetUserPasswordAndSessions,
  serializeAdminUser,
});

registerAdminLevelRoutes(app, {
  appendAdminAuditLog,
  asMessage,
  buildAdminLevelConfigSnapshot,
  loadStoryById,
  normalizeShortText,
  parseAdminLevelConfigPatch,
  randomToken,
  requireAdmin,
  requireAuth,
  requireCsrf,
  saveAdminLevelOverrideConfig,
  serializeLevelOverrideConfig,
});

registerAdminStoryRoutes(app, {
  appendAdminAuditLog,
  asMessage,
  buildAdminStoryMetaSnapshot,
  normalizeShortText,
  requireAdmin,
  requireAuth,
  requireCsrf,
  saveAdminStoryMetaOverride,
});

registerPlayerRoutes(app, {
  VALID_PROGRESS_STATUS,
  asMessage,
  db,
  getLevelProgressMap,
  listStoriesForUser,
  loadStoryById,
  normalizeAttempts,
  normalizeContentVersion,
  normalizePositiveInteger,
  nowIso,
  requireAuth,
  requireCsrf,
  serializeProgressRow,
});

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const mapped = errorResponsePayload(error);
  if (!isAppError(error) || mapped.status >= 500) {
    console.error("[http] unhandled error", error);
  }

  res.status(mapped.status).json(mapped.payload);
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`puzzle backend running at http://localhost:${port}`);
});

function initializeSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_guest INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      token_hash TEXT,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_level_progress (
      user_id INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      level_id TEXT NOT NULL,
      status TEXT NOT NULL,
      best_time_ms INTEGER,
      best_moves INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_played_at TEXT,
      completed_at TEXT,
      save_state_json TEXT,
      content_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, story_id, level_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      requested_by TEXT NOT NULL,
      target_date TEXT NOT NULL,
      story_file TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      log_file TEXT NOT NULL,
      event_log_file TEXT NOT NULL,
      summary_path TEXT NOT NULL,
      error_message TEXT,
      exit_code INTEGER,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      requested_ip TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      requested_by_username TEXT NOT NULL,
      requested_password_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      request_note TEXT,
      requested_at TEXT NOT NULL,
      requested_ip TEXT,
      reviewed_at TEXT,
      reviewed_by_user_id INTEGER,
      review_note TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_progress_user_story ON user_level_progress(user_id, story_id);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created ON generation_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_created ON generation_jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_expires_at ON password_reset_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_password_reset_requests_user_status ON password_reset_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status_requested ON password_reset_requests(status, requested_at);
  `);

  ensureSessionColumns(database);
  ensureUserColumns(database);
  enforceSingleSessionConstraint(database);
  markStaleGenerationJobsAsFailed(database);
}


function ensureSessionColumns(database) {
  const columns = database.prepare("PRAGMA table_info(sessions)").all();
  const hasCsrfToken = columns.some((column) => column.name === "csrf_token");
  const hasTokenHash = columns.some((column) => column.name === "token_hash");

  if (!hasCsrfToken) {
    database.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT");
  }

  if (!hasTokenHash) {
    database.exec("ALTER TABLE sessions ADD COLUMN token_hash TEXT");
  }

  const sessionRowsMissingTokenHash = database
    .prepare("SELECT token FROM sessions WHERE token_hash IS NULL OR length(token_hash) = 0")
    .all();

  if (sessionRowsMissingTokenHash.length > 0) {
    const updateTokenHash = database.prepare("UPDATE sessions SET token_hash = ? WHERE token = ?");
    const tx = database.transaction((rows) => {
      for (const row of rows) {
        const token = String(row?.token || "").trim();
        if (!token) {
          continue;
        }
        updateTokenHash.run(hashSessionToken(token), token);
      }
    });
    tx(sessionRowsMissingTokenHash);
  }

  database.prepare("DELETE FROM sessions WHERE csrf_token IS NULL OR length(csrf_token) = 0").run();
  database.prepare("DELETE FROM sessions WHERE token_hash IS NULL OR length(token_hash) = 0").run();
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)");
}

function ensureUserColumns(database) {
  const columns = database.prepare("PRAGMA table_info(users)").all();
  const hasIsGuest = columns.some((column) => column.name === "is_guest");

  if (!hasIsGuest) {
    database.exec("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0");
  }

  database.prepare("UPDATE users SET is_guest = 0 WHERE is_guest IS NULL").run();
}

function enforceSingleSessionConstraint(database) {
  const duplicatedUsers = database
    .prepare("SELECT user_id FROM sessions GROUP BY user_id HAVING COUNT(*) > 1")
    .all();

  for (const row of duplicatedUsers) {
    const sessions = database
      .prepare("SELECT token FROM sessions WHERE user_id = ? ORDER BY expires_at DESC, created_at DESC")
      .all(row.user_id);

    const redundantTokens = sessions.slice(1).map((session) => session.token);
    if (redundantTokens.length > 0) {
      const placeholders = redundantTokens.map(() => "?").join(", ");
      database.prepare(`DELETE FROM sessions WHERE token IN (${placeholders})`).run(...redundantTokens);
    }
  }

  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_single_user ON sessions(user_id)");
}

function resolveStoriesRootDir() {
  const configuredRoot = String(process.env.STORY_CONTENT_ROOT || "").trim();
  if (configuredRoot) {
    return resolveProjectPath(configuredRoot);
  }

  return path.normalize(DEFAULT_STORIES_ROOT_DIR);
}

function ensureStoryIndexFile() {
  if (fs.existsSync(STORY_INDEX_FILE)) {
    return;
  }

  const normalizedStoriesRoot = path.normalize(STORIES_ROOT_DIR);
  const normalizedLegacyRoot = path.normalize(LEGACY_STORIES_ROOT_DIR);
  const legacyIndexPath = path.join(normalizedLegacyRoot, "index.json");

  if (normalizedStoriesRoot !== normalizedLegacyRoot && fs.existsSync(legacyIndexPath)) {
    fs.cpSync(normalizedLegacyRoot, normalizedStoriesRoot, { recursive: true });
    if (fs.existsSync(STORY_INDEX_FILE)) {
      return;
    }
  }

  const payload = {
    version: 1,
    stories: [],
  };
  fs.writeFileSync(STORY_INDEX_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function requireWorkerAuth(req, res, next) {
  if (!STORY_GENERATOR_WORKER_TOKEN) {
    res.status(503).json({ message: "worker token 未配置" });
    return;
  }

  const token = extractWorkerToken(req);
  if (!token || token !== STORY_GENERATOR_WORKER_TOKEN) {
    res.status(401).json({ message: "worker 鉴权失败" });
    return;
  }

  next();
}

function extractWorkerToken(req) {
  const headerToken = req.headers["x-worker-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return token || "";
  }

  return "";
}

function getBooksDbOrThrow() {
  if (booksDb) {
    return booksDb;
  }

  if (!fs.existsSync(RESOLVED_BOOK_INGEST_DB_PATH)) {
    throw new Error(`未找到书籍数据库: ${RESOLVED_BOOK_INGEST_DB_PATH}`);
  }

  booksDb = new Database(RESOLVED_BOOK_INGEST_DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  return booksDb;
}

function materializeChapterTextToFile(chapterId, runId) {
  const booksDatabase = getBooksDbOrThrow();
  const row = booksDatabase
    .prepare(
      `
      SELECT c.id, c.book_id, b.title AS book_title, c.chapter_index, c.chapter_title, c.chapter_text, c.char_count
      FROM chapters c
      JOIN books b ON b.id = c.book_id
      WHERE c.id = ?
    `,
    )
    .get(chapterId);

  if (!row || typeof row.chapter_text !== "string" || !row.chapter_text.trim()) {
    throw new Error(`chapter_id 不存在或正文为空: ${chapterId}`);
  }

  const chapterDir = path.join(STORY_GENERATOR_SUMMARY_DIR, "chapters");
  fs.mkdirSync(chapterDir, { recursive: true });

  const chapterFile = path.join(chapterDir, `${runId}_chapter_${Number(row.id)}.txt`);
  fs.writeFileSync(chapterFile, row.chapter_text, "utf-8");

  return {
    chapter_id: Number(row.id),
    book_id: Number(row.book_id),
    book_title: String(row.book_title || ""),
    chapter_index: Number(row.chapter_index),
    chapter_title: String(row.chapter_title || ""),
    char_count: Number(row.char_count || 0),
    story_file: chapterFile,
  };
}

function syncBooksGenerationLink({ runId, chapterId, storyId, summaryPath }) {
  const normalizedChapterId = normalizePositiveInteger(chapterId);
  const normalizedStoryId = normalizeShortText(storyId);
  if (!normalizedChapterId || !normalizedStoryId) {
    return false;
  }

  if (!fs.existsSync(RESOLVED_BOOK_INGEST_DB_PATH)) {
    return false;
  }

  let booksWriteDb = null;
  try {
    booksWriteDb = new Database(RESOLVED_BOOK_INGEST_DB_PATH, {
      fileMustExist: true,
    });
    booksWriteDb.pragma("busy_timeout = 5000");
    booksWriteDb.exec("PRAGMA foreign_keys = ON");

    const chapter = booksWriteDb.prepare("SELECT id FROM chapters WHERE id = ? LIMIT 1").get(normalizedChapterId);
    if (!chapter) {
      return false;
    }

    booksWriteDb.prepare("BEGIN IMMEDIATE").run();
    try {
      const usage = booksWriteDb
        .prepare(
          `
          SELECT id, pipeline_run_id
          FROM chapter_usage
          WHERE chapter_id = ?
            AND usage_type = 'puzzle_story'
            AND status = 'succeeded'
          LIMIT 1
        `,
        )
        .get(normalizedChapterId);

      const isSameRun = usage && String(usage.pipeline_run_id || "") === String(runId || "");

      if (usage) {
        booksWriteDb
          .prepare(
            `
            UPDATE chapter_usage
            SET pipeline_run_id = ?,
                generated_story_id = ?,
                summary_path = ?,
                status = 'succeeded',
                error_message = '',
                updated_at = datetime('now')
            WHERE id = ?
          `,
          )
          .run(String(runId || ""), normalizedStoryId, String(summaryPath || ""), usage.id);
      } else {
        booksWriteDb
          .prepare(
            `
            INSERT INTO chapter_usage (
              chapter_id, usage_type, status, reserved_at, expires_at,
              pipeline_run_id, generated_story_id, summary_path, error_message, updated_at
            ) VALUES (?, 'puzzle_story', 'succeeded', datetime('now'), NULL, ?, ?, ?, '', datetime('now'))
          `,
          )
          .run(normalizedChapterId, String(runId || ""), normalizedStoryId, String(summaryPath || ""));
      }

      if (!isSameRun) {
        booksWriteDb
          .prepare(
            `
            UPDATE chapters
            SET used_count = used_count + 1,
                last_used_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?
          `,
          )
          .run(normalizedChapterId);
      }

      booksWriteDb.prepare("COMMIT").run();
      return true;
    } catch (error) {
      booksWriteDb.prepare("ROLLBACK").run();
      throw error;
    }
  } catch {
    return false;
  } finally {
    if (booksWriteDb) {
      booksWriteDb.close();
    }
  }
}

function runBookIngestCommand(options = {}) {
  const source = String(options.source || "").trim();
  if (!source) {
    return Promise.reject(new Error("source 不能为空"));
  }

  const format = String(options.format || "auto").trim().toLowerCase();
  const sourceFormat = format === "txt" || format === "epub" ? format : "auto";
  const title = String(options.title || "").trim();
  const author = String(options.author || "").trim();
  const genre = String(options.genre || "").trim();
  const language = String(options.language || "zh").trim() || "zh";
  const replaceBook = Boolean(options.replaceBook);
  const runId = String(options.runId || "").trim();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(5000, Math.floor(Number(options.timeoutMs)))
    : 1000 * 60 * 5;

  const pythonCommand = Array.isArray(STORY_GENERATOR_PYTHON_CMD) && STORY_GENERATOR_PYTHON_CMD.length > 0
    ? STORY_GENERATOR_PYTHON_CMD
    : [STORY_GENERATOR_PYTHON_BIN || "python3"];
  const pythonExec = String(pythonCommand[0] || STORY_GENERATOR_PYTHON_BIN || "python3").trim() || "python3";
  const pythonArgs = pythonCommand.slice(1);

  const args = [
    ...pythonArgs,
    "-m",
    "scripts.book_ingest.ingest",
    "--db",
    RESOLVED_BOOK_INGEST_DB_PATH,
    "--source",
    source,
    "--format",
    sourceFormat,
    "--language",
    language,
  ];

  if (title) {
    args.push("--title", title);
  }
  if (author) {
    args.push("--author", author);
  }
  if (genre) {
    args.push("--genre", genre);
  }
  if (replaceBook) {
    args.push("--replace-book");
  }
  if (runId) {
    args.push("--run-id", runId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExec, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finalize = (handler) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      handler();
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finalize(() => reject(error));
    });

    child.on("close", (code) => {
      finalize(() => {
        const output = String(stdout || "").trim();
        const parsed = safeParseJsonObject(output);
        if (Number(code) !== 0) {
          const message = normalizeShortText(parsed?.error || "")
            || normalizeShortText(stderr)
            || `book ingest exited with code ${Number(code)}`;
          reject(new Error(message));
          return;
        }

        if (parsed && parsed.ok === false) {
          const message = normalizeShortText(parsed.error || "") || "book ingest failed";
          reject(new Error(message));
          return;
        }

        resolve(parsed && typeof parsed === "object" && Object.keys(parsed).length > 0
          ? parsed
          : {
            ok: true,
            output,
          });
      });
    });

    const timer = setTimeout(() => {
      finalize(() => {
        child.kill("SIGKILL");
        reject(new Error(`book ingest timeout after ${timeoutMs}ms`));
      });
    }, timeoutMs);
  });
}

function runBookSummaryCommand(options = {}) {
  const bookId = normalizePositiveInteger(options.bookId);
  const chapterId = normalizePositiveInteger(options.chapterId);
  if (!bookId && !chapterId) {
    return Promise.reject(new Error("bookId 或 chapterId 至少传一个"));
  }

  const runId = String(options.runId || "").trim();
  const force = Boolean(options.force);
  const chunkSize = normalizePositiveInteger(options.chunkSize) || 1000;
  const summaryMaxChars = normalizePositiveInteger(options.summaryMaxChars) || 200;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(5000, Math.floor(Number(options.timeoutMs)))
    : STORY_GENERATOR_BOOK_SUMMARY_TIMEOUT_MS;

  const runtimeInput = options.llmRuntime && typeof options.llmRuntime === "object"
    ? { ...options.llmRuntime }
    : {};
  if (!String(runtimeInput.purpose || "").trim()) {
    runtimeInput.purpose = "summary";
  }
  if (!runtimeInput.userId && normalizePositiveInteger(options.userId)) {
    runtimeInput.userId = normalizePositiveInteger(options.userId);
  }
  const runtime = resolveLlmRuntimeSettings(runtimeInput);
  const resolvedBaseUrl = String(options.baseUrl || runtime.api_base_url || "").trim();
  const resolvedSummaryModel = String(options.summaryModel || options.textModel || runtime.summary_model || runtime.text_model || "").trim();
  const resolvedApiKey = String(options.apiKey || runtime.api_key || "").trim();
  const proxyEnv = buildLlmProxyEnv({
    proxy_url: String(options.proxyUrl || runtime.proxy_url || "").trim(),
    no_proxy: String(options.noProxy || runtime.no_proxy || "").trim(),
  });

  const pythonCommand = Array.isArray(STORY_GENERATOR_PYTHON_CMD) && STORY_GENERATOR_PYTHON_CMD.length > 0
    ? STORY_GENERATOR_PYTHON_CMD
    : [STORY_GENERATOR_PYTHON_BIN || "python3"];
  const pythonExec = String(pythonCommand[0] || STORY_GENERATOR_PYTHON_BIN || "python3").trim() || "python3";
  const pythonArgs = pythonCommand.slice(1);

  const args = [
    ...pythonArgs,
    "-m",
    "scripts.book_ingest.summarize",
    "--db",
    RESOLVED_BOOK_INGEST_DB_PATH,
    "--chunk-size",
    String(chunkSize),
    "--summary-max-chars",
    String(summaryMaxChars),
  ];

  if (bookId) {
    args.push("--book-id", String(bookId));
  }
  if (chapterId) {
    args.push("--chapter-id", String(chapterId));
  }
  if (runId) {
    args.push("--run-id", runId);
  }
  if (force) {
    args.push("--force");
  }
  if (resolvedBaseUrl) {
    args.push("--base-url", resolvedBaseUrl);
  }
  if (resolvedSummaryModel) {
    args.push("--text-model", resolvedSummaryModel);
  }
  if (resolvedApiKey) {
    args.push("--api-key", resolvedApiKey);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExec, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...proxyEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (typeof options.onSpawn === "function") {
      try {
        options.onSpawn({
          pid: Number(child.pid) || 0,
          kill: (signal = "SIGTERM") => {
            try {
              return child.kill(signal);
            } catch {
              return false;
            }
          },
        });
      } catch {
        // ignore onSpawn hook errors
      }
    }

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finalize = (handler) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      handler();
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finalize(() => reject(error));
    });

    child.on("close", (code) => {
      finalize(() => {
        const output = String(stdout || "").trim();
        const parsed = safeParseJsonObject(output);
        if (Number(code) !== 0) {
          const message = normalizeShortText(parsed?.error || "")
            || normalizeShortText(stderr)
            || `book summary exited with code ${Number(code)}`;
          reject(new Error(message));
          return;
        }

        if (parsed && parsed.ok === false) {
          const message = normalizeShortText(parsed.error || "") || "book summary failed";
          reject(new Error(message));
          return;
        }

        resolve(parsed && typeof parsed === "object" && Object.keys(parsed).length > 0
          ? parsed
          : {
            ok: true,
            output,
          });
      });
    });

    const timer = setTimeout(() => {
      finalize(() => {
        child.kill("SIGKILL");
        reject(new Error(`book summary timeout after ${timeoutMs}ms`));
      });
    }, timeoutMs);
  });
}

function runStoryGeneratorAtomicCommand(command, payload, options = {}) {
  const allowedCommands = new Set(["generate-text", "generate-image", "generate-images", "check-connection"]);
  const normalizedCommand = String(command || "").trim();
  if (!allowedCommands.has(normalizedCommand)) {
    return Promise.reject(new Error(`不支持的原子命令: ${normalizedCommand}`));
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
    : STORY_GENERATOR_ATOMIC_TIMEOUT_MS;
  const incomingPayload = payload && typeof payload === "object" ? payload : {};
  const runtimeInput = options.llmRuntime && typeof options.llmRuntime === "object"
    ? { ...options.llmRuntime }
    : {};
  if (!String(runtimeInput.purpose || "").trim()) {
    runtimeInput.purpose = normalizedCommand === "generate-image" || normalizedCommand === "generate-images"
      ? "image"
      : "text";
  }
  if (!runtimeInput.userId && normalizePositiveInteger(options.userId)) {
    runtimeInput.userId = normalizePositiveInteger(options.userId);
  }
  const runtime = resolveLlmRuntimeSettings(runtimeInput);

  const hasValue = (value) => String(value || "").trim().length > 0;
  const requestPayload = {
    ...incomingPayload,
  };

  if (!hasValue(requestPayload.base_url) && hasValue(runtime.api_base_url)) {
    requestPayload.base_url = runtime.api_base_url;
  }
  if (!hasValue(requestPayload.text_model) && hasValue(runtime.text_model)) {
    requestPayload.text_model = runtime.text_model;
  }
  if (!hasValue(requestPayload.summary_model) && hasValue(runtime.summary_model)) {
    requestPayload.summary_model = runtime.summary_model;
  }
  if (!hasValue(requestPayload.image_model) && hasValue(runtime.image_model)) {
    requestPayload.image_model = runtime.image_model;
  }
  if (!hasValue(requestPayload.api_key) && hasValue(runtime.api_key)) {
    requestPayload.api_key = runtime.api_key;
  }

  const proxyEnv = buildLlmProxyEnv(runtime);
  const childEnv = {
    ...process.env,
    ...proxyEnv,
  };
  if (hasValue(runtime.api_key)) {
    childEnv.AIHUBMIX_API_KEY = runtime.api_key;
    childEnv.STORY_GENERATOR_API_KEY = runtime.api_key;
  }

  const pythonCommand = Array.isArray(STORY_GENERATOR_PYTHON_CMD) && STORY_GENERATOR_PYTHON_CMD.length > 0
    ? STORY_GENERATOR_PYTHON_CMD
    : [STORY_GENERATOR_PYTHON_BIN || "python3"];
  const pythonExec = String(pythonCommand[0] || STORY_GENERATOR_PYTHON_BIN || "python3").trim() || "python3";
  const pythonArgs = pythonCommand.slice(1);

  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonExec,
      [...pythonArgs, "-m", STORY_GENERATOR_ATOMIC_MODULE, normalizedCommand],
      {
        cwd: ROOT_DIR,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let finished = false;

    const done = (error, result = null) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutTimer);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }

      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 800);

      done(new Error(`原子命令超时: ${normalizedCommand} (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      done(new Error(`启动原子命令失败(${pythonCommand.join(" ")}): ${asMessage(error, "spawn failed")}`));
    });

    child.on("close", (code) => {
      if (finished) {
        return;
      }

      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      const parsedStdout = safeParseJsonObject(trimmedStdout);
      const stderrPayload = safeParseJsonObject(trimmedStderr);

      if (code === 0) {
        if (!parsedStdout || parsedStdout.ok !== true || !parsedStdout.result || typeof parsedStdout.result !== "object") {
          done(new Error(`原子命令输出不合法: ${normalizedCommand}`));
          return;
        }
        done(null, parsedStdout.result);
        return;
      }

      const errorMessage = String(parsedStdout.error || stderrPayload.error || trimmedStderr || trimmedStdout || "atomic command failed").trim();
      done(new Error(`原子命令失败(${normalizedCommand}): ${errorMessage}`));
    });

    try {
      child.stdin.write(JSON.stringify(requestPayload));
      child.stdin.end();
    } catch (error) {
      done(new Error(`写入原子命令输入失败: ${asMessage(error, "stdin write failed")}`));
    }
  });
}

function nextGenerationSceneAttemptNo(runId, sceneIndex) {
  const row = db
    .prepare(
      `
      SELECT MAX(attempt_no) AS max_attempt_no
      FROM generation_job_scene_image_attempts
      WHERE run_id = ? AND scene_index = ?
    `,
    )
    .get(runId, sceneIndex);

  const current = Number(row?.max_attempt_no || 0);
  return Number.isInteger(current) && current > 0 ? current + 1 : 1;
}

function createGenerationSceneImageAttempt({
  runId,
  sceneIndex,
  provider,
  model,
  imagePrompt,
}) {
  const attemptNo = nextGenerationSceneAttemptNo(runId, sceneIndex);
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO generation_job_scene_image_attempts (
      run_id,
      scene_index,
      attempt_no,
      status,
      provider,
      model,
      image_prompt,
      error_message,
      created_at,
      started_at,
      updated_at
    ) VALUES (?, ?, ?, 'running', ?, ?, ?, '', ?, ?, ?)
  `,
  ).run(
    runId,
    sceneIndex,
    attemptNo,
    String(provider || "").trim(),
    String(model || "").trim(),
    String(imagePrompt || "").trim(),
    now,
    now,
    now,
  );

  return db
    .prepare(
      `
      SELECT id, run_id, scene_index, attempt_no, status,
             provider, model, image_prompt,
             image_url, image_path, error_message,
             latency_ms, created_at, started_at, ended_at, updated_at
      FROM generation_job_scene_image_attempts
      WHERE run_id = ? AND scene_index = ? AND attempt_no = ?
      LIMIT 1
    `,
    )
    .get(runId, sceneIndex, attemptNo);
}

function finalizeGenerationSceneImageAttempt({
  runId,
  sceneIndex,
  attemptNo,
  status,
  imageUrl,
  imagePath,
  errorMessage,
  latencyMs,
}) {
  const normalizedStatus = normalizeGenerationCandidateRetryStatus(status);
  const now = nowIso();

  db.prepare(
    `
    UPDATE generation_job_scene_image_attempts
    SET status = ?,
        image_url = ?,
        image_path = ?,
        error_message = ?,
        latency_ms = ?,
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?
    WHERE run_id = ?
      AND scene_index = ?
      AND attempt_no = ?
  `,
  ).run(
    normalizedStatus,
    String(imageUrl || "").trim(),
    String(imagePath || "").trim(),
    String(errorMessage || "").trim(),
    Number.isFinite(Number(latencyMs)) ? Math.max(0, Math.floor(Number(latencyMs))) : null,
    now,
    now,
    runId,
    sceneIndex,
    attemptNo,
  );
}

function setGenerationSceneImageRunning(runId, sceneIndex) {
  db.prepare(
    `
    UPDATE generation_job_scenes
    SET image_status = 'running',
        error_message = '',
        updated_at = ?
    WHERE run_id = ? AND scene_index = ?
  `,
  ).run(nowIso(), runId, sceneIndex);
}

function setGenerationSceneImageResult({ runId, sceneIndex, status, imageUrl, imagePath, errorMessage }) {
  const normalizedImageStatus = normalizeGenerationSceneImageStatus(status);
  const now = nowIso();
  const normalizedPath = String(imagePath || "").trim();
  const normalizedUrl = String(imageUrl || "").trim();
  const resolvedImageUrl = normalizedUrl || resolveStoryAssetUrlFromFsPath(normalizedPath);

  db.prepare(
    `
    UPDATE generation_job_scenes
    SET image_status = ?,
        image_url = ?,
        image_path = ?,
        error_message = ?,
        selected = CASE
          WHEN ? = 'success' THEN selected
          ELSE 0
        END,
        updated_at = ?
    WHERE run_id = ? AND scene_index = ?
  `,
  ).run(
    normalizedImageStatus,
    resolvedImageUrl,
    normalizedPath,
    normalizedImageStatus === "success" ? "" : String(errorMessage || "").trim(),
    normalizedImageStatus,
    now,
    runId,
    sceneIndex,
  );
}

function enqueueGenerationJob({ runId, requestedBy, targetDate, storyFile, dryRun, payload, logFile, eventLogFile, summaryPath }) {
  const now = nowIso();
  db.prepare(
    `
    INSERT INTO generation_jobs (
      run_id, status, review_status, flow_stage, requested_by, target_date, story_file, dry_run,
      payload_json, log_file, event_log_file, summary_path,
      published_at, error_message, exit_code, created_at, started_at, ended_at, updated_at
    ) VALUES (?, 'queued', '', 'text_generating', ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', NULL, ?, NULL, NULL, ?)
  `,
  ).run(
    runId,
    requestedBy,
    targetDate,
    storyFile || "",
    dryRun ? 1 : 0,
    JSON.stringify(payload),
    logFile,
    eventLogFile,
    summaryPath,
    now,
    now,
  );

  upsertGenerationJobMetaOnEnqueue({
    runId,
    requestedBy,
    payload,
    createdAt: now,
  });

  cleanupGenerationJobs();
}

function upsertGenerationJobMetaOnEnqueue({ runId, requestedBy, payload, createdAt }) {
  try {
    const requestedByUser = db
      .prepare("SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1")
      .get(String(requestedBy || "").trim());

    const chapterId = normalizePositiveInteger(payload?.chapter_id) || null;
    const bookId = normalizePositiveInteger(payload?.book_id) || null;
    const usageId = normalizePositiveInteger(payload?.usage_id) || null;
    const storyId = normalizeShortText(payload?.story_id) || null;
    const now = createdAt || nowIso();

    db.prepare(
      `
      INSERT INTO generation_job_meta (
        run_id,
        requested_by_user_id,
        chapter_id,
        book_id,
        usage_id,
        result_story_id,
        job_kind,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'story_generation', ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        requested_by_user_id = COALESCE(excluded.requested_by_user_id, generation_job_meta.requested_by_user_id),
        chapter_id = COALESCE(excluded.chapter_id, generation_job_meta.chapter_id),
        book_id = COALESCE(excluded.book_id, generation_job_meta.book_id),
        usage_id = COALESCE(excluded.usage_id, generation_job_meta.usage_id),
        result_story_id = CASE
          WHEN COALESCE(excluded.result_story_id, '') <> '' THEN excluded.result_story_id
          ELSE generation_job_meta.result_story_id
        END,
        updated_at = excluded.updated_at
    `,
    ).run(
      runId,
      Number.isInteger(requestedByUser?.id) ? Number(requestedByUser.id) : null,
      chapterId,
      bookId,
      usageId,
      storyId,
      now,
      now,
    );
  } catch {
    // ignore meta sync errors to keep main queue flow available
  }
}

function upsertGenerationJobMetaOnComplete({ runId, status, storyId, updatedAt }) {
  try {
    const normalizedStatus = String(status || "").trim();
    if (normalizedStatus !== "succeeded") {
      return;
    }

    let resolvedStoryId = normalizeShortText(storyId);
    if (!resolvedStoryId) {
      const row = db
        .prepare("SELECT payload_json FROM generation_jobs WHERE run_id = ? LIMIT 1")
        .get(runId);
      const payload = safeParseJsonObject(row?.payload_json);
      resolvedStoryId = normalizeShortText(payload?.story_id);
    }

    if (!resolvedStoryId) {
      return;
    }

    db.prepare(
      `
      UPDATE generation_job_meta
      SET result_story_id = ?,
          updated_at = ?
      WHERE run_id = ?
    `,
    ).run(resolvedStoryId, updatedAt || nowIso(), runId);
  } catch {
    // ignore meta sync errors to keep main queue flow available
  }
}

function claimGenerationJob() {
  const now = nowIso();
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
      )
      .get();

    if (!row) {
      return null;
    }

    const updated = db
      .prepare(
        `
        UPDATE generation_jobs
        SET status = 'running',
            flow_stage = 'images_generating',
            started_at = COALESCE(started_at, ?),
            error_message = '',
            exit_code = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'queued'
      `,
      )
      .run(now, now, row.id);

    if (updated.changes !== 1) {
      return null;
    }

    const claimed = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE id = ?
      `,
      )
      .get(row.id);

    return claimed ? serializeGenerationJobRow(claimed, true) : null;
  });

  return tx();
}

function completeGenerationJobByRunId(runId, {
  status,
  exitCode,
  errorMessage,
  storyId,
  reviewStatus,
}) {
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE run_id = ?
      `,
      )
      .get(runId);

    if (!existing) {
      return null;
    }

    if (existing.status === "queued" || existing.status === "running") {
      const now = nowIso();
      const payload = safeParseJsonObject(existing.payload_json);
      const reviewMode = isReviewModePayload(payload, Boolean(existing.dry_run));
      const existingReviewStatus = normalizeGenerationReviewStatus(existing.review_status);

      let nextReviewStatus = existingReviewStatus;
      let nextPublishedAt = existing.published_at || null;
      let nextFlowStage = normalizeGenerationFlowStage(existing.flow_stage) || "text_generating";

      if (status !== "succeeded") {
        if (existingReviewStatus !== "published") {
          nextReviewStatus = "";
          nextPublishedAt = null;
        }
        nextFlowStage = "failed";
      } else if (existingReviewStatus === "published") {
        nextReviewStatus = "published";
        nextPublishedAt = existing.published_at || now;
        nextFlowStage = "published";
      } else if (reviewMode) {
        const requestedReviewStatus = normalizeGenerationReviewStatus(reviewStatus);
        nextReviewStatus = requestedReviewStatus || "pending_review";
        nextPublishedAt = nextReviewStatus === "published" ? (existing.published_at || now) : null;
        nextFlowStage = nextReviewStatus === "published" ? "published" : "review_ready";
      } else {
        nextReviewStatus = "";
        nextPublishedAt = null;
        nextFlowStage = "published";
      }

      db.prepare(
        `
        UPDATE generation_jobs
        SET status = ?,
            review_status = ?,
            flow_stage = ?,
            exit_code = ?,
            error_message = ?,
            published_at = ?,
            ended_at = COALESCE(ended_at, ?),
            updated_at = ?
        WHERE run_id = ?
      `,
      ).run(status, nextReviewStatus, nextFlowStage, exitCode, errorMessage, nextPublishedAt, now, now, runId);

      upsertGenerationJobMetaOnComplete({
        runId,
        status,
        storyId,
        updatedAt: now,
      });

      if (status === "succeeded") {
        syncGenerationJobCandidatesFromSummary(runId, existing.summary_path);
      }
    }

    const latest = db
      .prepare(
        `
        SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
               review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
               published_at, error_message, exit_code,
               created_at, started_at, ended_at, updated_at
        FROM generation_jobs
        WHERE run_id = ?
      `,
      )
      .get(runId);

    return latest ? serializeGenerationJobRow(latest, true) : null;
  });

  return tx();
}

function normalizeGenerationCandidate(rawCandidate, fallbackIndex) {
  const sceneIndex = normalizePositiveInteger(rawCandidate?.scene_index) || fallbackIndex;
  const sceneId = normalizePositiveInteger(rawCandidate?.scene_id) || null;
  const imageStatus = normalizeCandidateImageStatus(rawCandidate?.image_status);
  const selectedRaw = rawCandidate?.selected;
  const selected = selectedRaw === undefined
    ? imageStatus === "success"
    : normalizeBoolean(selectedRaw);

  return {
    scene_index: sceneIndex,
    scene_id: sceneId,
    title: String(rawCandidate?.title || "").trim(),
    description: String(rawCandidate?.description || "").trim(),
    story_text: String(rawCandidate?.story_text || "").trim(),
    image_prompt: String(rawCandidate?.image_prompt || "").trim(),
    mood: String(rawCandidate?.mood || "").trim(),
    characters: normalizeCandidateCharacters(rawCandidate?.characters),
    grid_rows: normalizeIntegerInRange(rawCandidate?.grid_rows, 2, 20) || 6,
    grid_cols: normalizeIntegerInRange(rawCandidate?.grid_cols, 2, 20) || 4,
    time_limit_sec: normalizeIntegerInRange(rawCandidate?.time_limit_sec, 30, 3600) || 180,
    image_status: imageStatus,
    image_url: String(rawCandidate?.image_url || "").trim(),
    image_path: String(rawCandidate?.image_path || "").trim(),
    error_message: String(rawCandidate?.error_message || "").trim(),
    selected,
  };
}

function parseSceneIdFromLevelId(levelId, fallbackIndex) {
  const text = String(levelId || "").trim();
  if (!text) {
    return fallbackIndex;
  }

  const matched = text.match(/_(\d+)$/);
  if (!matched) {
    return fallbackIndex;
  }

  const parsed = normalizePositiveInteger(matched[1]);
  return parsed || fallbackIndex;
}

function resolveLegacyReviewManifestPath(summary) {
  const publishManifest = String(summary?.publish?.manifest || "").trim();
  if (publishManifest && fs.existsSync(publishManifest) && fs.statSync(publishManifest).isFile()) {
    return path.normalize(publishManifest);
  }

  const publishStoryId = normalizeGeneratedStoryId(summary?.publish?.story_id);
  const summaryStoryId = normalizeGeneratedStoryId(summary?.story_id);
  const targetStoryId = publishStoryId || summaryStoryId;
  if (!targetStoryId) {
    return "";
  }

  const manifestPath = path.join(STORIES_ROOT_DIR, targetStoryId, "story.json");
  if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
    return manifestPath;
  }

  return "";
}

function buildLegacyReviewCandidatesFromSummary(summary) {
  const manifestPath = resolveLegacyReviewManifestPath(summary);
  if (!manifestPath) {
    return [];
  }

  const manifestPayload = readJsonSafe(manifestPath);
  if (!manifestPayload || !Array.isArray(manifestPayload.levels) || manifestPayload.levels.length === 0) {
    return [];
  }

  const manifestDir = path.dirname(manifestPath);
  const normalizedManifestDir = path.normalize(manifestDir);
  const levels = manifestPayload.levels;

  return levels.map((level, index) => {
    const fallbackIndex = index + 1;
    const sourceImage = String(level?.source_image || "").trim();
    const relativeImagePath = sourceImage.replace(/^\/+/, "");

    let imagePath = "";
    if (relativeImagePath) {
      const resolvedImagePath = path.normalize(path.resolve(manifestDir, relativeImagePath));
      if (
        resolvedImagePath === normalizedManifestDir
        || resolvedImagePath.startsWith(`${normalizedManifestDir}${path.sep}`)
      ) {
        try {
          if (fs.existsSync(resolvedImagePath) && fs.statSync(resolvedImagePath).isFile()) {
            imagePath = resolvedImagePath;
          }
        } catch {
          imagePath = "";
        }
      }
    }

    const imageUrl = imagePath ? resolveStoryAssetUrlFromFsPath(imagePath) : "";
    const imageStatus = imagePath ? "success" : "failed";
    const gridRows = normalizeIntegerInRange(level?.grid?.rows, 2, 20) || 6;
    const gridCols = normalizeIntegerInRange(level?.grid?.cols, 2, 20) || 4;
    const timeLimitSec = normalizeIntegerInRange(level?.time_limit_sec, 30, 3600) || 180;

    return {
      scene_index: fallbackIndex,
      scene_id: parseSceneIdFromLevelId(level?.id, fallbackIndex),
      title: String(level?.title || "").trim(),
      description: String(level?.description || "").trim(),
      story_text: String(level?.story_text || "").trim(),
      image_prompt: "",
      mood: "",
      characters: [],
      grid_rows: gridRows,
      grid_cols: gridCols,
      time_limit_sec: timeLimitSec,
      image_status: imageStatus,
      image_url: imageUrl,
      image_path: imagePath,
      error_message: imagePath ? "" : "legacy_manifest_image_missing",
      selected: Boolean(imagePath),
    };
  });
}

function syncGenerationJobCandidatesFromSummary(runId, summaryPath) {
  const summary = readJsonSafe(summaryPath);
  if (!summary) {
    return { upserted: 0 };
  }

  const rawCandidates = Array.isArray(summary.candidates) && summary.candidates.length > 0
    ? summary.candidates
    : buildLegacyReviewCandidatesFromSummary(summary);

  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    return { upserted: 0 };
  }

  const candidates = rawCandidates
    .map((item, index) => normalizeGenerationCandidate(item, index + 1))
    .filter((item) => Number.isInteger(item.scene_index) && item.scene_index > 0);

  if (candidates.length === 0) {
    return { upserted: 0 };
  }

  const now = nowIso();
  try {
    const insert = db.prepare(
      `
      INSERT OR IGNORE INTO generation_job_level_candidates (
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
        image_status,
        image_url,
        image_path,
        error_message,
        selected,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );

    const tx = db.transaction((items) => {
      let inserted = 0;
      for (const item of items) {
        const result = insert.run(
          runId,
          item.scene_index,
          item.scene_id,
          item.title,
          item.description,
          item.story_text,
          item.image_prompt,
          item.mood,
          JSON.stringify(item.characters),
          item.grid_rows,
          item.grid_cols,
          item.time_limit_sec,
          item.image_status,
          item.image_url,
          item.image_path,
          item.error_message,
          item.selected ? 1 : 0,
          now,
          now,
        );
        inserted += Number(result?.changes || 0);
      }

      return inserted;
    });

    const inserted = tx(candidates);
    return { upserted: inserted };
  } catch {
    return { upserted: 0 };
  }
}

function listGenerationJobCandidates(runId) {
  try {
    const rows = db
      .prepare(
        `
        SELECT run_id, scene_index, scene_id, title, description, story_text,
               image_prompt, mood, characters_json, grid_rows, grid_cols,
               time_limit_sec, image_status, image_url, image_path,
               error_message, selected, created_at, updated_at
        FROM generation_job_level_candidates
        WHERE run_id = ?
        ORDER BY scene_index ASC
      `,
      )
      .all(runId);

    return rows.map((row) => ({
      run_id: row.run_id,
      scene_index: Number(row.scene_index),
      scene_id: row.scene_id === null || row.scene_id === undefined ? null : Number(row.scene_id),
      title: String(row.title || ""),
      description: String(row.description || ""),
      story_text: String(row.story_text || ""),
      image_prompt: String(row.image_prompt || ""),
      mood: String(row.mood || ""),
      characters: safeParseJsonArray(row.characters_json),
      grid_rows: Number(row.grid_rows || 6),
      grid_cols: Number(row.grid_cols || 4),
      time_limit_sec: Number(row.time_limit_sec || 180),
      image_status: String(row.image_status || "pending"),
      image_url: String(row.image_url || ""),
      image_path: String(row.image_path || ""),
      error_message: String(row.error_message || ""),
      selected: Boolean(row.selected),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    }));
  } catch {
    return [];
  }
}

function summarizeGenerationCandidates(candidates) {
  const summary = {
    total: 0,
    success: 0,
    failed: 0,
    pending: 0,
    selected: 0,
    ready_for_publish: 0,
  };

  for (const item of candidates) {
    summary.total += 1;
    if (item.image_status === "success") {
      summary.success += 1;
    } else if (item.image_status === "failed" || item.image_status === "skipped") {
      summary.failed += 1;
    } else {
      summary.pending += 1;
    }

    if (item.selected) {
      summary.selected += 1;
      if (item.image_status === "success") {
        summary.ready_for_publish += 1;
      }
    }
  }

  return summary;
}

function updateGenerationJobCandidate({ runId, sceneIndex, selected, gridRows, gridCols }) {
  const existing = db
    .prepare(
      `
      SELECT run_id, scene_index, scene_id, title, description, story_text,
             image_prompt, mood, characters_json, grid_rows, grid_cols,
             time_limit_sec, image_status, image_url, image_path,
             error_message, selected, created_at, updated_at
      FROM generation_job_level_candidates
      WHERE run_id = ? AND scene_index = ?
    `,
    )
    .get(runId, sceneIndex);

  if (!existing) {
    return null;
  }

  const nextSelected = selected === null ? Boolean(existing.selected) : Boolean(selected);
  const nextGridRows = gridRows ?? Number(existing.grid_rows || 6);
  const nextGridCols = gridCols ?? Number(existing.grid_cols || 4);

  db.prepare(
    `
    UPDATE generation_job_level_candidates
    SET selected = ?,
        grid_rows = ?,
        grid_cols = ?,
        updated_at = ?
    WHERE run_id = ? AND scene_index = ?
  `,
  ).run(nextSelected ? 1 : 0, nextGridRows, nextGridCols, nowIso(), runId, sceneIndex);

  return listGenerationJobCandidates(runId).find((item) => item.scene_index === sceneIndex) || null;
}

function serializeGenerationCandidateRetryRow(row) {
  if (!row) {
    return null;
  }

  return {
    retry_id: Number(row.id),
    run_id: String(row.run_id || ""),
    scene_index: Number(row.scene_index || 0),
    status: normalizeGenerationCandidateRetryStatus(row.status),
    requested_by: String(row.requested_by || ""),
    attempts: Number(row.attempts || 0),
    error_message: String(row.error_message || ""),
    created_at: row.created_at || null,
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    updated_at: row.updated_at || null,
  };
}

function enqueueGenerationCandidateImageRetry({ runId, sceneIndex, requestedBy }) {
  const now = nowIso();
  const tx = db.transaction(() => {
    const candidate = db
      .prepare(
        `
        SELECT run_id, scene_index, image_prompt
        FROM generation_job_level_candidates
        WHERE run_id = ? AND scene_index = ?
      `,
      )
      .get(runId, sceneIndex);

    if (!candidate) {
      throw new Error("候选关卡不存在");
    }

    if (!String(candidate.image_prompt || "").trim()) {
      throw new Error("候选关卡缺少 image_prompt");
    }

    db.prepare(
      `
      UPDATE generation_job_level_candidates
      SET image_status = 'pending',
          selected = 0,
          error_message = '',
          updated_at = ?
      WHERE run_id = ? AND scene_index = ?
    `,
    ).run(now, runId, sceneIndex);

    db.prepare(
      `
      UPDATE generation_candidate_image_retries
      SET status = 'cancelled',
          error_message = CASE
            WHEN COALESCE(trim(error_message), '') = '' THEN 'superseded by new retry request'
            ELSE error_message
          END,
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE run_id = ?
        AND scene_index = ?
        AND status IN ('queued', 'running')
    `,
    ).run(now, now, runId, sceneIndex);

    const inserted = db
      .prepare(
        `
        INSERT INTO generation_candidate_image_retries (
          run_id,
          scene_index,
          status,
          requested_by,
          attempts,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, 'queued', ?, 0, '', ?, ?)
      `,
      )
      .run(runId, sceneIndex, String(requestedBy || "").trim(), now, now);

    const retryId = Number(inserted.lastInsertRowid);
    const retryRow = db
      .prepare(
        `
        SELECT id, run_id, scene_index, status, requested_by, attempts, error_message,
               created_at, started_at, ended_at, updated_at
        FROM generation_candidate_image_retries
        WHERE id = ?
      `,
      )
      .get(retryId);

    return {
      retry_id: retryId,
      retry: serializeGenerationCandidateRetryRow(retryRow),
      candidate: listGenerationJobCandidates(runId).find((item) => item.scene_index === sceneIndex) || null,
    };
  });

  return tx();
}

function claimGenerationCandidateImageRetry() {
  const now = nowIso();
  const tx = db.transaction(() => {
    const queued = db
      .prepare(
        `
        SELECT id, run_id, scene_index
        FROM generation_candidate_image_retries
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `,
      )
      .get();

    if (!queued) {
      return null;
    }

    const updated = db
      .prepare(
        `
        UPDATE generation_candidate_image_retries
        SET status = 'running',
            attempts = attempts + 1,
            started_at = COALESCE(started_at, ?),
            error_message = '',
            updated_at = ?
        WHERE id = ?
          AND status = 'queued'
      `,
      )
      .run(now, now, queued.id);

    if (updated.changes !== 1) {
      return null;
    }

    const claimed = db
      .prepare(
        `
        SELECT r.id AS retry_id,
               r.run_id,
               r.scene_index,
               r.status,
               r.requested_by,
               r.attempts,
               r.error_message,
               r.created_at,
               r.started_at,
               r.ended_at,
               r.updated_at,
               c.scene_id,
               c.title,
               c.description,
               c.story_text,
               c.image_prompt,
               c.mood,
               c.characters_json,
               c.grid_rows,
               c.grid_cols,
               c.time_limit_sec,
               g.target_date,
               g.payload_json,
               g.event_log_file
        FROM generation_candidate_image_retries r
        JOIN generation_job_level_candidates c
          ON c.run_id = r.run_id
         AND c.scene_index = r.scene_index
        JOIN generation_jobs g
          ON g.run_id = r.run_id
        WHERE r.id = ?
        LIMIT 1
      `,
      )
      .get(queued.id);

    if (!claimed) {
      return null;
    }

    const payload = safeParseJsonObject(claimed.payload_json);
    const outputRoot = resolveProjectPath(
      payload.output_root || payload.story_output_root || payload.story_content_root,
      STORY_GENERATOR_OUTPUT_ROOT,
    );

    return {
      retry_id: Number(claimed.retry_id),
      run_id: String(claimed.run_id || ""),
      scene_index: Number(claimed.scene_index || 0),
      scene_id: Number(claimed.scene_id || claimed.scene_index || 0),
      title: String(claimed.title || ""),
      description: String(claimed.description || ""),
      story_text: String(claimed.story_text || ""),
      image_prompt: String(claimed.image_prompt || ""),
      mood: String(claimed.mood || ""),
      characters: safeParseJsonArray(claimed.characters_json),
      grid_rows: normalizeIntegerInRange(claimed.grid_rows, 2, 20) || 6,
      grid_cols: normalizeIntegerInRange(claimed.grid_cols, 2, 20) || 4,
      time_limit_sec: normalizeIntegerInRange(claimed.time_limit_sec, 30, 3600) || 180,
      target_date: String(claimed.target_date || ""),
      image_size: String(payload.image_size || "2K"),
      timeout_sec: normalizePositiveNumber(payload.timeout_sec) || 120,
      poll_seconds: normalizePositiveNumber(payload.poll_seconds) || 2.5,
      poll_attempts: normalizePositiveInteger(payload.poll_attempts) || 40,
      watermark: normalizeBoolean(payload.watermark),
      output_root: outputRoot,
      event_log_file: String(claimed.event_log_file || ""),
    };
  });

  return tx();
}

function completeGenerationCandidateImageRetry({ retryId, status, imageUrl, imagePath, errorMessage }) {
  const normalizedStatus = normalizeGenerationCandidateRetryStatus(status);
  if (!normalizedStatus || normalizedStatus === "queued" || normalizedStatus === "running") {
    throw new Error("重试任务状态不合法");
  }

  const now = nowIso();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `
        SELECT id, run_id, scene_index, status
        FROM generation_candidate_image_retries
        WHERE id = ?
      `,
      )
      .get(retryId);

    if (!existing) {
      return null;
    }

    const normalizedImagePath = String(imagePath || "").trim();
    const normalizedImageUrl = String(imageUrl || "").trim();
    const resolvedImageUrl = normalizedImageUrl || resolveStoryAssetUrlFromFsPath(normalizedImagePath);

    if (normalizedStatus === "succeeded") {
      if (!normalizedImagePath) {
        throw new Error("重试成功时缺少 image_path");
      }

      db.prepare(
        `
        UPDATE generation_job_level_candidates
        SET image_status = 'success',
            image_url = ?,
            image_path = ?,
            error_message = '',
            selected = 1,
            updated_at = ?
        WHERE run_id = ? AND scene_index = ?
      `,
      ).run(resolvedImageUrl, normalizedImagePath, now, existing.run_id, existing.scene_index);
    } else {
      db.prepare(
        `
        UPDATE generation_job_level_candidates
        SET image_status = 'failed',
            error_message = ?,
            selected = 0,
            updated_at = ?
        WHERE run_id = ? AND scene_index = ?
      `,
      ).run(errorMessage || "retry failed", now, existing.run_id, existing.scene_index);
    }

    db.prepare(
      `
      UPDATE generation_candidate_image_retries
      SET status = ?,
          error_message = ?,
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE id = ?
    `,
    ).run(normalizedStatus, normalizedStatus === "succeeded" ? "" : errorMessage, now, now, retryId);

    const retry = db
      .prepare(
        `
        SELECT id, run_id, scene_index, status, requested_by, attempts, error_message,
               created_at, started_at, ended_at, updated_at
        FROM generation_candidate_image_retries
        WHERE id = ?
      `,
      )
      .get(retryId);

    return {
      retry: serializeGenerationCandidateRetryRow(retry),
      candidate: listGenerationJobCandidates(existing.run_id).find((item) => item.scene_index === Number(existing.scene_index)) || null,
    };
  });

  return tx();
}

function listGenerationJobs(limit = 50) {
  const rows = db
    .prepare(
      `
      SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
             review_status, flow_stage, log_file, event_log_file, summary_path,
             published_at, error_message, exit_code,
             created_at, started_at, ended_at, updated_at
      FROM generation_jobs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(limit);

  return rows.map(serializeGenerationJobRow);
}

function getGenerationJobByRunId(runId) {
  const row = db
    .prepare(
      `
      SELECT id, run_id, status, requested_by, target_date, story_file, dry_run,
             review_status, flow_stage, payload_json, log_file, event_log_file, summary_path,
             published_at, error_message, exit_code,
             created_at, started_at, ended_at, updated_at
      FROM generation_jobs
      WHERE run_id = ?
    `,
    )
    .get(runId);

  if (!row) {
    return null;
  }

  return serializeGenerationJobRow(row, true);
}

function serializeGenerationJobRow(row, includePayload = false) {
  const payload = includePayload ? safeParseJsonObject(row.payload_json) : undefined;
  const reviewStatus = normalizeGenerationReviewStatus(row.review_status);
  const flowStage = normalizeGenerationFlowStage(row.flow_stage);

  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    run_id: row.run_id,
    status: row.status,
    requested_by: row.requested_by,
    target_date: row.target_date,
    story_file: row.story_file || "",
    dry_run: Boolean(row.dry_run),
    review_status: reviewStatus,
    flow_stage: flowStage,
    log_file: row.log_file,
    event_log_file: row.event_log_file,
    summary_path: row.summary_path,
    published_at: row.published_at || null,
    error_message: row.error_message || "",
    exit_code: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    created_at: row.created_at,
    started_at: row.started_at || null,
    ended_at: row.ended_at || null,
    updated_at: row.updated_at,
    ...(includePayload ? { payload } : {}),
  };
}

function getGeneratedChapterMap(chapterIds = []) {
  const wanted = new Set(
    chapterIds
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0),
  );
  const map = new Map();
  if (wanted.size === 0) {
    return map;
  }

  const rows = db
    .prepare(
      `
      SELECT run_id, payload_json, summary_path, created_at, ended_at
      FROM generation_jobs
      WHERE status = 'succeeded'
      ORDER BY COALESCE(ended_at, created_at) DESC, id DESC
    `,
    )
    .all();

  for (const row of rows) {
    const payload = safeParseJsonObject(row.payload_json);
    const chapterId = Number(payload.chapter_id);
    if (!Number.isInteger(chapterId) || chapterId <= 0) {
      continue;
    }
    if (!wanted.has(chapterId) || map.has(chapterId)) {
      continue;
    }

    const summary = readJsonSafe(row.summary_path);
    const summaryStoryId = summary && typeof summary.story_id === "string" ? summary.story_id : "";
    const payloadStoryId = typeof payload.story_id === "string" ? payload.story_id : "";

    map.set(chapterId, {
      run_id: String(row.run_id || ""),
      story_id: summaryStoryId || payloadStoryId || "",
      generated_at: row.ended_at || row.created_at || null,
    });

    if (map.size >= wanted.size) {
      break;
    }
  }

  return map;
}

function cleanupGenerationJobs() {
  const rows = db.prepare("SELECT id FROM generation_jobs ORDER BY created_at DESC, id DESC").all();
  if (rows.length <= MAX_GENERATION_JOBS) {
    return;
  }

  const keepIds = new Set(rows.slice(0, MAX_GENERATION_JOBS).map((item) => Number(item.id)));
  const removable = rows
    .slice(MAX_GENERATION_JOBS)
    .map((item) => Number(item.id))
    .filter((id) => !keepIds.has(id));

  if (removable.length === 0) {
    return;
  }

  const placeholders = removable.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM generation_jobs
      WHERE id IN (${placeholders})
        AND status NOT IN ('queued', 'running')`,
  ).run(...removable);
}

function markStaleGenerationJobsAsFailed(database) {
  const now = nowIso();
  database.prepare(
    `
    UPDATE generation_jobs
    SET status = 'failed',
        flow_stage = 'failed',
        error_message = CASE
          WHEN error_message IS NULL OR length(trim(error_message)) = 0 THEN 'worker interrupted before completion'
          ELSE error_message
        END,
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?
    WHERE status = 'running'
  `,
  ).run(now, now);
}
