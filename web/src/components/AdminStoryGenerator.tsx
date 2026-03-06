import { useCallback, useEffect, useMemo, useState } from "react";

import {
  apiCreateAdminGenerationJob,
  apiGrantAdminUserRole,
  apiGetAdminLevelConfig,
  apiGetAdminGenerationJob,
  apiGetAdminGenerationReview,
  apiPublishAdminGenerationSelected,
  apiRetryAdminGenerationCandidateImage,
  apiGetStoryDetail,
  apiListAdminBookChapters,
  apiListAdminGenerationJobs,
  apiListAdminUsers,
  apiListStories,
  apiPreviewAdminLevelConfig,
  apiRevokeAdminUserRole,
  apiRunAdminLevelTest,
  apiUpdateAdminGenerationCandidate,
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
  AdminGenerationCandidate,
  AdminGenerationCandidateCounts,
  AdminGenerationEvent,
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
  const [reviewCandidates, setReviewCandidates] = useState<AdminGenerationCandidate[]>([]);
  const [reviewCounts, setReviewCounts] = useState<AdminGenerationCandidateCounts>(defaultCandidateCounts);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewPublishing, setReviewPublishing] = useState(false);
  const [reviewUpdatingSceneIndex, setReviewUpdatingSceneIndex] = useState<number | null>(null);
  const [reviewRetryingSceneIndex, setReviewRetryingSceneIndex] = useState<number | null>(null);
  const [levelConfigSnapshot, setLevelConfigSnapshot] = useState<AdminLevelConfigResponse | null>(null);
  const [testRunResult, setTestRunResult] = useState<AdminLevelTestRunResponse | null>(null);
  const [levelConfigForm, setLevelConfigForm] = useState<LevelConfigFormState>(defaultLevelConfigForm());
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
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
  const hasSucceededJobs = useMemo(
    () => recentJobs.some((job) => job.status === "succeeded"),
    [recentJobs],
  );
  const reviewReadyCount = useMemo(() => Number(reviewCounts.ready_for_publish || 0), [reviewCounts.ready_for_publish]);

  const toggleSection = useCallback((key: AdminSectionKey): void => {
    setCollapsedSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  const loadRecentJobs = useCallback(async (): Promise<void> => {
    try {
      const response = await apiListAdminGenerationJobs(20);
      setRecentJobs(response.jobs || []);
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
      const response = await apiGetAdminGenerationReview(targetRunId);
      setReviewRunId(targetRunId);
      setReviewCandidates(response.candidates || []);
      setReviewCounts(response.counts || defaultCandidateCounts());
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
        const detail = await apiGetAdminGenerationJob(activeRunId);
        if (disposed) {
          return;
        }

        setActiveJob(detail);

        if (detail.status === "succeeded") {
          if (isReviewModeJob(detail)) {
            setPanelInfo(`生成完成，待审核发布：${detail.run_id}`);
            setActiveRunId("");
            await loadGenerationReview(detail.run_id);
            await loadRecentJobs();
            return;
          }

          const storyId = pickStoryId(detail);
          setPanelInfo(storyId ? `生成完成：${storyId}` : "生成完成，已发布到故事首页。");
          setActiveRunId("");
          await onGenerated(storyId);
          await loadRecentJobs();
          return;
        }

        if (detail.status === "failed" || detail.status === "cancelled") {
          setPanelError(detail.error_message || "生成任务失败");
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
  }, [activeRunId, loadGenerationReview, loadRecentJobs, onGenerated, visible]);

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

    if (reviewRunId && puzzleFlowStep !== "review") {
      setPuzzleFlowStep("review");
      return;
    }

    if (!reviewRunId && activeRunId && puzzleFlowStep === "select") {
      setPuzzleFlowStep("generate");
    }
  }, [activeRunId, puzzleFlowStep, reviewRunId, visible]);

  const handleViewJobProgress = useCallback((runId: string): void => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    setPanelError("");
    setPanelInfo(`正在查看任务进度：${targetRunId}`);
    setShowGenerateDialog(false);
    setReviewRunId("");
    setReviewCandidates([]);
    setReviewCounts(defaultCandidateCounts());
    setActiveJob(null);
    setActiveRunId(targetRunId);
    setPuzzleFlowStep("generate");
    setCollapsedSections((prev) => ({
      ...prev,
      puzzle: false,
    }));
  }, []);

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

  const handleUpdateReviewCandidate = useCallback(async (
    sceneIndex: number,
    payload: {
      selected?: boolean;
      grid_rows?: number;
      grid_cols?: number;
    },
  ): Promise<void> => {
    if (!reviewRunId) {
      return;
    }

    setReviewUpdatingSceneIndex(sceneIndex);
    setPanelError("");

    try {
      await apiUpdateAdminGenerationCandidate(reviewRunId, sceneIndex, payload);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewUpdatingSceneIndex(null);
    }
  }, [loadGenerationReview, reviewRunId]);

  const handlePublishSelected = useCallback(async (): Promise<void> => {
    if (!reviewRunId) {
      return;
    }

    setReviewPublishing(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const response = await apiPublishAdminGenerationSelected(reviewRunId);
      setPanelInfo(`发布完成：${response.story_id}（${response.level_count} 关）`);
      await loadGenerationReview(reviewRunId);
      await loadRecentJobs();
      await onGenerated(response.story_id);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewPublishing(false);
    }
  }, [loadGenerationReview, loadRecentJobs, onGenerated, reviewRunId]);

  const handleRetryReviewCandidate = useCallback(async (sceneIndex: number): Promise<void> => {
    if (!reviewRunId) {
      return;
    }

    setReviewRetryingSceneIndex(sceneIndex);
    setPanelError("");

    try {
      const response = await apiRetryAdminGenerationCandidateImage(reviewRunId, sceneIndex);
      setPanelInfo(`已加入重试队列：scene ${sceneIndex}（retry #${response.retry_id}）`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewRetryingSceneIndex(null);
    }
  }, [loadGenerationReview, reviewRunId]);

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
      const response = await apiCreateAdminGenerationJob({
        chapter_id: selectedChapterId,
        target_date: targetDate,
        scene_count: requestedSceneCount,
        concurrency: 3,
      });

      setReviewRunId("");
      setReviewCandidates([]);
      setReviewCounts(defaultCandidateCounts());
      setActiveRunId(response.run_id);
      setActiveJob(null);
      setPuzzleFlowStep("generate");
      setPanelInfo(`任务已入队：${response.run_id}（目标 ${response.scene_count || requestedSceneCount} 张）`);
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
          return job.status === "succeeded";
        }
        return true;
      })
      .slice(0, 8);

    if (filteredJobs.length === 0) {
      if (mode === "generate") {
        return <p className="progress-inline">暂无运行中的任务。</p>;
      }
      if (mode === "review") {
        return <p className="progress-inline">暂无可审核任务，请先完成生成。</p>;
      }
      return <p className="progress-inline">暂无任务记录。</p>;
    }

    return (
      <ul>
        {filteredJobs.map((job) => {
          const progressViewable = job.status === "running" || job.status === "queued";
          const reviewViewable = job.status === "succeeded";
          const viewing = activeRunId === job.run_id;
          const reviewing = reviewRunId === job.run_id;

          return (
            <li key={job.run_id}>
              <span>{job.run_id}</span>
              <span className={`level-state ${job.status === "succeeded" ? "done" : "todo"}`}>{job.status}</span>
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
                  {reviewing ? "审核中" : "审核发布"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  const canJumpGenerateStep = Boolean(activeRunId || resumableJob || recentJobs.length > 0);
  const canJumpReviewStep = Boolean(reviewRunId || hasSucceededJobs);

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
          <span>检测到运行中任务：{resumableJob.run_id}</span>
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
                  <strong>生成任务</strong>
                  <small>查看进度和日志</small>
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
                  <small>挑选关卡再发布</small>
                </span>
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
                              disabled={submitting || Boolean(activeRunId)}
                              onClick={() => setShowGenerateDialog(true)}
                            >
                              {submitting ? "创建中..." : activeRunId ? "任务进行中" : "去生成"}
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
                    <h4>第二步：生成任务</h4>
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
                        disabled={!selectedChapter || submitting || Boolean(activeRunId)}
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
                      <p className="progress-inline">状态：{activeJob?.status || "queued"}</p>
                      {activeJob?.log_tail?.length ? (
                        <pre className="admin-log-tail">{activeJob.log_tail.slice(-8).join("\n")}</pre>
                      ) : null}
                    </div>
                  ) : resumableJob ? (
                    <div className="admin-puzzle-hint">
                      <p className="progress-inline">检测到运行中任务：{resumableJob.run_id}</p>
                      <button type="button" className="nav-btn" onClick={() => handleViewJobProgress(resumableJob.run_id)}>
                        继续查看进度
                      </button>
                    </div>
                  ) : (
                    <p className="progress-inline">当前没有运行中的任务。你可以回到第一步创建新任务。</p>
                  )}
                </div>

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
                          disabled={reviewLoading || reviewPublishing}
                          onClick={() => void loadGenerationReview(reviewRunId)}
                        >
                          {reviewLoading ? "刷新中..." : "刷新审核"}
                        </button>
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={reviewLoading || reviewPublishing || reviewReadyCount <= 0}
                          onClick={() => void handlePublishSelected()}
                        >
                          {reviewPublishing ? "发布中..." : `发布选中关卡（${reviewReadyCount}）`}
                        </button>
                      </div>
                    </div>

                    <p className="progress-inline">
                      候选 {reviewCounts.total} · 成功 {reviewCounts.success} · 失败 {reviewCounts.failed} · 已选 {reviewCounts.selected}
                    </p>

                    {reviewCandidates.length === 0 ? (
                      <p className="progress-inline">暂无候选关卡，请先完成生成。</p>
                    ) : (
                      <div className="admin-review-table">
                        <table>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>关卡</th>
                              <th>图片状态</th>
                              <th>发布</th>
                              <th>rows</th>
                              <th>cols</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reviewCandidates.map((candidate) => {
                              const updating = reviewUpdatingSceneIndex === candidate.scene_index;
                              const retrying = reviewRetryingSceneIndex === candidate.scene_index;
                              const canSelect = candidate.image_status === "success";
                              const canRetry = candidate.image_status === "failed" || candidate.image_status === "skipped";

                              return (
                                <tr key={`${candidate.run_id}-${candidate.scene_index}`}>
                                  <td>{candidate.scene_index}</td>
                                  <td>
                                    <div className="admin-review-title">{candidate.title || `关卡 ${candidate.scene_index}`}</div>
                                    {candidate.error_message ? (
                                      <div className="admin-review-error">{candidate.error_message}</div>
                                    ) : (
                                      <div className="admin-review-prompt">{candidate.image_prompt || "-"}</div>
                                    )}
                                  </td>
                                  <td>
                                    <span className={`level-state ${canSelect ? "done" : "todo"}`}>{candidate.image_status}</span>
                                  </td>
                                  <td>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(candidate.selected && canSelect)}
                                      disabled={!canSelect || updating || reviewPublishing}
                                      onChange={(event) => {
                                        void handleUpdateReviewCandidate(candidate.scene_index, {
                                          selected: event.currentTarget.checked,
                                        });
                                      }}
                                    />
                                  </td>
                                  <td>
                                    <select
                                      value={candidate.grid_rows}
                                      disabled={updating || reviewPublishing}
                                      onChange={(event) => {
                                        void handleUpdateReviewCandidate(candidate.scene_index, {
                                          grid_rows: Number(event.currentTarget.value),
                                        });
                                      }}
                                    >
                                      {REVIEW_GRID_OPTIONS.map((value) => (
                                        <option key={`rows-${candidate.scene_index}-${value}`} value={value}>
                                          {value}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td>
                                    <select
                                      value={candidate.grid_cols}
                                      disabled={updating || reviewPublishing}
                                      onChange={(event) => {
                                        void handleUpdateReviewCandidate(candidate.scene_index, {
                                          grid_cols: Number(event.currentTarget.value),
                                        });
                                      }}
                                    >
                                      {REVIEW_GRID_OPTIONS.map((value) => (
                                        <option key={`cols-${candidate.scene_index}-${value}`} value={value}>
                                          {value}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td>
                                    {canRetry ? (
                                      <button
                                        type="button"
                                        className="nav-btn admin-review-retry-btn"
                                        disabled={retrying || reviewPublishing || reviewLoading}
                                        onClick={() => void handleRetryReviewCandidate(candidate.scene_index)}
                                      >
                                        {retrying ? "重试中..." : "重试出图"}
                                      </button>
                                    ) : (
                                      <span className="progress-inline">-</span>
                                    )}
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
                    <p className="progress-inline">第三步：先从下方“可审核任务”里选择一个 succeeded 任务。</p>
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
                disabled={!selectedChapter || submitting || Boolean(activeRunId)}
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

function extractJobProgress(job: AdminGenerationJobDetail | null): JobProgress {
  if (!job) {
    return { value: 0, completed: 0, total: 1, message: "等待任务启动" };
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

  const events = Array.isArray(detail.events) ? detail.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index] as AdminGenerationEvent;
    const candidate =
      (typeof item.published_story_id === "string" && item.published_story_id) ||
      (typeof item.story_id === "string" && item.story_id) ||
      "";
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function isReviewModeJob(detail: AdminGenerationJobDetail): boolean {
  const summaryReviewMode = detail.summary && typeof detail.summary === "object"
    ? (detail.summary as Record<string, unknown>).review_mode
    : undefined;
  if (typeof summaryReviewMode === "boolean") {
    return summaryReviewMode;
  }

  const payloadReviewMode = detail.payload && typeof detail.payload === "object"
    ? (detail.payload as Record<string, unknown>).review_mode
    : undefined;
  if (typeof payloadReviewMode === "boolean") {
    return payloadReviewMode;
  }

  return false;
}

function defaultCandidateCounts(): AdminGenerationCandidateCounts {
  return {
    total: 0,
    success: 0,
    failed: 0,
    pending: 0,
    selected: 0,
    ready_for_publish: 0,
  };
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
