import { ApiError } from "../../core/api";
import {
  AdminGenerationJob,
  AdminGenerationJobDetail,
  AdminGenerationSceneCounts,
  AdminLevelConfigPatch,
  AdminLevelConfigResponse,
  AdminLevelDifficulty,
} from "../../core/types";

export type JobProgress = {
  value: number;
  completed: number;
  total: number;
  message: string;
};

export type LevelConfigFormState = {
  enabled: boolean;
  grid_rows: string;
  grid_cols: string;
  time_limit_sec: string;
  difficulty: "" | AdminLevelDifficulty;
  difficulty_factor: string;
  content_version: string;
};

export function compactText(value: unknown, limit = 160): string {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function normalizeReviewStatus(value: unknown): "" | "pending_review" | "published" {
  const text = String(value || "").trim().toLowerCase();
  if (text === "pending_review" || text === "published") {
    return text;
  }
  return "";
}

export function normalizeFlowStage(value: unknown): "" | "text_generating" | "text_ready" | "images_generating" | "review_ready" | "published" | "failed" {
  const text = String(value || "").trim().toLowerCase();
  if (
    text === "text_generating"
    || text === "text_ready"
    || text === "images_generating"
    || text === "review_ready"
    || text === "published"
    || text === "failed"
  ) {
    return text;
  }
  return "";
}

export function isReviewListJob(job: AdminGenerationJob): boolean {
  const flowStage = normalizeFlowStage(job.flow_stage);
  const reviewStatus = normalizeReviewStatus(job.review_status);
  if (reviewStatus === "published" || flowStage === "published") {
    return true;
  }
  if (job.status === "succeeded" && flowStage === "review_ready") {
    return true;
  }
  return flowStage === "review_ready" || flowStage === "images_generating" || flowStage === "failed";
}

export function generationJobStateClass(job: AdminGenerationJob): "todo" | "running" | "done" {
  const flowStage = normalizeFlowStage(job.flow_stage);
  const reviewStatus = normalizeReviewStatus(job.review_status);

  if (reviewStatus === "published" || flowStage === "published") {
    return "done";
  }

  if (job.status === "failed" || job.status === "cancelled" || flowStage === "failed") {
    return "todo";
  }

  if (job.status === "succeeded" || flowStage === "review_ready") {
    return "running";
  }

  return "running";
}

export function formatGenerationJobStateLabel(job: AdminGenerationJob): string {
  const flowStage = normalizeFlowStage(job.flow_stage);
  const reviewStatus = normalizeReviewStatus(job.review_status);

  if (reviewStatus === "published" || flowStage === "published") {
    return "已发布";
  }

  if (job.status === "queued") {
    return "排队中";
  }

  if (job.status === "running" || flowStage === "text_generating" || flowStage === "images_generating") {
    return flowStage === "images_generating" ? "出图中" : "文案生成中";
  }

  if (flowStage === "review_ready" || reviewStatus === "pending_review") {
    return "待审核";
  }

  if (job.status === "succeeded") {
    return "已完成";
  }

  if (job.status === "cancelled") {
    return "已取消";
  }

  if (job.status === "failed" || flowStage === "failed") {
    return "失败";
  }

  return String(job.status || "未知");
}

export function extractJobProgress(job: AdminGenerationJobDetail | null): JobProgress {
  if (!job) {
    return { value: 0, completed: 0, total: 1, message: "暂无任务" };
  }

  if (job.status === "queued") {
    return { value: 0, completed: 0, total: 1, message: "排队中" };
  }

  if (job.status === "succeeded") {
    const total = Number((job.summary?.total_scenes as number | undefined) || 1);
    const generated = Number((job.summary?.generated_scenes as number | undefined) || total);
    return { value: 1, completed: generated, total, message: "已完成" };
  }

  const events = Array.isArray(job.events) ? job.events : [];
  const sceneEvents = events.filter((item) => item?.event === "images.scene.completed");
  const latest = sceneEvents.length > 0 ? sceneEvents[sceneEvents.length - 1] : null;

  if (latest) {
    const total = Number(latest.total || 1);
    const completed = Number(latest.completed || 0);
    const rawProgress = Number(latest.progress || (total > 0 ? completed / total : 0));
    return {
      value: Number.isFinite(rawProgress) ? rawProgress : 0,
      completed,
      total,
      message: `正在生成分镜：${latest.scene_title || latest.scene_id || "scene"}`,
    };
  }

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  return {
    value: job.status === "running" ? 0.05 : 0,
    completed: 0,
    total: 1,
    message: String(lastEvent?.event || "处理中"),
  };
}

export function pickStoryId(detail: AdminGenerationJobDetail): string {
  const summaryStoryId = detail.summary && typeof detail.summary.story_id === "string" ? detail.summary.story_id : "";
  if (summaryStoryId) {
    return summaryStoryId;
  }

  if (detail.payload && typeof detail.payload === "object") {
    const payloadStoryId = (detail.payload as Record<string, unknown>).story_id;
    if (typeof payloadStoryId === "string" && payloadStoryId.trim()) {
      return payloadStoryId.trim();
    }
  }

  return "";
}

export function defaultSceneCounts(): AdminGenerationSceneCounts {
  return {
    total: 0,
    text_ready: 0,
    text_failed: 0,
    images_success: 0,
    images_failed: 0,
    images_pending: 0,
    images_running: 0,
    selected: 0,
    ready_for_publish: 0,
    deleted: 0,
  };
}

export function createClientRunId(): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const randomPart = Math.random().toString(16).slice(2, 10);
  return `admin_${stamp}_${randomPart}`;
}

