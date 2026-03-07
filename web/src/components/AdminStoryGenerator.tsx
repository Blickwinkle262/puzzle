import { useCallback, useEffect, useMemo, useState } from "react";

import {
  apiDeleteRunScene,
  apiGenerateRunSceneImage,
  apiGenerateRunSceneImagesBatch,
  apiGenerateRunText,
  apiGrantAdminUserRole,
  apiGetAdminLevelConfig,
  apiGetGenerationRun,
  apiGetStoryDetail,
  apiListAdminBookChapters,
  apiListGenerationRuns,
  apiListAdminUsers,
  apiListStories,
  apiPublishRun,
  apiPreviewAdminLevelConfig,
  apiRevokeAdminUserRole,
  apiRunAdminLevelTest,
  apiUpdateRunScene,
  apiUpdateAdminLevelConfig,
} from "../core/api";
import {
  AdminLevelConfigPatch,
  AdminLevelConfigResponse,
  AdminLevelDifficulty,
  AdminLevelTestRunResponse,
  AdminManagedRole,
  AdminUserSummary,
  StoryListItem,
} from "../core/types";
import {
  useAdminChapterSelectionState,
  useAdminPublishState,
  useAdminRunJobActions,
  useAdminRunReviewState,
  useAdminUserPermissionState,
} from "../hooks/useAdminStoryGeneratorSections";
import {
  AdminChapterSelectionSection,
  AdminGenerateDialogModal,
  AdminStatusBanner,
  AdminRecentJobsList,
  AdminPuzzleGenerateStage,
  AdminPuzzleReviewStage,
  AdminPuzzleSelectStage,
  AdminPublishSection,
  AdminRunReviewSection,
  AdminScenePreviewModal,
  AdminUserPermissionsSection,
} from "./AdminStoryGeneratorSections";
import {
  buildLevelConfigPatch,
  createClientRunId,
  defaultLevelConfigForm,
  defaultSceneCounts,
  errorMessage,
  extractJobProgress,
  formatDurationMs,
  formatGenerationJobStateLabel,
  formatTime,
  formFromLevelConfig,
  isReviewListJob,
  normalizeFlowStage,
  normalizeReviewStatus,
  pickStoryId,
  type JobProgress,
  type LevelConfigFormState,
} from "./admin-story-generator/utils";

type AdminStoryGeneratorProps = {
  visible: boolean;
  onClose: () => void;
  onGenerated: (storyId: string) => Promise<void> | void;
  onOpenStory: (storyId: string) => Promise<void> | void;
};

type LevelOption = {
  id: string;
  title: string;
};

type AdminSectionKey = "users" | "levelConfig" | "puzzle";
type PuzzleFlowStep = "select" | "generate" | "review";

const PUZZLE_FLOW_SEQUENCE: PuzzleFlowStep[] = ["select", "generate", "review"];

const DEFAULT_MIN_CHARS = 500;
const DEFAULT_MAX_CHARS = 2200;
const DEFAULT_SCENE_COUNT = 12;
const MIN_SCENE_COUNT = 6;
const DEFAULT_CHAPTER_PAGE_SIZE = 10;
const CHAPTER_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const CHAPTER_PAGE_SIZE_STORAGE_KEY = "admin_story_generator.chapter_page_size";
const MANAGED_ROLES: AdminManagedRole[] = ["admin", "editor", "level_designer", "operator"];
const MANAGED_LEVEL_DIFFICULTIES: AdminLevelDifficulty[] = ["easy", "normal", "hard", "nightmare"];
const REVIEW_GRID_OPTIONS = Array.from({ length: 19 }, (_, index) => index + 2);
const REVIEW_TIME_OPTIONS = [60, 90, 120, 150, 180, 240, 300, 420, 600];

