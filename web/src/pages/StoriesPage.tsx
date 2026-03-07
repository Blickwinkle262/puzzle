import { SyntheticEvent } from "react";

import { StoryListItem } from "../core/types";

type StoryBookGroup = {
  key: string;
  title: string;
  stories: StoryListItem[];
  totalLevels: number;
  completedLevels: number;
};

type StoriesPageProps = {
  activeBookKey: string;
  adminGeneratorNode: JSX.Element | null;
  currentPasswordInput: string;
  error: string;
  hideStoriesHero: boolean;
  info: string;
  isAdmin: boolean;
  isGuest: boolean;
  nextPasswordInput: string;
  openingStoryId: string | null;
  roleHint: string;
  roleKey: string;
  roleLabel: string;
  sharedCoverOverlay: JSX.Element | null;
  showAdminGenerator: boolean;
  showChangePassword: boolean;
  showGuestUpgrade: boolean;
  storyBookGroups: StoryBookGroup[];
  totalBookCount: number;
  totalCompletedCount: number;
  totalLevelCount: number;
  totalStoryCount: number;
  upgradePasswordInput: string;
  upgradeUsernameInput: string;
  userName: string;
  onChangePasswordSubmit: () => void;
  onCoverError: (event: SyntheticEvent<HTMLImageElement>) => void;
  onCoverOrFallback: (value: string | undefined) => string;
  onCurrentPasswordInputChange: (value: string) => void;
  onGuestUpgradeSubmit: () => void;
  onHideChangePassword: () => void;
  onHideGuestUpgrade: () => void;
  onLogout: () => void;
  onNextPasswordInputChange: (value: string) => void;
  onOpenStory: (story: StoryListItem) => void;
  onStoryCoverRefChange: (storyId: string, node: HTMLImageElement | null) => void;
  onToggleAdminGenerator: () => void;
  onToggleBook: (bookKey: string) => void;
  onToggleChangePassword: () => void;
  onToggleGuestUpgrade: () => void;
  onUpgradePasswordInputChange: (value: string) => void;
  onUpgradeUsernameInputChange: (value: string) => void;
};

