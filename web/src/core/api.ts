import {
  AdminBookChaptersResponse,
  AdminBookIngestTask,
  AdminBookSummaryTaskItem,
  AdminBookSummaryTask,
  AdminChapterTextResponse,
  AdminBookUploadResponse,
  AdminStoryMetaResponse,
  AdminGenerationCreateResponse,
  AdminGenerationCandidate,
  AdminGenerationRunDetailResponse,
  AdminGenerationRunMutateResponse,
  AdminGenerationReviewResponse,
  AdminGenerationPublishResponse,
  AdminGenerationRetryImageResponse,
  AdminGenerationJob,
  AdminGenerationJobDetail,
  AdminLevelConfigPatch,
  AdminLevelConfigResponse,
  AdminLevelTestRunResponse,
  AdminLlmConnectionTestResponse,
  AdminLlmModelsFetchResponse,
  AdminLlmEnvKeysResponse,
  AdminLlmProfileResponse,
  AdminLlmProviderDeleteResponse,
  AdminLlmProviderModelsResponse,
  AdminLlmProviderResponse,
  AdminLlmProvidersResponse,
  AdminManagedRole,
  AdminUsersResponse,
  LevelProgress,
  StoryDetail,
  StoryListItem,
  UserProfile,
} from "./types";

const API_PREFIX = "/api";
const CSRF_COOKIE_NAME = "puzzle_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export type AuthResponse = {
  // user 内含 is_admin（由后端基于 user_roles + env 兜底计算）
  user: UserProfile;
};

export type AuthMeResponse = {
  // /auth/me 返回统一用户态，前端直接消费 is_admin，不再额外探测管理员接口
  user: UserProfile;
};

export type AuthRefreshResponse = {
  // 刷新会话后也会返回最新 is_admin，避免前端持有过期权限状态
  user: UserProfile;
  refreshed_at: string;
};

export type ForgotPasswordResponse = {
  message: string;
};

export type AdminLlmProviderPatch = {
  name?: string;
  provider_kind?: "compatible";
  api_base_url?: string;
  proxy_url?: string;
  no_proxy_hosts?: string;
  enabled?: boolean;
};

export type AdminLlmProviderKeyPatch = {
  key_source?: "env" | "custom";
  env_key_name?: string;
  api_key?: string;
};

export type AdminLlmRuntimeOverridesPatch = {
  api_base_url?: string;
  proxy_url?: string;
  no_proxy?: string;
  api_key_selector?: string;
  env_key_name?: string;
  api_key?: string;
};

export type AdminLlmProfilePatch = {
  provider_id?: number | null;
  story_provider_id?: number | null;
  summary_provider_id?: number | null;
  text2image_provider_id?: number | null;
  story_prompt_model?: string;
  summary_model?: string;
  text2image_model?: string;
  reset?: boolean;
};

export type StoriesResponse = {
  stories: StoryListItem[];
};

export type StoryDetailResponse = {
  story: StoryDetail;
};

export type UpdateLevelProgressPayload = {
  story_id: string;
  status?: "not_started" | "in_progress" | "completed";
  best_time_ms?: number;
  best_moves?: number;
  attempts_increment?: number;
  content_version?: number;
  save_state_json?: unknown;
};

export type UpdateLevelProgressResponse = {
  progress: LevelProgress;
};

class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, message: string, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function requestJson<T>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const method = (opts.method ?? "GET").toUpperCase();

  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers[CSRF_HEADER_NAME] = csrfToken;
    }
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: "include",
    headers,
    body,
  });

  if (!response.ok) {
    const payload = await safeParseJson(response);
    const message =
      payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
        ? (payload as { message: string }).message
        : `请求失败 (${response.status})`;

    throw new ApiError(response.status, message, payload);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function safeParseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function readCookie(name: string): string {
  const source = typeof document !== "undefined" ? document.cookie : "";
  if (!source) {
    return "";
  }

  const parts = source.split(";");
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey !== name || rest.length === 0) {
      continue;
    }
    return decodeURIComponent(rest.join("="));
  }

  return "";
}