export function AdminStoryGenerator({ visible, onClose, onGenerated, onOpenStory }: AdminStoryGeneratorProps): JSX.Element | null {
  const {
    adminUsers,
    loadingUsers,
    roleSubmittingKey,
    setAdminUsers,
    setLoadingUsers,
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

  const [configStories, setConfigStories] = useState<StoryListItem[]>([]);
  const [configLevels, setConfigLevels] = useState<LevelOption[]>([]);

  const [loadingConfigCatalog, setLoadingConfigCatalog] = useState(false);
  const [loadingLevelConfig, setLoadingLevelConfig] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configPreviewing, setConfigPreviewing] = useState(false);
  const [configTesting, setConfigTesting] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [panelInfo, setPanelInfo] = useState("");

  const [configStoryId, setConfigStoryId] = useState("");
  const [configLevelId, setConfigLevelId] = useState("");
  const [levelConfigSnapshot, setLevelConfigSnapshot] = useState<AdminLevelConfigResponse | null>(null);
  const [testRunResult, setTestRunResult] = useState<AdminLevelTestRunResponse | null>(null);
  const [levelConfigForm, setLevelConfigForm] = useState<LevelConfigFormState>(defaultLevelConfigForm());
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);

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
  }, []);

  const loadRecentJobs = useCallback(async (): Promise<void> => {
    try {
      const response = await apiListGenerationRuns();
      setRecentJobs((response.runs || []).slice(0, 20));
    } catch {
      // ignore recent jobs errors in panel
    }
  }, []);

  const loadGenerationReview = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    setReviewLoading(true);
    try {
      const response = await apiGetGenerationRun(targetRunId);
      setReviewRunId(targetRunId);
      setReviewScenes((response.scenes || []).filter((item) => !item.deleted_at));
      setReviewCounts(response.counts || defaultSceneCounts());
      setActiveJob(response.job || null);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewLoading(false);
    }
  }, []);

  const loadAdminUsers = useCallback(async (): Promise<void> => {
    setLoadingUsers(true);

    try {
      const response = await apiListAdminUsers({
        keyword: userKeyword.trim() || undefined,
        limit: 120,
      });
      setAdminUsers(response.users || []);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingUsers(false);
    }
  }, [userKeyword]);

  const loadConfigStories = useCallback(async (): Promise<void> => {
    setLoadingConfigCatalog(true);

    try {
      const response = await apiListStories();
      const stories = response.stories || [];
      setConfigStories(stories);

      if (stories.length === 0) {
        setConfigStoryId("");
        setConfigLevelId("");
        setConfigLevels([]);
        setLevelConfigSnapshot(null);
        return;
      }

      if (!stories.some((item) => item.id === configStoryId)) {
        setConfigStoryId(stories[0].id);
      }
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingConfigCatalog(false);
    }
  }, [configStoryId]);

  const loadConfigLevels = useCallback(async (storyId: string): Promise<void> => {
    const targetStoryId = storyId.trim();
    if (!targetStoryId) {
      setConfigLevels([]);
      setConfigLevelId("");
      return;
    }

    setLoadingConfigCatalog(true);
    try {
      const detail = await apiGetStoryDetail(targetStoryId);
      const levelOptions = (detail.story?.levels || []).map((item) => ({
        id: item.id,
        title: item.title,
      }));

      setConfigLevels(levelOptions);
      if (levelOptions.length === 0) {
        setConfigLevelId("");
        setLevelConfigSnapshot(null);
        return;
      }

      if (!levelOptions.some((item) => item.id === configLevelId)) {
        setConfigLevelId(levelOptions[0].id);
      }
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingConfigCatalog(false);
    }
  }, [configLevelId]);

  const loadLevelConfig = useCallback(async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      return;
    }

    setLoadingLevelConfig(true);
    setTestRunResult(null);
    try {
      const snapshot = await apiGetAdminLevelConfig(configStoryId, configLevelId);
      setLevelConfigSnapshot(snapshot);
      setLevelConfigForm(formFromLevelConfig(snapshot));
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingLevelConfig(false);
    }
  }, [configLevelId, configStoryId]);

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
  }, [bookId, chapterPage, chapterPageSize, includeUsed, keyword, maxCharsInput, minCharsInput, selectedChapterId]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    setChapterPage(1);
  }, [bookId, chapterPageSize, includeUsed, keyword, maxCharsInput, minCharsInput, visible]);

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

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadRecentJobs();
    void loadAdminUsers();
    void loadConfigStories();
  }, [visible]);

  useEffect(() => {
    if (!visible || !configStoryId) {
      return;
    }

    void loadConfigLevels(configStoryId);
  }, [configStoryId, loadConfigLevels, visible]);

  useEffect(() => {
    if (!visible || !configStoryId || !configLevelId) {
      return;
    }

    void loadLevelConfig();
  }, [configLevelId, configStoryId, loadLevelConfig, visible]);

  const handleRoleToggle = async (targetUser: AdminUserSummary, role: AdminManagedRole): Promise<void> => {
    const hasRole = targetUser.roles.includes(role);
    const actionKey = `${targetUser.id}:${role}:${hasRole ? "revoke" : "grant"}`;

    setRoleSubmittingKey(actionKey);
    setPanelError("");
    setPanelInfo("");

    try {
      if (hasRole) {
        await apiRevokeAdminUserRole(targetUser.id, role);
        setPanelInfo(`已移除 ${targetUser.username} 的 ${role} 角色`);
      } else {
        await apiGrantAdminUserRole(targetUser.id, role, "granted via admin panel");
        setPanelInfo(`已授予 ${targetUser.username} 的 ${role} 角色`);
      }
      await loadAdminUsers();
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setRoleSubmittingKey("");
    }
  };

  const handleConfigFormChange = (patch: Partial<LevelConfigFormState>): void => {
    setLevelConfigForm((prev) => ({
      ...prev,
      ...patch,
    }));
  };

  const handlePreviewLevelConfig = async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      setPanelError("请先选择故事和关卡");
      return;
    }

    const parsed = buildLevelConfigPatch(levelConfigForm);
    if (!parsed.ok) {
      setPanelError(parsed.message || "配置参数不合法");
      return;
    }

    setConfigPreviewing(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const snapshot = await apiPreviewAdminLevelConfig(configStoryId, configLevelId, parsed.patch || {});
      setLevelConfigSnapshot(snapshot);
      setPanelInfo("预览配置已更新（未落库）");
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setConfigPreviewing(false);
    }
  };

  const handleSaveLevelConfig = async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      setPanelError("请先选择故事和关卡");
      return;
    }

    const parsed = buildLevelConfigPatch(levelConfigForm);
    if (!parsed.ok) {
      setPanelError(parsed.message || "配置参数不合法");
      return;
    }

    setConfigSaving(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const snapshot = await apiUpdateAdminLevelConfig(configStoryId, configLevelId, parsed.patch || {});
      setLevelConfigSnapshot(snapshot);
      setLevelConfigForm(formFromLevelConfig(snapshot));
      setPanelInfo("关卡配置已保存");
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setConfigSaving(false);
    }
  };

  const handleTestLevelConfig = async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      setPanelError("请先选择故事和关卡");
      return;
    }

    const parsed = buildLevelConfigPatch(levelConfigForm);
    if (!parsed.ok) {
      setPanelError(parsed.message || "配置参数不合法");
      return;
    }

    setConfigTesting(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const result = await apiRunAdminLevelTest(configStoryId, configLevelId, parsed.patch || {});
      setTestRunResult(result);
      setLevelConfigSnapshot({
        ok: true,
        ...result.config,
      });
      setPanelInfo(`测试关卡已生成：${result.test_run_id}`);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setConfigTesting(false);
    }
  };

  useEffect(() => {
    if (!visible || !activeRunId) {
      return;
    }

    let disposed = false;

    const poll = async (): Promise<void> => {
      try {
        const detail = await apiGetGenerationRun(activeRunId);
        if (disposed) {
          return;
        }

        setActiveJob(detail.job);

        if (reviewRunId && reviewRunId === activeRunId) {
          setReviewScenes((detail.scenes || []).filter((item) => !item.deleted_at));
          setReviewCounts(detail.counts || defaultSceneCounts());
        }

        const job = detail.job;
        const flowStage = normalizeFlowStage(job.flow_stage);

        if (flowStage === "published" || normalizeReviewStatus(job.review_status) === "published") {
          const storyId = pickStoryId(job);
          const publishedAtText = job.published_at ? `（${formatTime(job.published_at)}）` : "";
          setPanelInfo(storyId
            ? `任务已发布：${storyId}${publishedAtText}`
            : `任务已发布${publishedAtText}`);
          setActiveRunId("");
          if (storyId) {
            await onGenerated(storyId);
          }
          await loadGenerationReview(job.run_id);
          await loadRecentJobs();
          return;
        }

        if (flowStage === "review_ready") {
          setPanelInfo(`文案与图片已准备完毕：${job.run_id}`);
          setActiveRunId("");
          await loadGenerationReview(job.run_id);
          await loadRecentJobs();
          return;
        }

        if (job.status === "failed" || job.status === "cancelled" || flowStage === "failed") {
          setPanelError(job.error_message || "生成任务失败");
          setActiveRunId("");
          await loadRecentJobs();
        }
      } catch (err) {
        if (!disposed) {
          setPanelError(errorMessage(err));
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, loadGenerationReview, loadRecentJobs, onGenerated, reviewRunId, visible]);

  useEffect(() => {
    if (!visible || !reviewRunId) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadGenerationReview(reviewRunId);
    }, 4000);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadGenerationReview, reviewRunId, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    if (activeRunId && puzzleFlowStep === "select") {
      setPuzzleFlowStep("generate");
    }
  }, [activeRunId, puzzleFlowStep, visible]);

  const handleViewJobProgress = useCallback((runId: string): void => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    setPanelError("");
    setPanelInfo(`正在查看任务进度：${targetRunId}`);
    setShowGenerateDialog(false);
    setReviewRunId(targetRunId);
    setReviewScenes([]);
    setReviewCounts(defaultSceneCounts());
    setActiveJob(null);
    setActiveRunId(targetRunId);
    setPuzzleFlowStep("generate");
    setCollapsedSections((prev) => ({
      ...prev,
      puzzle: false,
    }));
    void loadGenerationReview(targetRunId);
  }, [loadGenerationReview]);


  const { handleCancelRun, handleDeleteRun, handleOpenReview } = useAdminRunJobActions({
    activeRunId,
    defaultSceneCounts,
    loadGenerationReview,
    loadRecentJobs,
    recentJobs,
    reviewRunId,
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
    toErrorMessage: errorMessage,
  });

  const handleUpdateReviewScene = useCallback(async (
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
  ): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewUpdatingSceneIndex(sceneIndex);
    setPanelError("");

    try {
      await apiUpdateRunScene(reviewRunId, sceneIndex, payload);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewUpdatingSceneIndex(null);
    }
  }, [loadGenerationReview, reviewLocked, reviewRunId]);

  const handlePublishSelected = useCallback(async (): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewPublishing(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const response = await apiPublishRun(reviewRunId);
      setPanelInfo(`发布完成：${response.story_id}（${response.level_count} 关）`);
      await loadGenerationReview(reviewRunId);
      await loadRecentJobs();
      if (response.story_id) {
        await onGenerated(response.story_id);
        setPublishSuccess({
          run_id: reviewRunId,
          story_id: response.story_id,
          level_count: Number(response.level_count || 0),
        });
      }
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewPublishing(false);
    }
  }, [loadGenerationReview, loadRecentJobs, onGenerated, reviewLocked, reviewRunId]);

  const handleOpenPublishedStory = useCallback(async (): Promise<void> => {
    if (!publishSuccess?.story_id) {
      return;
    }

    setPanelError("");
    try {
      await onOpenStory(publishSuccess.story_id);
      setPublishSuccess(null);
      onClose();
    } catch (err) {
      setPanelError(errorMessage(err));
    }
  }, [onClose, onOpenStory, publishSuccess]);

  const handleStayAfterPublish = useCallback((): void => {
    setPublishSuccess(null);
  }, []);

  const handleRetryReviewCandidate = useCallback(async (sceneIndex: number): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewRetryingSceneIndex(sceneIndex);
    setPanelError("");

    try {
      await apiGenerateRunSceneImage(reviewRunId, sceneIndex);
      setPanelInfo(`已重新出图：scene ${sceneIndex}`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewRetryingSceneIndex(null);
    }
  }, [loadGenerationReview, reviewLocked, reviewRunId]);

  const handleBatchGenerateImages = useCallback(async (): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewBatchGenerating(true);
    setPanelError("");

    try {
      const pendingSceneIndexes = reviewScenes
        .filter((scene) => scene.image_status === "pending" || scene.image_status === "failed" || scene.image_status === "skipped")
        .map((scene) => scene.scene_index);
      await apiGenerateRunSceneImagesBatch(reviewRunId, {
        scene_indexes: pendingSceneIndexes,
        concurrency: 3,
      });
      setPanelInfo(`批量出图已完成：${pendingSceneIndexes.length} 个 scene`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewBatchGenerating(false);
    }
  }, [loadGenerationReview, reviewLocked, reviewRunId, reviewScenes]);

  const handleDeleteReviewScene = useCallback(async (sceneIndex: number): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    const confirmed = window.confirm(`确认删除 scene ${sceneIndex} 吗？`);
    if (!confirmed) {
      return;
    }

    setReviewDeletingSceneIndex(sceneIndex);
    setPanelError("");
    try {
      await apiDeleteRunScene(reviewRunId, sceneIndex);
      setPanelInfo(`已删除 scene ${sceneIndex}`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewDeletingSceneIndex(null);
    }
  }, [loadGenerationReview, reviewLocked, reviewRunId]);



  const handleOpenGeneratedStory = async (storyId: string): Promise<void> => {
    const targetId = storyId.trim();
    if (!targetId) {
      setPanelError("未找到可打开的 story_id");
      return;
    }

    setPanelError("");
    setPanelInfo(`正在打开故事：${targetId}`);
    try {
      await onOpenStory(targetId);
    } catch (err) {
      setPanelError(errorMessage(err));
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (!selectedChapterId) {
      setPanelError("请先选择一个章节");
      return;
    }

    const requestedSceneCount = Number(sceneCountInput);
    if (!Number.isInteger(requestedSceneCount) || requestedSceneCount < MIN_SCENE_COUNT) {
      setPanelError(`生成张数必须是大于 5 的整数（建议 ${DEFAULT_SCENE_COUNT}）`);
      return;
    }

    if (selectedChapter?.has_succeeded_story) {
      const storyHint = selectedChapter.generated_story_id ? `（已生成：${selectedChapter.generated_story_id}）` : "";
      const confirmed = window.confirm(`该章节已生成过${storyHint}，确认重新生成吗？`);
      if (!confirmed) {
        return;
      }
    }

    setSubmitting(true);
    setPanelError("");
    setPanelInfo("");
    setShowGenerateDialog(false);

    try {
      const runId = createClientRunId();
      await apiGenerateRunText(runId, {
        chapter_id: selectedChapterId,
        target_date: targetDate,
        scene_count: requestedSceneCount,
      });

      setReviewRunId(runId);
      setReviewScenes([]);
      setReviewCounts(defaultSceneCounts());
      setActiveRunId(runId);
      setActiveJob(null);
      setPuzzleFlowStep("generate");
      setPanelInfo(`文案已生成：${runId}（目标 ${requestedSceneCount} 张），请在第二步确认拆分并触发出图`);
      await loadGenerationReview(runId);
      await loadRecentJobs();
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

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

  if (!visible) {
    return null;
  }

  return (
    <section className="account-panel admin-panel">
      <h3>管理后台</h3>
      <p>这里统一处理人员权限、关卡配置（预览/测试）和谜题生成任务。</p>

      <AdminStatusBanner
        activeRunId={activeRunId}
        panelError={panelError}
        panelInfo={panelInfo}
        resumableJob={resumableJob}
        onViewJobProgress={handleViewJobProgress}
      />

      <AdminUserPermissionsSection
        adminUsers={adminUsers}
        collapsed={collapsedSections.users}
        loadingUsers={loadingUsers}
        managedRoles={MANAGED_ROLES}
        roleSubmittingKey={roleSubmittingKey}
        userKeyword={userKeyword}
        formatDurationMs={formatDurationMs}
        formatTime={formatTime}
        onRefreshUsers={() => void loadAdminUsers()}
        onRoleToggle={(user, role) => {
          void handleRoleToggle(user, role);
        }}
        onToggleSection={() => toggleSection("users")}
        onUserKeywordChange={setUserKeyword}
      />

      <AdminChapterSelectionSection
        collapsed={collapsedSections.levelConfig}
        configLevelId={configLevelId}
        configLevels={configLevels}
        configPreviewing={configPreviewing}
        configSaving={configSaving}
        configStoryId={configStoryId}
        configStories={configStories}
        configTesting={configTesting}
        levelConfigForm={levelConfigForm}
        levelConfigSnapshot={levelConfigSnapshot}
        loadingConfigCatalog={loadingConfigCatalog}
        loadingLevelConfig={loadingLevelConfig}
        managedLevelDifficulties={MANAGED_LEVEL_DIFFICULTIES}
        testRunResult={testRunResult}
        onConfigFormChange={handleConfigFormChange}
        onConfigLevelIdChange={(value) => {
          setConfigLevelId(value);
          setLevelConfigSnapshot(null);
          setTestRunResult(null);
        }}
        onConfigStoryIdChange={(value) => {
          setConfigStoryId(value);
          setConfigLevelId("");
          setLevelConfigSnapshot(null);
          setTestRunResult(null);
        }}
        onLoadConfigStories={() => void loadConfigStories()}
        onLoadLevelConfig={() => void loadLevelConfig()}
        onPreviewLevelConfig={() => void handlePreviewLevelConfig()}
        onSaveLevelConfig={() => void handleSaveLevelConfig()}
        onTestLevelConfig={() => void handleTestLevelConfig()}
        onToggleSection={() => toggleSection("levelConfig")}
      />

      <AdminRunReviewSection
        canGoNextFlowStep={canGoNextFlowStep}
        canGoPrevFlowStep={canGoPrevFlowStep}
        canJumpGenerateStep={canJumpGenerateStep}
        canJumpReviewStep={canJumpReviewStep}
        collapsed={collapsedSections.puzzle}
        currentFlowStepIndex={currentFlowStepIndex}
        flowStepCount={PUZZLE_FLOW_SEQUENCE.length}
        puzzleFlowStep={puzzleFlowStep}
        onSetPuzzleFlowStep={setPuzzleFlowStep}
        onToggleSection={() => toggleSection("puzzle")}
      >

            {puzzleFlowStep === "select" && (
              <AdminPuzzleSelectStage
                bookId={bookId}
                books={books}
                canJumpGenerateStep={canJumpGenerateStep}
                chapterPage={chapterPage}
                chapterPageSize={chapterPageSize}
                chapterPageSizeOptions={CHAPTER_PAGE_SIZE_OPTIONS}
                chapterTotal={chapterTotal}
                chapters={chapters}
                includeUsed={includeUsed}
                keyword={keyword}
                loadingChapters={loadingChapters}
                maxCharsInput={maxCharsInput}
                minCharsInput={minCharsInput}
                selectedChapter={selectedChapter}
                selectedChapterId={selectedChapterId}
                submitting={submitting}
                totalChapterPages={totalChapterPages}
                onBookIdChange={setBookId}
                onChapterPageSizeChange={(nextPageSize) => {
                  if (!CHAPTER_PAGE_SIZE_OPTIONS.includes(nextPageSize as (typeof CHAPTER_PAGE_SIZE_OPTIONS)[number])) {
                    return;
                  }
                  setChapterPageSize(nextPageSize);
                  setChapterPage(1);
                }}
                onClose={onClose}
                onIncludeUsedChange={setIncludeUsed}
                onKeywordChange={setKeyword}
                onLoadChapters={() => {
                  void loadChapters();
                }}
                onMaxCharsInputChange={setMaxCharsInput}
                onMinCharsInputChange={setMinCharsInput}
                onNextPage={() => setChapterPage((page) => Math.min(totalChapterPages, page + 1))}
                onOpenGeneratedStory={(storyId) => {
                  void handleOpenGeneratedStory(storyId);
                }}
                onOpenGenerateDialog={() => setShowGenerateDialog(true)}
                onPrevPage={() => setChapterPage((page) => Math.max(1, page - 1))}
                onSelectChapterId={setSelectedChapterId}
                onSetPuzzleFlowGenerate={() => setPuzzleFlowStep("generate")}
              />
            )}

            {puzzleFlowStep === "generate" && (
              <AdminPuzzleGenerateStage
                activeJob={activeJob}
                activeRunId={activeRunId}
                formatGenerationJobStateLabel={formatGenerationJobStateLabel}
                onBatchGenerateImages={() => {
                  void handleBatchGenerateImages();
                }}
                onDeleteReviewScene={(sceneIndex) => {
                  void handleDeleteReviewScene(sceneIndex);
                }}
                onLoadGenerationReview={(runId) => {
                  void loadGenerationReview(runId);
                }}
                onOpenGenerateDialog={() => setShowGenerateDialog(true)}
                onRetryReviewCandidate={(sceneIndex) => {
                  void handleRetryReviewCandidate(sceneIndex);
                }}
                onSetPuzzleFlowReview={() => setPuzzleFlowStep("review")}
                onSetPuzzleFlowSelect={() => setPuzzleFlowStep("select")}
                onSetScenePreview={setScenePreview}
                onViewJobProgress={handleViewJobProgress}
                progress={progress}
                renderRecentJobsGenerate={(
                  <AdminRecentJobsList
                    {...recentJobsListCommonProps}
                    mode="generate"
                  />
                )}
                resumableJob={resumableJob}
                reviewBatchGenerating={reviewBatchGenerating}
                reviewCounts={reviewCounts}
                reviewDeletingSceneIndex={reviewDeletingSceneIndex}
                reviewLoading={reviewLoading}
                reviewLocked={reviewLocked}
                reviewPendingImageCount={reviewPendingImageCount}
                reviewPublishing={reviewPublishing}
                reviewRetryingSceneIndex={reviewRetryingSceneIndex}
                reviewRunId={reviewRunId}
                reviewScenes={reviewScenes}
                selectedChapter={selectedChapter}
                submitting={submitting}
              />
            )}

            {puzzleFlowStep === "review" && (
              <AdminPuzzleReviewStage
                activeJob={activeJob}
                formatTime={formatTime}
                onLoadGenerationReview={(runId) => {
                  void loadGenerationReview(runId);
                }}
                onPublishSelected={() => {
                  void handlePublishSelected();
                }}
                onSetPuzzleFlowGenerate={() => setPuzzleFlowStep("generate")}
                onSetScenePreview={setScenePreview}
                onUpdateReviewScene={(sceneIndex, patch) => {
                  void handleUpdateReviewScene(sceneIndex, patch);
                }}
                renderRecentJobsReview={(
                  <AdminRecentJobsList
                    {...recentJobsListCommonProps}
                    mode="review"
                  />
                )}
                reviewBatchGenerating={reviewBatchGenerating}
                reviewCounts={reviewCounts}
                reviewGridOptions={REVIEW_GRID_OPTIONS}
                reviewLoading={reviewLoading}
                reviewLocked={reviewLocked}
                reviewPendingImageCount={reviewPendingImageCount}
                reviewPublishing={reviewPublishing}
                reviewReadyCount={reviewReadyCount}
                reviewRunId={reviewRunId}
                reviewScenes={reviewScenes}
                reviewTimeOptions={REVIEW_TIME_OPTIONS}
                reviewUpdatingSceneIndex={reviewUpdatingSceneIndex}
              />
            )}

      </AdminRunReviewSection>

      <AdminPublishSection
        publishSuccess={publishSuccess}
        onOpenPublishedStory={() => {
          void handleOpenPublishedStory();
        }}
        onStayAfterPublish={handleStayAfterPublish}
      />

      <AdminScenePreviewModal
        scenePreview={scenePreview}
        onClose={() => setScenePreview(null)}
      />

      <AdminGenerateDialogModal
        open={showGenerateDialog}
        defaultSceneCount={DEFAULT_SCENE_COUNT}
        sceneCountInput={sceneCountInput}
        selectedChapter={selectedChapter}
        submitting={submitting}
        targetDate={targetDate}
        onClose={() => setShowGenerateDialog(false)}
        onSceneCountInputChange={setSceneCountInput}
        onSubmit={() => {
          void handleSubmit();
        }}
        onTargetDateChange={setTargetDate}
      />

    </section>
  );
}
