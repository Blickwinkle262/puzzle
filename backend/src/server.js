import { spawn } from "node:child_process";
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
import { registerAdminLegacyGenerationRoutes } from "./routes/adminLegacyGenerationRoutes.js";
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
let booksDb = null;

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
ensureStoryIndexFile();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
initializeSchema(db);
runMigrations(db);

if (LEGACY_GENERATE_STORY_CREATE_ENABLED) {
  console.warn(
    "[generation] legacy POST /api/admin/generate-story is enabled via GENERATION_LEGACY_CREATE_ENABLED=1; this is temporary compatibility mode.",
  );
}

const {
  buildGeneratedStoryBookMap,
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

registerAdminLegacyGenerationRoutes(app, {
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
  setGenerationSceneImageResult,
  setGenerationSceneImageRunning,
  summarizeGenerationScenes,
});

registerRunSceneRoutes(app, {
  deleteGenerationSceneDraft,
  getGenerationJobByRunId,
  getGenerationSceneByIndex,
  listGenerationScenes,
  normalizePositiveInteger,
  normalizeRunId,
  refreshGenerationRunState,
  requireAdmin,
  requireAuth,
  requireCsrf,
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

    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_progress_user_story ON user_level_progress(user_id, story_id);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created ON generation_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_created ON generation_jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_expires_at ON password_reset_tokens(expires_at);
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

function runStoryGeneratorAtomicCommand(command, payload, options = {}) {
  const allowedCommands = new Set(["generate-text", "generate-image", "generate-images"]);
  const normalizedCommand = String(command || "").trim();
  if (!allowedCommands.has(normalizedCommand)) {
    return Promise.reject(new Error(`不支持的原子命令: ${normalizedCommand}`));
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
    : STORY_GENERATOR_ATOMIC_TIMEOUT_MS;
  const requestPayload = payload && typeof payload === "object" ? payload : {};
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
        env: {
          ...process.env,
        },
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