function buildQueryString(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function apiLogin(username: string, password: string): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/auth/login", {
    method: "POST",
    body: { username, password },
  });
}

export function apiRegister(username: string, password: string): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/auth/register", {
    method: "POST",
    body: { username, password },
  });
}

export function apiGuestLogin(): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/auth/guest-login", {
    method: "POST",
  });
}

export function apiGuestUpgrade(username: string, password: string): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/auth/guest-upgrade", {
    method: "POST",
    body: { username, password },
  });
}

export function apiChangePassword(currentPassword: string, newPassword: string): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/auth/change-password", {
    method: "POST",
    body: {
      current_password: currentPassword,
      new_password: newPassword,
    },
  });
}

export function apiForgotPassword(username: string, newPassword: string): Promise<ForgotPasswordResponse> {
  return requestJson<ForgotPasswordResponse>("/auth/forgot-password", {
    method: "POST",
    body: {
      username,
      new_password: newPassword,
    },
  });
}

export function apiResetPassword(token: string, newPassword: string): Promise<void> {
  return requestJson<void>("/auth/reset-password", {
    method: "POST",
    body: {
      token,
      new_password: newPassword,
    },
  });
}

export function apiLogout(): Promise<void> {
  return requestJson<void>("/auth/logout", {
    method: "POST",
  });
}

export function apiGetMe(): Promise<AuthMeResponse> {
  return requestJson<AuthMeResponse>("/auth/me");
}

export function apiRefreshSession(): Promise<AuthRefreshResponse> {
  return requestJson<AuthRefreshResponse>("/auth/refresh", {
    method: "POST",
  });
}

export function apiListStories(): Promise<StoriesResponse> {
  return requestJson<StoriesResponse>("/stories");
}

export function apiGetStoryDetail(storyId: string): Promise<StoryDetailResponse> {
  return requestJson<StoryDetailResponse>(`/stories/${encodeURIComponent(storyId)}`);
}

export function apiGetAdminStoryMeta(storyId: string): Promise<AdminStoryMetaResponse> {
  const normalizedStoryId = String(storyId || "").trim();
  if (!normalizedStoryId) {
    throw new ApiError(400, "story_id 不能为空");
  }
  return requestJson<AdminStoryMetaResponse>(`/admin/stories/${encodeURIComponent(normalizedStoryId)}/meta`);
}

export function apiUpdateAdminStoryMeta(
  storyId: string,
  payload: {
    book_id: string;
    description: string;
    story_overview_title: string;
    story_overview_paragraphs: string[];
  },
): Promise<AdminStoryMetaResponse> {
  const normalizedStoryId = String(storyId || "").trim();
  if (!normalizedStoryId) {
    throw new ApiError(400, "story_id 不能为空");
  }

  return requestJson<AdminStoryMetaResponse>(`/admin/stories/${encodeURIComponent(normalizedStoryId)}/meta`, {
    method: "PUT",
    body: payload,
  });
}

export function apiUpdateLevelProgress(
  levelId: string,
  payload: UpdateLevelProgressPayload,
): Promise<UpdateLevelProgressResponse> {
  return requestJson<UpdateLevelProgressResponse>(`/progress/levels/${encodeURIComponent(levelId)}`, {
    method: "PUT",
    body: payload,
  });
}


export type AdminBookChaptersQuery = {
  book_id?: number;
  book_title?: string;
  min_chars?: number;
  max_chars?: number;
  keyword?: string;
  include_used?: boolean;
  include_toc_like?: boolean;
  limit?: number;
  offset?: number;
};

export type AdminUploadBookPayload = {
  file: Blob;
  fileName?: string;
  format?: "epub" | "txt";
  title?: string;
  author?: string;
  genre?: string;
  language?: string;
  replaceBook?: boolean;
};

export type AdminGenerateStoryPayload = {
  target_date?: string;
  run_id?: string;
  chapter_id?: number;
  story_file?: string;
  dry_run?: boolean;
  story_id?: string;
  image_size?: string;
  scene_count?: number;
  candidate_scenes?: number;
  min_scenes?: number;
  max_scenes?: number;
  concurrency?: number;
  timeout_sec?: number;
  poll_seconds?: number;
  poll_attempts?: number;
  review_mode?: boolean;
};

