import { useCallback, useEffect, useMemo, useState } from "react";

import {
  apiCreateAdminGenerationJob,
  apiGrantAdminUserRole,
  apiGetAdminLevelConfig,
  apiGetAdminGenerationJob,
  apiGetStoryDetail,
  apiListAdminBookChapters,
  apiListAdminGenerationJobs,
  apiListAdminUsers,
  apiListStories,
  apiPreviewAdminLevelConfig,
  apiRevokeAdminUserRole,
  apiRunAdminLevelTest,
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

const DEFAULT_MIN_CHARS = 500;
const DEFAULT_MAX_CHARS = 2200;
const DEFAULT_SCENE_COUNT = 12;
const MIN_SCENE_COUNT = 6;
const MANAGED_ROLES: AdminManagedRole[] = ["admin", "editor", "level_designer", "operator"];
const MANAGED_LEVEL_DIFFICULTIES: AdminLevelDifficulty[] = ["easy", "normal", "hard", "nightmare"];

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

  const [activeRunId, setActiveRunId] = useState("");
  const [activeJob, setActiveJob] = useState<AdminGenerationJobDetail | null>(null);
  const [levelConfigSnapshot, setLevelConfigSnapshot] = useState<AdminLevelConfigResponse | null>(null);
  const [testRunResult, setTestRunResult] = useState<AdminLevelTestRunResponse | null>(null);
  const [levelConfigForm, setLevelConfigForm] = useState<LevelConfigFormState>(defaultLevelConfigForm());

  const selectedChapter = useMemo(
    () => chapters.find((item) => item.id === selectedChapterId) || null,
    [chapters, selectedChapterId],
  );

  const progress = useMemo(() => extractJobProgress(activeJob), [activeJob]);

  const loadRecentJobs = useCallback(async (): Promise<void> => {
    try {
      const response = await apiListAdminGenerationJobs(20);
      setRecentJobs(response.jobs || []);
    } catch {
      // ignore recent jobs errors in panel
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
        limit: 80,
      });

      setBooks(response.books || []);
      setChapters(response.chapters || []);

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
  }, [bookId, includeUsed, keyword, maxCharsInput, minCharsInput, selectedChapterId]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    void loadChapters();
    void loadRecentJobs();
    void loadAdminUsers();
    void loadConfigStories();
  }, [loadAdminUsers, loadChapters, loadConfigStories, loadRecentJobs, visible]);

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
  }, [activeRunId, loadRecentJobs, onGenerated, visible]);

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

    try {
      const response = await apiCreateAdminGenerationJob({
        chapter_id: selectedChapterId,
        target_date: targetDate,
        scene_count: requestedSceneCount,
        concurrency: 3,
      });

      setActiveRunId(response.run_id);
      setActiveJob(null);
      setPanelInfo(`任务已入队：${response.run_id}（目标 ${response.scene_count || requestedSceneCount} 张）`);
      await loadRecentJobs();
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!visible) {
    return null;
  }

  return (
    <section className="account-panel admin-panel">
      <h3>管理员：章节生成故事</h3>
      <p>选择聊斋章节后，系统会自动触发 Python 生成并实时回传进度。</p>

      {panelError && <div className="banner-error">{panelError}</div>}
      {panelInfo && <div className="banner-info">{panelInfo}</div>}

      <div className="admin-run-box">
        <h4>用户权限管理</h4>
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
      </div>

      <div className="admin-run-box">
        <h4>关卡配置 / 预览 / 测试</h4>

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
      </div>

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

      <div className="admin-run-box">
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

        <div className="inline-actions">
          <button type="button" className="primary-btn" disabled={!selectedChapter || submitting || Boolean(activeRunId)} onClick={() => void handleSubmit()}>
            {submitting ? "创建中..." : "开始生成"}
          </button>
          {selectedChapter && (
            <span className="progress-inline">
              当前选择：{selectedChapter.chapter_title}（{selectedChapter.char_count}字）
            </span>
          )}
        </div>
      </div>

      {activeRunId && (
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
      )}

      {recentJobs.length > 0 && (
        <div className="admin-recent-jobs">
          <h4>最近任务</h4>
          <ul>
            {recentJobs.slice(0, 8).map((job) => (
              <li key={job.run_id}>
                <span>{job.run_id}</span>
                <span className={`level-state ${job.status === "succeeded" ? "done" : "todo"}`}>{job.status}</span>
                <span>{job.target_date}</span>
              </li>
            ))}
          </ul>
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