export function StoriesPage({
  activeBookKey,
  adminGeneratorNode,
  currentPasswordInput,
  error,
  hideStoriesHero,
  info,
  isAdmin,
  isGuest,
  nextPasswordInput,
  openingStoryId,
  roleHint,
  roleKey,
  roleLabel,
  sharedCoverOverlay,
  showAdminGenerator,
  showChangePassword,
  showGuestUpgrade,
  storyBookGroups,
  totalBookCount,
  totalCompletedCount,
  totalLevelCount,
  totalStoryCount,
  upgradePasswordInput,
  upgradeUsernameInput,
  userName,
  onChangePasswordSubmit,
  onCoverError,
  onCoverOrFallback,
  onCurrentPasswordInputChange,
  onGuestUpgradeSubmit,
  onHideChangePassword,
  onHideGuestUpgrade,
  onLogout,
  onNextPasswordInputChange,
  onOpenStory,
  onStoryCoverRefChange,
  onToggleAdminGenerator,
  onToggleBook,
  onToggleChangePassword,
  onToggleGuestUpgrade,
  onUpgradePasswordInputChange,
  onUpgradeUsernameInputChange,
}: StoriesPageProps): JSX.Element {
  return (
    <div className={`hub-shell stories-shell stories-home-shell role-shell role-${roleKey}`}>
      <header className="stories-home-nav">
        <div className="stories-home-brand">故事导航</div>
        <div className="toolbar-row nav-right">
          {isGuest ? (
            <button type="button" className="nav-btn" onClick={onToggleGuestUpgrade}>
              升级账号
            </button>
          ) : (
            <button type="button" className="nav-btn" onClick={onToggleChangePassword}>
              修改密码
            </button>
          )}
          {isAdmin && (
            <button type="button" className="nav-btn" onClick={onToggleAdminGenerator}>
              {showAdminGenerator ? "收起管理后台" : "管理后台"}
            </button>
          )}
          <button type="button" className="nav-btn" onClick={onLogout}>
            退出登录
          </button>
        </div>
      </header>

      {error && <div className="banner-error">{error}</div>}
      {info && <div className="banner-info">{info}</div>}

      {adminGeneratorNode}

      {isGuest && showGuestUpgrade && (
        <section className="account-panel">
          <h3>游客账号升级</h3>
          <p>升级后可跨设备登录，并继续当前进度。</p>
          <label className="form-field">
            新用户名
            <input
              value={upgradeUsernameInput}
              onChange={(event) => onUpgradeUsernameInputChange(event.currentTarget.value)}
              placeholder="至少 3 个字符"
              autoComplete="username"
            />
          </label>
          <label className="form-field">
            新密码
            <input
              type="password"
              value={upgradePasswordInput}
              onChange={(event) => onUpgradePasswordInputChange(event.currentTarget.value)}
              placeholder="至少 6 位"
              autoComplete="new-password"
            />
          </label>
          <div className="inline-actions">
            <button type="button" className="primary-btn" onClick={onGuestUpgradeSubmit}>
              完成升级
            </button>
            <button type="button" className="link-btn" onClick={onHideGuestUpgrade}>
              取消
            </button>
          </div>
        </section>
      )}

      {!isGuest && showChangePassword && (
        <section className="account-panel">
          <h3>修改密码</h3>
          <p>更新后当前会话会自动轮换，不影响正在玩的关卡。</p>
          <label className="form-field">
            当前密码
            <input
              type="password"
              value={currentPasswordInput}
              onChange={(event) => onCurrentPasswordInputChange(event.currentTarget.value)}
              placeholder="输入当前密码"
              autoComplete="current-password"
            />
          </label>
          <label className="form-field">
            新密码
            <input
              type="password"
              value={nextPasswordInput}
              onChange={(event) => onNextPasswordInputChange(event.currentTarget.value)}
              placeholder="至少 6 位"
              autoComplete="new-password"
            />
          </label>
          <div className="inline-actions">
            <button type="button" className="primary-btn" onClick={onChangePasswordSubmit}>
              更新密码
            </button>
            <button type="button" className="link-btn" onClick={onHideChangePassword}>
              取消
            </button>
          </div>
        </section>
      )}

      {!hideStoriesHero && (
        <section className="stories-home-hero">
          <h1>
            故事<span>导航</span>
          </h1>
          <p className="stories-home-sub">
            欢迎你，{userName || "玩家"}
            <span className={`role-badge role-badge-${roleKey}`}>{roleLabel}</span>
          </p>
          <p className="stories-home-hint">{roleHint}</p>
          <div className="stories-home-stats">
            <div className="stories-home-stat">
              <strong>{totalBookCount}</strong>
              <span>书目</span>
            </div>
            <div className="stories-home-stat">
              <strong>{totalStoryCount}</strong>
              <span>故事</span>
            </div>
            <div className="stories-home-stat">
              <strong>{totalLevelCount}</strong>
              <span>关卡</span>
            </div>
            <div className="stories-home-stat">
              <strong>{totalCompletedCount}</strong>
              <span>已完成</span>
            </div>
          </div>
        </section>
      )}

      <div className="stories-home-divider">
        <span />
        <b>{hideStoriesHero ? "书目" : "全部书目"}</b>
        <span />
      </div>

      {storyBookGroups.length > 0 ? (
        <main className="stories-home-main">
          {storyBookGroups.map((group, groupIndex) => {
            const isOpen = activeBookKey === group.key;
            const bookProgressPercent = group.totalLevels > 0 ? Math.round((group.completedLevels / group.totalLevels) * 100) : 0;
            const coverStory = group.stories.find((story) => Boolean(story.cover)) || group.stories[0] || null;

            return (
              <section
                key={group.key}
                className={`stories-book-section ${isOpen ? "open" : ""}`}
                style={{ animationDelay: `${0.08 + groupIndex * 0.06}s` }}
              >
                <button
                  type="button"
                  className="stories-book-header"
                  disabled={Boolean(openingStoryId)}
                  onClick={() => onToggleBook(group.key)}
                >
                  <div className="stories-book-thumb">
                    {coverStory ? (
                      <img src={onCoverOrFallback(coverStory.cover)} alt={group.title} onError={onCoverError} />
                    ) : (
                      <span>📖</span>
                    )}
                  </div>
                  <div className="stories-book-info">
                    <h2>{group.title}</h2>
                    <p>
                      故事 {group.stories.length} 本 · 关卡 {group.totalLevels} 关
                    </p>
                    <div className="stories-book-progress-row">
                      <div className="stories-book-progress-bar">
                        <i style={{ width: `${bookProgressPercent}%` }} />
                      </div>
                      <span>
                        {group.completedLevels} / {group.totalLevels}
                      </span>
                    </div>
                  </div>
                  <div className="stories-book-toggle" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6,9 12,15 18,9" />
                    </svg>
                  </div>
                </button>

                <div className="stories-book-body" style={{ maxHeight: isOpen ? "none" : "0px" }}>
                  <div className="stories-book-curtain" aria-hidden="true">
                    <span className="stories-book-curtain-rod" />
                    <span className="stories-book-curtain-half left">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="stories-book-curtain-half right">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <div className="stories-book-body-inner">
                    <p className="stories-book-description">
                      已收录 {group.stories.length} 个故事，支持继续闯关与新故事扩展。
                    </p>

                    <div className={`stories-story-grid ${openingStoryId ? "has-opening" : ""}`}>
                      {group.stories.map((story) => {
                        const completed = Number(story.completed_levels || 0);
                        const total = Number(story.total_levels || 0);
                        const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
                        const statusClass = completed >= total && total > 0 ? "done" : completed > 0 ? "current" : "none";

                        return (
                          <button
                            type="button"
                            key={story.id}
                            className={`stories-story-card status-${statusClass} ${openingStoryId === story.id ? "is-opening" : ""}`}
                            disabled={Boolean(openingStoryId)}
                            onClick={() => onOpenStory(story)}
                          >
                            <div className="stories-story-cover">
                              <img
                                ref={(node) => {
                                  onStoryCoverRefChange(story.id, node);
                                }}
                                src={onCoverOrFallback(story.cover)}
                                alt={story.title}
                                onError={onCoverError}
                              />
                              {statusClass === "current" && <span className="stories-story-badge current">进行中</span>}
                              {statusClass === "done" && <span className="stories-story-badge done">已完成</span>}
                            </div>
                            <div className="stories-story-info">
                              <h3>{story.title}</h3>
                              <p>{story.description}</p>
                              <div className="stories-story-progress-row">
                                <span className={completed > 0 ? "has-progress" : ""}>
                                  完成度 {completed}/{total}
                                </span>
                                <div className="stories-story-mini-bar">
                                  <i style={{ width: `${progressPercent}%` }} />
                                </div>
                              </div>
                              <div className="stories-story-cta">{completed > 0 ? "继续翻开" : "打开这本故事"} →</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </main>
      ) : (
        <div className="screen-message">暂无可展示的故事内容</div>
      )}

      {openingStoryId && <div className="opening-note">正在翻开故事...</div>}
      {sharedCoverOverlay}
    </div>
  );
}
