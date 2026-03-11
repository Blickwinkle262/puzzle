import { useCallback, useEffect, useMemo, useState } from "react";

import { apiListAdminBookChapters } from "../core/adminApi";
import {
  AdminLevelDifficulty,
  AdminManagedRole,
} from "../core/types";
import {
  useAdminChapterSelectionState,
  useAdminPublishState,
  useAdminRunReviewState,
  useAdminUserPermissionState,
} from "./useAdminStoryGeneratorSections";
import { AdminSectionKey, PuzzleFlowStep } from "./admin-story-generator/shared";
import {
  defaultSceneCounts,
  errorMessage,
  extractJobProgress,
  isReviewListJob,
  normalizeFlowStage,
  normalizeReviewStatus,
} from "../components/admin-story-generator/utils";
import { useAdminUsersCoordinator } from "./admin-story-generator/useAdminUsersCoordinator";
import { useAdminLevelConfigCoordinator } from "./admin-story-generator/useAdminLevelConfigCoordinator";
import { useAdminPuzzleFlowCoordinator } from "./admin-story-generator/useAdminPuzzleFlowCoordinator";
import { useAdminPuzzleActionsCoordinator } from "./admin-story-generator/useAdminPuzzleActionsCoordinator";

type AdminStoryGeneratorCoordinatorOptions = {
  visible: boolean;
  onClose: () => void;
  onGenerated: (storyId: string) => Promise<void> | void;
  onOpenStory: (storyId: string) => Promise<void> | void;
};

export const PUZZLE_FLOW_SEQUENCE: PuzzleFlowStep[] = ["select", "generate", "review"];

export const DEFAULT_MIN_CHARS = 500;
export const DEFAULT_MAX_CHARS = 2200;
export const DEFAULT_SCENE_COUNT = 12;
export const MIN_SCENE_COUNT = 6;
export const DEFAULT_CHAPTER_PAGE_SIZE = 10;
export const CHAPTER_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
export const CHAPTER_PAGE_SIZE_STORAGE_KEY = "admin_story_generator.chapter_page_size";
export const MANAGED_ROLES: AdminManagedRole[] = ["admin", "editor", "level_designer", "operator"];
export const MANAGED_LEVEL_DIFFICULTIES: AdminLevelDifficulty[] = ["easy", "normal", "hard", "nightmare"];
export const REVIEW_GRID_OPTIONS = Array.from({ length: 19 }, (_, index) => index + 2);
export const REVIEW_TIME_OPTIONS = [60, 90, 120, 150, 180, 240, 300, 420, 600];

