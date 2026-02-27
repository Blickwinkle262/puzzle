import { CSSProperties, FormEvent, SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiGetMe,
  apiRefreshSession,
  apiGetStoryDetail,
  apiListStories,
  apiLogin,
  apiLogout,
  apiRegister,
  apiUpdateLevelProgress,
  ApiError,
} from "./core/api";
import { LevelProgress, StoryDetail, StoryListItem } from "./core/types";
import { PuzzlePlayer } from "./components/PuzzlePlayer";

const OPEN_BOOK_ANIMATION_MS = 380;
const SHARED_COVER_ANIMATION_MS = 420;
const SESSION_REFRESH_INTERVAL_MS = 1000 * 60 * 8;
const FALLBACK_COVER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 800'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%231f1a3b'/%3E%3Cstop offset='1' stop-color='%23101b30'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='600' height='800' fill='url(%23g)'/%3E%3Ctext x='50%25' y='50%25' fill='%23f4e7bf' font-size='44' text-anchor='middle' dominant-baseline='middle'%3EStory%3C/text%3E%3C/svg%3E";

type Screen = "auth" | "stories" | "story" | "play";
type AuthMode = "login" | "register";
type TransitionPhase = "prepare" | "run";

type CoverRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type SharedCoverTransition = {
  storyId: string;
  coverSrc: string;
  from: CoverRect;
  to: CoverRect | null;
  phase: TransitionPhase;
};

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>("auth");
  const [hasSession, setHasSession] = useState(false);
  const [userName, setUserName] = useState<string>("");
  const [stories, setStories] = useState<StoryListItem[]>([]);
  const [activeStory, setActiveStory] = useState<StoryDetail | null>(null);
  const [playIndex, setPlayIndex] = useState(0);
  const [levelSeed, setLevelSeed] = useState(0);
  const [loadingText, setLoadingText] = useState<string>("正在恢复登录状态...");
  const [error, setError] = useState<string>("");

  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [openingStoryId, setOpeningStoryId] = useState<string | null>(null);
  const [sharedCover, setSharedCover] = useState<SharedCoverTransition | null>(null);
  const [hideDetailCover, setHideDetailCover] = useState(false);

  const storyCoverRefs = useRef<Record<string, HTMLImageElement | null>>({});
  const storyDetailCoverRef = useRef<HTMLImageElement | null>(null);

  const clearSession = useCallback(() => {
    setHasSession(false);
    setUserName("");
    setStories([]);
    setActiveStory(null);
    setScreen("auth");
    setLoadingText("");
    setOpeningStoryId(null);
    setSharedCover(null);
    setHideDetailCover(false);
  }, []);

  useEffect(() => {
    if (!sharedCover) {
      return;
    }

    // Fallback cleanup: even if transition fails to enter "run", clear overlay to avoid floating cover.
    const timeoutMs = sharedCover.phase === "run" ? SHARED_COVER_ANIMATION_MS : SHARED_COVER_ANIMATION_MS + 180;
    const timer = window.setTimeout(() => {
      setSharedCover(null);
      setHideDetailCover(false);
      setOpeningStoryId(null);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [sharedCover]);

  useEffect(() => {
    if (!hasSession) {
      return;
    }

    let cancelled = false;

    const refreshSessionSilently = async (): Promise<void> => {
      try {
        const response = await apiRefreshSession();
        if (!cancelled) {
          setUserName(response.user.username);
        }
      } catch {
        // 忽略刷新异常，避免打断当前游戏流程。
      }
    };

    const warmupTimer = window.setTimeout(() => {
      void refreshSessionSilently();
    }, 2500);

    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      void refreshSessionSilently();
    }, SESSION_REFRESH_INTERVAL_MS);

    const onFocus = () => {
      void refreshSessionSilently();
    };

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void refreshSessionSilently();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(warmupTimer);
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasSession]);

  const refreshStories = useCallback(async () => {
    const response = await apiListStories();
    setStories(response.stories);
  }, []);

  const bootstrapSession = useCallback(
    async () => {
      setLoadingText("正在加载故事导航...");
      setError("");

      try {
        const [meResponse, storiesResponse] = await Promise.all([apiGetMe(), apiListStories()]);
        setHasSession(true);
        setUserName(meResponse.user.username);
        setStories(storiesResponse.stories);
        setScreen("stories");
      } catch (err) {
        clearSession();
        if (err instanceof ApiError && err.status === 401) {
          setError("");
        } else {
          setError(errorMessage(err));
        }
      } finally {
        setLoadingText("");
      }
    },
    [clearSession],
  );

  useEffect(() => {
    void bootstrapSession();
  }, [bootstrapSession]);

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const username = usernameInput.trim();
    const password = passwordInput.trim();
    if (!username || !password) {
      setError("请输入用户名和密码");
      return;
    }

    setLoadingText(authMode === "login" ? "正在登录..." : "正在注册...");
    setError("");

    try {
      const response =
        authMode === "login"
          ? await apiLogin(username, password)
          : await apiRegister(username, password);

      setUserName(response.user.username);
      setHasSession(true);
      const storiesResponse = await apiListStories();
      setStories(storiesResponse.stories);
      setScreen("stories");
      setPasswordInput("");
      setLoadingText("");
    } catch (err) {
      setError(errorMessage(err));
      setLoadingText("");
    }
  };

  const handleLogout = async (): Promise<void> => {
    clearSession();

    try {
      await apiLogout();
    } catch {
      // 忽略登出失败（会话可能已经失效）
    }
  };

  const openStory = useCallback(
    async (story: StoryListItem) => {
      if (openingStoryId) {
        return;
      }

      const sourceCover = storyCoverRefs.current[story.id];
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

      setOpeningStoryId(story.id);
      setError("");

      if (sourceCover && !reduceMotion) {
        setSharedCover({
          storyId: story.id,
          coverSrc: coverOrFallback(story.cover),
          from: elementRect(sourceCover),
          to: null,
          phase: "prepare",
        });
        setHideDetailCover(true);
      } else {
        setSharedCover(null);
        setHideDetailCover(false);
      }

      try {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, OPEN_BOOK_ANIMATION_MS);
        });

        const response = await apiGetStoryDetail(story.id);
        setActiveStory(response.story);
        setPlayIndex(0);
        setLevelSeed((value) => value + 1);
        setScreen("story");
        if (!sourceCover || reduceMotion) {
          setOpeningStoryId(null);
        }
      } catch (err) {
        setOpeningStoryId(null);
        setSharedCover(null);
        setHideDetailCover(false);
        setError(errorMessage(err));
      }
    },
    [openingStoryId],
  );

  useEffect(() => {
    if (!sharedCover || sharedCover.to || screen !== "story" || !activeStory || activeStory.id !== sharedCover.storyId) {
      return;
    }

    const target = storyDetailCoverRef.current;
    if (!target) {
      // If target cover is not ready, gracefully drop transition overlay.
      setSharedCover(null);
      setHideDetailCover(false);
      setOpeningStoryId(null);
      return;
    }

    const toRect = elementRect(target);
    setSharedCover((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        to: toRect,
        phase: "prepare",
      };
    });

    const raf = window.requestAnimationFrame(() => {
      setSharedCover((prev) => {
        if (!prev || !prev.to) {
          return prev;
        }
        return {
          ...prev,
          phase: "run",
        };
      });
      setOpeningStoryId(null);
    });

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [sharedCover, screen, activeStory]);

  const sharedCoverStyle = sharedCover ? buildSharedCoverStyle(sharedCover) : undefined;
  const sharedCoverOverlay = sharedCover && sharedCover.phase === "run" ? (
    <div className="shared-cover-overlay" style={sharedCoverStyle}>
      <img src={sharedCover.coverSrc} alt="" />
    </div>
  ) : null;

  const updateActiveStoryProgress = useCallback((levelId: string, progress: LevelProgress) => {
    setActiveStory((prev) => {
      if (!prev) {
        return prev;
      }

      return {
        ...prev,
        level_progress: {
          ...prev.level_progress,
          [levelId]: progress,
        },
      };
    });
  }, []);

  const submitLevelProgress = useCallback(
    async (
      levelId: string,
      payload: {
        story_id: string;
        status?: "not_started" | "in_progress" | "completed";
        best_time_ms?: number;
        best_moves?: number;
        attempts_increment?: number;
        content_version?: number;
      },
    ) => {
      try {
        const response = await apiUpdateLevelProgress(levelId, payload);
        updateActiveStoryProgress(levelId, response.progress);
        await refreshStories();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshStories, updateActiveStoryProgress],
  );

  const openPlayAtIndex = useCallback(
    (index: number, attemptIncrement: number) => {
      if (!activeStory) {
        return;
      }

      const clampedIndex = Math.max(0, Math.min(index, activeStory.levels.length - 1));
      const targetLevel = activeStory.levels[clampedIndex];

      if (targetLevel.asset_missing) {
        setError(`关卡《${targetLevel.title}》资源缺失，请检查 story.json 与图片文件路径`);
        return;
      }

      setPlayIndex(clampedIndex);
      setLevelSeed((value) => value + 1);
      setScreen("play");

      void submitLevelProgress(targetLevel.id, {
        story_id: activeStory.id,
        status: "in_progress",
        attempts_increment: attemptIncrement,
        content_version: targetLevel.content_version,
      });
    },
    [activeStory, submitLevelProgress],
  );

  const completedCount = useMemo(() => {
    if (!activeStory) {
      return 0;
    }

    return activeStory.levels.reduce((count, level) => {
      const status = activeStory.level_progress[level.id]?.status;
      return count + (status === "completed" ? 1 : 0);
    }, 0);
  }, [activeStory]);

  const completedMap = useMemo(() => {
    if (!activeStory) {
      return {} as Record<string, boolean>;
    }

    const result: Record<string, boolean> = {};
    for (const level of activeStory.levels) {
      result[level.id] = activeStory.level_progress[level.id]?.status === "completed";
    }
    return result;
  }, [activeStory]);

  if (loadingText) {
    return <div className="screen-message">{loadingText}</div>;
  }

  if (screen === "auth") {
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={handleAuthSubmit}>
          <h1>拼图故事</h1>
          <p>登录后可保存关卡进度与故事线完成状态</p>

          <label className="form-field">
            用户名
            <input
              value={usernameInput}
              onChange={(event) => setUsernameInput(event.currentTarget.value)}
              placeholder="至少 3 个字符"
              autoComplete="username"
            />
          </label>

          <label className="form-field">
            密码
            <input
              type="password"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.currentTarget.value)}
              placeholder="至少 6 位"
              autoComplete={authMode === "login" ? "current-password" : "new-password"}
            />
          </label>

          {error && <div className="form-error">{error}</div>}

          <button className="primary-btn" type="submit">
            {authMode === "login" ? "登录" : "注册并登录"}
          </button>

          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setAuthMode((mode) => (mode === "login" ? "register" : "login"));
              setError("");
            }}
          >
            {authMode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
          </button>
        </form>
      </div>
    );
  }

  if (screen === "stories") {
    return (
      <div className="hub-shell">
        <header className="hub-header">
          <div>
            <h1>故事导航</h1>
            <p>欢迎你，{userName || "玩家"}</p>
          </div>
          <button type="button" className="nav-btn" onClick={handleLogout}>
            退出登录
          </button>
        </header>

        {error && <div className="banner-error">{error}</div>}

        <main className={`story-grid ${openingStoryId ? "has-opening" : ""}`}>
          {stories.map((story) => (
            <button
              type="button"
              key={story.id}
              className={`book-card ${openingStoryId === story.id ? "is-opening" : ""}`}
              onClick={() => void openStory(story)}
              disabled={Boolean(openingStoryId)}
            >
              <span className="book-spine" aria-hidden="true" />
              <img
                ref={(node) => {
                  storyCoverRefs.current[story.id] = node;
                }}
                src={coverOrFallback(story.cover)}
                alt={story.title}
                className="book-cover"
                onError={replaceWithFallbackCover}
              />
              <span className="book-gloss" aria-hidden="true" />
              <span className="book-meta">
                <span className="book-title">{story.title}</span>
                <span className="book-desc">{story.description}</span>
                <span className="book-progress">
                  完成度 {story.completed_levels}/{story.total_levels}
                </span>
                <span className="book-action">
                  {story.completed_levels > 0 ? "继续翻开" : "打开这本故事"} →
                </span>
              </span>
            </button>
          ))}
        </main>

        {openingStoryId && <div className="opening-note">正在翻开故事...</div>}
        {sharedCoverOverlay}
      </div>
    );
  }

  if (!activeStory) {
    return (
      <div className="screen-message">
        <div>故事数据不存在</div>
        <button className="primary-btn" type="button" onClick={() => setScreen("stories")}>
          返回故事导航
        </button>
      </div>
    );
  }

  if (screen === "story") {
    return (
      <div className="hub-shell story-enter-shell">
        <header className="hub-header">
          <div>
            <h1>{activeStory.title}</h1>
            <p>{activeStory.description}</p>
          </div>
          <div className="toolbar-row">
            <button type="button" className="nav-btn" onClick={() => setScreen("stories")}>
              ← 返回故事导航
            </button>
            <button type="button" className="nav-btn" onClick={handleLogout}>
              退出登录
            </button>
          </div>
        </header>

        {error && <div className="banner-error">{error}</div>}

        <section className="story-detail-cover-wrap">
          <img
            ref={storyDetailCoverRef}
            src={coverOrFallback(activeStory.cover)}
            alt={activeStory.title}
            className={`story-detail-cover ${hideDetailCover ? "is-hidden" : ""}`}
            onError={replaceWithFallbackCover}
          />
        </section>

        {activeStory.story_overview_title && (
          <details className="story-panel" open>
            <summary>{activeStory.story_overview_title}</summary>
            {(activeStory.story_overview_paragraphs ?? []).map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </details>
        )}

        <section className="level-list">
          {activeStory.levels.map((level, index) => {
            const progress = activeStory.level_progress[level.id];
            const completed = progress?.status === "completed";
            const disabled = Boolean(level.asset_missing);

            return (
              <article className="level-card" key={level.id}>
                <div>
                  <h3>
                    {index + 1}. {level.title}
                  </h3>
                  <p>{level.description}</p>
                  <p className="progress-inline">
                    网格 {level.grid.rows} × {level.grid.cols}
                    <span className={`level-state ${completed ? "done" : "todo"}`}>
                      {disabled ? "资源缺失" : completed ? "已完成" : progress?.status === "in_progress" ? "进行中" : "未开始"}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={disabled}
                  onClick={() => openPlayAtIndex(index, progress?.status === "in_progress" ? 0 : 1)}
                >
                  {disabled ? "不可用" : completed ? "重玩" : progress?.status === "in_progress" ? "继续" : "开始"}
                </button>
              </article>
            );
          })}
        </section>

        <div className="progress-inline">已完成 {completedCount}/{activeStory.levels.length}</div>
        {sharedCoverOverlay}
      </div>
    );
  }

  const currentLevel = activeStory.levels[Math.max(0, Math.min(playIndex, activeStory.levels.length - 1))];
  const totalLevels = activeStory.levels.length;
  const allCompleted = completedCount >= totalLevels;

  return (
    <PuzzlePlayer
      key={`${activeStory.id}-${currentLevel.id}-${levelSeed}`}
      storyTitle={activeStory.title}
      storyDescription={activeStory.description}
      level={currentLevel}
      levelIndex={playIndex}
      totalLevels={totalLevels}
      currentCompleted={Boolean(completedMap[currentLevel.id])}
      completedCount={completedCount}
      allCompleted={allCompleted}
      canPrev={playIndex > 0}
      canNext={playIndex < totalLevels - 1}
      onBackToStory={() => setScreen("story")}
      onRestartLevel={() => {
        setLevelSeed((value) => value + 1);
      }}
      onPrevLevel={() => openPlayAtIndex(playIndex - 1, 1)}
      onNextLevel={() => openPlayAtIndex(playIndex + 1, 1)}
      onJumpUnfinished={() => {
        const firstUnfinished = activeStory.levels.findIndex((level) => !completedMap[level.id] && !level.asset_missing);
        const fallbackIndex = activeStory.levels.findIndex((level) => !level.asset_missing);
        const target = firstUnfinished >= 0 ? firstUnfinished : fallbackIndex >= 0 ? fallbackIndex : 0;
        openPlayAtIndex(target, 1);
      }}
      onLevelSolved={(levelId, elapsedMs) => {
        const solvedLevel = activeStory.levels.find((level) => level.id === levelId);
        void submitLevelProgress(levelId, {
          story_id: activeStory.id,
          status: "completed",
          attempts_increment: 0,
          best_time_ms: elapsedMs !== null && elapsedMs > 0 ? elapsedMs : undefined,
          content_version: solvedLevel?.content_version,
        });
      }}
    />
  );
}

function elementRect(element: Element): CoverRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function buildSharedCoverStyle(transition: SharedCoverTransition): CSSProperties {
  const target = transition.phase === "run" && transition.to ? transition.to : transition.from;
  return {
    left: target.left,
    top: target.top,
    width: target.width,
    height: target.height,
    transition: transition.phase === "run" ? `all ${SHARED_COVER_ANIMATION_MS}ms cubic-bezier(0.2, 0.75, 0.3, 1)` : "none",
  };
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

function coverOrFallback(value: string | undefined): string {
  if (typeof value !== "string" || !value.trim()) {
    return FALLBACK_COVER;
  }
  return value;
}

function replaceWithFallbackCover(event: SyntheticEvent<HTMLImageElement>): void {
  if (event.currentTarget.src !== FALLBACK_COVER) {
    event.currentTarget.src = FALLBACK_COVER;
  }
}
