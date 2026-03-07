import { CSSProperties, PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";

import { StoryDetail } from "../core/types";

type StoryPageProps = {
  activeJumperIndex: number;
  activeJumperLevelId: string;
  activeStory: StoryDetail;
  completedCount: number;
  error: string;
  hideDetailCover: boolean;
  mobileJumperStyle: CSSProperties;
  overviewParagraphs: string[];
  overviewTitle: string;
  pendingCount: number;
  renderDesktopJumperItems: JSX.Element[];
  renderMobileJumperItems: JSX.Element[];
  sharedCoverOverlay: JSX.Element | null;
  showMobileJumper: boolean;
  storyBestTimeText: string;
  storyLevelTotal: number;
  storyProgressPercent: number;
  onBackToStories: () => void;
  onCoverError: (event: SyntheticEvent<HTMLImageElement>) => void;
  onCoverOrFallback: (value: string | undefined) => string;
  onFormatBestTime: (value?: number) => string;
  onLogout: () => void;
  onMobileJumperPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onMobileJumperPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onMobileJumperPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onOpenPlayAtIndex: (index: number, attemptsIncrement: number) => void;
  onStoryDetailCoverRefChange: (node: HTMLImageElement | null) => void;
};

export function StoryPage({
  activeJumperIndex,
  activeJumperLevelId,
  activeStory,
  completedCount,
  error,
  hideDetailCover,
  mobileJumperStyle,
  overviewParagraphs,
  overviewTitle,
  pendingCount,
  renderDesktopJumperItems,
  renderMobileJumperItems,
  sharedCoverOverlay,
  showMobileJumper,
  storyBestTimeText,
  storyLevelTotal,
  storyProgressPercent,
  onBackToStories,
  onCoverError,
  onCoverOrFallback,
  onFormatBestTime,
  onLogout,
  onMobileJumperPointerDown,
  onMobileJumperPointerMove,
  onMobileJumperPointerUp,
  onOpenPlayAtIndex,
  onStoryDetailCoverRefChange,
}: StoryPageProps): JSX.Element {
  return (
    <div className="hub-shell story-shell story-directory-shell story-enter-shell">
      <header className="story-directory-navbar">
        <div className="story-directory-brand">故事目录</div>
        <div className="toolbar-row">
          <button type="button" className="nav-btn" onClick={onBackToStories}>
            ← 返回故事导航
          </button>
          <button type="button" className="nav-btn" onClick={onLogout}>
            退出登录
          </button>
        </div>
      </header>

      {error && <div className="banner-error">{error}</div>}

      <section className="story-directory-hero">
        <img
          ref={onStoryDetailCoverRefChange}
          src={onCoverOrFallback(activeStory.cover)}
          alt={activeStory.title}
          className={`story-directory-hero-cover ${hideDetailCover ? "is-hidden" : ""}`}
          onError={onCoverError}
        />
        <div className="story-directory-hero-overlay" />
        <div className="story-directory-hero-content">
          <p className="story-directory-eyebrow">聊斋故事线</p>
          <h1>{activeStory.title}</h1>
          <p className="story-directory-description">{activeStory.description}</p>
          <div className="story-directory-progress">
            <div className="story-directory-progress-row">
              <span className="progress-inline">故事进度</span>
              <span className="progress-inline">已完成 {completedCount}/{storyLevelTotal} 关</span>
            </div>
            <div className="story-directory-progress-bar">
              <div style={{ width: `${storyProgressPercent}%` }} />
            </div>
          </div>
        </div>
      </section>

      <main className="story-directory-main">
        <section className="story-directory-left">
          <article className="story-intro-card">
            <p className="story-intro-title">故事简介</p>
            <p className="story-intro-text">{activeStory.description}</p>
          </article>

          <details className="story-narration-card" open={overviewParagraphs.length > 0}>
            <summary>
              <span>{overviewTitle}</span>
            </summary>
            <div className="story-narration-body">
              {overviewParagraphs.length > 0 ? (
                overviewParagraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
              ) : (
                <p>暂无旁白，直接选择关卡开始挑战。</p>
              )}
            </div>
          </details>

          <div className="story-levels-title">全部关卡</div>
          <section className="story-level-list">
            {activeStory.levels.map((level, index) => {
              const progress = activeStory.level_progress[level.id];
              const completed = progress?.status === "completed";
              const inProgress = progress?.status === "in_progress";
              const disabled = Boolean(level.asset_missing);
              const stateClass = completed ? "done" : inProgress ? "current" : "locked";
              const stateLabel = disabled ? "资源缺失" : completed ? "已完成" : inProgress ? "进行中" : "未开始";
              const bestTimeText = onFormatBestTime(progress?.best_time_ms);
              const actionLabel = disabled ? "不可用" : completed ? "重玩" : inProgress ? "继续" : "开始";
              const isLinked = activeJumperLevelId === level.id;

              return (
                <article
                  className={`story-level-card ${stateClass}${isLinked ? " is-focused" : ""}`}
                  key={level.id}
                  id={`story-level-${level.id}`}
                  data-level-id={level.id}
                >
                  <div className="story-level-main">
                    <div className="story-level-left">
                      <h3>
                        {index + 1}. {level.title}
                      </h3>
                      <p>{level.description}</p>
                      <div className="story-level-tags">
                        <span className="story-level-tag">网格 {level.grid.rows} × {level.grid.cols}</span>
                        <span className={`story-level-tag story-level-tag-${stateClass}`}>{stateLabel}</span>
                        {bestTimeText && <span className="story-level-tag">最快 {bestTimeText}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`story-level-action story-level-action-${stateClass}`}
                      disabled={disabled}
                      onClick={() => onOpenPlayAtIndex(index, inProgress ? 0 : 1)}
                    >
                      {actionLabel}
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        </section>

        <aside className="story-directory-right">
          <section className="story-stats-card">
            <p className="story-stats-title">游玩统计</p>
            <div className="story-stats-grid">
              <div>
                <strong>{completedCount}</strong>
                <span>已完成</span>
              </div>
              <div>
                <strong>{pendingCount}</strong>
                <span>待挑战</span>
              </div>
              <div>
                <strong>{storyBestTimeText || "--:--"}</strong>
                <span>最佳用时</span>
              </div>
              <div>
                <strong>{storyProgressPercent}%</strong>
                <span>完成率</span>
              </div>
            </div>
          </section>

          <section className="story-jumper-card">
            <p className="story-stats-title">关卡速览</p>
            <div className="story-jumper-list">{renderDesktopJumperItems}</div>
          </section>
        </aside>
      </main>

      <div className={`story-jumper-fab-shell ${showMobileJumper ? "is-open" : ""}`} style={mobileJumperStyle}>
        <button
          type="button"
          className="story-jumper-fab-toggle"
          onPointerDown={onMobileJumperPointerDown}
          onPointerMove={onMobileJumperPointerMove}
          onPointerUp={onMobileJumperPointerUp}
        >
          关卡速览 {activeJumperIndex}/{storyLevelTotal}
        </button>

        {showMobileJumper && (
          <section className="story-jumper-fab-panel" aria-label="移动端关卡速览">
            <p className="story-stats-title">关卡速览</p>
            <div className="story-jumper-list">{renderMobileJumperItems}</div>
          </section>
        )}
      </div>

      {sharedCoverOverlay}
    </div>
  );
}