export type AdminUsersQuery = {
  keyword?: string;
  role?: AdminManagedRole;
  limit?: number;
  offset?: number;
  page?: number;
};

export function apiListAdminBookChapters(query: AdminBookChaptersQuery = {}): Promise<AdminBookChaptersResponse> {
  const qs = buildQueryString(query);
  return requestJson<AdminBookChaptersResponse>(`/admin/book-chapters${qs}`);
}

export function apiGetAdminChapterText(chapterId: number): Promise<AdminChapterTextResponse> {
  const normalizedChapterId = Number.isFinite(chapterId) ? Math.floor(chapterId) : 0;
  if (normalizedChapterId <= 0) {
    throw new ApiError(400, "chapter_id 必须是正整数");
  }

  return requestJson<AdminChapterTextResponse>(
    `/admin/book-chapters/${encodeURIComponent(String(normalizedChapterId))}/text`,
  );
}

export async function apiUploadAdminBook(payload: AdminUploadBookPayload): Promise<AdminBookUploadResponse> {
  if (!payload || !(payload.file instanceof Blob)) {
    throw new ApiError(400, "上传文件无效");
  }

  const query = buildQueryString({
    format: payload.format,
    title: payload.title,
    author: payload.author,
    genre: payload.genre,
    language: payload.language,
    replace_book: payload.replaceBook,
  });

  const hasFileCtor = typeof File !== "undefined";
  const fallbackName = hasFileCtor && payload.file instanceof File ? payload.file.name : "book_upload.epub";
  const rawName = String(payload.fileName || fallbackName || "book_upload.epub");
  const safeFileName = rawName
    .replace(/[\\/\r\n]+/g, "_")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120)
    .trim() || "book_upload.epub";

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "x-file-name": safeFileName,
  };

  const csrfToken = readCookie(CSRF_COOKIE_NAME);
  if (csrfToken) {
    headers[CSRF_HEADER_NAME] = csrfToken;
  }

  const response = await fetch(`${API_PREFIX}/admin/books/upload${query}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: payload.file,
  });

  if (!response.ok) {
    const errorPayload = await safeParseJson(response);
    const message =
      errorPayload && typeof errorPayload === "object" && typeof (errorPayload as { message?: unknown }).message === "string"
        ? (errorPayload as { message: string }).message
        : `请求失败 (${response.status})`;
    throw new ApiError(response.status, message, errorPayload);
  }

  return (await response.json()) as AdminBookUploadResponse;
}

export function apiGetAdminBookUploadTask(runId: string): Promise<{ ok: boolean; db_path: string; task: AdminBookIngestTask }> {
  return requestJson<{ ok: boolean; db_path: string; task: AdminBookIngestTask }>(
    `/admin/books/upload/${encodeURIComponent(runId)}`,
  );
}

export function apiListAdminBookUploadTasks(limit = 10): Promise<{
  ok: boolean;
  db_path: string;
  limit: number;
  tasks: AdminBookIngestTask[];
}> {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.min(50, Math.max(1, Math.floor(limit)))
    : 10;
  const qs = buildQueryString({ limit: normalizedLimit });
  return requestJson<{
    ok: boolean;
    db_path: string;
    limit: number;
    tasks: AdminBookIngestTask[];
  }>(`/admin/books/upload${qs}`);
}

export function apiReparseAdminBook(bookId: number): Promise<{
  ok: boolean;
  run_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  book: {
    id: number;
    title: string;
    chapter_count: number;
    source_name: string;
  };
}> {
  const normalizedBookId = Number.isFinite(bookId) ? Math.floor(bookId) : 0;
  if (normalizedBookId <= 0) {
    throw new ApiError(400, "book_id 必须是正整数");
  }
  return requestJson<{
    ok: boolean;
    run_id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    book: {
      id: number;
      title: string;
      chapter_count: number;
      source_name: string;
    };
  }>(`/admin/books/${encodeURIComponent(String(normalizedBookId))}/reparse`, {
    method: "POST",
  });
}

export function apiCreateAdminBookSummaryRun(
  bookId: number,
  payload: {
    force?: boolean;
    chunk_size?: number;
    summary_max_chars?: number;
  } = {},
): Promise<{
  ok: boolean;
  run_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  book: {
    id: number;
    title: string;
    chapter_count: number;
  };
}> {
  const normalizedBookId = Number.isFinite(bookId) ? Math.floor(bookId) : 0;
  if (normalizedBookId <= 0) {
    throw new ApiError(400, "book_id 必须是正整数");
  }

  return requestJson<{
    ok: boolean;
    run_id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    book: {
      id: number;
      title: string;
      chapter_count: number;
    };
  }>(`/admin/books/${encodeURIComponent(String(normalizedBookId))}/summaries`, {
    method: "POST",
    body: payload,
  });
}

export function apiGetAdminBookSummaryTask(runId: string): Promise<{ ok: boolean; db_path: string; task: AdminBookSummaryTask }> {
  return requestJson<{ ok: boolean; db_path: string; task: AdminBookSummaryTask }>(
    `/admin/books/summaries/${encodeURIComponent(runId)}`,
  );
}

export function apiListAdminBookSummaryTasks(limit = 10): Promise<{
  ok: boolean;
  db_path: string;
  limit: number;
  tasks: AdminBookSummaryTask[];
}> {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.min(50, Math.max(1, Math.floor(limit)))
    : 10;
  const qs = buildQueryString({ limit: normalizedLimit });
  return requestJson<{
    ok: boolean;
    db_path: string;
    limit: number;
    tasks: AdminBookSummaryTask[];
  }>(`/admin/books/summaries${qs}`);
}

export function apiListAdminBookSummaryTaskItems(
  runId: string,
  limit = 200,
): Promise<{
  ok: boolean;
  run_id: string;
  limit: number;
  task: AdminBookSummaryTask;
  items: AdminBookSummaryTaskItem[];
}> {
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) {
    throw new ApiError(400, "run_id 不能为空");
  }

  const normalizedLimit = Number.isFinite(limit)
    ? Math.min(500, Math.max(1, Math.floor(limit)))
    : 200;
  const qs = buildQueryString({ limit: normalizedLimit });
  return requestJson<{
    ok: boolean;
    run_id: string;
    limit: number;
    task: AdminBookSummaryTask;
    items: AdminBookSummaryTaskItem[];
  }>(`/admin/books/summaries/${encodeURIComponent(normalizedRunId)}/items${qs}`);
}

export function apiResumeAdminBookSummaryTask(
  runId: string,
  payload: {
    force?: boolean;
    chunk_size?: number;
    summary_max_chars?: number;
  } = {},
): Promise<{
  ok: boolean;
  resumed_from_run_id: string;
  run_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  scope_type: "book" | "chapter";
  scope_id: number;
}> {
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) {
    throw new ApiError(400, "run_id 不能为空");
  }

  return requestJson<{
    ok: boolean;
    resumed_from_run_id: string;
    run_id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    scope_type: "book" | "chapter";
    scope_id: number;
  }>(`/admin/books/summaries/${encodeURIComponent(normalizedRunId)}/resume`, {
    method: "POST",
    body: payload,
  });
}

export function apiCancelAdminBookSummaryTask(
  runId: string,
  payload: {
    reason?: string;
  } = {},
): Promise<{
  ok: boolean;
  run_id: string;
  signal_sent: boolean;
  task: AdminBookSummaryTask;
  message: string;
}> {
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) {
    throw new ApiError(400, "run_id 不能为空");
  }

  return requestJson<{
    ok: boolean;
    run_id: string;
    signal_sent: boolean;
    task: AdminBookSummaryTask;
    message: string;
  }>(`/admin/books/summaries/${encodeURIComponent(normalizedRunId)}/cancel`, {
    method: "POST",
    body: payload,
  });
}

export function apiCreateAdminGenerationJob(payload: AdminGenerateStoryPayload): Promise<AdminGenerationCreateResponse> {
  return requestJson<AdminGenerationCreateResponse>("/admin/generate-story", {
    method: "POST",
    body: payload,
  });
}

export function apiListAdminGenerationJobs(limit = 50): Promise<{ jobs: AdminGenerationJob[] }> {
  const qs = buildQueryString({ limit });
  return requestJson<{ jobs: AdminGenerationJob[] }>(`/admin/generate-story${qs}`);
}

export function apiGetAdminGenerationJob(runId: string): Promise<AdminGenerationJobDetail> {
  return requestJson<AdminGenerationJobDetail>(`/admin/generate-story/${encodeURIComponent(runId)}`);
}

export function apiGetAdminGenerationReview(runId: string): Promise<AdminGenerationReviewResponse> {
  return requestJson<AdminGenerationReviewResponse>(`/admin/generation-jobs/${encodeURIComponent(runId)}/review`);
}

export function apiUpdateAdminGenerationCandidate(
  runId: string,
  sceneIndex: number,
  payload: {
    selected?: boolean;
    grid_rows?: number;
    grid_cols?: number;
  },
): Promise<{ ok: boolean; candidate?: AdminGenerationCandidate }> {
  return requestJson<{ ok: boolean; candidate?: AdminGenerationCandidate }>(
    `/admin/generation-jobs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(String(sceneIndex))}`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export function apiPublishAdminGenerationSelected(runId: string): Promise<AdminGenerationPublishResponse> {
  return requestJson<AdminGenerationPublishResponse>(`/admin/generation-jobs/${encodeURIComponent(runId)}/publish-selected`, {
    method: "POST",
  });
}

export function apiRetryAdminGenerationCandidateImage(
  runId: string,
  sceneIndex: number,
): Promise<AdminGenerationRetryImageResponse> {
  return requestJson<AdminGenerationRetryImageResponse>(
    `/admin/generation-jobs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(String(sceneIndex))}/retry-image`,
    {
      method: "POST",
    },
  );
}

export function apiListGenerationRuns(): Promise<{ runs: AdminGenerationJob[] }> {
  return requestJson<{ runs: AdminGenerationJob[] }>("/runs");
}

export function apiGetGenerationRun(runId: string): Promise<AdminGenerationRunDetailResponse> {
  return requestJson<AdminGenerationRunDetailResponse>(`/runs/${encodeURIComponent(runId)}`);
}

export function apiGenerateRunText(
  runId: string,
  payload: {
    chapter_id?: number;
    story_file?: string;
    target_date?: string;
    scene_count?: number;
    candidate_scenes?: number;
    min_scenes?: number;
    max_scenes?: number;
  },
): Promise<AdminGenerationRunMutateResponse> {
  return requestJson<AdminGenerationRunMutateResponse>(`/runs/${encodeURIComponent(runId)}/generate-text`, {
    method: "POST",
    body: payload,
  });
}

export function apiGenerateRunSceneImage(
  runId: string,
  sceneIndex: number,
  payload: {
    image_model?: string;
    image_size?: string;
    timeout_sec?: number;
    poll_seconds?: number;
    poll_attempts?: number;
  } = {},
): Promise<AdminGenerationRunMutateResponse> {
  return requestJson<AdminGenerationRunMutateResponse>(
    `/runs/${encodeURIComponent(runId)}/scenes/${encodeURIComponent(String(sceneIndex))}/generate-image`,
    {
      method: "POST",
      body: payload,
    },
  );
}

export function apiGenerateRunSceneImagesBatch(
  runId: string,
  payload: {
    scene_indexes?: number[];
    concurrency?: number;
    image_model?: string;
    image_size?: string;
    timeout_sec?: number;
    poll_seconds?: number;
    poll_attempts?: number;
  } = {},
): Promise<AdminGenerationRunMutateResponse> {
  return requestJson<AdminGenerationRunMutateResponse>(`/runs/${encodeURIComponent(runId)}/scenes/generate-images-batch`, {
    method: "POST",
    body: payload,
  });
}

export function apiUpdateRunScene(
  runId: string,
  sceneIndex: number,
  payload: {
    title?: string;
    description?: string;
    story_text?: string;
    image_prompt?: string;
    selected?: boolean;
    grid_rows?: number;
    grid_cols?: number;
    time_limit_sec?: number;
  },
): Promise<AdminGenerationRunMutateResponse> {
  return requestJson<AdminGenerationRunMutateResponse>(
    `/runs/${encodeURIComponent(runId)}/scenes/${encodeURIComponent(String(sceneIndex))}`,
    {
      method: "PATCH",
      body: payload,
    },
  );
}

export function apiDeleteRunScene(runId: string, sceneIndex: number): Promise<AdminGenerationRunMutateResponse> {
  return requestJson<AdminGenerationRunMutateResponse>(
    `/runs/${encodeURIComponent(runId)}/scenes/${encodeURIComponent(String(sceneIndex))}`,
    {
      method: "DELETE",
    },
  );
}

export function apiPublishRun(runId: string): Promise<AdminGenerationRunMutateResponse> {
  return requestJson<AdminGenerationRunMutateResponse>(`/runs/${encodeURIComponent(runId)}/publish`, {
    method: "POST",
  });
}

export function apiCancelRun(runId: string, reason = "cancelled by admin"): Promise<AdminGenerationRunMutateResponse> {
  return requestJson<AdminGenerationRunMutateResponse>(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: { reason },
  });
}

export function apiDeleteRun(
  runId: string,
  payload: {
    force?: boolean;
    allow_published?: boolean;
    purge_files?: boolean;
  } = {},
): Promise<{ ok: boolean; run_id: string; removed_files: string[] }> {
  return requestJson<{ ok: boolean; run_id: string; removed_files: string[] }>(`/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
    body: payload,
  });
}

