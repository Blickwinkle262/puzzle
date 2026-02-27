import {
  LevelProgress,
  StoryDetail,
  StoryListItem,
  UserProfile,
} from "./types";

const API_PREFIX = "/api";
const CSRF_COOKIE_NAME = "puzzle_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export type AuthResponse = {
  user: UserProfile;
};

export type AuthMeResponse = {
  user: UserProfile;
};

export type AuthRefreshResponse = {
  user: UserProfile;
  refreshed_at: string;
};

export type ForgotPasswordResponse = {
  message: string;
  reset_token?: string;
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

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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

    throw new ApiError(response.status, message);
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

export function apiForgotPassword(username: string): Promise<ForgotPasswordResponse> {
  return requestJson<ForgotPasswordResponse>("/auth/forgot-password", {
    method: "POST",
    body: { username },
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

export function apiUpdateLevelProgress(
  levelId: string,
  payload: UpdateLevelProgressPayload,
): Promise<UpdateLevelProgressResponse> {
  return requestJson<UpdateLevelProgressResponse>(`/progress/levels/${encodeURIComponent(levelId)}`, {
    method: "PUT",
    body: payload,
  });
}

export { ApiError };
