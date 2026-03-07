import { useCallback, useState } from "react";

import {
  AdminBookInfo,
  AdminChapterSummary,
  AdminGenerationJob,
  AdminGenerationJobDetail,
  AdminGenerationScene,
  AdminGenerationSceneCounts,
  AdminUserSummary,
} from "../core/types";
import { apiCancelRun, apiDeleteRun } from "../core/api";

type PuzzleFlowStep = "select" | "generate" | "review";

type AdminSectionKey = "users" | "levelConfig" | "puzzle";

type ScenePreviewState = {
  run_id: string;
  scene_index: number;
  title: string;
  image_url: string;
  image_prompt: string;
};

type PublishSuccessState = {
  run_id: string;
  story_id: string;
  level_count: number;
};

export function useAdminUserPermissionState() {
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userKeyword, setUserKeyword] = useState("");
  const [roleSubmittingKey, setRoleSubmittingKey] = useState("");

  return {
    adminUsers,
    loadingUsers,
    roleSubmittingKey,
    setAdminUsers,
    setLoadingUsers,
    setRoleSubmittingKey,
    setUserKeyword,
    userKeyword,
  };
}

export function useAdminChapterSelectionState(options: {
  defaultMinChars: number;
  defaultMaxChars: number;
  defaultSceneCount: number;
  defaultChapterPageSize: number;
  chapterPageSizeOptions: readonly number[];
  chapterPageSizeStorageKey: string;
}) {
  const {
    chapterPageSizeOptions,
    chapterPageSizeStorageKey,
    defaultChapterPageSize,
    defaultMaxChars,
    defaultMinChars,
    defaultSceneCount,
  } = options;

  const [books, setBooks] = useState<AdminBookInfo[]>([]);
  const [chapters, setChapters] = useState<AdminChapterSummary[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [bookId, setBookId] = useState<string>("");
  const [keyword, setKeyword] = useState("");
  const [minCharsInput, setMinCharsInput] = useState(String(defaultMinChars));
  const [maxCharsInput, setMaxCharsInput] = useState(String(defaultMaxChars));
  const [includeUsed, setIncludeUsed] = useState(true);

  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null);
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sceneCountInput, setSceneCountInput] = useState(String(defaultSceneCount));
  const [chapterPage, setChapterPage] = useState(1);
  const [chapterPageSize, setChapterPageSize] = useState<number>(() => {
    if (typeof window === "undefined") {
      return defaultChapterPageSize;
    }

    const savedValue = Number(window.localStorage.getItem(chapterPageSizeStorageKey));
    return chapterPageSizeOptions.includes(savedValue)
      ? savedValue
      : defaultChapterPageSize;
  });
  const [chapterTotal, setChapterTotal] = useState(0);

  return {
    bookId,
    books,
    chapterPage,
    chapterPageSize,
    chapterTotal,
    chapters,
    includeUsed,
    keyword,
    loadingChapters,
    maxCharsInput,
    minCharsInput,
    sceneCountInput,
    selectedChapterId,
    setBookId,
    setBooks,
    setChapterPage,
    setChapterPageSize,
    setChapterTotal,
    setChapters,
    setIncludeUsed,
    setKeyword,
    setLoadingChapters,
    setMaxCharsInput,
    setMinCharsInput,
    setSceneCountInput,
    setSelectedChapterId,
    setSubmitting,
    setTargetDate,
    submitting,
    targetDate,
  };
}

export function useAdminRunReviewState(defaultSceneCounts: () => AdminGenerationSceneCounts) {
  const [recentJobs, setRecentJobs] = useState<AdminGenerationJob[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [activeJob, setActiveJob] = useState<AdminGenerationJobDetail | null>(null);
  const [reviewRunId, setReviewRunId] = useState("");
  const [reviewScenes, setReviewScenes] = useState<AdminGenerationScene[]>([]);
  const [reviewCounts, setReviewCounts] = useState<AdminGenerationSceneCounts>(defaultSceneCounts);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewPublishing, setReviewPublishing] = useState(false);
  const [reviewBatchGenerating, setReviewBatchGenerating] = useState(false);
  const [reviewUpdatingSceneIndex, setReviewUpdatingSceneIndex] = useState<number | null>(null);
  const [reviewRetryingSceneIndex, setReviewRetryingSceneIndex] = useState<number | null>(null);
  const [reviewDeletingSceneIndex, setReviewDeletingSceneIndex] = useState<number | null>(null);
  const [runCancellingId, setRunCancellingId] = useState("");
  const [runDeletingId, setRunDeletingId] = useState("");
  const [puzzleFlowStep, setPuzzleFlowStep] = useState<PuzzleFlowStep>("select");
  const [collapsedSections, setCollapsedSections] = useState<Record<AdminSectionKey, boolean>>({
    users: true,
    levelConfig: true,
    puzzle: true,
  });

  return {
    activeJob,
    activeRunId,
    collapsedSections,
    puzzleFlowStep,
    recentJobs,
    reviewBatchGenerating,
    reviewCounts,
    reviewDeletingSceneIndex,
    reviewLoading,
    reviewPublishing,
    reviewRetryingSceneIndex,
    reviewRunId,
    reviewScenes,
    reviewUpdatingSceneIndex,
    runCancellingId,
    runDeletingId,
    setActiveJob,
    setActiveRunId,
    setCollapsedSections,
    setPuzzleFlowStep,
    setRecentJobs,
    setReviewBatchGenerating,
    setReviewCounts,
    setReviewDeletingSceneIndex,
    setReviewLoading,
    setReviewPublishing,
    setReviewRetryingSceneIndex,
    setReviewRunId,
    setReviewScenes,
    setReviewUpdatingSceneIndex,
    setRunCancellingId,
    setRunDeletingId,
  };
}

