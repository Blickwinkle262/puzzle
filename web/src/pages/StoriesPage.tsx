import {
  CSSProperties,
  SyntheticEvent,
  TouchEvent as ReactTouchEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AdminStoryBookOption, StoryListItem } from "../core/types";

type StoryBookGroup = {
  key: string;
  title: string;
  stories: StoryListItem[];
  storyCount: number;
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
  storyMetaBookOptions: AdminStoryBookOption[];
  storyMetaEditor: {
    story_id: string;
    title: string;
    book_id: string;
    description: string;
    story_overview_title: string;
    story_overview_text: string;
  } | null;
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
  onOpenStoryMetaEditor: (story: StoryListItem) => void;
  onSaveStoryMetaEditor: () => void;
  onStoryCoverRefChange: (storyId: string, node: HTMLImageElement | null) => void;
  onStoryMetaBookIdChange: (value: string) => void;
  onStoryMetaDescriptionChange: (value: string) => void;
  onStoryMetaOverviewTextChange: (value: string) => void;
  onStoryMetaOverviewTitleChange: (value: string) => void;
  onCloseStoryMetaEditor: () => void;
  onToggleAdminGenerator: () => void;
  onToggleBook: (bookKey: string) => void;
  onToggleChangePassword: () => void;
  onToggleGuestUpgrade: () => void;
  onUpgradePasswordInputChange: (value: string) => void;
  onUpgradeUsernameInputChange: (value: string) => void;
  loadingStoryMetaEditor: boolean;
  savingStoryMetaEditor: boolean;
};

type StoryPreviewState = {
  story: StoryListItem;
  groupTitle: string;
  completed: number;
  total: number;
  progressPercent: number;
  isPlaceholder: boolean;
};

type StoryRailState = {
  activeIndex: number;
  total: number;
  progress: number;
};

type StorySubgroup = {
  key: string;
  label: string;
  stories: StoryListItem[];
  offset: number;
};

const STORY_SUBGROUP_CHUNK_SIZE = 8;
const STORY_TOUCH_MOVE_THRESHOLD_PX = 10;

function getStoryFanTiltDegrees(index: number, total: number): number {
  const normalizedTotal = Math.max(1, Number(total || 0));
  if (normalizedTotal <= 1) {
    return 0;
  }
  const center = (normalizedTotal - 1) / 2;
  const distanceFromCenter = index - center;
  const maxDistance = Math.max(1, center);
  const normalizedDistance = distanceFromCenter / maxDistance;
  const tilt = normalizedDistance * 5.5;
  return Math.max(-6, Math.min(6, tilt));
}