export function apiListAdminUsers(query: AdminUsersQuery = {}): Promise<AdminUsersResponse> {
  const qs = buildQueryString(query);
  return requestJson<AdminUsersResponse>(`/admin/users${qs}`);
}

export function apiGrantAdminUserRole(
  userId: number,
  role: AdminManagedRole,
  note?: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/admin/users/${encodeURIComponent(String(userId))}/roles`, {
    method: "POST",
    body: {
      role,
      note,
    },
  });
}

export function apiRevokeAdminUserRole(userId: number, role: AdminManagedRole): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/admin/users/${encodeURIComponent(String(userId))}/roles/${encodeURIComponent(role)}`, {
    method: "DELETE",
  });
}

export function apiApproveAdminUserPasswordReset(userId: number, note?: string): Promise<{ ok: boolean; request_id: number }> {
  return requestJson<{ ok: boolean; request_id: number }>(`/admin/users/${encodeURIComponent(String(userId))}/password-reset/approve`, {
    method: "POST",
    body: {
      note,
    },
  });
}

export function apiGetAdminLevelConfig(storyId: string, levelId: string): Promise<AdminLevelConfigResponse> {
  return requestJson<AdminLevelConfigResponse>(
    `/admin/stories/${encodeURIComponent(storyId)}/levels/${encodeURIComponent(levelId)}/config`,
  );
}