type UseAdminRunJobActionsOptions = {
  activeRunId: string;
  recentJobs: AdminGenerationJob[];
  reviewRunId: string;
  defaultSceneCounts: () => AdminGenerationSceneCounts;
  loadGenerationReview: (runId: string) => Promise<void>;
  loadRecentJobs: () => Promise<void>;
  setActiveJob: (job: AdminGenerationJobDetail | null) => void;
  setActiveRunId: (runId: string) => void;
  setCollapsedSections: (
    updater: (prev: Record<AdminSectionKey, boolean>) => Record<AdminSectionKey, boolean>,
  ) => void;
  setPanelError: (message: string) => void;
  setPanelInfo: (message: string) => void;
  setPuzzleFlowStep: (step: PuzzleFlowStep) => void;
  setReviewCounts: (counts: AdminGenerationSceneCounts) => void;
  setReviewRunId: (runId: string) => void;
  setReviewScenes: (scenes: AdminGenerationScene[]) => void;
  setRunCancellingId: (runId: string) => void;
  setRunDeletingId: (runId: string) => void;
  setShowGenerateDialog: (visible: boolean) => void;
  toErrorMessage: (err: unknown) => string;
};

export function useAdminRunJobActions({
  activeRunId,
  recentJobs,
  reviewRunId,
  defaultSceneCounts,
  loadGenerationReview,
  loadRecentJobs,
  setActiveJob,
  setActiveRunId,
  setCollapsedSections,
  setPanelError,
  setPanelInfo,
  setPuzzleFlowStep,
  setReviewCounts,
  setReviewRunId,
  setReviewScenes,
  setRunCancellingId,
  setRunDeletingId,
  setShowGenerateDialog,
  toErrorMessage,
}: UseAdminRunJobActionsOptions) {
  const handleOpenReview = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    setPanelError("");
    setPanelInfo(`加载审核数据：${targetRunId}`);
    setShowGenerateDialog(false);
    setActiveRunId("");
    setActiveJob(null);
    setPuzzleFlowStep("review");
    setCollapsedSections((prev) => ({
      ...prev,
      puzzle: false,
    }));
    await loadGenerationReview(targetRunId);
  }, [
    loadGenerationReview,
    setActiveJob,
    setActiveRunId,
    setCollapsedSections,
    setPanelError,
    setPanelInfo,
    setPuzzleFlowStep,
    setShowGenerateDialog,
  ]);

  const handleCancelRun = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    const confirmed = window.confirm(`确认取消任务 ${targetRunId} 吗？`);
    if (!confirmed) {
      return;
    }

    setRunCancellingId(targetRunId);
    setPanelError("");
    try {
      await apiCancelRun(targetRunId, "cancelled by admin from panel");
      setPanelInfo(`任务已取消：${targetRunId}`);

      if (activeRunId === targetRunId) {
        setActiveRunId("");
        setActiveJob(null);
      }

      if (reviewRunId === targetRunId) {
        await loadGenerationReview(targetRunId);
      }

      await loadRecentJobs();
    } catch (err) {
      setPanelError(toErrorMessage(err));
    } finally {
      setRunCancellingId("");
    }
  }, [
    activeRunId,
    loadGenerationReview,
    loadRecentJobs,
    reviewRunId,
    setActiveJob,
    setActiveRunId,
    setPanelError,
    setPanelInfo,
    setRunCancellingId,
    toErrorMessage,
  ]);

  const handleDeleteRun = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    const targetJob = recentJobs.find((item) => item.run_id === targetRunId) || null;
    const force = targetJob?.status === "running";
    const confirmed = window.confirm(
      force
        ? `任务 ${targetRunId} 仍在运行，确认强制删除吗？`
        : `确认删除任务 ${targetRunId} 吗？`,
    );
    if (!confirmed) {
      return;
    }

    setRunDeletingId(targetRunId);
    setPanelError("");
    try {
      await apiDeleteRun(targetRunId, {
        force,
      });
      setPanelInfo(`任务已删除：${targetRunId}`);

      if (activeRunId === targetRunId) {
        setActiveRunId("");
        setActiveJob(null);
      }

      if (reviewRunId === targetRunId) {
        setReviewRunId("");
        setReviewScenes([]);
        setReviewCounts(defaultSceneCounts());
      }

      await loadRecentJobs();
    } catch (err) {
      setPanelError(toErrorMessage(err));
    } finally {
      setRunDeletingId("");
    }
  }, [
    activeRunId,
    defaultSceneCounts,
    loadRecentJobs,
    recentJobs,
    reviewRunId,
    setActiveJob,
    setActiveRunId,
    setPanelError,
    setPanelInfo,
    setReviewCounts,
    setReviewRunId,
    setReviewScenes,
    setRunDeletingId,
    toErrorMessage,
  ]);

  return {
    handleCancelRun,
    handleDeleteRun,
    handleOpenReview,
  };
}

export function useAdminPublishState() {
  const [scenePreview, setScenePreview] = useState<ScenePreviewState | null>(null);
  const [publishSuccess, setPublishSuccess] = useState<PublishSuccessState | null>(null);

  return {
    publishSuccess,
    scenePreview,
    setPublishSuccess,
    setScenePreview,
  };
}