export function useAdminStoryGeneratorCoordinator({
  visible,
  onClose,
  onGenerated,
  onOpenStory,
}: AdminStoryGeneratorCoordinatorOptions) {
  const {
    adminUsers,
    loadingUsers,
    passwordResetSubmittingUserId,
    roleSubmittingKey,
    setAdminUsers,
    setLoadingUsers,
    setPasswordResetSubmittingUserId,
    setRoleSubmittingKey,
    setUserKeyword,
    userKeyword,
  } = useAdminUserPermissionState();

  const {
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
  } = useAdminChapterSelectionState({
    defaultMinChars: DEFAULT_MIN_CHARS,
    defaultMaxChars: DEFAULT_MAX_CHARS,
    defaultSceneCount: DEFAULT_SCENE_COUNT,
    defaultChapterPageSize: DEFAULT_CHAPTER_PAGE_SIZE,
    chapterPageSizeOptions: CHAPTER_PAGE_SIZE_OPTIONS,
    chapterPageSizeStorageKey: CHAPTER_PAGE_SIZE_STORAGE_KEY,
  });

  const {
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
  } = useAdminRunReviewState(defaultSceneCounts);

  const {
    publishSuccess,
    scenePreview,
    setPublishSuccess,
    setScenePreview,
  } = useAdminPublishState();

  const [panelError, setPanelError] = useState("");
  const [panelInfo, setPanelInfo] = useState("");
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);

  const {
    configLevelId,
    configLevels,
    configPreviewing,
    configSaving,
    configStories,
    configStoryId,
    configTesting,
    handleConfigFormChange,
    handlePreviewLevelConfig,
    handleSaveLevelConfig,
    handleTestLevelConfig,
    levelConfigForm,
    levelConfigSnapshot,
    loadConfigStories,
    loadLevelConfig,
    loadingConfigCatalog,
    loadingLevelConfig,
    setConfigLevelId,
    setConfigStoryId,
    setLevelConfigSnapshot,
    setTestRunResult,
    testRunResult,
  } = useAdminLevelConfigCoordinator({
    visible,
    setPanelError,
    setPanelInfo,
  });

  const {
    handleApprovePasswordReset,
    handleRoleToggle,
    loadAdminUsers,
  } = useAdminUsersCoordinator({
    userKeyword,
    setAdminUsers,
    setLoadingUsers,
    setPasswordResetSubmittingUserId,
    setRoleSubmittingKey,
    setPanelError,
    setPanelInfo,
  });

  const selectedChapter = useMemo(
    () => chapters.find((item) => item.id === selectedChapterId) || null,
    [chapters, selectedChapterId],
  );

  const progress = useMemo(() => extractJobProgress(activeJob), [activeJob]);
  const totalChapterPages = useMemo(() => {
    const pages = Math.ceil(chapterTotal / chapterPageSize);
    return pages > 0 ? pages : 1;
  }, [chapterPageSize, chapterTotal]);
  const resumableJob = useMemo(
    () => recentJobs.find((job) => job.status === "running" || job.status === "queued") || null,
    [recentJobs],
  );
  const hasReviewJobs = useMemo(
    () => recentJobs.some((job) => isReviewListJob(job)),
    [recentJobs],
  );
  const reviewReadyCount = useMemo(() => Number(reviewCounts.ready_for_publish || 0), [reviewCounts.ready_for_publish]);
  const reviewPendingImageCount = useMemo(
    () => Number(reviewCounts.images_pending || 0) + Number(reviewCounts.images_running || 0),
    [reviewCounts.images_pending, reviewCounts.images_running],
  );
  const reviewStatus = normalizeReviewStatus(activeJob?.review_status);
  const reviewLocked = reviewStatus === "published" || normalizeFlowStage(activeJob?.flow_stage) === "published";

  const toggleSection = useCallback((key: AdminSectionKey): void => {
    setCollapsedSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, [setCollapsedSections]);

  const loadChapters = useCallback(async (): Promise<void> => {
    setLoadingChapters(true);
    setPanelError("");

    const parsedMinChars = Number(minCharsInput);
    const parsedMaxChars = Number(maxCharsInput);

    try {
      const response = await apiListAdminBookChapters({
        book_id: bookId ? Number(bookId) : undefined,
        keyword: keyword.trim() || undefined,
        min_chars: Number.isFinite(parsedMinChars) && parsedMinChars > 0 ? parsedMinChars : undefined,
        max_chars: Number.isFinite(parsedMaxChars) && parsedMaxChars > 0 ? parsedMaxChars : undefined,
        include_used: includeUsed,
        limit: chapterPageSize,
        offset: (chapterPage - 1) * chapterPageSize,
      });

      setBooks(response.books || []);
      setChapters(response.chapters || []);
      setChapterTotal(Number(response.total || 0));

      if (response.chapters.length === 0) {
        setSelectedChapterId(null);
      } else if (!response.chapters.some((item) => item.id === selectedChapterId)) {
        setSelectedChapterId(response.chapters[0].id);
      }
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingChapters(false);
    }
  }, [
    bookId,
    chapterPage,
    chapterPageSize,
    includeUsed,
    keyword,
    maxCharsInput,
    minCharsInput,
    selectedChapterId,
    setBooks,
    setChapterTotal,
    setChapters,
    setLoadingChapters,
    setSelectedChapterId,
  ]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    setChapterPage(1);
  }, [bookId, chapterPageSize, includeUsed, keyword, maxCharsInput, minCharsInput, setChapterPage, visible]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(CHAPTER_PAGE_SIZE_STORAGE_KEY, String(chapterPageSize));
  }, [chapterPageSize]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadChapters();
  }, [loadChapters, visible]);

  const {
    handleCancelRun,
    handleDeleteRun,
    handleOpenReview,
    handleViewJobProgress,
    loadGenerationReview,
    loadRecentJobs,
  } = useAdminPuzzleFlowCoordinator({
    activeRunId,
    onGenerated,
    recentJobs,
    reviewRunId,
    setRecentJobs,
    setActiveJob,
    setActiveRunId,
    setCollapsedSections,
    setPanelError,
    setPanelInfo,
    setPuzzleFlowStep,
    setReviewCounts,
    setReviewLoading,
    setReviewRunId,
    setReviewScenes,
    setRunCancellingId,
    setRunDeletingId,
    setShowGenerateDialog,
    toErrorMessage: errorMessage,
    visible,
  });

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadRecentJobs();
    void loadAdminUsers();
    void loadConfigStories();
  }, [loadAdminUsers, loadConfigStories, loadRecentJobs, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    if (activeRunId && puzzleFlowStep === "select") {
      setPuzzleFlowStep("generate");
    }
  }, [activeRunId, puzzleFlowStep, setPuzzleFlowStep, visible]);

  const {
    handleBatchGenerateImages,
    handleDeleteReviewScene,
    handleOpenGeneratedStory,
    handleOpenPublishedStory,
    handlePublishSelected,
    handleRetryReviewCandidate,
    handleStayAfterPublish,
    handleSubmit,
    handleUpdateReviewScene,
  } = useAdminPuzzleActionsCoordinator({
    onClose,
    onGenerated,
    onOpenStory,
    publishSuccess,
    reviewLocked,
    reviewRunId,
    reviewScenes,
    sceneCountInput,
    selectedChapter,
    selectedChapterId,
    targetDate,
    loadGenerationReview,
    loadRecentJobs,
    setActiveJob,
    setActiveRunId,
    setPanelError,
    setPanelInfo,
    setPublishSuccess,
    setPuzzleFlowStep,
    setReviewBatchGenerating,
    setReviewCounts,
    setReviewDeletingSceneIndex,
    setReviewPublishing,
    setReviewRetryingSceneIndex,
    setReviewRunId,
    setReviewScenes,
    setReviewUpdatingSceneIndex,
    setShowGenerateDialog,
    setSubmitting,
  });

  const recentJobsListCommonProps = {
    activeRunId,
    recentJobs,
    reviewRunId,
    runCancellingId,
    runDeletingId,
    onCancelRun: (runId: string) => {
      void handleCancelRun(runId);
    },
    onDeleteRun: (runId: string) => {
      void handleDeleteRun(runId);
    },
    onOpenReview: (runId: string) => {
      void handleOpenReview(runId);
    },
    onViewJobProgress: handleViewJobProgress,
  };

  const canJumpGenerateStep = Boolean(activeRunId || reviewRunId || resumableJob || recentJobs.length > 0);
  const canJumpReviewStep = Boolean(reviewRunId || hasReviewJobs);
  const currentFlowStepIndex = Math.max(0, PUZZLE_FLOW_SEQUENCE.indexOf(puzzleFlowStep));
  const canGoPrevFlowStep = currentFlowStepIndex > 0;
  const canGoNextFlowStep = (puzzleFlowStep === "select" && canJumpGenerateStep)
    || (puzzleFlowStep === "generate" && canJumpReviewStep);

  const constants = {
    CHAPTER_PAGE_SIZE_OPTIONS,
    DEFAULT_SCENE_COUNT,
    MANAGED_LEVEL_DIFFICULTIES,
    MANAGED_ROLES,
    PUZZLE_FLOW_SEQUENCE,
    REVIEW_GRID_OPTIONS,
    REVIEW_TIME_OPTIONS,
  };

  const usersState = {
    adminUsers,
    loadingUsers,
    passwordResetSubmittingUserId,
    roleSubmittingKey,
    userKeyword,
  };

  const usersActions = {
    handleApprovePasswordReset,
    handleRoleToggle,
    loadAdminUsers,
    setUserKeyword,
  };

  const levelConfigState = {
    configLevelId,
    configLevels,
    configPreviewing,
    configSaving,
    configStories,
    configStoryId,
    configTesting,
    levelConfigForm,
    levelConfigSnapshot,
    loadingConfigCatalog,
    loadingLevelConfig,
    testRunResult,
  };

  const levelConfigActions = {
    handleConfigFormChange,
    handlePreviewLevelConfig,
    handleSaveLevelConfig,
    handleTestLevelConfig,
    loadConfigStories,
    loadLevelConfig,
    setConfigLevelId,
    setConfigStoryId,
    setLevelConfigSnapshot,
    setTestRunResult,
  };

  const chapterState = {
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
    selectedChapter,
    selectedChapterId,
    submitting,
    targetDate,
    totalChapterPages,
  };

  const chapterActions = {
    handleOpenGeneratedStory,
    handleSubmit,
    loadChapters,
    setBookId,
    setChapterPage,
    setChapterPageSize,
    setIncludeUsed,
    setKeyword,
    setMaxCharsInput,
    setMinCharsInput,
    setSceneCountInput,
    setSelectedChapterId,
    setTargetDate,
  };

  const puzzleState = {
    activeJob,
    activeRunId,
    progress,
    recentJobsListCommonProps,
    resumableJob,
    reviewBatchGenerating,
    reviewCounts,
    reviewDeletingSceneIndex,
    reviewLoading,
    reviewLocked,
    reviewPendingImageCount,
    reviewPublishing,
    reviewReadyCount,
    reviewRetryingSceneIndex,
    reviewRunId,
    reviewScenes,
    reviewUpdatingSceneIndex,
  };

  const puzzleActions = {
    handleBatchGenerateImages,
    handleDeleteReviewScene,
    handlePublishSelected,
    handleRetryReviewCandidate,
    handleUpdateReviewScene,
    handleViewJobProgress,
    loadGenerationReview,
    setScenePreview,
  };

  const sectionState = {
    canGoNextFlowStep,
    canGoPrevFlowStep,
    canJumpGenerateStep,
    canJumpReviewStep,
    collapsedSections,
    currentFlowStepIndex,
    puzzleFlowStep,
  };

  const sectionActions = {
    setPuzzleFlowStep,
    toggleSection,
  };

  const publishState = {
    publishSuccess,
    scenePreview,
  };

  const publishActions = {
    handleOpenPublishedStory,
    handleStayAfterPublish,
    setScenePreview,
  };

  const uiState = {
    panelError,
    panelInfo,
    showGenerateDialog,
  };

  const uiActions = {
    setShowGenerateDialog,
  };

  return {
    chapterActions,
    chapterState,
    constants,
    levelConfigActions,
    levelConfigState,
    publishActions,
    publishState,
    puzzleActions,
    puzzleState,
    sectionActions,
    sectionState,
    uiActions,
    uiState,
    usersActions,
    usersState,
  };
}
