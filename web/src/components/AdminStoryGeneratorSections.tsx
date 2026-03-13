import { ReactNode, useEffect, useState } from "react";

import {
  AdminBookIngestTask,
  AdminBookSummaryTask,
  AdminBookInfo,
  AdminChapterSummary,
  AdminGenerationJob,
  AdminGenerationJobDetail,
  AdminGenerationScene,
  AdminGenerationSceneCounts,
  AdminLevelConfigResponse,
  AdminLevelDifficulty,
  AdminLevelTestRunResponse,
  AdminManagedRole,
  AdminUserSummary,
  StoryListItem,
} from "../core/types";
import {
  compactText,
  formatGenerationJobStateLabel,
  generationJobStateClass,
  isReviewListJob,
  normalizeFlowStage,
  normalizeReviewStatus,
  type LevelConfigFormState,
} from "./admin-story-generator/utils";

type SectionProps = {
  children: ReactNode;
};

type LevelOption = {
  id: string;
  title: string;
};

type AdminStatusBannerProps = {
  activeRunId: string;
  panelError: string;
  panelInfo: string;
  resumableJob: AdminGenerationJob | null;
  onViewJobProgress: (runId: string) => void;
};

export function AdminStatusBanner({
  activeRunId,
  panelError,
  panelInfo,
  resumableJob,
  onViewJobProgress,
}: AdminStatusBannerProps): JSX.Element {
  return (
    <>
      {panelError && <div className="banner-error">{panelError}</div>}
      {panelInfo && <div className="banner-info">{panelInfo}</div>}
      {resumableJob && !activeRunId && (
        <div className="banner-info admin-running-banner">
          <span>检测到未完成任务：{resumableJob.run_id}（{formatGenerationJobStateLabel(resumableJob)}）</span>
          <button type="button" className="nav-btn" onClick={() => onViewJobProgress(resumableJob.run_id)}>
            查看进度
          </button>
        </div>
      )}
    </>
  );
}

type AdminUserPermissionsSectionProps = {
  adminUsers: AdminUserSummary[];
  collapsed: boolean;
  loadingUsers: boolean;
  managedRoles: AdminManagedRole[];
  passwordResetSubmittingUserId: string;
  roleSubmittingKey: string;
  userKeyword: string;
  formatDurationMs: (value: number) => string;
  formatTime: (value: string | null | undefined) => string;
  onApprovePasswordReset: (user: AdminUserSummary) => void;
  onRefreshUsers: () => void;
  onRoleToggle: (user: AdminUserSummary, role: AdminManagedRole) => void;
  onToggleSection: () => void;
  onUserKeywordChange: (value: string) => void;
};

