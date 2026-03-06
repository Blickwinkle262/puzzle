import { useCallback, useEffect, useMemo, useState } from "react";

import {
  apiCancelRun,
  apiDeleteRunScene,
  apiDeleteRun,
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
  ApiError,
} from "../core/api";
import {
  AdminBookInfo,
  AdminChapterSummary,
  AdminLevelConfigPatch,
  AdminLevelConfigResponse,
  AdminLevelDifficulty,
  AdminLevelTestRunResponse,
  AdminGenerationScene,
  AdminGenerationSceneCounts,
  AdminGenerationJob,
  AdminGenerationJobDetail,
  AdminManagedRole,
  AdminUserSummary,
  StoryListItem,
} from "../core/types";

type AdminStoryGeneratorProps = {
  visible: boolean;
  onClose: () => void;
  onGenerated: (storyId: string) => Promise<void> | void;
  onOpenStory: (storyId: string) => Promise<void> | void;
};

type JobProgress = {
  value: number;
  completed: number;
  total: number;
  message: string;
};

type LevelOption = {
  id: string;
  title: string;
};

type LevelConfigFormState = {
  enabled: boolean;
  grid_rows: string;
  grid_cols: string;
  time_limit_sec: string;
  difficulty: "" | AdminLevelDifficulty;
  difficulty_factor: string;
  content_version: string;
};

