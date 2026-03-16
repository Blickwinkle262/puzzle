import { useCallback, useEffect, useMemo, useState } from "react";

import {
  apiCancelAdminBookSummaryTask,
  apiCreateAdminLlmProvider,
  apiDeleteAdminLlmProvider,
  apiCreateAdminBookSummaryRun,
  apiFetchAdminLlmProviderModels,
  apiGetAdminBookSummaryTask,
  apiGetAdminChapterText,
  apiGetAdminBookUploadTask,
  apiGetAdminLlmGlobalProfile,
  apiGetAdminLlmUserProfile,
  apiListAdminBookSummaryTasks,
  apiListAdminBookChapters,
  apiListAdminBookUploadTasks,
  apiListAdminLlmEnvKeys,
  apiListAdminLlmProviderModels,
  apiListAdminLlmProviders,
  apiReparseAdminBook,
  apiResumeAdminBookSummaryTask,
  apiTestAdminLlmProvider,
  apiUpdateAdminLlmGlobalProfile,
  apiUpdateAdminLlmProvider,
  apiUpdateAdminLlmProviderKey,
  apiUpdateAdminLlmUserProfile,
  apiUploadAdminBook,
} from "../core/adminApi";
import { apiGetMe } from "../core/api";
import {
  AdminLlmApiKeyOption,
  AdminBookIngestTask,
  AdminBookSummaryTask,
  AdminBookUploadResponse,
  AdminLevelDifficulty,
  AdminLlmConnectionTestResult,
  AdminLlmModelOption,
  AdminLlmProfile,
  AdminLlmProvider,
  AdminLlmProviderKeySource,
  AdminLlmProviderModel,
  AdminLlmRuntimeState,
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

type PendingBookReplaceState = {
  file: File;
  format: "epub" | "txt";
  uploadTitle: string;
  incomingFileName: string;
  existingBookTitle: string;
  existingChapterCount: number;
  message: string;
};

type ChapterTextPreviewState = {
  chapter_id: number;
  book_title: string;
  book_author: string;
  chapter_index: number;
  chapter_title: string;
  char_count: number;
  word_count: number;
  chapter_text: string;
};

type LlmProfileScope = "global" | "user";

type LlmProviderDraftState = {
  id: number;
  name: string;
  provider_kind: "compatible";
  api_base_url: string;
  proxy_url: string;
  no_proxy_hosts: string;
  enabled: boolean;
  key_source: AdminLlmProviderKeySource;
  env_key_name: string;
  custom_api_key: string;
};

type LlmProfileDraftState = {
  provider_id: number | null;
  story_provider_id: number | null;
  summary_provider_id: number | null;
  text2image_provider_id: number | null;
  story_prompt_model: string;
  summary_model: string;
  text2image_model: string;
};

type LlmProviderCreateDraftState = {
  name: string;
  api_base_url: string;
  proxy_url: string;
  no_proxy_hosts: string;
  enabled: boolean;
  key_source: AdminLlmProviderKeySource;
  env_key_name: string;
  custom_api_key: string;
};

const EMPTY_LLM_PROFILE_DRAFT: LlmProfileDraftState = {
  provider_id: null,
  story_provider_id: null,
  summary_provider_id: null,
  text2image_provider_id: null,
  story_prompt_model: "",
  summary_model: "",
  text2image_model: "",
};

const EMPTY_LLM_PROVIDER_CREATE_DRAFT: LlmProviderCreateDraftState = {
  name: "",
  api_base_url: "",
  proxy_url: "",
  no_proxy_hosts: "",
  enabled: true,
  key_source: "env",
  env_key_name: "",
  custom_api_key: "",
};

function toProviderDraft(provider: AdminLlmProvider): LlmProviderDraftState {
  return {
    id: provider.id,
    name: provider.name,
    provider_kind: provider.provider_kind,
    api_base_url: provider.api_base_url,
    proxy_url: provider.proxy_url,
    no_proxy_hosts: provider.no_proxy_hosts,
    enabled: provider.enabled,
    key_source: provider.key?.key_source || "env",
    env_key_name: provider.key?.env_key_name || "",
    custom_api_key: "",
  };
}

function toProfileDraft(profile: AdminLlmProfile | null, effective: AdminLlmRuntimeState | null): LlmProfileDraftState {
  if (profile) {
    const providerId = profile.provider_id;
    const storyProviderId = profile.story_provider_id || providerId;
    const summaryProviderId = profile.summary_provider_id || storyProviderId || providerId;
    const imageProviderId = profile.text2image_provider_id || providerId;

    return {
      provider_id: providerId,
      story_provider_id: storyProviderId,
      summary_provider_id: summaryProviderId,
      text2image_provider_id: imageProviderId,
      story_prompt_model: profile.story_prompt_model || profile.text_model || "",
      summary_model: profile.summary_model || "",
      text2image_model: profile.text2image_model || profile.image_model || "",
    };
  }

  if (effective) {
    return {
      provider_id: effective.provider_id,
      story_provider_id: effective.provider_id,
      summary_provider_id: effective.provider_id,
      text2image_provider_id: effective.provider_id,
      story_prompt_model: effective.text_model || "",
      summary_model: effective.summary_model || "",
      text2image_model: effective.image_model || "",
    };
  }

  return { ...EMPTY_LLM_PROFILE_DRAFT };
}

function aggregateModelOptions(rows: AdminLlmProviderModel[]): AdminLlmModelOption[] {
  const map = new Map<string, AdminLlmModelOption>();
  for (const row of rows) {
    const modelId = String(row.model_id || "").trim();
    if (!modelId) {
      continue;
    }
    const existing = map.get(modelId) || {
      id: modelId,
      text: false,
      summary: false,
      image: false,
    };
    if (row.model_type === "text") {
      existing.text = true;
    }
    if (row.model_type === "summary") {
      existing.summary = true;
    }
    if (row.model_type === "image") {
      existing.image = true;
    }
    map.set(modelId, existing);
  }
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function collectProfileProviderIds(draft: LlmProfileDraftState): number[] {
  const ids = [
    draft.story_provider_id,
    draft.summary_provider_id,
    draft.text2image_provider_id,
    draft.provider_id,
  ]
    .map((value) => Number(value || 0))
    .filter((value, index, source) => Number.isInteger(value) && value > 0 && source.indexOf(value) === index);
  return ids;
}

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
const BOOK_UPLOAD_MAX_BYTES = 80 * 1024 * 1024;

export type AdminPanelNoticeScope = "users" | "levelConfig" | "llm" | "bookIngest" | "puzzle" | "global";

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
    setUserPage,
    setUserPageSize,
    setUserRoleFilter,
    setUserSummary,
    setUserTotal,
    setUserKeyword,
    userPage,
    userPageSize,
    userRoleFilter,
    userSummary,
    userTotal,
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

  const [panelError, setPanelErrorState] = useState("");
  const [panelInfo, setPanelInfoState] = useState("");
  const [panelNoticeScope, setPanelNoticeScope] = useState<AdminPanelNoticeScope>("global");
  const setPanelError = useCallback((message: string): void => {
    const next = String(message || "");
    setPanelErrorState(next);
    if (next) {
      setPanelInfoState("");
    }
  }, []);
  const setPanelInfo = useCallback((message: string): void => {
    const next = String(message || "");
    setPanelInfoState(next);
    if (next) {
      setPanelErrorState("");
    }
  }, []);
  const setScopedPanelError = useCallback((scope: AdminPanelNoticeScope, message: string): void => {
    setPanelNoticeScope(scope);
    setPanelError(message);
  }, [setPanelError]);
  const setScopedPanelInfo = useCallback((scope: AdminPanelNoticeScope, message: string): void => {
    setPanelNoticeScope(scope);
    setPanelInfo(message);
  }, [setPanelInfo]);
  const setUsersPanelError = useCallback((message: string): void => {
    setScopedPanelError("users", message);
  }, [setScopedPanelError]);
  const setUsersPanelInfo = useCallback((message: string): void => {
    setScopedPanelInfo("users", message);
  }, [setScopedPanelInfo]);
  const setLevelConfigPanelError = useCallback((message: string): void => {
    setScopedPanelError("levelConfig", message);
  }, [setScopedPanelError]);
  const setLevelConfigPanelInfo = useCallback((message: string): void => {
    setScopedPanelInfo("levelConfig", message);
  }, [setScopedPanelInfo]);
  const setBookIngestPanelError = useCallback((message: string): void => {
    setScopedPanelError("bookIngest", message);
  }, [setScopedPanelError]);
  const setBookIngestPanelInfo = useCallback((message: string): void => {
    setScopedPanelInfo("bookIngest", message);
  }, [setScopedPanelInfo]);
  const setPuzzlePanelError = useCallback((message: string): void => {
    setScopedPanelError("puzzle", message);
  }, [setScopedPanelError]);
  const setPuzzlePanelInfo = useCallback((message: string): void => {
    setScopedPanelInfo("puzzle", message);
  }, [setScopedPanelInfo]);
  const setLlmPanelError = useCallback((message: string): void => {
    setScopedPanelError("llm", message);
  }, [setScopedPanelError]);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [uploadingBook, setUploadingBook] = useState(false);
  const [bookUploadTasks, setBookUploadTasks] = useState<AdminBookIngestTask[]>([]);
  const [loadingBookUploadTasks, setLoadingBookUploadTasks] = useState(false);
  const [reparsingBook, setReparsingBook] = useState(false);
  const [summaryBookId, setSummaryBookId] = useState("");
  const [generatingBookSummary, setGeneratingBookSummary] = useState(false);
  const [bookSummaryTaskActionRunId, setBookSummaryTaskActionRunId] = useState("");
  const [bookSummaryTasks, setBookSummaryTasks] = useState<AdminBookSummaryTask[]>([]);
  const [loadingBookSummaryTasks, setLoadingBookSummaryTasks] = useState(false);
  const [pendingBookReplace, setPendingBookReplace] = useState<PendingBookReplaceState | null>(null);
  const [chapterTextPreview, setChapterTextPreview] = useState<ChapterTextPreviewState | null>(null);
  const [loadingChapterTextPreview, setLoadingChapterTextPreview] = useState(false);
  const [llmProviders, setLlmProviders] = useState<AdminLlmProvider[]>([]);
  const [llmEnvKeyOptions, setLlmEnvKeyOptions] = useState<AdminLlmApiKeyOption[]>([]);
  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<number>(0);
  const [llmProviderDraft, setLlmProviderDraft] = useState<LlmProviderDraftState | null>(null);
  const [llmCreateProviderDraft, setLlmCreateProviderDraft] = useState<LlmProviderCreateDraftState>({ ...EMPTY_LLM_PROVIDER_CREATE_DRAFT });
  const [llmCachedModels, setLlmCachedModels] = useState<AdminLlmProviderModel[]>([]);
  const [llmCachedModelsByProviderId, setLlmCachedModelsByProviderId] = useState<Record<number, AdminLlmProviderModel[]>>({});
  const [llmProfileScope, setLlmProfileScope] = useState<LlmProfileScope>("global");
  const [llmProfileUserIdInput, setLlmProfileUserIdInput] = useState("");
  const [llmProfile, setLlmProfile] = useState<AdminLlmProfile | null>(null);
  const [llmEffectiveRuntime, setLlmEffectiveRuntime] = useState<AdminLlmRuntimeState | null>(null);
  const [llmProfileDraft, setLlmProfileDraft] = useState<LlmProfileDraftState>({ ...EMPTY_LLM_PROFILE_DRAFT });
  const [loadingLlmConfig, setLoadingLlmConfig] = useState(false);
  const [savingLlmConfig, setSavingLlmConfig] = useState(false);
  const [testingLlmConfig, setTestingLlmConfig] = useState(false);
  const [fetchingLlmModels, setFetchingLlmModels] = useState(false);
  const [fetchingLlmModelsProviderId, setFetchingLlmModelsProviderId] = useState(0);
  const [lastLlmTest, setLastLlmTest] = useState<AdminLlmConnectionTestResult | null>(null);
  const [llmFetchedModels, setLlmFetchedModels] = useState<AdminLlmModelOption[]>([]);
  const [llmFetchedModelsByProviderId, setLlmFetchedModelsByProviderId] = useState<Record<number, AdminLlmModelOption[]>>({});
  const [lastLlmModelsFetchedAt, setLastLlmModelsFetchedAt] = useState("");
  const [llmLastModelsFetchedAtByProviderId, setLlmLastModelsFetchedAtByProviderId] = useState<Record<number, string>>({});
  const [llmNoticeError, setLlmNoticeError] = useState("");
  const [llmNoticeInfo, setLlmNoticeInfo] = useState("");
  const [llmProfileSavedAt, setLlmProfileSavedAt] = useState(0);
  const [llmProviderSavedAt, setLlmProviderSavedAt] = useState(0);

  const clearLlmNotice = useCallback((): void => {
    setLlmNoticeError("");
    setLlmNoticeInfo("");
  }, []);

  const showLlmNoticeError = useCallback((message: string): void => {
    setLlmNoticeError(String(message || ""));
    setLlmNoticeInfo("");
  }, []);

  const showLlmNoticeInfo = useCallback((message: string): void => {
    setLlmNoticeInfo(String(message || ""));
    setLlmNoticeError("");
  }, []);

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
    setPanelError: setLevelConfigPanelError,
    setPanelInfo: setLevelConfigPanelInfo,
  });

  const {
    handleApprovePasswordReset,
    handleRoleToggle,
    loadAdminUsers,
  } = useAdminUsersCoordinator({
    userKeyword,
    userPage,
    userPageSize,
    userRoleFilter,
    setAdminUsers,
    setLoadingUsers,
    setPasswordResetSubmittingUserId,
    setRoleSubmittingKey,
    setUserSummary,
    setUserTotal,
    setPanelError: setUsersPanelError,
    setPanelInfo: setUsersPanelInfo,
  });

  const selectedChapter = useMemo(
    () => chapters.find((item) => item.id === selectedChapterId) || null,
    [chapters, selectedChapterId],
  );

  const progress = useMemo(() => extractJobProgress(activeJob), [activeJob]);
  const userTotalPages = useMemo(() => {
    const size = Math.max(1, Number(userPageSize || 10));
    const pages = Math.ceil(Math.max(0, Number(userTotal || 0)) / size);
    return pages > 0 ? pages : 1;
  }, [userPageSize, userTotal]);
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
    setPuzzlePanelError("");

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
      setPuzzlePanelError(errorMessage(err));
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
    setPuzzlePanelError,
    setSelectedChapterId,
  ]);

  const loadBookUploadTasks = useCallback(async (options: { silent?: boolean } = {}): Promise<void> => {
    const silent = Boolean(options.silent);
    if (!silent) {
      setLoadingBookUploadTasks(true);
      setBookIngestPanelError("");
    }

    try {
      const response = await apiListAdminBookUploadTasks(10);
      setBookUploadTasks(Array.isArray(response?.tasks) ? response.tasks : []);
    } catch (err) {
      if (!silent) {
        setBookIngestPanelError(errorMessage(err));
      }
    } finally {
      if (!silent) {
        setLoadingBookUploadTasks(false);
      }
    }
  }, [setBookIngestPanelError]);

  const loadBookSummaryTasks = useCallback(async (options: { silent?: boolean } = {}): Promise<void> => {
    const silent = Boolean(options.silent);
    if (!silent) {
      setLoadingBookSummaryTasks(true);
      setBookIngestPanelError("");
    }

    try {
      const response = await apiListAdminBookSummaryTasks(10);
      setBookSummaryTasks(Array.isArray(response?.tasks) ? response.tasks : []);
    } catch (err) {
      if (!silent) {
        setBookIngestPanelError(errorMessage(err));
      }
    } finally {
      if (!silent) {
        setLoadingBookSummaryTasks(false);
      }
    }
  }, [setBookIngestPanelError]);

  const loadLlmProviderModels = useCallback(async (
    providerId: number,
    options: { silent?: boolean; syncSelected?: boolean } = {},
  ): Promise<void> => {
    const silent = Boolean(options.silent);
    const syncSelected = options.syncSelected;
    if (!providerId) {
      if (syncSelected !== false) {
        setLlmCachedModels([]);
        setLlmFetchedModels([]);
        setLastLlmModelsFetchedAt("");
      }
      return;
    }

    try {
      const response = await apiListAdminLlmProviderModels(providerId);
      const rows = Array.isArray(response?.models) ? response.models : [];
      const modelOptions = aggregateModelOptions(rows);
      setLlmCachedModelsByProviderId((prev) => ({
        ...prev,
        [providerId]: rows,
      }));
      setLlmFetchedModelsByProviderId((prev) => ({
        ...prev,
        [providerId]: modelOptions,
      }));
      const fetchedAt = rows.reduce((latest, row) => {
        const value = String(row.fetched_at || "").trim();
        return value > latest ? value : latest;
      }, "");

      setLlmLastModelsFetchedAtByProviderId((prev) => ({
        ...prev,
        [providerId]: fetchedAt,
      }));

      const shouldSyncSelected = syncSelected === true
        || (syncSelected !== false && providerId === Number(selectedLlmProviderId || 0));
      if (shouldSyncSelected) {
        setLlmCachedModels(rows);
        setLlmFetchedModels(modelOptions);
        setLastLlmModelsFetchedAt(fetchedAt);
      }
    } catch (err) {
      if (!silent) {
        setLlmPanelError(errorMessage(err));
      }
    }
  }, [selectedLlmProviderId, setLlmPanelError]);

  const applyLlmProfileResponse = useCallback((
    profile: AdminLlmProfile | null,
    effective: AdminLlmRuntimeState | null,
    providersOverride: AdminLlmProvider[] | null = null,
  ): void => {
    const nextDraft = toProfileDraft(profile, effective);
    const providers = Array.isArray(providersOverride) ? providersOverride : llmProviders;

    setLlmProfile(profile);
    setLlmEffectiveRuntime(effective);
    setLlmProfileDraft(nextDraft);

    const providerId = Number(nextDraft.story_provider_id || nextDraft.provider_id || effective?.provider_id || providers[0]?.id || 0);
    if (!providerId) {
      setSelectedLlmProviderId(0);
      setLlmProviderDraft(null);
      return;
    }

    setSelectedLlmProviderId(providerId);
    setLlmProviderDraft((current) => {
      if (current && current.id === providerId) {
        return current;
      }
      const provider = providers.find((item) => item.id === providerId);
      return provider ? toProviderDraft(provider) : null;
    });

    const providerIds = collectProfileProviderIds(nextDraft);
    providerIds.forEach((id) => {
      void loadLlmProviderModels(id, { silent: true, syncSelected: id === providerId });
    });
  }, [llmProviders, loadLlmProviderModels]);

  const loadLlmProfileByScope = useCallback(async (
    scope: LlmProfileScope,
    options: { silent?: boolean; userIdInput?: string } = {},
  ): Promise<void> => {
    const silent = Boolean(options.silent);
    const rawUserId = String(options.userIdInput ?? llmProfileUserIdInput).trim();
    if (!silent) {
      setLlmPanelError("");
    }

    try {
      if (scope === "global") {
        const response = await apiGetAdminLlmGlobalProfile();
        applyLlmProfileResponse(response?.profile || null, response?.effective || null);
        return;
      }

      const userId = Number(rawUserId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error("请先选择目标用户，再加载用户 profile");
      }

      const response = await apiGetAdminLlmUserProfile(userId);
      applyLlmProfileResponse(response?.profile || null, response?.effective || null);
    } catch (err) {
      if (!silent) {
        setLlmPanelError(errorMessage(err));
      }
    }
  }, [applyLlmProfileResponse, llmProfileUserIdInput, setLlmPanelError]);

  const loadLlmConfig = useCallback(async (options: { silent?: boolean } = {}): Promise<void> => {
    const silent = Boolean(options.silent);
    if (!silent) {
      setLoadingLlmConfig(true);
      setLlmPanelError("");
    }

    try {
      const [providersResponse, envKeysResponse, globalProfileResponse] = await Promise.all([
        apiListAdminLlmProviders(),
        apiListAdminLlmEnvKeys(),
        apiGetAdminLlmGlobalProfile(),
      ]);

      const providers = Array.isArray(providersResponse?.providers) ? providersResponse.providers : [];
      const envKeys = Array.isArray(envKeysResponse?.key_options) ? envKeysResponse.key_options : [];
      setLlmProviders(providers);
      setLlmEnvKeyOptions(envKeys);
      setLlmCreateProviderDraft((prev) => {
        const fallbackEnvKey = String(envKeys[0]?.key || "").trim();
        if (prev.env_key_name || !fallbackEnvKey) {
          return prev;
        }
        return {
          ...prev,
          env_key_name: fallbackEnvKey,
        };
      });
      setLlmProfileScope("global");

      const profile = globalProfileResponse?.profile || null;
      const effective = globalProfileResponse?.effective || null;
      applyLlmProfileResponse(profile, effective, providers);

      setLastLlmTest(null);
      if (providers.length === 0) {
        setLlmCachedModels([]);
        setLlmFetchedModels([]);
        setLastLlmModelsFetchedAt("");
      }
    } catch (err) {
      if (!silent) {
        setLlmPanelError(errorMessage(err));
      }
    } finally {
      if (!silent) {
        setLoadingLlmConfig(false);
      }
    }
  }, [applyLlmProfileResponse, setLlmPanelError]);

  const handleLlmProviderIdChange = useCallback((value: string): void => {
    const providerId = Number(value);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      setSelectedLlmProviderId(0);
      setLlmProviderDraft(null);
      setLlmCachedModels([]);
      setLlmFetchedModels([]);
      setLastLlmModelsFetchedAt("");
      return;
    }

    const provider = llmProviders.find((item) => item.id === providerId) || null;
    const cachedRows = llmCachedModelsByProviderId[providerId] || [];
    const cachedOptions = llmFetchedModelsByProviderId[providerId] || [];
    setSelectedLlmProviderId(providerId);
    setLlmProviderDraft(provider ? toProviderDraft(provider) : null);
    setLlmCachedModels(cachedRows);
    setLlmFetchedModels(cachedOptions);
    setLastLlmModelsFetchedAt(llmLastModelsFetchedAtByProviderId[providerId] || "");
    void loadLlmProviderModels(providerId, { silent: true, syncSelected: true });
  }, [llmCachedModelsByProviderId, llmFetchedModelsByProviderId, llmLastModelsFetchedAtByProviderId, llmProviders, loadLlmProviderModels]);

  const handleLlmProviderFieldChange = useCallback((patch: Partial<Omit<LlmProviderDraftState, "id" | "key_source" | "env_key_name" | "custom_api_key">>): void => {
    setLlmProviderDraft((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        ...patch,
      };
    });
  }, []);

  const handleLlmProviderKeyFieldChange = useCallback((patch: Partial<Pick<LlmProviderDraftState, "key_source" | "env_key_name" | "custom_api_key">>): void => {
    setLlmProviderDraft((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        ...patch,
      };
    });
  }, []);

  const handleLlmCreateProviderFieldChange = useCallback((patch: Partial<LlmProviderCreateDraftState>): void => {
    setLlmCreateProviderDraft((prev) => ({
      ...prev,
      ...patch,
    }));
  }, []);

  const handleCreateLlmProvider = useCallback(async (): Promise<void> => {
    const keySource: AdminLlmProviderKeySource = llmCreateProviderDraft.key_source === "custom" ? "custom" : "env";
    const draft = {
      ...llmCreateProviderDraft,
      name: String(llmCreateProviderDraft.name || "").trim(),
      api_base_url: String(llmCreateProviderDraft.api_base_url || "").trim(),
      proxy_url: String(llmCreateProviderDraft.proxy_url || "").trim(),
      no_proxy_hosts: String(llmCreateProviderDraft.no_proxy_hosts || "").trim(),
      key_source: keySource,
      env_key_name: String(llmCreateProviderDraft.env_key_name || "").trim(),
      custom_api_key: String(llmCreateProviderDraft.custom_api_key || "").trim(),
    };

    if (!draft.name) {
      setPanelError("请先填写 provider 名称");
      return;
    }
    if (!draft.api_base_url) {
      setPanelError("请先填写 API Base URL");
      return;
    }
    if (draft.key_source === "env" && !draft.env_key_name) {
      setPanelError("请先选择 Env Key，或切换为 Custom Key");
      return;
    }
    if (draft.key_source === "custom" && !draft.custom_api_key) {
      setPanelError("请先输入 Custom API Key");
      return;
    }

    setSavingLlmConfig(true);
    setPanelError("");
    try {
      const response = await apiCreateAdminLlmProvider({
        name: draft.name,
        provider_kind: "compatible",
        api_base_url: draft.api_base_url,
        proxy_url: draft.proxy_url,
        no_proxy_hosts: draft.no_proxy_hosts,
        enabled: draft.enabled,
      });

      const createdProvider = response?.provider || null;
      let provider = createdProvider;
      if (provider) {
        const keyResponse = await apiUpdateAdminLlmProviderKey(provider.id, {
          key_source: draft.key_source,
          env_key_name: draft.key_source === "env" ? draft.env_key_name : "",
          api_key: draft.key_source === "custom" ? draft.custom_api_key : "",
        });
        if (keyResponse?.provider) {
          provider = keyResponse.provider;
        }
      }

      if (provider) {
        setLlmProviders((prev) => [provider, ...prev]);
        setSelectedLlmProviderId(provider.id);
        setLlmProviderDraft(toProviderDraft(provider));
        setLlmProfileDraft((prev) => ({
          ...prev,
          provider_id: provider.id,
        }));
        setLlmCreateProviderDraft({
          ...EMPTY_LLM_PROVIDER_CREATE_DRAFT,
          api_base_url: draft.api_base_url,
          env_key_name: String(llmEnvKeyOptions[0]?.key || "").trim(),
        });
      }
      setPanelInfo("Provider 已创建并保存 Key");
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setSavingLlmConfig(false);
    }
  }, [llmCreateProviderDraft, llmEnvKeyOptions, setPanelError, setPanelInfo]);

  const handleLlmProfileScopeChange = useCallback((scope: LlmProfileScope): void => {
    setLlmProfileScope(scope);
    setLastLlmTest(null);
    setPanelError("");
    if (scope === "global") {
      void loadLlmProfileByScope("global", { silent: false });
    }
  }, [loadLlmProfileByScope, setPanelError]);

  const handleLlmProfileUserIdInputChange = useCallback((value: string): void => {
    setLlmProfileUserIdInput(value);
  }, []);

  const handleLoadLlmUserProfile = useCallback(async (): Promise<void> => {
    setLoadingLlmConfig(true);
    setPanelError("");
    try {
      await loadLlmProfileByScope("user", { userIdInput: llmProfileUserIdInput });
    } finally {
      setLoadingLlmConfig(false);
    }
  }, [llmProfileUserIdInput, loadLlmProfileByScope, setPanelError]);

  const handleLlmProfileFieldChange = useCallback((patch: Partial<LlmProfileDraftState>): void => {
    let nextDraft: LlmProfileDraftState | null = null;
    setLlmProfileDraft((prev) => {
      nextDraft = {
        ...prev,
        ...patch,
      };
      return nextDraft;
    });

    const draft = nextDraft;
    if (!draft) {
      return;
    }
    collectProfileProviderIds(draft).forEach((id) => {
      void loadLlmProviderModels(id, { silent: true, syncSelected: false });
    });
  }, [loadLlmProviderModels]);

  const handleSaveLlmProvider = useCallback(async (): Promise<void> => {
    const draft = llmProviderDraft;
    if (!draft) {
      setPanelError("请先选择 provider");
      return;
    }

    if (draft.key_source === "env" && !String(draft.env_key_name || "").trim()) {
      setPanelError("请先选择 env key");
      return;
    }
    if (draft.key_source === "custom") {
      const hasInputCustomKey = String(draft.custom_api_key || "").trim().length > 0;
      const currentProvider = llmProviders.find((item) => item.id === draft.id) || null;
      const hasExistingCustomKey = Boolean(
        currentProvider?.key
        && currentProvider.key.key_source === "custom"
        && currentProvider.key.has_key,
      );
      if (!hasInputCustomKey && !hasExistingCustomKey) {
        setPanelError("请先输入 custom API Key");
        return;
      }
    }

    setSavingLlmConfig(true);
    setPanelError("");
    try {
      const providerResponse = await apiUpdateAdminLlmProvider(draft.id, {
        name: draft.name,
        provider_kind: draft.provider_kind,
        api_base_url: draft.api_base_url,
        proxy_url: draft.proxy_url,
        no_proxy_hosts: draft.no_proxy_hosts,
        enabled: draft.enabled,
      });
      let provider = providerResponse?.provider || null;
      const keyResponse = await apiUpdateAdminLlmProviderKey(draft.id, {
        key_source: draft.key_source,
        env_key_name: draft.key_source === "env" ? draft.env_key_name : "",
        api_key: draft.key_source === "custom" ? draft.custom_api_key : "",
      });
      if (keyResponse?.provider) {
        provider = keyResponse.provider;
      }

      if (provider) {
        setLlmProviders((prev) => prev.map((item) => (item.id === provider.id ? provider : item)));
        setLlmProviderDraft((current) => ({
          ...(current ? { ...current } : toProviderDraft(provider)),
          ...toProviderDraft(provider),
          custom_api_key: "",
        }));
      }
      setLlmProviderSavedAt(Date.now());
      setPanelInfo("Provider 已保存（含 Key）");
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setSavingLlmConfig(false);
    }
  }, [llmProviderDraft, llmProviders, setPanelError, setPanelInfo]);

  const handleDeleteLlmProvider = useCallback(async (providerId: number): Promise<void> => {
    const targetId = Number(providerId || 0);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      setPanelError("请先选择有效的 provider");
      return;
    }

    const targetProvider = llmProviders.find((item) => item.id === targetId) || null;
    if (!targetProvider) {
      setPanelError("provider 不存在或已删除");
      return;
    }

    const confirmed = window.confirm(`确认删除 Provider「${targetProvider.name}」吗？`);
    if (!confirmed) {
      return;
    }

    setSavingLlmConfig(true);
    setPanelError("");
    try {
      await apiDeleteAdminLlmProvider(targetId);

      const nextProviders = llmProviders.filter((item) => item.id !== targetId);
      setLlmProviders(nextProviders);

      setLlmFetchedModelsByProviderId((prev) => {
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setLlmCachedModelsByProviderId((prev) => {
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setLlmLastModelsFetchedAtByProviderId((prev) => {
        const next = { ...prev };
        delete next[targetId];
        return next;
      });

      const nextSelectedProvider = nextProviders[0] || null;
      if (!nextSelectedProvider) {
        setSelectedLlmProviderId(0);
        setLlmProviderDraft(null);
        setLlmCachedModels([]);
        setLlmFetchedModels([]);
        setLastLlmModelsFetchedAt("");
      } else {
        setSelectedLlmProviderId(nextSelectedProvider.id);
        setLlmProviderDraft(toProviderDraft(nextSelectedProvider));
        await loadLlmProviderModels(nextSelectedProvider.id, { silent: true, syncSelected: true });
      }

      setLlmProfileDraft((prev) => ({
        ...prev,
        provider_id: prev.provider_id === targetId ? null : prev.provider_id,
        story_provider_id: prev.story_provider_id === targetId ? null : prev.story_provider_id,
        summary_provider_id: prev.summary_provider_id === targetId ? null : prev.summary_provider_id,
        text2image_provider_id: prev.text2image_provider_id === targetId ? null : prev.text2image_provider_id,
      }));

      setPanelInfo(`Provider 已删除：${targetProvider.name}`);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setSavingLlmConfig(false);
    }
  }, [llmProviders, loadLlmProviderModels, setPanelError, setPanelInfo]);

  const handleSaveLlmProfile = useCallback(async (): Promise<void> => {
    const scope = llmProfileScope;
    const providerId = Number(llmProfileDraft.provider_id || 0);
    const storyProviderId = Number(llmProfileDraft.story_provider_id || 0);
    const summaryProviderId = Number(llmProfileDraft.summary_provider_id || 0);
    const imageProviderId = Number(llmProfileDraft.text2image_provider_id || 0);
    const canonicalProviderId = providerId > 0
      ? providerId
      : storyProviderId > 0
        ? storyProviderId
        : imageProviderId > 0
          ? imageProviderId
          : summaryProviderId > 0
            ? summaryProviderId
            : 0;

    const payload = {
      provider_id: canonicalProviderId > 0 ? canonicalProviderId : null,
      story_provider_id: storyProviderId > 0 ? storyProviderId : null,
      summary_provider_id: summaryProviderId > 0 ? summaryProviderId : null,
      text2image_provider_id: imageProviderId > 0 ? imageProviderId : null,
      story_prompt_model: llmProfileDraft.story_prompt_model,
      summary_model: llmProfileDraft.summary_model,
      text2image_model: llmProfileDraft.text2image_model,
    };

    setSavingLlmConfig(true);
    setPanelError("");
    try {
      const response = scope === "user"
        ? await (() => {
          const userId = Number(llmProfileUserIdInput);
          if (!Number.isInteger(userId) || userId <= 0) {
            throw new Error("请先选择目标用户，再保存用户 profile");
          }
          return apiUpdateAdminLlmUserProfile(userId, payload);
        })()
        : await apiUpdateAdminLlmGlobalProfile(payload);

      const profile = response?.profile || null;
      const effective = response?.effective || null;
      const nextDraft = toProfileDraft(profile, effective);
      setLlmProfile(profile);
      setLlmEffectiveRuntime(effective);
      setLlmProfileDraft(nextDraft);
      const providerIdFromRuntime = Number(nextDraft.story_provider_id || nextDraft.provider_id || effective?.provider_id || 0);
      if (providerIdFromRuntime > 0) {
        setSelectedLlmProviderId(providerIdFromRuntime);
        const provider = llmProviders.find((item) => item.id === providerIdFromRuntime) || null;
        if (provider) {
          setLlmProviderDraft(toProviderDraft(provider));
        }
      }
      const providerIds = collectProfileProviderIds(nextDraft);
      await Promise.all(providerIds.map((id) => loadLlmProviderModels(id, {
        silent: true,
        syncSelected: id === providerIdFromRuntime,
      })));
      setLlmProfileSavedAt(Date.now());
      setPanelInfo(scope === "user" ? "用户 profile 已保存" : "全局 profile 已保存");
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setSavingLlmConfig(false);
    }
  }, [llmProfileDraft, llmProfileScope, llmProfileUserIdInput, llmProviders, loadLlmProviderModels, setPanelError, setPanelInfo]);

  const handleTestLlmConfig = useCallback(async (): Promise<void> => {
    const providerId = Number(selectedLlmProviderId || 0);
    if (!providerId) {
      showLlmNoticeError("请先选择 provider");
      return;
    }

    const provider = llmProviders.find((item) => item.id === providerId) || null;
    const draft = llmProviderDraft && llmProviderDraft.id === providerId ? llmProviderDraft : null;
    const keySource = String(draft?.key_source || provider?.key?.key_source || "env").trim();
    const envKeyName = String(draft?.env_key_name || provider?.key?.env_key_name || "").trim();
    const customApiKey = String(draft?.custom_api_key || "").trim();

    setTestingLlmConfig(true);
    clearLlmNotice();
    showLlmNoticeInfo("正在执行 Provider 连接测试...");

    try {
      const response = await apiTestAdminLlmProvider(providerId, {
        api_base_url: String(draft?.api_base_url || provider?.api_base_url || "").trim(),
        proxy_url: String(draft?.proxy_url || provider?.proxy_url || "").trim(),
        no_proxy: String(draft?.no_proxy_hosts || provider?.no_proxy_hosts || "").trim(),
        env_key_name: keySource === "env" ? envKeyName : "",
        api_key_selector: keySource === "env" ? envKeyName : "",
        api_key: keySource === "custom" ? customApiKey : "",
      });
      const test = response?.test || null;
      setLastLlmTest(test);
      if (test) {
        const textStatus = test.text_model_exists ? "文本模型可用" : "文本模型不存在";
        const summaryStatus = test.summary_model_exists ? "摘要模型可用" : "摘要模型不存在";
        const imageStatus = test.image_model_exists ? "图像模型可用" : "图像模型不存在";
        const resolvedBaseUrl = String(test.resolved_base_url || test.api_base_url || "").trim();
        const resolvedBaseUrlText = resolvedBaseUrl ? `，endpoint=${resolvedBaseUrl}/models` : "";
        showLlmNoticeInfo(`连接测试完成：${textStatus}，${summaryStatus}，${imageStatus}，models=${test.models_count}${resolvedBaseUrlText}`);
      } else {
        showLlmNoticeInfo("连接测试完成，但返回结果为空");
      }
    } catch (err) {
      showLlmNoticeError(errorMessage(err));
    } finally {
      setTestingLlmConfig(false);
    }
  }, [clearLlmNotice, llmProviderDraft, llmProviders, selectedLlmProviderId, showLlmNoticeError, showLlmNoticeInfo]);

  const fetchLlmModelsByProviderId = useCallback(async (providerId: number): Promise<void> => {
    const normalizedProviderId = Number(providerId || 0);
    if (!Number.isInteger(normalizedProviderId) || normalizedProviderId <= 0) {
      showLlmNoticeError("请先选择 provider");
      return;
    }

    const selectedProvider = llmProviders.find((item) => item.id === normalizedProviderId) || null;
    const draft = llmProviderDraft && llmProviderDraft.id === normalizedProviderId ? llmProviderDraft : null;
    const keySource = String(draft?.key_source || selectedProvider?.key?.key_source || "env").trim();
    const envKeyName = String(draft?.env_key_name || selectedProvider?.key?.env_key_name || "").trim();
    const customApiKey = String(draft?.custom_api_key || "").trim();
    if (selectedProvider) {
      setSelectedLlmProviderId(normalizedProviderId);
      setLlmProviderDraft(toProviderDraft(selectedProvider));
    }

    setFetchingLlmModels(true);
    setFetchingLlmModelsProviderId(normalizedProviderId);
    clearLlmNotice();
    showLlmNoticeInfo("正在拉取 provider 模型列表...");

    try {
      const response = await apiFetchAdminLlmProviderModels(normalizedProviderId, {
        api_base_url: String(draft?.api_base_url || selectedProvider?.api_base_url || "").trim(),
        proxy_url: String(draft?.proxy_url || selectedProvider?.proxy_url || "").trim(),
        no_proxy: String(draft?.no_proxy_hosts || selectedProvider?.no_proxy_hosts || "").trim(),
        env_key_name: keySource === "env" ? envKeyName : "",
        api_key_selector: keySource === "env" ? envKeyName : "",
        api_key: keySource === "custom" ? customApiKey : "",
      });
      const fetchResult = response?.fetch || null;
      const models = Array.isArray(fetchResult?.models) ? fetchResult.models : [];
      const fetchedAt = String(fetchResult?.fetched_at || "").trim();
      setLlmFetchedModels(models);
      setLastLlmModelsFetchedAt(fetchedAt);
      await loadLlmProviderModels(normalizedProviderId, { silent: true, syncSelected: true });
      const resolvedBaseUrl = String(fetchResult?.resolved_base_url || fetchResult?.api_base_url || "").trim();
      const resolvedBaseUrlText = resolvedBaseUrl ? `，endpoint=${resolvedBaseUrl}/models` : "";
      const fetchedAtText = fetchedAt ? `，fetched_at=${fetchedAt}` : "";
      showLlmNoticeInfo(`模型拉取完成：共 ${Number(fetchResult?.models_count || models.length)} 个${resolvedBaseUrlText}${fetchedAtText}`);
    } catch (err) {
      showLlmNoticeError(`模型拉取失败：${errorMessage(err)}`);
    } finally {
      setFetchingLlmModels(false);
      setFetchingLlmModelsProviderId(0);
    }
  }, [clearLlmNotice, llmProviderDraft, llmProviders, loadLlmProviderModels, showLlmNoticeError, showLlmNoticeInfo]);

  const handleFetchLlmModels = useCallback(async (): Promise<void> => {
    const providerId = Number(selectedLlmProviderId || 0);
    await fetchLlmModelsByProviderId(providerId);
  }, [fetchLlmModelsByProviderId, selectedLlmProviderId]);

  const handleFetchLlmModelsByProvider = useCallback(async (providerId: number): Promise<void> => {
    await fetchLlmModelsByProviderId(providerId);
  }, [fetchLlmModelsByProviderId]);

  const refreshChapterListAfterIngest = useCallback(async (): Promise<void> => {
    setChapterPage(1);
    if (chapterPage === 1) {
      await loadChapters();
    }
  }, [chapterPage, loadChapters, setChapterPage]);

  const waitForBookIngestTask = useCallback(async (runId: string, fallbackName: string): Promise<void> => {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) {
      throw new Error("上传任务 run_id 为空");
    }

    let lastStatus = "";
    for (let attempt = 0; attempt < 240; attempt += 1) {
      let task = null as null | {
        run_id: string;
        status: "queued" | "running" | "succeeded" | "failed";
        inserted: number;
        updated: number;
        skipped: number;
        total: number;
        source_name: string;
        error_message: string;
      };

      try {
        const response = await apiGetAdminBookUploadTask(normalizedRunId);
        task = response?.task || null;
      } catch (err) {
        const status = Number((err as { status?: unknown })?.status || 0);
        if (status !== 404) {
          throw err;
        }
      }

      if (task) {
        if (task.status === "succeeded") {
          const total = Number(task.total || 0);
          const inserted = Number(task.inserted || 0);
          const updated = Number(task.updated || 0);
          const skipped = Number(task.skipped || 0);
          setBookIngestPanelInfo(`解析完成：${task.source_name || fallbackName}（总${total}章，新增${inserted}，更新${updated}，跳过${skipped}）`);
          await loadBookUploadTasks({ silent: true });
          await refreshChapterListAfterIngest();
          return;
        }

        if (task.status === "failed") {
          await loadBookUploadTasks({ silent: true });
          throw new Error(task.error_message || `上传解析失败（任务 ${task.run_id}）`);
        }

        if (lastStatus !== task.status) {
          setBookIngestPanelInfo(`上传任务进行中：${task.run_id}（${task.status}）`);
          lastStatus = task.status;
        }
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 1500);
      });
    }

    throw new Error(`上传解析超时（任务 ${normalizedRunId}）`);
  }, [loadBookUploadTasks, refreshChapterListAfterIngest, setBookIngestPanelInfo]);

  const waitForBookSummaryTask = useCallback(async (runId: string, fallbackBookName: string): Promise<void> => {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) {
      throw new Error("摘要任务 run_id 为空");
    }

    let lastStatus = "";
    for (let attempt = 0; attempt < 360; attempt += 1) {
      let task = null as null | {
        run_id: string;
        status: "queued" | "running" | "succeeded" | "failed";
        total: number;
        processed: number;
        succeeded: number;
        failed: number;
        skipped: number;
        error_message: string;
      };

      try {
        const response = await apiGetAdminBookSummaryTask(normalizedRunId);
        task = response?.task || null;
      } catch (err) {
        const status = Number((err as { status?: unknown })?.status || 0);
        if (status !== 404) {
          throw err;
        }
      }

      if (task) {
        if (task.status === "succeeded") {
          setBookIngestPanelInfo(
            `摘要完成：${fallbackBookName}（总${task.total}章，成功${task.succeeded}，跳过${task.skipped}，失败${task.failed}）`,
          );
          await loadBookSummaryTasks({ silent: true });
          await refreshChapterListAfterIngest();
          return;
        }

        if (task.status === "failed") {
          await loadBookSummaryTasks({ silent: true });
          throw new Error(task.error_message || `摘要任务失败（任务 ${task.run_id}）`);
        }

        if (lastStatus !== task.status) {
          setBookIngestPanelInfo(`摘要任务进行中：${task.run_id}（${task.status}）`);
          lastStatus = task.status;
        }
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 1500);
      });
    }

    throw new Error(`摘要任务超时（任务 ${normalizedRunId}）`);
  }, [loadBookSummaryTasks, refreshChapterListAfterIngest, setBookIngestPanelInfo]);

  const handleBookUploadResponse = useCallback(async (
    response: AdminBookUploadResponse | null | undefined,
    fallbackName: string,
  ): Promise<void> => {
    const asyncRunId = String(response?.run_id || "").trim();
    if (asyncRunId) {
      setBookIngestPanelInfo(`解析任务已提交：${asyncRunId}`);
      await waitForBookIngestTask(asyncRunId, fallbackName);
      return;
    }

    const ingest = response && response.ingest && typeof response.ingest === "object"
      ? response.ingest as Record<string, unknown>
      : {};

    const toCount = (value: unknown): number => {
      const normalized = Number(value);
      return Number.isFinite(normalized) && normalized >= 0 ? Math.floor(normalized) : 0;
    };

    const bookTitle = String(ingest.book_title || "").trim() || fallbackName;
    const total = toCount(ingest.total);
    const inserted = toCount(ingest.inserted);
    const updated = toCount(ingest.updated);
    const skipped = toCount(ingest.skipped);

    setBookIngestPanelInfo(`解析完成：${bookTitle}（总${total}章，新增${inserted}，更新${updated}，跳过${skipped}）`);
    await refreshChapterListAfterIngest();
    void loadBookUploadTasks({ silent: true });
  }, [loadBookUploadTasks, refreshChapterListAfterIngest, setBookIngestPanelInfo, waitForBookIngestTask]);

  const handleUploadBook = useCallback(async (file: File): Promise<void> => {
    if (!file || file.size <= 0) {
      setBookIngestPanelError("请选择要上传的书籍文件");
      return;
    }

    const lowerName = String(file.name || "").toLowerCase();
    const format: "epub" | "txt" | null = lowerName.endsWith(".epub")
      ? "epub"
      : lowerName.endsWith(".txt")
        ? "txt"
        : null;
    if (!format) {
      setBookIngestPanelError("仅支持 .epub 或 .txt 文件");
      return;
    }

    if (file.size > BOOK_UPLOAD_MAX_BYTES) {
      const actualMb = (file.size / 1024 / 1024).toFixed(1);
      setBookIngestPanelError(`文件过大（${actualMb}MB），当前上限为 80MB`);
      return;
    }

    try {
      await apiGetMe();
    } catch (err) {
      setBookIngestPanelError(`登录状态异常，请重新登录后再上传：${errorMessage(err)}`);
      return;
    }

    setUploadingBook(true);
    setBookIngestPanelError("");
    setPendingBookReplace(null);
    setBookIngestPanelInfo(`正在解析书籍：${file.name}`);

    try {
      const uploadTitle = String(file.name || "")
        .replace(/\.[^.]+$/, "")
        .trim()
        .slice(0, 120);

      let response;
      try {
        response = await apiUploadAdminBook({
          file,
          fileName: file.name,
          format,
          title: uploadTitle,
        });
      } catch (err) {
        const status = Number((err as { status?: unknown })?.status || 0);
        if (status !== 409) {
          throw err;
        }

        const errorPayload = (err as { payload?: unknown })?.payload;
        const payloadObj = errorPayload && typeof errorPayload === "object"
          ? errorPayload as Record<string, unknown>
          : null;
        const conflictCode = String(payloadObj?.code || "").trim();

        if (conflictCode === "book_ingest_running") {
          const task = payloadObj?.task && typeof payloadObj.task === "object"
            ? payloadObj.task as Record<string, unknown>
            : null;
          const runningRunId = String(task?.run_id || "").trim();
          if (runningRunId) {
            setBookIngestPanelInfo(`检测到同内容任务正在进行：${runningRunId}，已自动跟踪进度`);
            await waitForBookIngestTask(runningRunId, uploadTitle || file.name);
            return;
          }
        }

        if (conflictCode === "book_ingest_succeeded") {
          setBookIngestPanelInfo(errorMessage(err));
          await loadBookUploadTasks({ silent: true });
          await refreshChapterListAfterIngest();
          return;
        }

        if (conflictCode !== "book_exists") {
          throw err;
        }

        const bookInfo = payloadObj?.book && typeof payloadObj.book === "object"
          ? payloadObj.book as Record<string, unknown>
          : null;
        const existingBookTitle = String(bookInfo?.title || uploadTitle || file.name).trim() || file.name;
        const existingChapterCount = Number(bookInfo?.chapter_count || 0);

        setPendingBookReplace({
          file,
          format,
          uploadTitle,
          incomingFileName: file.name,
          existingBookTitle,
          existingChapterCount: Number.isFinite(existingChapterCount) ? existingChapterCount : 0,
          message: errorMessage(err),
        });
        setBookIngestPanelInfo(`检测到同名书籍：${existingBookTitle}（${Math.max(0, Number(existingChapterCount || 0))}章），请确认是否替换`);
        return;
      }

      await handleBookUploadResponse(response, uploadTitle || file.name);
    } catch (err) {
      setBookIngestPanelError(errorMessage(err));
    } finally {
      setUploadingBook(false);
      void loadBookUploadTasks({ silent: true });
    }
  }, [
    handleBookUploadResponse,
    loadBookUploadTasks,
    refreshChapterListAfterIngest,
    setBookIngestPanelError,
    setBookIngestPanelInfo,
  ]);

  const handleConfirmBookReplace = useCallback(async (): Promise<void> => {
    if (!pendingBookReplace) {
      return;
    }

    const {
      file,
      format,
      incomingFileName,
      uploadTitle,
    } = pendingBookReplace;

    setPendingBookReplace(null);
    setUploadingBook(true);
    setBookIngestPanelError("");
    setBookIngestPanelInfo(`正在替换书籍：${uploadTitle || incomingFileName}`);

    try {
      let response;
      try {
        response = await apiUploadAdminBook({
          file,
          fileName: incomingFileName,
          format,
          title: uploadTitle,
          replaceBook: true,
        });
      } catch (err) {
        const status = Number((err as { status?: unknown })?.status || 0);
        if (status !== 409) {
          throw err;
        }

        const errorPayload = (err as { payload?: unknown })?.payload;
        const payloadObj = errorPayload && typeof errorPayload === "object"
          ? errorPayload as Record<string, unknown>
          : null;
        const conflictCode = String(payloadObj?.code || "").trim();

        if (conflictCode === "book_ingest_running") {
          const task = payloadObj?.task && typeof payloadObj.task === "object"
            ? payloadObj.task as Record<string, unknown>
            : null;
          const runningRunId = String(task?.run_id || "").trim();
          if (runningRunId) {
            setBookIngestPanelInfo(`检测到同内容任务正在进行：${runningRunId}，已自动跟踪进度`);
            await waitForBookIngestTask(runningRunId, uploadTitle || incomingFileName);
            return;
          }
        }

        if (conflictCode === "book_ingest_succeeded") {
          setBookIngestPanelInfo(errorMessage(err));
          await loadBookUploadTasks({ silent: true });
          await refreshChapterListAfterIngest();
          return;
        }

        if (conflictCode === "book_exists") {
          setBookIngestPanelInfo(errorMessage(err));
          return;
        }

        throw err;
      }

      await handleBookUploadResponse(response, uploadTitle || incomingFileName);
    } catch (err) {
      setBookIngestPanelError(errorMessage(err));
    } finally {
      setUploadingBook(false);
      void loadBookUploadTasks({ silent: true });
    }
  }, [
    handleBookUploadResponse,
    loadBookUploadTasks,
    pendingBookReplace,
    refreshChapterListAfterIngest,
    setBookIngestPanelError,
    setBookIngestPanelInfo,
    waitForBookIngestTask,
  ]);

  const handleCancelBookReplace = useCallback(() => {
    setPendingBookReplace(null);
    setBookIngestPanelInfo("已撤销上传");
  }, [setBookIngestPanelInfo]);

  const handleReparseBook = useCallback(async (targetBookId: number): Promise<void> => {
    const normalizedBookId = Number.isFinite(targetBookId) ? Math.floor(targetBookId) : 0;
    if (normalizedBookId <= 0) {
      setBookIngestPanelError("请先选择要重解析的书籍");
      return;
    }

    setReparsingBook(true);
    setBookIngestPanelError("");
    setBookIngestPanelInfo("正在创建重解析任务...");

    try {
      const response = await apiReparseAdminBook(normalizedBookId);
      const runId = String(response?.run_id || "").trim();
      if (!runId) {
        throw new Error("重解析任务 run_id 为空");
      }
      const sourceName = String(response?.book?.source_name || response?.book?.title || `book_${normalizedBookId}`).trim();
      await waitForBookIngestTask(runId, sourceName);
    } catch (err) {
      setBookIngestPanelError(errorMessage(err));
    } finally {
      setReparsingBook(false);
      void loadBookUploadTasks({ silent: true });
    }
  }, [loadBookUploadTasks, setBookIngestPanelError, setBookIngestPanelInfo, waitForBookIngestTask]);

  const handleGenerateBookSummary = useCallback(async (targetBookId: number): Promise<void> => {
    const normalizedBookId = Number.isFinite(targetBookId) ? Math.floor(targetBookId) : 0;
    if (normalizedBookId <= 0) {
      setBookIngestPanelError("请先选择要生成摘要的书籍");
      return;
    }

    setGeneratingBookSummary(true);
    setBookIngestPanelError("");
    setBookIngestPanelInfo("正在创建章节摘要任务...");

    try {
      let runId = "";
      let bookTitle = "";
      try {
        const response = await apiCreateAdminBookSummaryRun(normalizedBookId, {
          force: false,
          chunk_size: 1000,
          summary_max_chars: 200,
        });
        runId = String(response?.run_id || "").trim();
        bookTitle = String(response?.book?.title || "").trim();
      } catch (err) {
        const status = Number((err as { status?: unknown })?.status || 0);
        if (status !== 409) {
          throw err;
        }

        const payload = (err as { payload?: unknown })?.payload;
        const payloadObj = payload && typeof payload === "object"
          ? payload as Record<string, unknown>
          : null;
        const code = String(payloadObj?.code || "").trim();
        if (code !== "book_summary_running") {
          throw err;
        }

        const task = payloadObj?.task && typeof payloadObj.task === "object"
          ? payloadObj.task as Record<string, unknown>
          : null;
        runId = String(task?.run_id || "").trim();
        if (!runId) {
          throw err;
        }
        setBookIngestPanelInfo(`检测到进行中的摘要任务：${runId}，已自动跟踪`);
      }

      if (!runId) {
        throw new Error("摘要任务 run_id 为空");
      }

      await waitForBookSummaryTask(runId, bookTitle || `book_${normalizedBookId}`);
    } catch (err) {
      setBookIngestPanelError(errorMessage(err));
    } finally {
      setGeneratingBookSummary(false);
      void loadBookSummaryTasks({ silent: true });
    }
  }, [loadBookSummaryTasks, setBookIngestPanelError, setBookIngestPanelInfo, waitForBookSummaryTask]);

  const handleResumeBookSummaryTask = useCallback(async (sourceRunId: string): Promise<void> => {
    const normalizedSourceRunId = String(sourceRunId || "").trim();
    if (!normalizedSourceRunId) {
      setBookIngestPanelError("run_id 不能为空");
      return;
    }

    setBookSummaryTaskActionRunId(normalizedSourceRunId);
    setGeneratingBookSummary(true);
    setBookIngestPanelError("");
    setBookIngestPanelInfo(`正在继续摘要任务：${normalizedSourceRunId}...`);

    try {
      let runId = "";
      let scopeType: "book" | "chapter" = "book";
      let scopeId = 0;

      try {
        const response = await apiResumeAdminBookSummaryTask(normalizedSourceRunId, {
          force: false,
          chunk_size: 1000,
          summary_max_chars: 200,
        });
        runId = String(response?.run_id || "").trim();
        scopeType = response?.scope_type === "chapter" ? "chapter" : "book";
        scopeId = Number(response?.scope_id || 0);
      } catch (err) {
        const status = Number((err as { status?: unknown })?.status || 0);
        if (status !== 409) {
          throw err;
        }
        const payloadObj = ((err as { payload?: unknown })?.payload ?? null) as Record<string, unknown> | null;
        const code = String(payloadObj?.code || "").trim();
        if (code !== "book_summary_running") {
          throw err;
        }
        const task = payloadObj?.task && typeof payloadObj.task === "object"
          ? payloadObj.task as Record<string, unknown>
          : null;
        runId = String(task?.run_id || "").trim();
        scopeType = String(task?.scope_type || "").trim() === "chapter" ? "chapter" : "book";
        scopeId = Number(task?.scope_id || 0);
        if (!runId) {
          throw err;
        }
        setBookIngestPanelInfo(`检测到正在运行的摘要任务：${runId}，已自动跟踪进度`);
      }

      if (!runId) {
        throw new Error("继续任务失败：run_id 为空");
      }

      if (scopeType === "book" && Number.isInteger(scopeId) && scopeId > 0) {
        setSummaryBookId(String(scopeId));
      }

      const fallbackName = scopeType === "book"
        ? String(books.find((item) => item.id === scopeId)?.title || "").trim() || `book_${scopeId}`
        : `chapter_${scopeId}`;
      await waitForBookSummaryTask(runId, fallbackName);
    } catch (err) {
      setBookIngestPanelError(errorMessage(err));
    } finally {
      setGeneratingBookSummary(false);
      setBookSummaryTaskActionRunId("");
      void loadBookSummaryTasks({ silent: true });
    }
  }, [books, loadBookSummaryTasks, setBookIngestPanelError, setBookIngestPanelInfo, waitForBookSummaryTask]);

  const handleCancelBookSummaryTask = useCallback(async (runId: string): Promise<void> => {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) {
      setBookIngestPanelError("run_id 不能为空");
      return;
    }

    setBookSummaryTaskActionRunId(normalizedRunId);
    setBookIngestPanelError("");
    setBookIngestPanelInfo(`正在取消摘要任务：${normalizedRunId}...`);
    try {
      const response = await apiCancelAdminBookSummaryTask(normalizedRunId, {
        reason: "cancelled by admin",
      });
      const task = response?.task || null;
      if (task && task.scope_type === "book" && Number.isFinite(task.scope_id) && task.scope_id > 0) {
        setSummaryBookId(String(task.scope_id));
      }
      setBookIngestPanelInfo(String(response?.message || `摘要任务已取消：${normalizedRunId}`));
    } catch (err) {
      setBookIngestPanelError(errorMessage(err));
    } finally {
      setBookSummaryTaskActionRunId("");
      void loadBookSummaryTasks({ silent: true });
    }
  }, [loadBookSummaryTasks, setBookIngestPanelError, setBookIngestPanelInfo]);

  const handlePreviewChapterText = useCallback(async (chapterId?: number): Promise<void> => {
    const targetChapterId = chapterId ?? selectedChapterId;
    if (!targetChapterId) {
      setPanelError("请先选择章节");
      return;
    }

    setLoadingChapterTextPreview(true);
    setPanelError("");
    try {
      const response = await apiGetAdminChapterText(targetChapterId);
      const chapter = response?.chapter;
      if (!chapter) {
        throw new Error("章节原文为空");
      }

      setChapterTextPreview({
        chapter_id: Number(chapter.id),
        book_title: String(chapter.book_title || ""),
        book_author: String(chapter.book_author || ""),
        chapter_index: Number(chapter.chapter_index || 0),
        chapter_title: String(chapter.chapter_title || ""),
        char_count: Number(chapter.char_count || 0),
        word_count: Number(chapter.word_count || 0),
        chapter_text: String(chapter.chapter_text || ""),
      });
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingChapterTextPreview(false);
    }
  }, [selectedChapterId, setPanelError]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    setChapterPage(1);
  }, [bookId, chapterPageSize, includeUsed, keyword, maxCharsInput, minCharsInput, setChapterPage, visible]);

  useEffect(() => {
    setChapterTextPreview(null);
  }, [selectedChapterId]);

  useEffect(() => {
    if (books.length === 0) {
      if (summaryBookId) {
        setSummaryBookId("");
      }
      return;
    }

    const selectedInBooks = books.some((item) => String(item.id) === summaryBookId);
    if (selectedInBooks) {
      return;
    }

    if (bookId && books.some((item) => String(item.id) === String(bookId))) {
      setSummaryBookId(String(bookId));
      return;
    }

    setSummaryBookId(String(books[0].id));
  }, [bookId, books, summaryBookId]);

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

  const hasRunningBookUploadTasks = useMemo(
    () => bookUploadTasks.some((task) => task.status === "queued" || task.status === "running"),
    [bookUploadTasks],
  );
  const hasRunningBookSummaryTasks = useMemo(
    () => bookSummaryTasks.some((task) => task.status === "queued" || task.status === "running"),
    [bookSummaryTasks],
  );

  useEffect(() => {
    if (!visible || !hasRunningBookUploadTasks) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadBookUploadTasks({ silent: true });
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasRunningBookUploadTasks, loadBookUploadTasks, visible]);

  useEffect(() => {
    if (!visible || !hasRunningBookSummaryTasks) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadBookSummaryTasks({ silent: true });
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasRunningBookSummaryTasks, loadBookSummaryTasks, visible]);

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
    setPanelError: setPuzzlePanelError,
    setPanelInfo: setPuzzlePanelInfo,
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

    const timer = window.setTimeout(() => {
      void loadAdminUsers();
    }, 160);

    return () => {
      window.clearTimeout(timer);
    };
  }, [loadAdminUsers, userKeyword, userPage, userPageSize, userRoleFilter, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    if (userPage <= userTotalPages) {
      return;
    }

    setUserPage(userTotalPages);
  }, [setUserPage, userPage, userTotalPages, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadRecentJobs();
    void loadConfigStories();
    void loadLlmConfig();
    void loadBookUploadTasks();
    void loadBookSummaryTasks();
  }, [loadBookSummaryTasks, loadBookUploadTasks, loadConfigStories, loadLlmConfig, loadRecentJobs, visible]);

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
    setPanelError: setPuzzlePanelError,
    setPanelInfo: setPuzzlePanelInfo,
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
    userPage,
    userPageSize,
    userKeyword,
    userRoleFilter,
    userSummary,
    userTotal,
    userTotalPages,
  };

  const usersActions = {
    handleApprovePasswordReset,
    handleRoleToggle,
    loadAdminUsers,
    setUserPage,
    setUserPageSize,
    setUserKeyword,
    setUserRoleFilter,
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

  const llmState = {
    llmProviders,
    llmProfileUserOptions: adminUsers,
    llmEnvKeyOptions,
    selectedLlmProviderId,
    llmProviderDraft,
    llmCreateProviderDraft,
    llmProfileScope,
    llmProfileUserIdInput,
    llmProfile,
    llmEffectiveRuntime,
    llmProfileDraft,
    llmCachedModels,
    loadingLlmConfig,
    savingLlmConfig,
    testingLlmConfig,
    fetchingLlmModels,
    fetchingLlmModelsProviderId,
    lastLlmTest,
    llmFetchedModels,
    llmFetchedModelsByProviderId,
    llmNoticeError,
    llmNoticeInfo,
    lastLlmModelsFetchedAt,
    llmLastModelsFetchedAtByProviderId,
    llmProfileSavedAt,
    llmProviderSavedAt,
  };

  const llmActions = {
    loadLlmConfig,
    handleLlmProviderIdChange,
    handleLlmProviderFieldChange,
    handleLlmProviderKeyFieldChange,
    handleLlmCreateProviderFieldChange,
    handleCreateLlmProvider,
    handleDeleteLlmProvider,
    handleLlmProfileScopeChange,
    handleLlmProfileUserIdInputChange,
    handleLoadLlmUserProfile,
    handleLlmProfileFieldChange,
    handleSaveLlmProvider,
    handleSaveLlmProfile,
    handleTestLlmConfig,
    handleFetchLlmModels,
    handleFetchLlmModelsByProvider,
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
    chapterTextPreview,
    loadingChapterTextPreview,
    reparsingBook,
    summaryBookId,
    generatingBookSummary,
    bookSummaryTaskActionRunId,
    bookUploadTasks,
    loadingBookUploadTasks,
    bookSummaryTasks,
    loadingBookSummaryTasks,
    pendingBookReplace,
    uploadingBook,
  };

  const chapterActions = {
    handleCancelBookReplace,
    handleConfirmBookReplace,
    handleReparseBook,
    handleGenerateBookSummary,
    handleResumeBookSummaryTask,
    handleCancelBookSummaryTask,
    handlePreviewChapterText,
    handleUploadBook,
    handleOpenGeneratedStory,
    handleSubmit,
    loadChapters,
    loadBookUploadTasks,
    loadBookSummaryTasks,
    setBookId,
    setChapterPage,
    setChapterPageSize,
    setIncludeUsed,
    setKeyword,
    setMaxCharsInput,
    setMinCharsInput,
    setSceneCountInput,
    setSelectedChapterId,
    setChapterTextPreview,
    setSummaryBookId,
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
    panelNoticeScope,
    showGenerateDialog,
  };

  const uiActions = {
    setPanelNoticeScope,
    setShowGenerateDialog,
  };

  return {
    chapterActions,
    chapterState,
    constants,
    llmActions,
    llmState,
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