export function apiUpdateAdminLevelConfig(
  storyId: string,
  levelId: string,
  payload: AdminLevelConfigPatch,
): Promise<AdminLevelConfigResponse> {
  return requestJson<AdminLevelConfigResponse>(
    `/admin/stories/${encodeURIComponent(storyId)}/levels/${encodeURIComponent(levelId)}/config`,
    {
      method: "PUT",
      body: payload,
    },
  );
}

export function apiPreviewAdminLevelConfig(
  storyId: string,
  levelId: string,
  payload: AdminLevelConfigPatch,
): Promise<AdminLevelConfigResponse> {
  return requestJson<AdminLevelConfigResponse>(
    `/admin/stories/${encodeURIComponent(storyId)}/levels/${encodeURIComponent(levelId)}/preview`,
    {
      method: "POST",
      body: payload,
    },
  );
}

export function apiRunAdminLevelTest(
  storyId: string,
  levelId: string,
  payload: AdminLevelConfigPatch,
): Promise<AdminLevelTestRunResponse> {
  return requestJson<AdminLevelTestRunResponse>(
    `/admin/stories/${encodeURIComponent(storyId)}/levels/${encodeURIComponent(levelId)}/test-run`,
    {
      method: "POST",
      body: payload,
    },
  );
}

export function apiListAdminLlmProviders(): Promise<AdminLlmProvidersResponse> {
  return requestJson<AdminLlmProvidersResponse>("/admin/llm/providers");
}