export function defaultLevelConfigForm(): LevelConfigFormState {
  return {
    enabled: true,
    grid_rows: "",
    grid_cols: "",
    time_limit_sec: "",
    difficulty: "",
    difficulty_factor: "",
    content_version: "",
  };
}

export function formFromLevelConfig(snapshot: AdminLevelConfigResponse): LevelConfigFormState {
  const override = snapshot.override_config;
  if (!override) {
    return defaultLevelConfigForm();
  }

  return {
    enabled: Boolean(override.enabled),
    grid_rows: override.grid_rows === null ? "" : String(override.grid_rows),
    grid_cols: override.grid_cols === null ? "" : String(override.grid_cols),
    time_limit_sec: override.time_limit_sec === null ? "" : String(override.time_limit_sec),
    difficulty: override.difficulty || "",
    difficulty_factor: override.difficulty_factor === null ? "" : String(override.difficulty_factor),
    content_version: override.content_version === null ? "" : String(override.content_version),
  };
}

export function buildLevelConfigPatch(form: LevelConfigFormState): { ok: true; patch: AdminLevelConfigPatch } | { ok: false; message: string } {
  const parseNullableInteger = (
    rawValue: string,
    fieldName: string,
    min: number,
    max: number,
  ): number | null => {
    const text = rawValue.trim();
    if (!text) {
      return null;
    }

    const parsed = Number(text);
    if (!Number.isInteger(parsed)) {
      throw new Error(`${fieldName} 必须是整数`);
    }
    if (parsed < min || parsed > max) {
      throw new Error(`${fieldName} 必须在 ${min}-${max} 之间`);
    }
    return parsed;
  };

  const parseNullableNumber = (
    rawValue: string,
    fieldName: string,
    min: number,
    max: number,
  ): number | null => {
    const text = rawValue.trim();
    if (!text) {
      return null;
    }

    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${fieldName} 必须是数字`);
    }
    if (parsed <= min || parsed > max) {
      throw new Error(`${fieldName} 必须在 (${min}, ${max}]`);
    }
    return parsed;
  };

  try {
    const patch: AdminLevelConfigPatch = {
      enabled: form.enabled,
      grid_rows: parseNullableInteger(form.grid_rows, "grid_rows", 2, 20),
      grid_cols: parseNullableInteger(form.grid_cols, "grid_cols", 2, 20),
      time_limit_sec: parseNullableInteger(form.time_limit_sec, "time_limit_sec", 30, 3600),
      difficulty: form.difficulty || null,
      difficulty_factor: parseNullableNumber(form.difficulty_factor, "difficulty_factor", 0, 5),
      content_version: parseNullableInteger(form.content_version, "content_version", 1, 999999),
    };

    return { ok: true, patch };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error),
    };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error) {
    const message = String(err.message || "").trim();
    if (/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) {
      return "网络请求失败：请检查后端服务、反向代理和当前浏览器网络连接";
    }
    return err.message;
  }
  return "请求失败";
}

export function formatTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace("T", " ").replace("Z", "");
}

export function formatDurationMs(value: number | null | undefined): string {
  if (!value || value <= 0) {
    return "-";
  }

  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const centiseconds = Math.floor((value % 1000) / 10)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}.${centiseconds}`;
}