function buildStorySubgroups(stories: StoryListItem[]): StorySubgroup[] {
  if (!Array.isArray(stories) || stories.length <= 12) {
    return [{ key: "all", label: "全部", stories: Array.isArray(stories) ? stories : [], offset: 0 }];
  }

  const groups: StorySubgroup[] = [];
  for (let index = 0; index < stories.length; index += STORY_SUBGROUP_CHUNK_SIZE) {
    const start = index;
    const end = Math.min(stories.length, start + STORY_SUBGROUP_CHUNK_SIZE);
    groups.push({
      key: `part-${groups.length + 1}`,
      label: `${start + 1}-${end}`,
      stories: stories.slice(start, end),
      offset: start,
    });
  }
  return groups;
}

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
  storyMetaBookOptions,
  storyMetaEditor,
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
  onOpenStoryMetaEditor,
  onSaveStoryMetaEditor,
  onStoryCoverRefChange,
  onStoryMetaBookIdChange,
  onStoryMetaDescriptionChange,
  onStoryMetaOverviewTextChange,
  onStoryMetaOverviewTitleChange,
  onCloseStoryMetaEditor,
  onToggleAdminGenerator,
  onToggleBook,
  onToggleChangePassword,
  onToggleGuestUpgrade,
  onUpgradePasswordInputChange,
  onUpgradeUsernameInputChange,
  loadingStoryMetaEditor,
  savingStoryMetaEditor,
}: StoriesPageProps): JSX.Element {
  const [previewState, setPreviewState] = useState<StoryPreviewState | null>(null);
  const [liftedStoryId, setLiftedStoryId] = useState<string | null>(null);
  const [storyRailStateMap, setStoryRailStateMap] = useState<Record<string, StoryRailState>>({});
  const [selectedStorySlotKey, setSelectedStorySlotKey] = useState<string | null>(null);
  const [storySubgroupIndexMap, setStorySubgroupIndexMap] = useState<Record<string, number>>({});

  const storyTrackRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const touchMovedRef = useRef(false);
  const touchStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragStateRef = useRef<{
    railKey: string;
    totalStoryCount: number;
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current === null) {
      return;
    }
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const buildPreviewState = (story: StoryListItem, groupTitle: string): StoryPreviewState => {
    const completed = Number(story.completed_levels || 0);
    const total = Number(story.total_levels || 0);
    const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return {
      story,
      groupTitle,
      completed,
      total,
      progressPercent,
      isPlaceholder: Boolean(story.book_placeholder),
    };
  };

  const openStoryPreview = (story: StoryListItem, groupTitle: string) => {
    if (Boolean(openingStoryId)) {
      return;
    }
    setPreviewState(buildPreviewState(story, groupTitle));
  };

  const closeStoryPreview = () => {
    setPreviewState(null);
  };

  const getStoryRailModeClass = (storyCount: number): string => {
    if (storyCount <= 5) {
      return "mode-static";
    }
    if (storyCount <= 12) {
      return "mode-rail";
    }
    return "mode-dense";
  };

  const getStoryRailKey = (bookKey: string, subgroupKey: string): string => `${bookKey}::${subgroupKey}`;

  const updateStoryRailState = (railKey: string, totalStoryCount: number) => {
    const trackNode = storyTrackRefs.current[railKey];
    if (!trackNode) {
      return;
    }

    const total = Math.max(1, Number(totalStoryCount || 0));
    const maxScrollLeft = Math.max(0, trackNode.scrollWidth - trackNode.clientWidth);
    const progress = maxScrollLeft > 0 ? Math.min(1, Math.max(0, trackNode.scrollLeft / maxScrollLeft)) : 0;
    const slotNodes = Array.from(trackNode.querySelectorAll<HTMLElement>(":scope > .stories-story-slot"));

    let activeIndex = total <= 1 ? 1 : Math.min(total, Math.max(1, Math.round(progress * (total - 1)) + 1));
    if (slotNodes.length > 0) {
      const viewportCenterX = trackNode.scrollLeft + trackNode.clientWidth / 2;
      let nearestDistance = Number.POSITIVE_INFINITY;
      let nearestIndex = 0;
      slotNodes.forEach((slotNode, index) => {
        const slotCenterX = slotNode.offsetLeft + slotNode.offsetWidth / 2;
        const distance = Math.abs(slotCenterX - viewportCenterX);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
      activeIndex = Math.min(total, Math.max(1, nearestIndex + 1));
    }

    setStoryRailStateMap((prev) => {
      const existing = prev[railKey];
      if (
        existing
        && existing.total === total
        && existing.activeIndex === activeIndex
        && Math.abs(existing.progress - progress) < 0.01
      ) {
        return prev;
      }

      return {
        ...prev,
        [railKey]: {
          total,
          activeIndex,
          progress,
        },
      };
    });
  };

  const forceFocusStorySlot = (railKey: string, totalStoryCount: number, slotIndex: number) => {
    const total = Math.max(1, Number(totalStoryCount || 0));
    const activeIndex = Math.min(total, Math.max(1, Math.floor(Number(slotIndex || 1))));
    setStoryRailStateMap((prev) => {
      const existing = prev[railKey];
      if (existing && existing.total === total && existing.activeIndex === activeIndex) {
        return prev;
      }
      return {
        ...prev,
        [railKey]: {
          total,
          activeIndex,
          progress: existing?.progress ?? 0,
        },
      };
    });
  };

  useEffect(() => {
    if (!activeBookKey) {
      return;
    }

    const group = storyBookGroups.find((item) => item.key === activeBookKey);
    if (!group) {
      return;
    }
    const subgroups = buildStorySubgroups(group.stories);
    const currentSubgroupIndex = storySubgroupIndexMap[activeBookKey] || 0;
    const normalizedSubgroupIndex = currentSubgroupIndex >= 0 && currentSubgroupIndex < subgroups.length
      ? currentSubgroupIndex
      : 0;
    const activeSubgroup = subgroups[normalizedSubgroupIndex] || subgroups[0];
    const railKey = getStoryRailKey(activeBookKey, activeSubgroup?.key || "all");

    const rafId = window.requestAnimationFrame(() => {
      updateStoryRailState(railKey, activeSubgroup?.stories.length || 0);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [activeBookKey, storyBookGroups, storySubgroupIndexMap]);

  useEffect(() => {
    if (!activeBookKey) {
      return;
    }

    const group = storyBookGroups.find((item) => item.key === activeBookKey);
    if (!group) {
      return;
    }

    const subgroups = buildStorySubgroups(group.stories);
    const currentSubgroupIndex = storySubgroupIndexMap[activeBookKey] || 0;
    const normalizedSubgroupIndex = currentSubgroupIndex >= 0 && currentSubgroupIndex < subgroups.length
      ? currentSubgroupIndex
      : 0;
    const activeSubgroup = subgroups[normalizedSubgroupIndex] || subgroups[0];
    const railKey = getStoryRailKey(activeBookKey, activeSubgroup?.key || "all");
    const stories = Array.isArray(activeSubgroup?.stories) ? activeSubgroup.stories : [];
    if (stories.length <= 0) {
      if (selectedStorySlotKey !== null) {
        setSelectedStorySlotKey(null);
      }
      return;
    }

    const slotKeys = stories.map((_, index) => `${railKey}::${index + 1}`);
    if (!selectedStorySlotKey || !slotKeys.includes(selectedStorySlotKey)) {
      setSelectedStorySlotKey(slotKeys[0]);
    }
  }, [activeBookKey, selectedStorySlotKey, storyBookGroups, storySubgroupIndexMap]);

  const handleTrackPointerDown = (railKey: string, totalStoryCount: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) {
      return;
    }

    const targetNode = event.target instanceof HTMLElement ? event.target : null;
    if (targetNode?.closest(".stories-story-card-open") || targetNode?.closest(".stories-story-edit-btn")) {
      return;
    }

    const target = event.currentTarget;
    dragStateRef.current = {
      railKey,
      totalStoryCount,
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: target.scrollLeft,
      moved: false,
    };
    target.classList.add("is-dragging");
    target.setPointerCapture(event.pointerId);
  };

  const handleTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const target = event.currentTarget;
    const delta = event.clientX - dragState.startX;
    if (Math.abs(delta) > 4) {
      dragState.moved = true;
    }
    target.scrollLeft = dragState.startScrollLeft - delta * 1.12;
  };

  const handleTrackPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const target = event.currentTarget;
    target.classList.remove("is-dragging");
    if (dragState.moved) {
      suppressClickUntilRef.current = Date.now() + 160;
    }
    dragStateRef.current = null;
    updateStoryRailState(dragState.railKey, dragState.totalStoryCount);
  };

  const handleTrackPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = null;
    event.currentTarget.classList.remove("is-dragging");
  };

  const handleStoryTouchStart = (event: ReactTouchEvent<HTMLButtonElement>, story: StoryListItem, groupTitle: string) => {
    const touch = event.touches[0] || event.changedTouches[0];
    touchMovedRef.current = false;
    touchStartPointRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    setLiftedStoryId(story.id);
    clearLongPressTimer();
    void groupTitle;
  };

  const handleStoryTouchMove = (event: ReactTouchEvent<HTMLButtonElement>) => {
    if (touchMovedRef.current) {
      return;
    }

    const touch = event.touches[0] || event.changedTouches[0];
    const startPoint = touchStartPointRef.current;
    if (!touch || !startPoint) {
      return;
    }

    const deltaX = touch.clientX - startPoint.x;
    const deltaY = touch.clientY - startPoint.y;
    const movedFarEnough = Math.hypot(deltaX, deltaY) >= STORY_TOUCH_MOVE_THRESHOLD_PX;
    if (!movedFarEnough) {
      return;
    }

    touchMovedRef.current = true;
    clearLongPressTimer();
  };

  const handleStoryTouchEnd = (
    event?: ReactTouchEvent<HTMLButtonElement>,
    story?: StoryListItem,
    groupTitle?: string,
    isPlaceholder?: boolean,
  ) => {
    clearLongPressTimer();

    const startPoint = touchStartPointRef.current;
    let moved = touchMovedRef.current;
    if (!moved && event && startPoint) {
      const touch = event.changedTouches[0] || event.touches[0];
      if (touch) {
        const deltaX = touch.clientX - startPoint.x;
        const deltaY = touch.clientY - startPoint.y;
        moved = Math.hypot(deltaX, deltaY) >= STORY_TOUCH_MOVE_THRESHOLD_PX;
      }
    }

    touchMovedRef.current = false;
    touchStartPointRef.current = null;
    if (moved) {
      setLiftedStoryId(null);
      return;
    }

    if (!story || !groupTitle || isPlaceholder || Boolean(openingStoryId)) {
      return;
    }

    suppressClickUntilRef.current = Date.now() + 280;
    openStoryPreview(story, groupTitle);
  };

  const handleStoryCardClick = (story: StoryListItem, _groupTitle: string, isPlaceholder: boolean) => {
    if (Date.now() < suppressClickUntilRef.current) {
      return;
    }
    if (isPlaceholder) {
      return;
    }
    openStoryPreview(story, _groupTitle);
  };

  const handlePreviewOpenStory = () => {
    if (!previewState || previewState.isPlaceholder) {
      return;
    }
    closeStoryPreview();
    onOpenStory(previewState.story);
  };

  return (
    <div className={`hub-shell stories-shell stories-home-shell role-shell role-${roleKey}${showAdminGenerator ? " has-admin-panel" : ""}`}>
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
            const storySubgroups = buildStorySubgroups(group.stories);
            const subgroupCount = storySubgroups.length;
            const storedSubgroupIndex = Number(storySubgroupIndexMap[group.key] || 0);
            const activeSubgroupIndex = storedSubgroupIndex >= 0 && storedSubgroupIndex < subgroupCount ? storedSubgroupIndex : 0;
            const activeSubgroup = storySubgroups[activeSubgroupIndex] || storySubgroups[0];
            const railModeClass = getStoryRailModeClass(activeSubgroup?.stories.length || group.storyCount);
            const railKey = getStoryRailKey(group.key, activeSubgroup?.key || "all");
            const bookProgressPercent = group.totalLevels > 0 ? Math.round((group.completedLevels / group.totalLevels) * 100) : 0;
            const coverStory = group.stories.find((story) => !story.book_placeholder && Boolean(story.cover))
              || group.stories.find((story) => !story.book_placeholder)
              || group.stories[0]
              || null;

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
                      故事 {group.storyCount} 本 · 关卡 {group.totalLevels} 关
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
                      {group.storyCount > 0
                        ? `已收录 ${group.storyCount} 个故事，支持继续闯关与新故事扩展。`
                        : "该书已入库，暂未生成故事关卡。请在管理后台先生成故事。"}
                    </p>

                    {subgroupCount > 1 && (
                      <div className="stories-story-subgroups" role="tablist" aria-label="故事分组">
                        {storySubgroups.map((subgroup, subgroupIndex) => (
                          <button
                            key={`${group.key}-${subgroup.key}`}
                            type="button"
                            className={`stories-story-subgroup-btn ${subgroupIndex === activeSubgroupIndex ? "is-active" : ""}`}
                            onClick={() => {
                              setStorySubgroupIndexMap((prev) => ({
                                ...prev,
                                [group.key]: subgroupIndex,
                              }));
                              const nextRailKey = getStoryRailKey(group.key, subgroup.key);
                              window.requestAnimationFrame(() => {
                                updateStoryRailState(nextRailKey, subgroup.stories.length);
                              });
                            }}
                          >
                            第{subgroupIndex + 1}组 · {subgroup.label}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className={`stories-story-grid ${openingStoryId ? "has-opening" : ""}`}>
                      <div className={`stories-story-grid-viewport ${railModeClass}`}>
                        <div
                          className={`stories-story-fan-track ${railModeClass}`}
                          ref={(node) => {
                            storyTrackRefs.current[railKey] = node;
                          }}
                          onScroll={() => updateStoryRailState(railKey, activeSubgroup?.stories.length || 0)}
                          onPointerDown={(event) => handleTrackPointerDown(railKey, activeSubgroup?.stories.length || 0, event)}
                          onPointerMove={handleTrackPointerMove}
                          onPointerUp={handleTrackPointerUp}
                          onPointerCancel={handleTrackPointerCancel}
                        >
                          {activeSubgroup?.stories.map((story, index) => {
                        const isPlaceholder = Boolean(story.book_placeholder);
                        const completed = Number(story.completed_levels || 0);
                        const total = Number(story.total_levels || 0);
                        const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
                        const statusClass = completed >= total && total > 0 ? "done" : completed > 0 ? "current" : "none";
                        const showEditButton = isAdmin && showAdminGenerator && !isPlaceholder;
                        const coverLabel = isPlaceholder ? "待生成" : `关卡 ${Math.max(0, completed)}/${Math.max(0, total)}`;
                        const isLifted = liftedStoryId === story.id;
                        const slotKey = `${railKey}::${index + 1}`;
                        const isSelected = selectedStorySlotKey === slotKey;
                        const slotStyle = {
                          ["--story-tilt" as string]: `${getStoryFanTiltDegrees(index, activeSubgroup?.stories.length || 0)}deg`,
                        } as CSSProperties;

                        return (
                          <div
                            key={story.id}
                            className={`stories-story-slot ${isSelected ? "is-selected" : ""} ${isLifted ? "is-lifted" : ""}`.trim()}
                            style={slotStyle}
                            onMouseEnter={() => {
                              setSelectedStorySlotKey(slotKey);
                              forceFocusStorySlot(railKey, activeSubgroup?.stories.length || 0, index + 1);
                              setLiftedStoryId(story.id);
                            }}
                            onMouseLeave={() => {
                              setLiftedStoryId((current) => (current === story.id ? null : current));
                            }}
                          >
                            <div
                              className={`stories-story-card status-${statusClass} ${openingStoryId === story.id ? "is-opening" : ""} ${showEditButton ? "has-edit" : ""}`.trim()}
                            >
                              <button
                                type="button"
                                className="stories-story-card-open"
                                disabled={Boolean(openingStoryId)}
                                onClick={(event) => {
                                  setSelectedStorySlotKey(slotKey);
                                  forceFocusStorySlot(railKey, activeSubgroup?.stories.length || 0, index + 1);
                                  if (event.detail > 0) {
                                    event.currentTarget.blur();
                                  }
                                  handleStoryCardClick(story, group.title, isPlaceholder);
                                }}
                                onTouchStart={(event) => handleStoryTouchStart(event, story, group.title)}
                                onTouchMove={handleStoryTouchMove}
                                onTouchEnd={(event) => handleStoryTouchEnd(event, story, group.title, isPlaceholder)}
                                onTouchCancel={(event) => handleStoryTouchEnd(event)}
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
                                  <span className="stories-story-cover-order">· {activeSubgroup.offset + index + 1}/{group.storyCount} ·</span>
                                  {statusClass === "current" && <span className="stories-story-badge current">进行中</span>}
                                  {statusClass === "done" && <span className="stories-story-badge done">已完成</span>}
                                  {isPlaceholder && <span className="stories-story-badge">待生成</span>}
                                  <strong className="stories-story-cover-title">{story.title}</strong>
                                </div>
                                <div className="stories-story-info">
                                  <h3>{story.title}</h3>
                                  <p>{story.description}</p>
                                  <div className="stories-story-progress-row">
                                    {isPlaceholder ? (
                                      <span>尚未生成</span>
                                    ) : (
                                      <span className={completed > 0 ? "has-progress" : ""}>
                                        完成度 {completed}/{total}
                                      </span>
                                    )}
                                    <div className="stories-story-mini-bar">
                                      <i style={{ width: `${progressPercent}%` }} />
                                    </div>
                                  </div>
                                  <div className="stories-story-cta">{isPlaceholder ? "请先生成故事" : completed > 0 ? "继续翻开" : "打开这本故事"} →</div>
                                </div>
                              </button>

                              {showEditButton && (
                                <button
                                  type="button"
                                  className="stories-story-edit-btn"
                                  disabled={Boolean(openingStoryId) || loadingStoryMetaEditor || savingStoryMetaEditor}
                                  onClick={() => onOpenStoryMetaEditor(story)}
                                >
                                  编辑
                                </button>
                              )}
                            </div>
                            <span className="stories-story-hover-label">{coverLabel}</span>
                          </div>
                        );
                          })}
                        </div>
                      </div>

                      {(activeSubgroup?.stories.length || 0) > 0 && (
                        <div className="stories-story-rail-footer">
                          <div className="stories-story-rail-progress">
                            <i
                              style={{
                                width: `${Math.round((storyRailStateMap[railKey]?.progress ?? 0) * 100)}%`,
                              }}
                            />
                          </div>
                          <span>
                            {storyRailStateMap[railKey]?.activeIndex || 1}
                            {" / "}
                            {storyRailStateMap[railKey]?.total || activeSubgroup?.stories.length || group.storyCount}
                          </span>
                        </div>
                      )}
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

      {previewState && (
        <div className="stories-story-preview-mask" role="dialog" aria-modal="true" onClick={closeStoryPreview}>
          <div className="stories-story-preview-card" onClick={(event) => event.stopPropagation()}>
            <div className="stories-story-preview-cover">
              <img
                src={onCoverOrFallback(previewState.story.cover)}
                alt={previewState.story.title}
                onError={onCoverError}
              />
              <div className="stories-story-preview-cover-overlay" />
              <div className="stories-story-preview-cover-title-wrap">
                <p>{previewState.groupTitle}</p>
                <h4>{previewState.story.title}</h4>
              </div>
            </div>

            <div className="stories-story-preview-body">
              <p className="stories-story-preview-description">{previewState.story.description}</p>
              <div className="stories-story-preview-progress-row">
                <div className="stories-story-preview-progress-bar">
                  <i style={{ width: `${previewState.progressPercent}%` }} />
                </div>
                <span>
                  {previewState.isPlaceholder
                    ? "待生成"
                    : `${previewState.completed}/${previewState.total} 关`}
                </span>
              </div>

              <div className="stories-story-preview-actions">
                <button
                  type="button"
                  className="primary-btn"
                  disabled={Boolean(openingStoryId) || previewState.isPlaceholder}
                  onClick={handlePreviewOpenStory}
                >
                  {previewState.isPlaceholder ? "请先生成故事" : "打开故事"}
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={closeStoryPreview}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {storyMetaEditor && (
        <div className="mask" role="dialog" aria-modal="true" onClick={onCloseStoryMetaEditor}>
          <div className="mask-card stories-edit-modal" onClick={(event) => event.stopPropagation()}>
            <h4>编辑故事元数据</h4>
            <p className="progress-inline">{storyMetaEditor.title}</p>

            <label className="form-field">
              所属书目
              <select
                value={storyMetaEditor.book_id}
                onChange={(event) => onStoryMetaBookIdChange(event.currentTarget.value)}
                disabled={savingStoryMetaEditor}
              >
                {storyMetaBookOptions.map((item) => (
                  <option key={`story-book-${item.book_id}`} value={item.book_id}>
                    {item.book_title}（{item.chapter_count}章）
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              故事简介
              <textarea
                rows={3}
                value={storyMetaEditor.description}
                onChange={(event) => onStoryMetaDescriptionChange(event.currentTarget.value)}
                disabled={savingStoryMetaEditor}
              />
            </label>

            <label className="form-field">
              梗概标题
              <input
                value={storyMetaEditor.story_overview_title}
                onChange={(event) => onStoryMetaOverviewTitleChange(event.currentTarget.value)}
                disabled={savingStoryMetaEditor}
              />
            </label>

            <label className="form-field">
              故事梗概（段落间空一行）
              <textarea
                rows={8}
                value={storyMetaEditor.story_overview_text}
                onChange={(event) => onStoryMetaOverviewTextChange(event.currentTarget.value)}
                disabled={savingStoryMetaEditor}
              />
            </label>

            <div className="inline-actions">
              <button
                type="button"
                className="primary-btn"
                disabled={savingStoryMetaEditor}
                onClick={onSaveStoryMetaEditor}
              >
                {savingStoryMetaEditor ? "保存中..." : "保存修改"}
              </button>
              <button
                type="button"
                className="link-btn"
                disabled={savingStoryMetaEditor}
                onClick={onCloseStoryMetaEditor}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {openingStoryId && <div className="opening-note">正在翻开故事...</div>}
      {sharedCoverOverlay}
    </div>
  );
}