export function apiCreateAdminLlmProvider(payload: AdminLlmProviderPatch): Promise<AdminLlmProviderResponse> {
  return requestJson<AdminLlmProviderResponse>("/admin/llm/providers", {
    method: "POST",
    body: payload,
  });
}

export function apiGetAdminLlmProvider(providerId: number): Promise<AdminLlmProviderResponse> {
  return requestJson<AdminLlmProviderResponse>(`/admin/llm/providers/${encodeURIComponent(String(providerId))}`);
}

export function apiUpdateAdminLlmProvider(providerId: number, payload: AdminLlmProviderPatch): Promise<AdminLlmProviderResponse> {
  return requestJson<AdminLlmProviderResponse>(`/admin/llm/providers/${encodeURIComponent(String(providerId))}`, {
    method: "PUT",
    body: payload,
  });
}

export function apiDeleteAdminLlmProvider(providerId: number): Promise<AdminLlmProviderDeleteResponse> {
  return requestJson<AdminLlmProviderDeleteResponse>(`/admin/llm/providers/${encodeURIComponent(String(providerId))}`, {
    method: "DELETE",
  });
}

export function apiUpdateAdminLlmProviderKey(providerId: number, payload: AdminLlmProviderKeyPatch): Promise<AdminLlmProviderResponse> {
  return requestJson<AdminLlmProviderResponse>(`/admin/llm/providers/${encodeURIComponent(String(providerId))}/key`, {
    method: "PUT",
    body: payload,
  });
}