export function AdminUserPermissionsSection({
  adminUsers,
  collapsed,
  loadingUsers,
  managedRoles,
  passwordResetSubmittingUserId,
  roleSubmittingKey,
  userKeyword,
  formatDurationMs,
  formatTime,
  onApprovePasswordReset,
  onRefreshUsers,
  onRoleToggle,
  onToggleSection,
  onUserKeywordChange,
}: AdminUserPermissionsSectionProps): JSX.Element {
  return (
    <div className="admin-run-box admin-collapsible-box">
      <button type="button" className={`admin-collapse-head ${collapsed ? "collapsed" : ""}`} onClick={onToggleSection}>
        <h4>用户权限管理</h4>
        <span className="admin-collapse-icon" aria-hidden="true">▾</span>
      </button>

      {!collapsed && (
        <>
          <div className="admin-user-toolbar">
            <label className="form-field">
              用户名检索
              <input value={userKeyword} onChange={(event) => onUserKeywordChange(event.currentTarget.value)} placeholder="输入用户名关键字" />
            </label>

            <div className="inline-actions">
              <button type="button" className="nav-btn" onClick={onRefreshUsers} disabled={loadingUsers}>
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
                          {user.pending_password_reset_count > 0 ? (
                            <span className="level-state pending">
                              待审批改密 {user.pending_password_reset_count}
                            </span>
                          ) : null}
                        </div>
                        {user.pending_password_reset_count > 0 && (
                          <div className="progress-inline">
                            最近申请：{formatTime(user.last_password_reset_requested_at)}
                          </div>
                        )}
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
                          {user.pending_password_reset_count > 0 ? (
                            <button
                              type="button"
                              className="primary-btn"
                              disabled={Boolean(roleSubmittingKey) || Boolean(passwordResetSubmittingUserId)}
                              onClick={() => onApprovePasswordReset(user)}
                            >
                              {passwordResetSubmittingUserId === String(user.id) ? "审批中..." : "审批改密"}
                            </button>
                          ) : null}
                          {managedRoles.map((role) => {
                            const hasRole = user.roles.includes(role);
                            const actionKey = `${user.id}:${role}:${hasRole ? "revoke" : "grant"}`;

                            return (
                              <button
                                key={`${user.id}-action-${role}`}
                                type="button"
                                className={hasRole ? "link-btn" : "nav-btn"}
                                disabled={Boolean(roleSubmittingKey)}
                                onClick={() => onRoleToggle(user, role)}
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
  );
}

type AdminChapterSelectionSectionProps = {
  collapsed: boolean;
  configLevelId: string;
  configLevels: LevelOption[];
  configPreviewing: boolean;
  configSaving: boolean;
  configStoryId: string;
  configStories: StoryListItem[];
  configTesting: boolean;
  levelConfigForm: LevelConfigFormState;
  levelConfigSnapshot: AdminLevelConfigResponse | null;
  loadingConfigCatalog: boolean;
  loadingLevelConfig: boolean;
  managedLevelDifficulties: AdminLevelDifficulty[];
  testRunResult: AdminLevelTestRunResponse | null;
  onConfigFormChange: (patch: Partial<LevelConfigFormState>) => void;
  onConfigLevelIdChange: (value: string) => void;
  onConfigStoryIdChange: (value: string) => void;
  onLoadConfigStories: () => void;
  onLoadLevelConfig: () => void;
  onPreviewLevelConfig: () => void;
  onSaveLevelConfig: () => void;
  onTestLevelConfig: () => void;
  onToggleSection: () => void;
};

export function AdminChapterSelectionSection({
  collapsed,
  configLevelId,
  configLevels,
  configPreviewing,
  configSaving,
  configStoryId,
  configStories,
  configTesting,
  levelConfigForm,
  levelConfigSnapshot,
  loadingConfigCatalog,
  loadingLevelConfig,
  managedLevelDifficulties,
  testRunResult,
  onConfigFormChange,
  onConfigLevelIdChange,
  onConfigStoryIdChange,
  onLoadConfigStories,
  onLoadLevelConfig,
  onPreviewLevelConfig,
  onSaveLevelConfig,
  onTestLevelConfig,
  onToggleSection,
}: AdminChapterSelectionSectionProps): JSX.Element {
  return (
    <div className="admin-run-box admin-collapsible-box">
      <button type="button" className={`admin-collapse-head ${collapsed ? "collapsed" : ""}`} onClick={onToggleSection}>
        <h4>关卡配置 / 预览 / 测试</h4>
        <span className="admin-collapse-icon" aria-hidden="true">▾</span>
      </button>

      {!collapsed && (
        <>
          <div className="admin-config-grid">
            <label className="form-field">
              故事
              <select value={configStoryId} onChange={(event) => onConfigStoryIdChange(event.currentTarget.value)}>
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
              <select value={configLevelId} onChange={(event) => onConfigLevelIdChange(event.currentTarget.value)}>
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
                onChange={(event) => onConfigFormChange({ enabled: event.currentTarget.checked })}
              />
            </label>

            <label className="form-field">
              行数（grid_rows）
              <input
                value={levelConfigForm.grid_rows}
                onChange={(event) => onConfigFormChange({ grid_rows: event.currentTarget.value })}
                placeholder="留空=不覆盖"
                inputMode="numeric"
              />
            </label>

            <label className="form-field">
              列数（grid_cols）
              <input
                value={levelConfigForm.grid_cols}
                onChange={(event) => onConfigFormChange({ grid_cols: event.currentTarget.value })}
                placeholder="留空=不覆盖"
                inputMode="numeric"
              />
            </label>

            <label className="form-field">
              时限（time_limit_sec）
              <input
                value={levelConfigForm.time_limit_sec}
                onChange={(event) => onConfigFormChange({ time_limit_sec: event.currentTarget.value })}
                placeholder="留空=自动计算"
                inputMode="numeric"
              />
            </label>

            <label className="form-field">
              难度（difficulty）
              <select
                value={levelConfigForm.difficulty}
                onChange={(event) => onConfigFormChange({ difficulty: event.currentTarget.value as "" | AdminLevelDifficulty })}
              >
                <option value="">留空=normal</option>
                {managedLevelDifficulties.map((difficulty) => (
                  <option key={difficulty} value={difficulty}>{difficulty}</option>
                ))}
              </select>
            </label>

            <label className="form-field">
              难度系数（difficulty_factor）
              <input
                value={levelConfigForm.difficulty_factor}
                onChange={(event) => onConfigFormChange({ difficulty_factor: event.currentTarget.value })}
                placeholder="留空=策略默认"
                inputMode="decimal"
              />
            </label>

            <label className="form-field">
              content_version
              <input
                value={levelConfigForm.content_version}
                onChange={(event) => onConfigFormChange({ content_version: event.currentTarget.value })}
                placeholder="留空=沿用"
                inputMode="numeric"
              />
            </label>
          </div>

          <div className="admin-config-actions inline-actions">
            <button type="button" className="nav-btn" onClick={onLoadConfigStories} disabled={loadingConfigCatalog}>
              {loadingConfigCatalog ? "加载中..." : "刷新故事"}
            </button>
            <button type="button" className="nav-btn" onClick={onLoadLevelConfig} disabled={!configStoryId || !configLevelId || loadingLevelConfig}>
              {loadingLevelConfig ? "读取中..." : "读取配置"}
            </button>
            <button type="button" className="nav-btn" onClick={onPreviewLevelConfig} disabled={!configStoryId || !configLevelId || configPreviewing}>
              {configPreviewing ? "预览中..." : "预览配置"}
            </button>
            <button type="button" className="primary-btn" onClick={onSaveLevelConfig} disabled={!configStoryId || !configLevelId || configSaving}>
              {configSaving ? "保存中..." : "保存配置"}
            </button>
            <button type="button" className="link-btn" onClick={onTestLevelConfig} disabled={!configStoryId || !configLevelId || configTesting}>
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
  );
}

type AdminBookUploadSectionProps = {
  books: AdminBookInfo[];
  bookUploadTasks: AdminBookIngestTask[];
  bookSummaryTasks: AdminBookSummaryTask[];
  collapsed: boolean;
  loadingBookUploadTasks: boolean;
  loadingBookSummaryTasks: boolean;
  reparsingBook: boolean;
  summaryBookId: string;
  generatingBookSummary: boolean;
  uploadingBook: boolean;
  onReloadTasks: () => void;
  onReloadSummaryTasks: () => void;
  onReparseBook: (bookId: number) => void;
  onSummaryBookIdChange: (value: string) => void;
  onGenerateBookSummary: (bookId: number) => void;
  onUploadBook: (file: File) => void;
  onToggleSection: () => void;
};

export function AdminBookUploadSection({
  books,
  bookUploadTasks,
  bookSummaryTasks,
  collapsed,
  loadingBookUploadTasks,
  loadingBookSummaryTasks,
  reparsingBook,
  summaryBookId,
  generatingBookSummary,
  uploadingBook,
  onReloadTasks,
  onReloadSummaryTasks,
  onReparseBook,
  onSummaryBookIdChange,
  onGenerateBookSummary,
  onUploadBook,
  onToggleSection,
}: AdminBookUploadSectionProps): JSX.Element {
  const [dismissedSuccessRunId, setDismissedSuccessRunId] = useState("");
  const runningTask = bookUploadTasks.find((task) => task.status === "running" || task.status === "queued") || null;
  const runningSummaryTask = bookSummaryTasks.find((task) => task.status === "running" || task.status === "queued") || null;
  const latestSucceededIngestTask = bookUploadTasks.find((task) => task.status === "succeeded") || null;
  const selectedSummaryBookId = Number(summaryBookId);
  const selectedSummaryBook = Number.isFinite(selectedSummaryBookId)
    ? books.find((item) => item.id === selectedSummaryBookId) || null
    : null;

  const statusClassName = (status: AdminBookIngestTask["status"]): string => {
    if (status === "succeeded") {
      return "done";
    }
    if (status === "failed") {
      return "todo";
    }
    return "running";
  };

  const statusLabel = (status: AdminBookIngestTask["status"]): string => {
    if (status === "succeeded") {
      return "succeeded";
    }
    if (status === "failed") {
      return "failed";
    }
    if (status === "running") {
      return "running";
    }
    return "queued";
  };

  const formatTaskSummary = (task: AdminBookIngestTask): string => {
    if (task.status === "succeeded") {
      return `总${task.total}章 / 新增${task.inserted} / 更新${task.updated} / 跳过${task.skipped}`;
    }
    if (task.status === "failed") {
      const reason = String(task.error_message || "未知错误").trim();
      return reason ? `失败：${compactText(reason, 80)}` : "失败：未知错误";
    }
    return `文件：${task.source_name || "-"}`;
  };

  const formatSummaryTask = (task: AdminBookSummaryTask): string => {
    if (task.status === "succeeded") {
      return `总${task.total}章 / 成功${task.succeeded} / 跳过${task.skipped} / 失败${task.failed}`;
    }
    if (task.status === "failed") {
      const reason = String(task.error_message || "未知错误").trim();
      return reason ? `失败：${compactText(reason, 80)}` : "失败：未知错误";
    }
    return `摘要生成中（${task.processed}/${task.total}）`;
  };

  const parseSummaryBookId = (): number => {
    const value = Number(summaryBookId);
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return Math.floor(value);
  };

  const taskTimestamp = (task: AdminBookSummaryTask): string => String(task.created_at || task.started_at || task.finished_at || "");
  const latestSummaryTaskByBookId = new Map<number, AdminBookSummaryTask>();
  for (const task of bookSummaryTasks) {
    if (task.scope_type !== "book" || !Number.isFinite(task.scope_id)) {
      continue;
    }
    const existing = latestSummaryTaskByBookId.get(task.scope_id);
    if (!existing || taskTimestamp(task) >= taskTimestamp(existing)) {
      latestSummaryTaskByBookId.set(task.scope_id, task);
    }
  }

  const bookListRows = books.map((book) => {
    const summaryTask = latestSummaryTaskByBookId.get(book.id) || null;
    const total = Math.max(0, Number(book.chapter_count) || 0);
    const summarizedCount = summaryTask
      ? Math.max(0, (Number(summaryTask.succeeded) || 0) + (Number(summaryTask.skipped) || 0))
      : 0;
    const doneCount = Math.max(0, Math.min(total, summarizedCount));
    const pendingCount = Math.max(0, total - doneCount);
    const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    const status = summaryTask?.status || "queued";
    const hasSummaryTask = Boolean(summaryTask);

    let statusText = "未生成";
    let statusClass = "todo";
    if (summaryTask?.status === "running" || summaryTask?.status === "queued") {
      statusText = "生成中";
      statusClass = "running";
    } else if (summaryTask?.status === "succeeded") {
      statusText = doneCount >= total && total > 0 ? "已完成" : "部分完成";
      statusClass = "done";
    } else if (summaryTask?.status === "failed") {
      statusText = "失败";
      statusClass = "todo";
    } else if (hasSummaryTask && doneCount > 0) {
      statusText = "部分完成";
      statusClass = "running";
    }

    return {
      book,
      doneCount,
      pendingCount,
      percent,
      status,
      statusText,
      statusClass,
    };
  });

  const totalBooks = books.length;
  const totalChapters = books.reduce((sum, book) => sum + Math.max(0, Number(book.chapter_count) || 0), 0);
  const totalSummarized = bookListRows.reduce((sum, row) => sum + row.doneCount, 0);
  const totalPending = Math.max(0, totalChapters - totalSummarized);
  const summaryPercent = totalChapters > 0 ? Math.round((totalSummarized / totalChapters) * 100) : 0;
  const runningUploadCount = bookUploadTasks.filter((task) => task.status === "queued" || task.status === "running").length;
  const runningSummaryCount = bookSummaryTasks.filter((task) => task.status === "queued" || task.status === "running").length;
  const targetBookId = parseSummaryBookId();

  const latestSuccessBannerText = latestSucceededIngestTask
    ? `${latestSucceededIngestTask.source_name || "book"} 解析完成 · ${Math.max(0, latestSucceededIngestTask.inserted || latestSucceededIngestTask.total)}章入库`
    : "";
  const showLatestSuccessBanner = Boolean(
    latestSucceededIngestTask
      && latestSucceededIngestTask.run_id
      && latestSucceededIngestTask.run_id !== dismissedSuccessRunId,
  );

  useEffect(() => {
    if (!latestSucceededIngestTask?.run_id) {
      return;
    }
    if (!dismissedSuccessRunId) {
      return;
    }
    if (latestSucceededIngestTask.run_id !== dismissedSuccessRunId) {
      setDismissedSuccessRunId("");
    }
  }, [dismissedSuccessRunId, latestSucceededIngestTask?.run_id]);

  return (
    <div className="admin-run-box admin-collapsible-box">
      <button type="button" className={`admin-collapse-head ${collapsed ? "collapsed" : ""}`} onClick={onToggleSection}>
        <h4>书籍管理（上传解析）</h4>
        <span className="admin-collapse-icon" aria-hidden="true">▾</span>
      </button>

      {!collapsed && (
        <>
          <p className="progress-inline">上传 .epub / .txt 后会自动解析入库，并同步到“谜题管理（章节生成）”选章节列表。</p>

          {runningTask && (
            <div className="banner-info admin-running-banner">
              <span>检测到未完成上传任务：{runningTask.run_id}（{statusLabel(runningTask.status)}）</span>
            </div>
          )}

          {runningSummaryTask && (
            <div className="banner-info admin-running-banner">
              <span>检测到未完成摘要任务：{runningSummaryTask.run_id}（{statusLabel(runningSummaryTask.status)}）</span>
            </div>
          )}

          {showLatestSuccessBanner && latestSucceededIngestTask && (
            <div className="admin-book-success-banner" role="status" aria-live="polite">
              <span className="admin-book-success-dot" aria-hidden="true">●</span>
              <span>{latestSuccessBannerText}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => setDismissedSuccessRunId(latestSucceededIngestTask.run_id)}
              >
                ×
              </button>
            </div>
          )}

          <div className="admin-book-manager">
            <section className="admin-book-section">
              <div className="admin-book-section-head">
                <h4>总览</h4>
                <span className="progress-inline">当前运行：上传 {runningUploadCount} · 摘要 {runningSummaryCount}</span>
              </div>

              <div className="admin-book-overview-stats">
                <div className="admin-book-stat-card">
                  <strong>{totalBooks}</strong>
                  <span>总书籍</span>
                </div>
                <div className="admin-book-stat-card">
                  <strong>{totalChapters}</strong>
                  <span>总章节</span>
                </div>
                <div className="admin-book-stat-card">
                  <strong>{totalSummarized}</strong>
                  <span>已摘要</span>
                </div>
                <div className="admin-book-stat-card">
                  <strong>{totalPending}</strong>
                  <span>待处理</span>
                </div>
              </div>

              <div className="admin-book-overview-progress">
                <div className="admin-running-banner">
                  <span>摘要总进度</span>
                  <span>{summaryPercent}%</span>
                </div>
                <div className="admin-progress-bar">
                  <div style={{ width: `${summaryPercent}%` }} />
                </div>
              </div>

              <div className="admin-book-target-row">
                <label className="form-field">
                  摘要目标书籍
                  <select value={summaryBookId} onChange={(event) => onSummaryBookIdChange(event.currentTarget.value)}>
                    <option value="">请选择书籍</option>
                    {books.map((book) => (
                      <option key={`summary-book-${book.id}`} value={book.id}>
                        {book.title}（{book.chapter_count}章）
                      </option>
                    ))}
                  </select>
                </label>

                <div className="inline-actions admin-book-target-actions">
                  <button
                    type="button"
                    className="nav-btn"
                    disabled={reparsingBook || uploadingBook || targetBookId <= 0}
                    onClick={() => onReparseBook(targetBookId)}
                  >
                    {reparsingBook ? "重解析中..." : "一键重解析"}
                  </button>
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={generatingBookSummary || targetBookId <= 0}
                    onClick={() => onGenerateBookSummary(targetBookId)}
                  >
                    {generatingBookSummary ? "摘要生成中..." : "生成章节摘要"}
                  </button>
                </div>
              </div>

              {selectedSummaryBook && !generatingBookSummary && (
                <p className="progress-inline">
                  当前摘要目标：{selectedSummaryBook.title}（{selectedSummaryBook.chapter_count}章，摘要预览将显示在章节预览中）
                </p>
              )}
            </section>

            <section className="admin-book-section">
              <div className="admin-book-section-head">
                <h4>书籍列表</h4>
                <span className="progress-inline">点击书籍可快速切换摘要目标</span>
              </div>

              {bookListRows.length === 0 ? (
                <p className="progress-inline">暂无已入库书籍，请先上传新书。</p>
              ) : (
                <ul className="admin-book-list">
                  {bookListRows.map((row) => {
                    const isTarget = row.book.id === targetBookId;
                    return (
                      <li key={`book-list-${row.book.id}`} className={`admin-book-list-item ${isTarget ? "is-active" : ""}`.trim()}>
                        <div className="admin-book-list-head">
                          <div>
                            <strong>{row.book.title}</strong>
                            <p className="progress-inline">
                              {row.book.author || "佚名"} · {row.book.chapter_count}章
                            </p>
                          </div>
                          <span className={`level-state ${row.statusClass}`}>{row.statusText}</span>
                        </div>

                        <div className="admin-running-banner">
                          <span className="progress-inline">摘要进度</span>
                          <span className="progress-inline">{row.doneCount} / {row.book.chapter_count}</span>
                        </div>
                        <div className="admin-progress-bar">
                          <div style={{ width: `${row.percent}%` }} />
                        </div>

                        <div className="inline-actions admin-book-item-actions">
                          <button
                            type="button"
                            className={isTarget ? "primary-btn" : "nav-btn"}
                            onClick={() => onSummaryBookIdChange(String(row.book.id))}
                          >
                            {isTarget ? "当前目标" : "设为目标"}
                          </button>
                          <button
                            type="button"
                            className="nav-btn"
                            disabled={generatingBookSummary}
                            onClick={() => onGenerateBookSummary(row.book.id)}
                          >
                            {generatingBookSummary && isTarget ? "生成中..." : "生成摘要"}
                          </button>
                          <button
                            type="button"
                            className="link-btn"
                            disabled={reparsingBook || uploadingBook}
                            onClick={() => onReparseBook(row.book.id)}
                          >
                            {reparsingBook && isTarget ? "重解析中..." : "重解析"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="admin-book-section">
              <div className="admin-book-section-head">
                <h4>上传新书</h4>
                <span className="progress-inline">.epub / .txt 上传后自动解析章节</span>
              </div>

              <label className="admin-book-upload-drop">
                <input
                  className="admin-book-upload-input"
                  type="file"
                  accept=".epub,.txt,application/epub+zip,text/plain"
                  disabled={uploadingBook}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) {
                      return;
                    }
                    onUploadBook(file);
                  }}
                />
                <span className="admin-book-upload-plus">＋</span>
                <strong>点击上传 .epub / .txt</strong>
                <small>上传后自动解析并同步到章节选择列表</small>
              </label>

              {uploadingBook && <p className="progress-inline">上传解析中，请稍候...</p>}
              {generatingBookSummary && <p className="progress-inline">章节摘要生成中，请稍候...</p>}

              <div className="admin-book-task-grid">
                <div className="admin-recent-jobs admin-book-task-card">
                  <div className="admin-running-banner">
                    <h4>最近上传任务（10条）</h4>
                    <button type="button" className="nav-btn" onClick={onReloadTasks} disabled={loadingBookUploadTasks}>
                      {loadingBookUploadTasks ? "刷新中..." : "刷新任务"}
                    </button>
                  </div>

                  {loadingBookUploadTasks ? (
                    <p className="progress-inline">加载中...</p>
                  ) : bookUploadTasks.length === 0 ? (
                    <p className="progress-inline">暂无上传任务记录。</p>
                  ) : (
                    <ul>
                      {bookUploadTasks.map((task) => (
                        <li key={task.run_id}>
                          <span>{task.run_id}</span>
                          <span className={`level-state ${statusClassName(task.status)}`}>{statusLabel(task.status)}</span>
                          <span>{task.source_name || "-"}</span>
                          <span>{formatTaskSummary(task)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="admin-recent-jobs admin-book-task-card">
                  <div className="admin-running-banner">
                    <h4>最近摘要任务（10条）</h4>
                    <button type="button" className="nav-btn" onClick={onReloadSummaryTasks} disabled={loadingBookSummaryTasks}>
                      {loadingBookSummaryTasks ? "刷新中..." : "刷新任务"}
                    </button>
                  </div>

                  {loadingBookSummaryTasks ? (
                    <p className="progress-inline">加载中...</p>
                  ) : bookSummaryTasks.length === 0 ? (
                    <p className="progress-inline">暂无摘要任务记录。</p>
                  ) : (
                    <ul>
                      {bookSummaryTasks.map((task) => (
                        <li key={task.run_id}>
                          <span>{task.run_id}</span>
                          <span className={`level-state ${statusClassName(task.status)}`}>{statusLabel(task.status)}</span>
                          <span>{task.scope_type}:{task.scope_id}</span>
                          <span>{formatSummaryTask(task)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

type AdminBookReplaceConfirmModalProps = {
  pendingReplace: {
    incomingFileName: string;
    existingBookTitle: string;
    existingChapterCount: number;
    message: string;
  } | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AdminBookReplaceConfirmModal({
  pendingReplace,
  submitting,
  onCancel,
  onConfirm,
}: AdminBookReplaceConfirmModalProps): JSX.Element | null {
  if (!pendingReplace) {
    return null;
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="mask-card admin-generate-modal" onClick={(event) => event.stopPropagation()}>
        <h4>同名书籍冲突</h4>
        <p className="progress-inline">{pendingReplace.message || "检测到已有同名书籍，是否替换？"}</p>
        <p className="progress-inline">旧书：{pendingReplace.existingBookTitle}（{Math.max(0, pendingReplace.existingChapterCount)}章）</p>
        <p className="progress-inline">本次文件：{pendingReplace.incomingFileName}</p>
        <div className="inline-actions">
          <button type="button" className="primary-btn" onClick={onConfirm} disabled={submitting}>
            {submitting ? "替换中..." : "替换旧书"}
          </button>
          <button type="button" className="link-btn" onClick={onCancel} disabled={submitting}>
            撤销上传
          </button>
        </div>
      </div>
    </div>
  );
}

type PuzzleFlowStep = "select" | "generate" | "review";

type AdminRunReviewSectionProps = {
  canGoNextFlowStep: boolean;
  canGoPrevFlowStep: boolean;
  canJumpGenerateStep: boolean;
  canJumpReviewStep: boolean;
  collapsed: boolean;
  currentFlowStepIndex: number;
  flowStepCount: number;
  puzzleFlowStep: PuzzleFlowStep;
  children: ReactNode;
  onSetPuzzleFlowStep: (step: PuzzleFlowStep) => void;
  onToggleSection: () => void;
};

export function AdminRunReviewSection({
  canGoNextFlowStep,
  canGoPrevFlowStep,
  canJumpGenerateStep,
  canJumpReviewStep,
  collapsed,
  currentFlowStepIndex,
  flowStepCount,
  puzzleFlowStep,
  children,
  onSetPuzzleFlowStep,
  onToggleSection,
}: AdminRunReviewSectionProps): JSX.Element {
  return (
    <div className="admin-run-box admin-collapsible-box">
      <button type="button" className={`admin-collapse-head ${collapsed ? "collapsed" : ""}`} onClick={onToggleSection}>
        <h4>谜题管理（章节生成）</h4>
        <span className="admin-collapse-icon" aria-hidden="true">▾</span>
      </button>

      {!collapsed && (
        <>
          <div className="admin-puzzle-flow" role="tablist" aria-label="谜题生成流程">
            <button
              type="button"
              className={`admin-flow-step ${puzzleFlowStep === "select" ? "active" : ""}`}
              onClick={() => onSetPuzzleFlowStep("select")}
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
              onClick={() => onSetPuzzleFlowStep("generate")}
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
              onClick={() => onSetPuzzleFlowStep("review")}
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
                  onSetPuzzleFlowStep("generate");
                } else if (puzzleFlowStep === "generate") {
                  onSetPuzzleFlowStep("select");
                }
              }}
            >
              ← 上一步
            </button>
            <span className="admin-puzzle-flow-status">流程 {currentFlowStepIndex + 1} / {flowStepCount}</span>
            <button
              type="button"
              className="nav-btn"
              disabled={!canGoNextFlowStep}
              onClick={() => {
                if (puzzleFlowStep === "select" && canJumpGenerateStep) {
                  onSetPuzzleFlowStep("generate");
                } else if (puzzleFlowStep === "generate" && canJumpReviewStep) {
                  onSetPuzzleFlowStep("review");
                }
              }}
            >
              下一步 →
            </button>
          </div>

          {children}
        </>
      )}
    </div>
  );
}

type RecentJobsMode = "all" | "generate" | "review";

type AdminRecentJobsListProps = {
  activeRunId: string;
  mode: RecentJobsMode;
  recentJobs: AdminGenerationJob[];
  reviewRunId: string;
  runCancellingId: string;
  runDeletingId: string;
  onCancelRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onOpenReview: (runId: string) => void;
  onViewJobProgress: (runId: string) => void;
};

export function AdminRecentJobsList({
  activeRunId,
  mode,
  recentJobs,
  reviewRunId,
  runCancellingId,
  runDeletingId,
  onCancelRun,
  onDeleteRun,
  onOpenReview,
  onViewJobProgress,
}: AdminRecentJobsListProps): JSX.Element {
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
                onClick={() => onViewJobProgress(job.run_id)}
                disabled={viewing}
              >
                {viewing ? "查看中" : "查看进度"}
              </button>
            )}
            {reviewViewable && (
              <button
                type="button"
                className="nav-btn admin-job-view-btn"
                onClick={() => onOpenReview(job.run_id)}
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
                onClick={() => onCancelRun(job.run_id)}
              >
                {cancelling ? "取消中" : "取消"}
              </button>
            )}
            {deletable && (
              <button
                type="button"
                className="nav-btn"
                disabled={cancelling || deleting}
                onClick={() => onDeleteRun(job.run_id)}
              >
                {deleting ? "删除中" : "删除"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type AdminPuzzleSelectStageProps = {
  bookId: string;
  books: AdminBookInfo[];
  canJumpGenerateStep: boolean;
  chapterPage: number;
  chapterPageSize: number;
  chapterPageSizeOptions: readonly number[];
  chapterTotal: number;
  chapters: AdminChapterSummary[];
  includeUsed: boolean;
  keyword: string;
  loadingChapters: boolean;
  maxCharsInput: string;
  minCharsInput: string;
  selectedChapter: AdminChapterSummary | null;
  selectedChapterId: number | null;
  submitting: boolean;
  loadingChapterTextPreview: boolean;
  totalChapterPages: number;
  onBookIdChange: (value: string) => void;
  onChapterPageSizeChange: (value: number) => void;
  onClose: () => void;
  onIncludeUsedChange: (value: boolean) => void;
  onKeywordChange: (value: string) => void;
  onLoadChapters: () => void;
  onMaxCharsInputChange: (value: string) => void;
  onMinCharsInputChange: (value: string) => void;
  onNextPage: () => void;
  onOpenGeneratedStory: (storyId: string) => void;
  onOpenGenerateDialog: () => void;
  onPreviewChapterText: (chapterId?: number) => void;
  onPrevPage: () => void;
  onSelectChapterId: (chapterId: number) => void;
  onSetPuzzleFlowGenerate: () => void;
};

export function AdminPuzzleSelectStage({
  bookId,
  books,
  canJumpGenerateStep,
  chapterPage,
  chapterPageSize,
  chapterPageSizeOptions,
  chapterTotal,
  chapters,
  includeUsed,
  keyword,
  loadingChapters,
  maxCharsInput,
  minCharsInput,
  selectedChapter,
  selectedChapterId,
  submitting,
  loadingChapterTextPreview,
  totalChapterPages,
  onBookIdChange,
  onChapterPageSizeChange,
  onClose,
  onIncludeUsedChange,
  onKeywordChange,
  onLoadChapters,
  onMaxCharsInputChange,
  onMinCharsInputChange,
  onNextPage,
  onOpenGeneratedStory,
  onOpenGenerateDialog,
  onPreviewChapterText,
  onPrevPage,
  onSelectChapterId,
  onSetPuzzleFlowGenerate,
}: AdminPuzzleSelectStageProps): JSX.Element {
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);

  const renderPreviewPanel = (mode: "desktop" | "mobile"): JSX.Element => {
    if (!selectedChapter) {
      return (
        <div className="admin-run-box admin-puzzle-preview">
          <h4>章节预览</h4>
          <p className="progress-inline">请先在左侧选择章节，再发起生成。</p>
        </div>
      );
    }

    return (
      <div className={`admin-run-box admin-puzzle-preview ${mode === "mobile" ? "mobile" : ""}`.trim()}>
        <div className="admin-puzzle-preview-head">
          <h4>章节预览</h4>
          {mode === "mobile" && (
            <button type="button" className="nav-btn" onClick={() => setMobilePreviewOpen(false)}>
              收起
            </button>
          )}
        </div>
        <p className="progress-inline">
          当前选择：第{selectedChapter.chapter_index}章 · {selectedChapter.chapter_title}（{selectedChapter.char_count}字）
        </p>
        <p className="admin-puzzle-preview-text">{selectedChapter.preview || "暂无章节预览"}</p>
        <div className="inline-actions">
          <button
            type="button"
            className="primary-btn"
            disabled={submitting}
            onClick={onOpenGenerateDialog}
          >
            {submitting ? "创建中..." : "去生成"}
          </button>
          <button
            type="button"
            className="nav-btn"
            disabled={loadingChapterTextPreview}
            onClick={() => onPreviewChapterText(selectedChapter.id)}
          >
            {loadingChapterTextPreview && selectedChapterId === selectedChapter.id ? "加载原文..." : "预览原文"}
          </button>
          {canJumpGenerateStep && (
            <button
              type="button"
              className="nav-btn"
              onClick={onSetPuzzleFlowGenerate}
            >
              查看生成进度
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <p className="progress-inline">第一步：先选章节，再点击“去生成”创建任务；章节预览改为悬浮窗展示。</p>

      <div className="admin-puzzle-main">
        <div className="admin-filters admin-puzzle-filters">
          <label className="form-field">
            书籍
            <select value={bookId} onChange={(event) => onBookIdChange(event.currentTarget.value)}>
              <option value="">全部书籍</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.title}（{book.chapter_count}章）
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            关键词
            <input value={keyword} onChange={(event) => onKeywordChange(event.currentTarget.value)} placeholder="章节标题关键词" />
          </label>

          <label className="form-field">
            最小字数
            <input value={minCharsInput} onChange={(event) => onMinCharsInputChange(event.currentTarget.value)} inputMode="numeric" />
          </label>

          <label className="form-field">
            最大字数
            <input value={maxCharsInput} onChange={(event) => onMaxCharsInputChange(event.currentTarget.value)} inputMode="numeric" />
          </label>

          <label className="form-field">
            每页条数
            <select
              value={chapterPageSize}
              onChange={(event) => onChapterPageSizeChange(Number(event.currentTarget.value))}
            >
              {chapterPageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size} 条/页
                </option>
              ))}
            </select>
          </label>

          <div className="inline-actions admin-puzzle-filter-actions">
            <label className="admin-check admin-puzzle-reuse-check">
              <input type="checkbox" checked={includeUsed} onChange={(event) => onIncludeUsedChange(event.currentTarget.checked)} />
              显示已生成章节（可重生）
            </label>
            <button type="button" className="nav-btn" onClick={onLoadChapters} disabled={loadingChapters}>
              {loadingChapters ? "查询中..." : "刷新章节"}
            </button>
            <button type="button" className="link-btn" onClick={onClose}>
              收起面板
            </button>
          </div>
        </div>

        <div className="admin-puzzle-layout">
          <div className="admin-puzzle-table-stack">
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
                          onChange={() => onSelectChapterId(chapter.id)}
                        />
                      </td>
                      <td>
                        <div className="admin-chapter-cell-book">{chapter.book_title}</div>
                      </td>
                      <td>
                        <div className="admin-chapter-cell-title">第{chapter.chapter_index}章 · {chapter.chapter_title}</div>
                        {chapter.has_succeeded_story && (
                          <>
                            <span className="level-state done" title={chapter.generated_story_id || undefined}>
                              已生成（可重生）
                            </span>
                            {chapter.generated_story_id && (
                              <button
                                type="button"
                                className="link-btn admin-open-story-btn"
                                onClick={() => onOpenGeneratedStory(chapter.generated_story_id || "")}
                              >
                                打开故事 {chapter.generated_story_id}
                              </button>
                            )}
                          </>
                        )}
                      </td>
                      <td>{chapter.char_count}</td>
                      <td>{chapter.used_count}</td>
                      <td>
                        <div className="admin-chapter-cell-action">
                          <button
                            type="button"
                            className="nav-btn"
                            disabled={submitting}
                            onClick={() => {
                              onSelectChapterId(chapter.id);
                              onOpenGenerateDialog();
                            }}
                          >
                            生成
                          </button>
                          <button
                            type="button"
                            className="nav-btn"
                            disabled={loadingChapterTextPreview}
                            onClick={() => {
                              onSelectChapterId(chapter.id);
                              onPreviewChapterText(chapter.id);
                            }}
                          >
                            {loadingChapterTextPreview && selectedChapterId === chapter.id ? "加载原文..." : "预览原文"}
                          </button>
                        </div>
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
                onClick={onPrevPage}
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
                onClick={onNextPage}
                disabled={loadingChapters || chapterPage >= totalChapterPages}
              >
                下一页 →
              </button>
            </div>
          </div>

          <aside className="admin-puzzle-side">{renderPreviewPanel("desktop")}</aside>
        </div>
      </div>

      <div className={`admin-puzzle-preview-fab-shell ${mobilePreviewOpen ? "is-open" : ""}`}>
        <button
          type="button"
          className="admin-puzzle-preview-fab-toggle"
          onClick={() => setMobilePreviewOpen((prev) => !prev)}
        >
          章节速览 {selectedChapter ? `第${selectedChapter.chapter_index}章` : "未选择"}
        </button>
        {mobilePreviewOpen && renderPreviewPanel("mobile")}
      </div>
    </>
  );
}

type ScenePreviewState = {
  run_id: string;
  scene_index: number;
  title: string;
  image_url: string;
  image_prompt: string;
};

type AdminPuzzleGenerateStageProps = {
  activeJob: AdminGenerationJobDetail | null;
  activeRunId: string;
  progress: {
    value: number;
    message: string;
    completed: number;
    total: number;
  };
  resumableJob: AdminGenerationJob | null;
  reviewBatchGenerating: boolean;
  reviewDeletingSceneIndex: number | null;
  reviewLoading: boolean;
  reviewLocked: boolean;
  reviewPendingImageCount: number;
  reviewPublishing: boolean;
  reviewRetryingSceneIndex: number | null;
  reviewRunId: string;
  reviewScenes: AdminGenerationScene[];
  reviewCounts: AdminGenerationSceneCounts;
  selectedChapter: AdminChapterSummary | null;
  submitting: boolean;
  onBatchGenerateImages: () => void;
  onDeleteReviewScene: (sceneIndex: number) => void;
  onLoadGenerationReview: (runId: string) => void;
  onOpenGenerateDialog: () => void;
  onRetryReviewCandidate: (sceneIndex: number) => void;
  onSetPuzzleFlowReview: () => void;
  onSetPuzzleFlowSelect: () => void;
  onSetScenePreview: (preview: ScenePreviewState) => void;
  onViewJobProgress: (runId: string) => void;
  renderRecentJobsGenerate: JSX.Element;
  formatGenerationJobStateLabel: (job: AdminGenerationJob | AdminGenerationJobDetail) => string;
};

export function AdminPuzzleGenerateStage({
  activeJob,
  activeRunId,
  progress,
  resumableJob,
  reviewBatchGenerating,
  reviewDeletingSceneIndex,
  reviewLoading,
  reviewLocked,
  reviewPendingImageCount,
  reviewPublishing,
  reviewRetryingSceneIndex,
  reviewRunId,
  reviewScenes,
  reviewCounts,
  selectedChapter,
  submitting,
  onBatchGenerateImages,
  onDeleteReviewScene,
  onLoadGenerationReview,
  onOpenGenerateDialog,
  onRetryReviewCandidate,
  onSetPuzzleFlowReview,
  onSetPuzzleFlowSelect,
  onSetScenePreview,
  onViewJobProgress,
  renderRecentJobsGenerate,
  formatGenerationJobStateLabel,
}: AdminPuzzleGenerateStageProps): JSX.Element {
  return (
    <div className="admin-puzzle-stage-stack">
      <div className="admin-run-box admin-puzzle-stage">
        <div className="admin-review-head">
          <h4>任务监控</h4>
          <div className="inline-actions">
            <button type="button" className="nav-btn" onClick={onSetPuzzleFlowSelect}>
              返回选章节
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                onSetPuzzleFlowSelect();
                onOpenGenerateDialog();
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
            <button type="button" className="nav-btn" onClick={() => onViewJobProgress(resumableJob.run_id)}>
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
                onClick={() => onLoadGenerationReview(reviewRunId)}
              >
                {reviewLoading ? "刷新中..." : "刷新"}
              </button>
              <button
                type="button"
                className="nav-btn"
                disabled={reviewLocked || reviewLoading || reviewPublishing || reviewBatchGenerating || reviewPendingImageCount <= 0}
                onClick={onBatchGenerateImages}
              >
                {reviewBatchGenerating ? "批量出图中..." : `批量出图（${reviewPendingImageCount}）`}
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={reviewScenes.length === 0}
                onClick={onSetPuzzleFlowReview}
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
                                  onSetScenePreview({
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
                                onClick={() => onRetryReviewCandidate(scene.scene_index)}
                              >
                                {retrying ? "重试中..." : "重试"}
                              </button>
                              <button
                                type="button"
                                className="nav-btn admin-review-delete-btn"
                                disabled={reviewLocked || retrying || deleting || reviewPublishing || reviewLoading || reviewBatchGenerating}
                                onClick={() => onDeleteReviewScene(scene.scene_index)}
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
        {renderRecentJobsGenerate}
      </div>
    </div>
  );
}

type AdminPuzzleReviewStageProps = {
  activeJob: AdminGenerationJobDetail | null;
  reviewGridOptions: number[];
  reviewLoading: boolean;
  reviewLocked: boolean;
  reviewPendingImageCount: number;
  reviewPublishing: boolean;
  reviewReadyCount: number;
  reviewRunId: string;
  reviewScenes: AdminGenerationScene[];
  reviewTimeOptions: number[];
  reviewUpdatingSceneIndex: number | null;
  reviewCounts: AdminGenerationSceneCounts;
  reviewBatchGenerating: boolean;
  onLoadGenerationReview: (runId: string) => void;
  onPublishSelected: () => void;
  onSetPuzzleFlowGenerate: () => void;
  onSetScenePreview: (preview: ScenePreviewState) => void;
  onUpdateReviewScene: (sceneIndex: number, patch: {
    grid_rows?: number;
    grid_cols?: number;
    time_limit_sec?: number;
    selected?: boolean;
  }) => void;
  renderRecentJobsReview: JSX.Element;
  formatTime: (value: string | null | undefined) => string;
};

export function AdminPuzzleReviewStage({
  activeJob,
  reviewGridOptions,
  reviewLoading,
  reviewLocked,
  reviewPendingImageCount,
  reviewPublishing,
  reviewReadyCount,
  reviewRunId,
  reviewScenes,
  reviewTimeOptions,
  reviewUpdatingSceneIndex,
  reviewCounts,
  reviewBatchGenerating,
  onLoadGenerationReview,
  onPublishSelected,
  onSetPuzzleFlowGenerate,
  onSetScenePreview,
  onUpdateReviewScene,
  renderRecentJobsReview,
  formatTime,
}: AdminPuzzleReviewStageProps): JSX.Element {
  return (
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
                onClick={() => onLoadGenerationReview(reviewRunId)}
              >
                {reviewLoading ? "刷新中..." : "刷新"}
              </button>
              <button
                type="button"
                className="nav-btn"
                disabled={reviewLoading || reviewPublishing}
                onClick={onSetPuzzleFlowGenerate}
              >
                返回步骤2
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={reviewLocked || reviewLoading || reviewPublishing || reviewReadyCount <= 0}
                onClick={onPublishSelected}
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
                                onSetScenePreview({
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
                                onUpdateReviewScene(scene.scene_index, {
                                  grid_rows: Number(event.currentTarget.value),
                                });
                              }}
                            >
                              {reviewGridOptions.map((value) => (
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
                                onUpdateReviewScene(scene.scene_index, {
                                  grid_cols: Number(event.currentTarget.value),
                                });
                              }}
                            >
                              {reviewGridOptions.map((value) => (
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
                                onUpdateReviewScene(scene.scene_index, {
                                  time_limit_sec: Number(event.currentTarget.value),
                                });
                              }}
                            >
                              {reviewTimeOptions.map((value) => (
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
                              onUpdateReviewScene(scene.scene_index, {
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
        {renderRecentJobsReview}
      </div>
    </div>
  );
}

type AdminPublishSectionProps = {
  publishSuccess: {
    run_id: string;
    story_id: string;
    level_count: number;
  } | null;
  onOpenPublishedStory: () => void;
  onStayAfterPublish: () => void;
};

export function AdminPublishSection({
  publishSuccess,
  onOpenPublishedStory,
  onStayAfterPublish,
}: AdminPublishSectionProps): JSX.Element | null {
  if (!publishSuccess) {
    return null;
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" onClick={onStayAfterPublish}>
      <div className="mask-card admin-publish-success-modal" onClick={(event) => event.stopPropagation()}>
        <h4>发布成功</h4>
        <p className="progress-inline">任务：{publishSuccess.run_id}</p>
        <p className="progress-inline">故事：{publishSuccess.story_id}（{publishSuccess.level_count} 关）</p>
        <p className="progress-inline">是否返回故事导航并打开该故事？</p>
        <div className="inline-actions">
          <button type="button" className="primary-btn" onClick={onOpenPublishedStory}>
            打开故事导航
          </button>
          <button type="button" className="nav-btn" onClick={onStayAfterPublish}>
            留在当前页
          </button>
        </div>
      </div>
    </div>
  );
}

type AdminScenePreviewModalProps = {
  scenePreview: {
    scene_index: number;
    title: string;
    image_url: string;
    image_prompt: string;
  } | null;
  onClose: () => void;
};

export function AdminScenePreviewModal({ scenePreview, onClose }: AdminScenePreviewModalProps): JSX.Element | null {
  if (!scenePreview) {
    return null;
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mask-card admin-image-preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="admin-image-preview-head">
          <h4>{scenePreview.title || `Scene ${scenePreview.scene_index}`} · 预览</h4>
          <button type="button" className="nav-btn" onClick={onClose}>关闭</button>
        </div>
        {scenePreview.image_url ? (
          <img className="admin-image-preview" src={scenePreview.image_url} alt={scenePreview.title || `scene ${scenePreview.scene_index}`} />
        ) : (
          <p className="progress-inline">暂无可预览图片。</p>
        )}
        <p className="admin-image-preview-prompt">{compactText(scenePreview.image_prompt, 260)}</p>
      </div>
    </div>
  );
}

type AdminChapterTextPreviewModalProps = {
  chapterPreview: {
    chapter_id: number;
    book_title: string;
    book_author: string;
    chapter_index: number;
    chapter_title: string;
    char_count: number;
    word_count: number;
    chapter_text: string;
  } | null;
  onClose: () => void;
};

export function AdminChapterTextPreviewModal({
  chapterPreview,
  onClose,
}: AdminChapterTextPreviewModalProps): JSX.Element | null {
  if (!chapterPreview) {
    return null;
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mask-card admin-chapter-text-modal" onClick={(event) => event.stopPropagation()}>
        <div className="admin-image-preview-head">
          <h4>
            第{chapterPreview.chapter_index}章 · {chapterPreview.chapter_title}
          </h4>
          <button type="button" className="nav-btn" onClick={onClose}>关闭</button>
        </div>
        <p className="progress-inline">
          {chapterPreview.book_title}
          {chapterPreview.book_author ? ` · ${chapterPreview.book_author}` : ""}
        </p>
        <p className="progress-inline">
          字数 {chapterPreview.char_count} · 词数 {chapterPreview.word_count}
        </p>
        <pre className="admin-chapter-text-content">{chapterPreview.chapter_text || "暂无章节原文"}</pre>
      </div>
    </div>
  );
}

type AdminGenerateDialogModalProps = {
  open: boolean;
  defaultSceneCount: number;
  sceneCountInput: string;
  selectedChapter: AdminChapterSummary | null;
  submitting: boolean;
  targetDate: string;
  onClose: () => void;
  onSceneCountInputChange: (value: string) => void;
  onSubmit: () => void;
  onTargetDateChange: (value: string) => void;
};

export function AdminGenerateDialogModal({
  open,
  defaultSceneCount,
  sceneCountInput,
  selectedChapter,
  submitting,
  targetDate,
  onClose,
  onSceneCountInputChange,
  onSubmit,
  onTargetDateChange,
}: AdminGenerateDialogModalProps): JSX.Element | null {
  if (!open) {
    return null;
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mask-card admin-generate-modal" onClick={(event) => event.stopPropagation()}>
        <h4>生成参数</h4>
        <p className="progress-inline">确认参数后开始生成任务。</p>

        <label className="form-field">
          生成日期（story_YYYY-MM-DD）
          <input value={targetDate} onChange={(event) => onTargetDateChange(event.currentTarget.value)} placeholder="YYYY-MM-DD" />
        </label>

        <label className="form-field">
          目标张数（至少 6）
          <input
            value={sceneCountInput}
            onChange={(event) => onSceneCountInputChange(event.currentTarget.value)}
            inputMode="numeric"
            placeholder={String(defaultSceneCount)}
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
            onClick={onSubmit}
          >
            {submitting ? "创建中..." : "开始生成"}
          </button>
          <button type="button" className="link-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