type AdminSectionKey = "users" | "levelConfig" | "puzzle";
type PuzzleFlowStep = "select" | "generate" | "review";

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
  const [books, setBooks] = useState<AdminBookInfo[]>([]);
  const [chapters, setChapters] = useState<AdminChapterSummary[]>([]);
  const [recentJobs, setRecentJobs] = useState<AdminGenerationJob[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUserSummary[]>([]);
  const [configStories, setConfigStories] = useState<StoryListItem[]>([]);
  const [configLevels, setConfigLevels] = useState<LevelOption[]>([]);

  const [loadingChapters, setLoadingChapters] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingConfigCatalog, setLoadingConfigCatalog] = useState(false);
  const [loadingLevelConfig, setLoadingLevelConfig] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configPreviewing, setConfigPreviewing] = useState(false);
  const [configTesting, setConfigTesting] = useState(false);
  const [roleSubmittingKey, setRoleSubmittingKey] = useState("");
  const [panelError, setPanelError] = useState("");
  const [panelInfo, setPanelInfo] = useState("");

  const [bookId, setBookId] = useState<string>("");
  const [keyword, setKeyword] = useState("");
  const [userKeyword, setUserKeyword] = useState("");
  const [configStoryId, setConfigStoryId] = useState("");
  const [configLevelId, setConfigLevelId] = useState("");
  const [minCharsInput, setMinCharsInput] = useState(String(DEFAULT_MIN_CHARS));
  const [maxCharsInput, setMaxCharsInput] = useState(String(DEFAULT_MAX_CHARS));
  const [includeUsed, setIncludeUsed] = useState(true);

  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null);
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sceneCountInput, setSceneCountInput] = useState(String(DEFAULT_SCENE_COUNT));
  const [chapterPage, setChapterPage] = useState(1);
  const [chapterPageSize, setChapterPageSize] = useState<number>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_CHAPTER_PAGE_SIZE;
    }

    const savedValue = Number(window.localStorage.getItem(CHAPTER_PAGE_SIZE_STORAGE_KEY));
    return CHAPTER_PAGE_SIZE_OPTIONS.includes(savedValue as (typeof CHAPTER_PAGE_SIZE_OPTIONS)[number])
      ? savedValue
      : DEFAULT_CHAPTER_PAGE_SIZE;
  });
  const [chapterTotal, setChapterTotal] = useState(0);

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
  const [levelConfigSnapshot, setLevelConfigSnapshot] = useState<AdminLevelConfigResponse | null>(null);
  const [testRunResult, setTestRunResult] = useState<AdminLevelTestRunResponse | null>(null);
  const [levelConfigForm, setLevelConfigForm] = useState<LevelConfigFormState>(defaultLevelConfigForm());
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [scenePreview, setScenePreview] = useState<ScenePreviewState | null>(null);
  const [publishSuccess, setPublishSuccess] = useState<PublishSuccessState | null>(null);
  const [puzzleFlowStep, setPuzzleFlowStep] = useState<PuzzleFlowStep>("select");
  const [collapsedSections, setCollapsedSections] = useState<Record<AdminSectionKey, boolean>>({
    users: true,
    levelConfig: true,
    puzzle: true,
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
  }, [loadGenerationReview]);

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
      setPanelError(errorMessage(err));
    } finally {
      setRunCancellingId("");
    }
  }, [activeRunId, loadGenerationReview, loadRecentJobs, reviewRunId]);

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
      setPanelError(errorMessage(err));
    } finally {
      setRunDeletingId("");
    }
  }, [activeRunId, loadRecentJobs, recentJobs, reviewRunId]);

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

  const renderRecentJobs = (mode: "all" | "generate" | "review"): JSX.Element => {
    const filteredJobs = recentJobs
      .filter((job) => {
        if (mode === "generate") {
          return job.status === "running" || job.status === "queued";
        }
        if (mode === "review") {
          return isReviewListJob(job);
        }
        return true;
      })
      .slice(0, 8);

    if (filteredJobs.length === 0) {
      if (mode === "generate") {
        return <p className="progress-inline">暂无运行中的任务。</p>;
      }
      if (mode === "review") {
        return <p className="progress-inline">暂无可编辑任务，请先完成文案生成。</p>;
      }
      return <p className="progress-inline">暂无任务记录。</p>;
    }

    return (
      <ul>
        {filteredJobs.map((job) => {
          const flowStage = normalizeFlowStage(job.flow_stage);
          const progressViewable = job.status === "running"
            || job.status === "queued"
            || flowStage === "text_generating"
            || flowStage === "images_generating";
          const reviewViewable = isReviewListJob(job);
          const viewing = activeRunId === job.run_id;
          const reviewing = reviewRunId === job.run_id;
          const reviewStatus = normalizeReviewStatus(job.review_status);
          const published = reviewStatus === "published" || flowStage === "published";
          const cancelling = runCancellingId === job.run_id;
          const deleting = runDeletingId === job.run_id;
          const cancellable = !published && (
            job.status === "queued"
            || job.status === "running"
            || flowStage === "text_generating"
            || flowStage === "text_ready"
            || flowStage === "images_generating"
            || flowStage === "review_ready"
          );
          const deletable = !published && (job.status === "failed" || job.status === "cancelled" || job.status === "queued");

          return (
            <li key={job.run_id}>
              <span>{job.run_id}</span>
              <span className={`level-state ${generationJobStateClass(job)}`}>{formatGenerationJobStateLabel(job)}</span>
              <span>{job.target_date}</span>
              {progressViewable && (
                <button
                  type="button"
                  className="nav-btn admin-job-view-btn"
                  onClick={() => handleViewJobProgress(job.run_id)}
                  disabled={viewing}
                >
                  {viewing ? "查看中" : "查看进度"}
                </button>
              )}
              {reviewViewable && (
                <button
                  type="button"
                  className="nav-btn admin-job-view-btn"
                  onClick={() => void handleOpenReview(job.run_id)}
                  disabled={reviewing}
                >
                  {reviewing
                    ? "查看中"
                    : reviewStatus === "published" || flowStage === "published"
                      ? "查看状态"
                      : "编辑发布"}
                </button>
              )}
              {cancellable && (
                <button
                  type="button"
                  className="nav-btn"
                  disabled={cancelling || deleting}
                  onClick={() => void handleCancelRun(job.run_id)}
                >
                  {cancelling ? "取消中" : "取消"}
                </button>
              )}
              {deletable && (
                <button
                  type="button"
                  className="nav-btn"
                  disabled={cancelling || deleting}
                  onClick={() => void handleDeleteRun(job.run_id)}
                >
                  {deleting ? "删除中" : "删除"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
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

      {panelError && <div className="banner-error">{panelError}</div>}
      {panelInfo && <div className="banner-info">{panelInfo}</div>}
      {resumableJob && !activeRunId && (
        <div className="banner-info admin-running-banner">
          <span>检测到未完成任务：{resumableJob.run_id}（{formatGenerationJobStateLabel(resumableJob)}）</span>
          <button type="button" className="nav-btn" onClick={() => handleViewJobProgress(resumableJob.run_id)}>
            查看进度
          </button>
        </div>
      )}

      <div className="admin-run-box admin-collapsible-box">
        <button
          type="button"
          className={`admin-collapse-head ${collapsedSections.users ? "collapsed" : ""}`}
          onClick={() => toggleSection("users")}
        >
          <h4>用户权限管理</h4>
          <span className="admin-collapse-icon" aria-hidden="true">▾</span>
        </button>

        {!collapsedSections.users && (
          <>
        <div className="admin-user-toolbar">
          <label className="form-field">
            用户名检索
            <input value={userKeyword} onChange={(event) => setUserKeyword(event.currentTarget.value)} placeholder="输入用户名关键字" />
          </label>

          <div className="inline-actions">
            <button type="button" className="nav-btn" onClick={() => void loadAdminUsers()} disabled={loadingUsers}>
              {loadingUsers ? "加载中..." : "刷新用户"}
            </button>
          </div>
        </div>

        <div className="admin-chapter-table">
          {adminUsers.length === 0 ? (
            <div className="progress-inline">暂无匹配用户。</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>当前角色</th>
                  <th>关卡最快</th>
                  <th>权限操作</th>
                  <th>最近登录</th>
                </tr>
              </thead>
              <tbody>
                {adminUsers.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.username}</strong>
                      {user.is_guest ? <span className="level-state todo">guest</span> : null}
                      {user.is_admin ? <span className="level-state done">admin访问</span> : null}
                    </td>
                    <td>
                      <div className="admin-role-list">
                        {user.roles.length > 0
                          ? user.roles.map((role) => (
                            <span key={`${user.id}-${role}`} className="level-state done">{role}</span>
                          ))
                          : <span className="level-state todo">无角色</span>}
                      </div>
                    </td>
                    <td>
                      <div className="admin-user-best-time-cell">
                        {user.fastest_level_time_ms && user.fastest_level_time_ms > 0 ? (
                          <>
                            <span className="level-state done">最快 {formatDurationMs(user.fastest_level_time_ms)}</span>
                            <span className="progress-inline">记录关卡 {user.best_time_level_count} · 已通关 {user.completed_level_count}</span>
                          </>
                        ) : (
                          <span className="level-state todo">暂无成绩</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="admin-role-actions">
                        {MANAGED_ROLES.map((role) => {
                          const hasRole = user.roles.includes(role);
                          const actionKey = `${user.id}:${role}:${hasRole ? "revoke" : "grant"}`;

                          return (
                            <button
                              key={`${user.id}-action-${role}`}
                              type="button"
                              className={hasRole ? "link-btn" : "nav-btn"}
                              disabled={Boolean(roleSubmittingKey)}
                              onClick={() => void handleRoleToggle(user, role)}
                            >
                              {roleSubmittingKey === actionKey
                                ? "处理中..."
                                : hasRole
                                  ? `移除 ${role}`
                                  : `授予 ${role}`}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td>{formatTime(user.last_login_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
          </>
        )}
      </div>

<div className="admin-run-box admin-collapsible-box">
        <button
          type="button"
          className={`admin-collapse-head ${collapsedSections.levelConfig ? "collapsed" : ""}`}
          onClick={() => toggleSection("levelConfig")}
        >
          <h4>关卡配置 / 预览 / 测试</h4>
          <span className="admin-collapse-icon" aria-hidden="true">▾</span>
        </button>

        {!collapsedSections.levelConfig && (
          <>

        <div className="admin-config-grid">
          <label className="form-field">
            故事
            <select
              value={configStoryId}
              onChange={(event) => {
                setConfigStoryId(event.currentTarget.value);
                setConfigLevelId("");
                setLevelConfigSnapshot(null);
                setTestRunResult(null);
              }}
            >
              <option value="">请选择故事</option>
              {configStories.map((story) => (
                <option key={story.id} value={story.id}>
                  {story.title || story.id}
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            关卡
            <select
              value={configLevelId}
              onChange={(event) => {
                setConfigLevelId(event.currentTarget.value);
                setLevelConfigSnapshot(null);
                setTestRunResult(null);
              }}
            >
              <option value="">请选择关卡</option>
              {configLevels.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.title || level.id}
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            启用 override
            <input
              type="checkbox"
              checked={levelConfigForm.enabled}
              onChange={(event) => handleConfigFormChange({ enabled: event.currentTarget.checked })}
            />
          </label>

          <label className="form-field">
            行数（grid_rows）
            <input
              value={levelConfigForm.grid_rows}
              onChange={(event) => handleConfigFormChange({ grid_rows: event.currentTarget.value })}
              placeholder="留空=不覆盖"
              inputMode="numeric"
            />
          </label>

          <label className="form-field">
            列数（grid_cols）
            <input
              value={levelConfigForm.grid_cols}
              onChange={(event) => handleConfigFormChange({ grid_cols: event.currentTarget.value })}
              placeholder="留空=不覆盖"
              inputMode="numeric"
            />
          </label>

          <label className="form-field">
            时限（time_limit_sec）
            <input
              value={levelConfigForm.time_limit_sec}
              onChange={(event) => handleConfigFormChange({ time_limit_sec: event.currentTarget.value })}
              placeholder="留空=自动计算"
              inputMode="numeric"
            />
          </label>

          <label className="form-field">
            难度（difficulty）
            <select
              value={levelConfigForm.difficulty}
              onChange={(event) => handleConfigFormChange({ difficulty: event.currentTarget.value as "" | AdminLevelDifficulty })}
            >
              <option value="">留空=normal</option>
              {MANAGED_LEVEL_DIFFICULTIES.map((difficulty) => (
                <option key={difficulty} value={difficulty}>{difficulty}</option>
              ))}
            </select>
          </label>

          <label className="form-field">
            难度系数（difficulty_factor）
            <input
              value={levelConfigForm.difficulty_factor}
              onChange={(event) => handleConfigFormChange({ difficulty_factor: event.currentTarget.value })}
              placeholder="留空=策略默认"
              inputMode="decimal"
            />
          </label>

          <label className="form-field">
            content_version
            <input
              value={levelConfigForm.content_version}
              onChange={(event) => handleConfigFormChange({ content_version: event.currentTarget.value })}
              placeholder="留空=沿用"
              inputMode="numeric"
            />
          </label>
        </div>

        <div className="admin-config-actions inline-actions">
          <button type="button" className="nav-btn" onClick={() => void loadConfigStories()} disabled={loadingConfigCatalog}>
            {loadingConfigCatalog ? "加载中..." : "刷新故事"}
          </button>
          <button type="button" className="nav-btn" onClick={() => void loadLevelConfig()} disabled={!configStoryId || !configLevelId || loadingLevelConfig}>
            {loadingLevelConfig ? "读取中..." : "读取配置"}
          </button>
          <button type="button" className="nav-btn" onClick={() => void handlePreviewLevelConfig()} disabled={!configStoryId || !configLevelId || configPreviewing}>
            {configPreviewing ? "预览中..." : "预览配置"}
          </button>
          <button type="button" className="primary-btn" onClick={() => void handleSaveLevelConfig()} disabled={!configStoryId || !configLevelId || configSaving}>
            {configSaving ? "保存中..." : "保存配置"}
          </button>
          <button type="button" className="link-btn" onClick={() => void handleTestLevelConfig()} disabled={!configStoryId || !configLevelId || configTesting}>
            {configTesting ? "测试中..." : "测试关卡"}
          </button>
        </div>

        {levelConfigSnapshot && (
          <div className="admin-config-summary">
            <div>
              <strong>基础配置：</strong>
              <pre>{JSON.stringify(levelConfigSnapshot.base_config, null, 2)}</pre>
            </div>
            <div>
              <strong>当前生效：</strong>
              <pre>{JSON.stringify(levelConfigSnapshot.effective_config, null, 2)}</pre>
            </div>
            {levelConfigSnapshot.preview_effective_config && (
              <div>
                <strong>预览生效：</strong>
                <pre>{JSON.stringify(levelConfigSnapshot.preview_effective_config, null, 2)}</pre>
              </div>
            )}
          </div>
        )}

        {testRunResult && (
          <div className="admin-config-summary">
            <strong>测试运行：</strong>
            <pre>{JSON.stringify({
              test_run_id: testRunResult.test_run_id,
              message: testRunResult.message,
              save_progress: testRunResult.save_progress,
              mode: testRunResult.mode,
            }, null, 2)}</pre>
          </div>
        )}
          </>
        )}
      </div>

<div className="admin-run-box admin-collapsible-box">
        <button
          type="button"
          className={`admin-collapse-head ${collapsedSections.puzzle ? "collapsed" : ""}`}
          onClick={() => toggleSection("puzzle")}
        >
          <h4>谜题管理（章节生成）</h4>
          <span className="admin-collapse-icon" aria-hidden="true">▾</span>
        </button>

        {!collapsedSections.puzzle && (
          <>
            <div className="admin-puzzle-flow" role="tablist" aria-label="谜题生成流程">
              <button
                type="button"
                className={`admin-flow-step ${puzzleFlowStep === "select" ? "active" : ""}`}
                onClick={() => setPuzzleFlowStep("select")}
              >
                <span className="admin-flow-index">1</span>
                <span className="admin-flow-meta">
                  <strong>选章节</strong>
                  <small>筛选并确认章节</small>
                </span>
              </button>
              <button
                type="button"
                className={`admin-flow-step ${puzzleFlowStep === "generate" ? "active" : ""}`}
                onClick={() => setPuzzleFlowStep("generate")}
                disabled={!canJumpGenerateStep}
              >
                <span className="admin-flow-index">2</span>
                <span className="admin-flow-meta">
                  <strong>文案/出图</strong>
                  <small>查看拆分并判断每张图状态</small>
                </span>
              </button>
              <button
                type="button"
                className={`admin-flow-step ${puzzleFlowStep === "review" ? "active" : ""}`}
                onClick={() => setPuzzleFlowStep("review")}
                disabled={!canJumpReviewStep}
              >
                <span className="admin-flow-index">3</span>
                <span className="admin-flow-meta">
                  <strong>审核发布</strong>
                  <small>修改 rows/cols/time 后发布</small>
                </span>
              </button>
            </div>

            <div className="admin-puzzle-flow-nav">
              <button
                type="button"
                className="nav-btn"
                disabled={!canGoPrevFlowStep}
                onClick={() => {
                  if (puzzleFlowStep === "review") {
                    setPuzzleFlowStep("generate");
                  } else if (puzzleFlowStep === "generate") {
                    setPuzzleFlowStep("select");
                  }
                }}
              >
                ← 上一步
              </button>
              <span className="admin-puzzle-flow-status">流程 {currentFlowStepIndex + 1} / {PUZZLE_FLOW_SEQUENCE.length}</span>
              <button
                type="button"
                className="nav-btn"
                disabled={!canGoNextFlowStep}
                onClick={() => {
                  if (puzzleFlowStep === "select" && canJumpGenerateStep) {
                    setPuzzleFlowStep("generate");
                  } else if (puzzleFlowStep === "generate" && canJumpReviewStep) {
                    setPuzzleFlowStep("review");
                  }
                }}
              >
                下一步 →
              </button>
            </div>

            {puzzleFlowStep === "select" && (
              <>
                <p className="progress-inline">第一步：先选章节，再点击“去生成”创建任务。</p>

                <div className="admin-puzzle-layout">
                  <div className="admin-puzzle-main">
                    <div className="admin-filters">
                      <label className="form-field">
                        书籍
                        <select value={bookId} onChange={(event) => setBookId(event.currentTarget.value)}>
                          <option value="">全部（默认聊斋）</option>
                          {books.map((book) => (
                            <option key={book.id} value={book.id}>
                              {book.title}（{book.chapter_count}章）
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="form-field">
                        关键词
                        <input value={keyword} onChange={(event) => setKeyword(event.currentTarget.value)} placeholder="章节标题关键词" />
                      </label>

                      <label className="form-field">
                        最小字数
                        <input value={minCharsInput} onChange={(event) => setMinCharsInput(event.currentTarget.value)} inputMode="numeric" />
                      </label>

                      <label className="form-field">
                        最大字数
                        <input value={maxCharsInput} onChange={(event) => setMaxCharsInput(event.currentTarget.value)} inputMode="numeric" />
                      </label>

                      <label className="form-field">
                        每页条数
                        <select
                          value={chapterPageSize}
                          onChange={(event) => {
                            const nextPageSize = Number(event.currentTarget.value);
                            if (!CHAPTER_PAGE_SIZE_OPTIONS.includes(nextPageSize as (typeof CHAPTER_PAGE_SIZE_OPTIONS)[number])) {
                              return;
                            }

                            setChapterPageSize(nextPageSize);
                            setChapterPage(1);
                          }}
                        >
                          {CHAPTER_PAGE_SIZE_OPTIONS.map((size) => (
                            <option key={size} value={size}>
                              {size} 条/页
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="admin-check">
                        <input type="checkbox" checked={includeUsed} onChange={(event) => setIncludeUsed(event.currentTarget.checked)} />
                        显示已生成章节（可重生）
                      </label>

                      <div className="inline-actions">
                        <button type="button" className="nav-btn" onClick={() => void loadChapters()} disabled={loadingChapters}>
                          {loadingChapters ? "查询中..." : "刷新章节"}
                        </button>
                        <button type="button" className="link-btn" onClick={onClose}>
                          收起面板
                        </button>
                      </div>
                    </div>

                    <div className="admin-chapter-table">
                      {chapters.length === 0 ? (
                        <div className="progress-inline">没有匹配章节，请调整条件。</div>
                      ) : (
                        <table>
                          <thead>
                            <tr>
                              <th>选择</th>
                              <th>书名</th>
                              <th>章节</th>
                              <th>字数</th>
                              <th>使用次数</th>
                              <th>预览</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {chapters.map((chapter) => (
                              <tr
                                key={chapter.id}
                                className={`${selectedChapterId === chapter.id ? "is-selected" : ""} ${chapter.has_succeeded_story ? "is-generated" : ""}`.trim()}
                              >
                                <td>
                                  <input
                                    type="radio"
                                    name="chapter"
                                    checked={selectedChapterId === chapter.id}
                                    onChange={() => setSelectedChapterId(chapter.id)}
                                  />
                                </td>
                                <td>{chapter.book_title}</td>
                                <td>
                                  第{chapter.chapter_index}章 · {chapter.chapter_title}
                                  {chapter.has_succeeded_story && (
                                    <>
                                      <span className="level-state done" title={chapter.generated_story_id || undefined}>
                                        已生成（可重生）
                                      </span>
                                      {chapter.generated_story_id && (
                                        <button
                                          type="button"
                                          className="link-btn admin-open-story-btn"
                                          onClick={() => void handleOpenGeneratedStory(chapter.generated_story_id || "")}
                                        >
                                          打开故事 {chapter.generated_story_id}
                                        </button>
                                      )}
                                    </>
                                  )}
                                </td>
                                <td>{chapter.char_count}</td>
                                <td>{chapter.used_count}</td>
                                <td>{chapter.preview || "-"}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="nav-btn"
                                    disabled={submitting}
                                    onClick={() => {
                                      setSelectedChapterId(chapter.id);
                                      setShowGenerateDialog(true);
                                    }}
                                  >
                                    生成
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    <div className="admin-chapter-pagination">
                      <button
                        type="button"
                        className="nav-btn admin-page-side-btn"
                        onClick={() => setChapterPage((page) => Math.max(1, page - 1))}
                        disabled={loadingChapters || chapterPage <= 1}
                      >
                        ← 上一页
                      </button>

                      <div className="admin-page-meta">
                        第 {chapterPage} / {totalChapterPages} 页 · 每页 {chapterPageSize} 条 · 共 {chapterTotal} 条
                      </div>

                      <button
                        type="button"
                        className="nav-btn admin-page-side-btn"
                        onClick={() => setChapterPage((page) => Math.min(totalChapterPages, page + 1))}
                        disabled={loadingChapters || chapterPage >= totalChapterPages}
                      >
                        下一页 →
                      </button>
                    </div>
                  </div>

                  <aside className="admin-puzzle-side">
                    <div className="admin-run-box admin-puzzle-preview">
                      <h4>章节预览</h4>
                      {selectedChapter ? (
                        <>
                          <p className="progress-inline">
                            当前选择：第{selectedChapter.chapter_index}章 · {selectedChapter.chapter_title}（{selectedChapter.char_count}字）
                          </p>
                          <p className="admin-puzzle-preview-text">{selectedChapter.preview || "暂无章节预览"}</p>
                          <div className="inline-actions">
                            <button
                              type="button"
                              className="primary-btn"
                              disabled={submitting}
                              onClick={() => setShowGenerateDialog(true)}
                            >
                              {submitting ? "创建中..." : "去生成"}
                            </button>
                            {canJumpGenerateStep && (
                              <button
                                type="button"
                                className="nav-btn"
                                onClick={() => setPuzzleFlowStep("generate")}
                              >
                                查看生成进度
                              </button>
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="progress-inline">请先在左侧选择章节，再发起生成。</p>
                      )}
                    </div>
                  </aside>
                </div>
              </>
            )}

            {puzzleFlowStep === "generate" && (
              <div className="admin-puzzle-stage-stack">
                <div className="admin-run-box admin-puzzle-stage">
                  <div className="admin-review-head">
                    <h4>任务监控</h4>
                    <div className="inline-actions">
                      <button type="button" className="nav-btn" onClick={() => setPuzzleFlowStep("select")}>
                        返回选章节
                      </button>
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => {
                          setPuzzleFlowStep("select");
                          setShowGenerateDialog(true);
                        }}
                        disabled={!selectedChapter || submitting}
                      >
                        {submitting ? "创建中..." : "创建新任务"}
                      </button>
                    </div>
                  </div>

                  {activeRunId ? (
                    <div className="admin-progress">
                      <h4>任务进度：{activeRunId}</h4>
                      <div className="admin-progress-bar">
                        <div style={{ width: `${Math.min(100, Math.max(0, progress.value * 100))}%` }} />
                      </div>
                      <p className="progress-inline">
                        {progress.message}（{progress.completed}/{progress.total}）
                      </p>
                      <p className="progress-inline">
                        状态：{activeJob ? formatGenerationJobStateLabel(activeJob) : "排队中"}
                      </p>
                      {activeJob?.log_tail?.length ? (
                        <pre className="admin-log-tail">{activeJob.log_tail.slice(-8).join("\n")}</pre>
                      ) : null}
                    </div>
                  ) : resumableJob ? (
                    <div className="admin-puzzle-hint">
                      <p className="progress-inline">检测到未完成任务：{resumableJob.run_id}（{formatGenerationJobStateLabel(resumableJob)}）</p>
                      <button type="button" className="nav-btn" onClick={() => handleViewJobProgress(resumableJob.run_id)}>
                        继续查看进度
                      </button>
                    </div>
                  ) : (
                    <p className="progress-inline">当前没有运行中的任务。你可以回到第一步创建新任务。</p>
                  )}
                </div>

                {reviewRunId ? (
                  <div className="admin-run-box admin-review-panel">
                    <div className="admin-review-head">
                      <h4>第二步：LLM 拆分与图片生成（{reviewRunId}）</h4>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="nav-btn"
                          disabled={reviewLoading || reviewPublishing || reviewBatchGenerating}
                          onClick={() => void loadGenerationReview(reviewRunId)}
                        >
                          {reviewLoading ? "刷新中..." : "刷新"}
                        </button>
                        <button
                          type="button"
                          className="nav-btn"
                          disabled={reviewLocked || reviewLoading || reviewPublishing || reviewBatchGenerating || reviewPendingImageCount <= 0}
                          onClick={() => void handleBatchGenerateImages()}
                        >
                          {reviewBatchGenerating ? "批量出图中..." : `批量出图（${reviewPendingImageCount}）`}
                        </button>
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={reviewScenes.length === 0}
                          onClick={() => setPuzzleFlowStep("review")}
                        >
                          去步骤3审核发布
                        </button>
                      </div>
                    </div>

                    <p className="progress-inline">
                      Scene {Math.max(0, reviewCounts.total - reviewCounts.deleted)} · 文案就绪 {reviewCounts.text_ready} · 图片成功 {reviewCounts.images_success} · 待处理 {reviewPendingImageCount}
                    </p>

                    {reviewScenes.length === 0 ? (
                      <p className="progress-inline">暂无 scene，请先完成文案生成。</p>
                    ) : (
                      <div className="admin-review-columns">
                        <div className="admin-review-table">
                          <h4>LLM 拆分结果（标题 / 文案 / Prompt）</h4>
                          <table>
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>标题 / 文案 / Prompt</th>
                              </tr>
                            </thead>
                            <tbody>
                              {reviewScenes.map((scene) => (
                                <tr key={`${scene.run_id}-${scene.scene_index}-split`}>
                                  <td>{scene.scene_index}</td>
                                  <td>
                                    <div className="admin-review-title">{scene.title || `Scene ${scene.scene_index}`}</div>
                                    <div className="admin-review-prompt">{compactText(scene.story_text || scene.description || "", 180)}</div>
                                    <div className="admin-review-prompt">{compactText(scene.image_prompt || "", 220)}</div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="admin-review-table">
                          <h4>图片状态（可重试）</h4>
                          <table>
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>状态</th>
                                <th>图片</th>
                                <th>操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {reviewScenes.map((scene) => {
                                const retrying = reviewRetryingSceneIndex === scene.scene_index;
                                const deleting = reviewDeletingSceneIndex === scene.scene_index;
                                const canRetry = scene.image_status === "failed"
                                  || scene.image_status === "skipped"
                                  || scene.image_status === "pending";

                                return (
                                  <tr key={`${scene.run_id}-${scene.scene_index}-image`}>
                                    <td>{scene.scene_index}</td>
                                    <td>
                                      <span className={`level-state ${scene.image_status === "success" ? "done" : "todo"}`}>
                                        {scene.image_status}
                                      </span>
                                      {scene.error_message ? (
                                        <div className="admin-review-error">{scene.error_message}</div>
                                      ) : null}
                                    </td>
                                    <td>
                                      {scene.image_url ? (
                                        <button
                                          type="button"
                                          className="link-btn admin-review-image-preview-btn"
                                          onClick={() => {
                                            setScenePreview({
                                              run_id: scene.run_id,
                                              scene_index: scene.scene_index,
                                              title: scene.title,
                                              image_url: scene.image_url,
                                              image_prompt: scene.image_prompt,
                                            });
                                          }}
                                        >
                                          预览图片
                                        </button>
                                      ) : (
                                        <span className="progress-inline">-</span>
                                      )}
                                    </td>
                                    <td>
                                      <div className="inline-actions">
                                        <button
                                          type="button"
                                          className="nav-btn admin-review-retry-btn"
                                          disabled={reviewLocked || retrying || deleting || reviewPublishing || reviewLoading || reviewBatchGenerating || !canRetry}
                                          onClick={() => void handleRetryReviewCandidate(scene.scene_index)}
                                        >
                                          {retrying ? "重试中..." : "重试"}
                                        </button>
                                        <button
                                          type="button"
                                          className="nav-btn admin-review-delete-btn"
                                          disabled={reviewLocked || retrying || deleting || reviewPublishing || reviewLoading || reviewBatchGenerating}
                                          onClick={() => void handleDeleteReviewScene(scene.scene_index)}
                                        >
                                          {deleting ? "删除中..." : "删除"}
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="admin-run-box admin-puzzle-stage">
                    <p className="progress-inline">第二步：先从下方任务里选择一个 run，查看 LLM 拆分与图片状态。</p>
                  </div>
                )}

                <div className="admin-recent-jobs">
                  <h4>近期生成任务</h4>
                  {renderRecentJobs("generate")}
                </div>
              </div>
            )}
            {puzzleFlowStep === "review" && (
              <div className="admin-puzzle-stage-stack">
                {reviewRunId ? (
                  <div className="admin-run-box admin-review-panel">
                    <div className="admin-review-head">
                      <h4>第三步：审核发布（{reviewRunId}）</h4>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="nav-btn"
                          disabled={reviewLoading || reviewPublishing || reviewBatchGenerating}
                          onClick={() => void loadGenerationReview(reviewRunId)}
                        >
                          {reviewLoading ? "刷新中..." : "刷新"}
                        </button>
                        <button
                          type="button"
                          className="nav-btn"
                          disabled={reviewLoading || reviewPublishing}
                          onClick={() => setPuzzleFlowStep("generate")}
                        >
                          返回步骤2
                        </button>
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={reviewLocked || reviewLoading || reviewPublishing || reviewReadyCount <= 0}
                          onClick={() => void handlePublishSelected()}
                        >
                          {reviewLocked
                            ? "已发布"
                            : reviewPublishing
                              ? "发布中..."
                              : `发布选中（${reviewReadyCount}）`}
                        </button>
                      </div>
                    </div>

                    <p className="progress-inline">
                      Scene {Math.max(0, reviewCounts.total - reviewCounts.deleted)} · 可发布 {reviewReadyCount} · 待处理图片 {reviewPendingImageCount}
                    </p>
                    {reviewPendingImageCount > 0 && (
                      <p className="progress-inline">仍有图片未完成，请先回到第二步继续出图。</p>
                    )}
                    {reviewLocked && (
                      <p className="progress-inline">
                        该任务已发布{activeJob?.published_at ? `（${formatTime(activeJob.published_at)}）` : ""}，此处改为只读；如需改 rows/cols/time/test 请到上方「关卡配置」模块。
                      </p>
                    )}

                    {reviewScenes.length === 0 ? (
                      <p className="progress-inline">暂无 scene，请先完成第二步文案与图片生成。</p>
                    ) : (
                      <div className="admin-review-table">
                        <h4>关卡配置（rows / cols / time）</h4>
                        <table>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>场景</th>
                              <th>缩略图</th>
                              <th>Rows</th>
                              <th>Cols</th>
                              <th>限时</th>
                              <th>发布</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reviewScenes.map((scene) => {
                              const updating = reviewUpdatingSceneIndex === scene.scene_index;
                              const canSelect = scene.image_status === "success";
                              return (
                                <tr key={`${scene.run_id}-${scene.scene_index}-publish`}>
                                  <td>{scene.scene_index}</td>
                                  <td>
                                    <div className="admin-review-title">{scene.title || `Scene ${scene.scene_index}`}</div>
                                    <div className="admin-review-prompt">图片状态：{scene.image_status}</div>
                                  </td>
                                  <td>
                                    {scene.image_url ? (
                                      <button
                                        type="button"
                                        className="admin-scene-thumb-btn"
                                        onClick={() => {
                                          setScenePreview({
                                            run_id: scene.run_id,
                                            scene_index: scene.scene_index,
                                            title: scene.title,
                                            image_url: scene.image_url,
                                            image_prompt: scene.image_prompt,
                                          });
                                        }}
                                        aria-label={`预览 scene ${scene.scene_index}`}
                                      >
                                        <img className="admin-scene-thumb" src={scene.image_url} alt={scene.title || `scene ${scene.scene_index}`} />
                                      </button>
                                    ) : (
                                      <span className="progress-inline">-</span>
                                    )}
                                  </td>
                                  <td>
                                    <label>
                                      <select
                                        value={scene.grid_rows}
                                        disabled={reviewLocked || updating || reviewPublishing}
                                        onChange={(event) => {
                                          void handleUpdateReviewScene(scene.scene_index, {
                                            grid_rows: Number(event.currentTarget.value),
                                          });
                                        }}
                                      >
                                        {REVIEW_GRID_OPTIONS.map((value) => (
                                          <option key={`rows-${scene.scene_index}-${value}`} value={value}>
                                            {value}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  </td>
                                  <td>
                                    <label>
                                      <select
                                        value={scene.grid_cols}
                                        disabled={reviewLocked || updating || reviewPublishing}
                                        onChange={(event) => {
                                          void handleUpdateReviewScene(scene.scene_index, {
                                            grid_cols: Number(event.currentTarget.value),
                                          });
                                        }}
                                      >
                                        {REVIEW_GRID_OPTIONS.map((value) => (
                                          <option key={`cols-${scene.scene_index}-${value}`} value={value}>
                                            {value}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  </td>
                                  <td>
                                    <label>
                                      <select
                                        value={scene.time_limit_sec}
                                        disabled={reviewLocked || updating || reviewPublishing}
                                        onChange={(event) => {
                                          void handleUpdateReviewScene(scene.scene_index, {
                                            time_limit_sec: Number(event.currentTarget.value),
                                          });
                                        }}
                                      >
                                        {REVIEW_TIME_OPTIONS.map((value) => (
                                          <option key={`time-${scene.scene_index}-${value}`} value={value}>
                                            {value}s
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  </td>
                                  <td>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(scene.selected && canSelect)}
                                      disabled={reviewLocked || !canSelect || updating || reviewPublishing}
                                      onChange={(event) => {
                                        void handleUpdateReviewScene(scene.scene_index, {
                                          selected: event.currentTarget.checked,
                                        });
                                      }}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="admin-run-box admin-puzzle-stage">
                    <p className="progress-inline">第三步：先在第二步选择 run，完成出图后再审核发布。</p>
                  </div>
                )}

                <div className="admin-recent-jobs">
                  <h4>可审核任务</h4>
                  {renderRecentJobs("review")}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {publishSuccess && (
        <div className="mask" role="dialog" aria-modal="true" onClick={handleStayAfterPublish}>
          <div className="mask-card admin-publish-success-modal" onClick={(event) => event.stopPropagation()}>
            <h4>发布成功</h4>
            <p className="progress-inline">任务：{publishSuccess.run_id}</p>
            <p className="progress-inline">故事：{publishSuccess.story_id}（{publishSuccess.level_count} 关）</p>
            <p className="progress-inline">是否返回故事导航并打开该故事？</p>
            <div className="inline-actions">
              <button type="button" className="primary-btn" onClick={() => void handleOpenPublishedStory()}>
                打开故事导航
              </button>
              <button type="button" className="nav-btn" onClick={handleStayAfterPublish}>
                留在当前页
              </button>
            </div>
          </div>
        </div>
      )}

      {scenePreview && (
        <div className="mask" role="dialog" aria-modal="true" onClick={() => setScenePreview(null)}>
          <div className="mask-card admin-image-preview-modal" onClick={(event) => event.stopPropagation()}>
            <div className="admin-image-preview-head">
              <h4>{scenePreview.title || `Scene ${scenePreview.scene_index}`} · 预览</h4>
              <button type="button" className="nav-btn" onClick={() => setScenePreview(null)}>关闭</button>
            </div>
            {scenePreview.image_url ? (
              <img className="admin-image-preview" src={scenePreview.image_url} alt={scenePreview.title || `scene ${scenePreview.scene_index}`} />
            ) : (
              <p className="progress-inline">暂无可预览图片。</p>
            )}
            <p className="admin-image-preview-prompt">{compactText(scenePreview.image_prompt, 260)}</p>
          </div>
        </div>
      )}

      {showGenerateDialog && (
        <div className="mask" role="dialog" aria-modal="true" onClick={() => setShowGenerateDialog(false)}>
          <div className="mask-card admin-generate-modal" onClick={(event) => event.stopPropagation()}>
            <h4>生成参数</h4>
            <p className="progress-inline">确认参数后开始生成任务。</p>

            <label className="form-field">
              生成日期（story_YYYY-MM-DD）
              <input value={targetDate} onChange={(event) => setTargetDate(event.currentTarget.value)} placeholder="YYYY-MM-DD" />
            </label>

            <label className="form-field">
              目标张数（至少 6）
              <input
                value={sceneCountInput}
                onChange={(event) => setSceneCountInput(event.currentTarget.value)}
                inputMode="numeric"
                placeholder={String(DEFAULT_SCENE_COUNT)}
              />
            </label>

            {selectedChapter && (
              <p className="progress-inline">
                当前选择：{selectedChapter.chapter_title}（{selectedChapter.char_count}字）
              </p>
            )}

            <div className="inline-actions">
              <button
                type="button"
                className="primary-btn"
                disabled={!selectedChapter || submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? "创建中..." : "开始生成"}
              </button>
              <button type="button" className="link-btn" onClick={() => setShowGenerateDialog(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

    </section>
  );
}


function compactText(value: unknown, limit = 160): string {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function normalizeReviewStatus(value: unknown): "" | "pending_review" | "published" {
  const text = String(value || "").trim().toLowerCase();
  if (text === "pending_review" || text === "published") {
    return text;
  }
  return "";
}

function normalizeFlowStage(value: unknown): "" | "text_generating" | "text_ready" | "images_generating" | "review_ready" | "published" | "failed" {
  const text = String(value || "").trim().toLowerCase();
  if (text === "text_generating"
    || text === "text_ready"
    || text === "images_generating"
    || text === "review_ready"
    || text === "published"
    || text === "failed") {
    return text;
  }
  return "";
}

function isReviewListJob(job: AdminGenerationJob): boolean {
  const flowStage = normalizeFlowStage(job.flow_stage);
  if (flowStage === "text_ready"
    || flowStage === "images_generating"
    || flowStage === "review_ready"
    || flowStage === "published") {
    return true;
  }

  const reviewStatus = normalizeReviewStatus(job.review_status);
  return reviewStatus === "pending_review" || reviewStatus === "published";
}

function generationJobStateClass(job: AdminGenerationJob): "todo" | "running" | "done" {
  const flowStage = normalizeFlowStage(job.flow_stage);

  if (job.status === "failed" || job.status === "cancelled" || flowStage === "failed") {
    return "todo";
  }

  if (flowStage === "published") {
    return "done";
  }

  if (flowStage === "review_ready" || flowStage === "images_generating" || flowStage === "text_generating" || flowStage === "text_ready") {
    return "running";
  }

  if (job.status === "running") {
    return "running";
  }

  if (job.status === "queued") {
    return "todo";
  }

  if (job.status === "succeeded") {
    return normalizeReviewStatus(job.review_status) === "pending_review" ? "running" : "done";
  }

  return "todo";
}

function formatGenerationJobStateLabel(job: AdminGenerationJob): string {
  const flowStage = normalizeFlowStage(job.flow_stage);

  if (flowStage === "text_generating") {
    return "文案生成中";
  }
  if (flowStage === "text_ready") {
    return "文案已就绪";
  }
  if (flowStage === "images_generating") {
    return "图片生成中";
  }
  if (flowStage === "review_ready") {
    return "待发布";
  }
  if (flowStage === "published") {
    return "已发布";
  }
  if (flowStage === "failed") {
    return "失败";
  }

  if (job.status === "queued") {
    return "排队中";
  }
  if (job.status === "running") {
    return "生成中";
  }
  if (job.status === "failed") {
    return "失败";
  }
  if (job.status === "cancelled") {
    return "已取消";
  }

  const reviewStatus = normalizeReviewStatus(job.review_status);
  if (reviewStatus === "pending_review") {
    return "待审核";
  }
  if (reviewStatus === "published") {
    return "已发布";
  }
  return "已完成";
}

function extractJobProgress(job: AdminGenerationJobDetail | null): JobProgress {
  if (!job) {
    return { value: 0, completed: 0, total: 1, message: "等待任务启动" };
  }

  const flowStage = normalizeFlowStage(job.flow_stage);

  if (flowStage === "published") {
    return { value: 1, completed: 1, total: 1, message: "已发布" };
  }

  if (flowStage === "review_ready") {
    return { value: 1, completed: 1, total: 1, message: "待发布" };
  }

  if (flowStage === "images_generating") {
    return { value: 0.7, completed: 0, total: 1, message: "图片生成中" };
  }

  if (flowStage === "text_ready") {
    return { value: 0.45, completed: 0, total: 1, message: "文案已生成，等待出图" };
  }

  if (flowStage === "text_generating") {
    return { value: 0.2, completed: 0, total: 1, message: "文案生成中" };
  }

  if (flowStage === "failed" || job.status === "failed" || job.status === "cancelled") {
    return { value: 1, completed: 0, total: 1, message: "任务失败" };
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
    message: String(lastEvent?.event || (job.status === "queued" ? "排队中" : "处理中")),
  };
}

function pickStoryId(detail: AdminGenerationJobDetail): string {
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

function defaultSceneCounts(): AdminGenerationSceneCounts {
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

function createClientRunId(): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const randomPart = Math.random().toString(16).slice(2, 10);
  return `admin_${stamp}_${randomPart}`;
}

function defaultLevelConfigForm(): LevelConfigFormState {
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

function formFromLevelConfig(snapshot: AdminLevelConfigResponse): LevelConfigFormState {
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

function buildLevelConfigPatch(form: LevelConfigFormState): { ok: true; patch: AdminLevelConfigPatch } | { ok: false; message: string } {
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

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "请求失败";
}

function formatTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.replace("T", " ").replace("Z", "");
}

function formatDurationMs(value: number | null | undefined): string {
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