export function apiListAdminLlmProviderModels(providerId: number): Promise<AdminLlmProviderModelsResponse> {
  return requestJson<AdminLlmProviderModelsResponse>(`/admin/llm/providers/${encodeURIComponent(String(providerId))}/models`);
}

export function apiFetchAdminLlmProviderModels(
  providerId: number,
  payload: AdminLlmRuntimeOverridesPatch = {},
): Promise<AdminLlmModelsFetchResponse> {
  return requestJson<AdminLlmModelsFetchResponse>(`/admin/llm/providers/${encodeURIComponent(String(providerId))}/models/fetch`, {
    method: "POST",
    body: payload,
  });
}

export function apiTestAdminLlmProvider(
  providerId: number,
  payload: AdminLlmRuntimeOverridesPatch = {},
): Promise<AdminLlmConnectionTestResponse> {
  return requestJson<AdminLlmConnectionTestResponse>(`/admin/llm/providers/${encodeURIComponent(String(providerId))}/test`, {
    method: "POST",
    body: payload,
  });
}

export function apiListAdminLlmEnvKeys(): Promise<AdminLlmEnvKeysResponse> {
  return requestJson<AdminLlmEnvKeysResponse>("/admin/llm/env-keys");
}

export function apiGetAdminLlmGlobalProfile(): Promise<AdminLlmProfileResponse> {
  return requestJson<AdminLlmProfileResponse>("/admin/llm/global/profile");
}

export function apiUpdateAdminLlmGlobalProfile(payload: AdminLlmProfilePatch): Promise<AdminLlmProfileResponse> {
  return requestJson<AdminLlmProfileResponse>("/admin/llm/global/profile", {
    method: "PUT",
    body: payload,
  });
}

export function apiGetAdminLlmUserProfile(userId: number): Promise<AdminLlmProfileResponse> {
  return requestJson<AdminLlmProfileResponse>(`/admin/llm/users/${encodeURIComponent(String(userId))}/profile`);
}

export function apiUpdateAdminLlmUserProfile(userId: number, payload: AdminLlmProfilePatch): Promise<AdminLlmProfileResponse> {
  return requestJson<AdminLlmProfileResponse>(`/admin/llm/users/${encodeURIComponent(String(userId))}/profile`, {
    method: "PUT",
    body: payload,
  });
}

export { ApiError };
