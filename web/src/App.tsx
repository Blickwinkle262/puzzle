import { CSSProperties, FormEvent, SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiChangePassword,
  apiForgotPassword,
  apiGetMe,
  apiGuestLogin,
  apiGuestUpgrade,
  apiRefreshSession,
  apiResetPassword,
  apiGetStoryDetail,
  apiListStories,
  apiLogin,
  apiLogout,
  apiRegister,
  apiUpdateLevelProgress,
  ApiError,
} from "./core/api";
import { LevelProgress, StoryDetail, StoryListItem, UserProfile } from "./core/types";
import { AdminStoryGenerator } from "./components/AdminStoryGenerator";
import { PuzzlePlayer } from "./components/PuzzlePlayer";

const OPEN_BOOK_ANIMATION_MS = 380;
const SHARED_COVER_ANIMATION_MS = 420;
const SESSION_REFRESH_INTERVAL_MS = 1000 * 60 * 8;
const COLLAPSED_BOOK_KEY = "__collapsed__";
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

type StoryBookGroup = {
  key: string;
  title: string;
  stories: StoryListItem[];
  totalLevels: number;
  completedLevels: number;
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
  const [info, setInfo] = useState<string>("");
  const [isGuest, setIsGuest] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminGenerator, setShowAdminGenerator] = useState(false);

  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [forgotUsernameInput, setForgotUsernameInput] = useState("");
  const [resetTokenInput, setResetTokenInput] = useState("");
  const [resetPasswordInput, setResetPasswordInput] = useState("");
  const [showGuestUpgrade, setShowGuestUpgrade] = useState(false);
  const [upgradeUsernameInput, setUpgradeUsernameInput] = useState("");
  const [upgradePasswordInput, setUpgradePasswordInput] = useState("");
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [nextPasswordInput, setNextPasswordInput] = useState("");
  const [selectedBookKey, setSelectedBookKey] = useState("");
  const [openingStoryId, setOpeningStoryId] = useState<string | null>(null);
  const [sharedCover, setSharedCover] = useState<SharedCoverTransition | null>(null);
  const [hideDetailCover, setHideDetailCover] = useState(false);
  const [activeJumperLevelId, setActiveJumperLevelId] = useState<string>("");

  const storyCoverRefs = useRef<Record<string, HTMLImageElement | null>>({});
  const storyDetailCoverRef = useRef<HTMLImageElement | null>(null);

  const applyAuthUser = useCallback((user: UserProfile) => {
    setHasSession(true);
    setUserName(user.username);
    setIsGuest(Boolean(user.is_guest));
    setIsAdmin(Boolean(user.is_admin));
    if (!user.is_admin) {
      setShowAdminGenerator(false);
    }
  }, []);

  const clearAccountPanels = useCallback(() => {
    setShowGuestUpgrade(false);
    setShowChangePassword(false);
    setUpgradeUsernameInput("");
    setUpgradePasswordInput("");
    setCurrentPasswordInput("");
    setNextPasswordInput("");
  }, []);

  const clearSession = useCallback(() => {
    setHasSession(false);
    setUserName("");
    setIsGuest(false);
    setIsAdmin(false);
    setShowAdminGenerator(false);
    setError("");
    setStories([]);
    setSelectedBookKey("");
    setActiveStory(null);
    setScreen("auth");
    setLoadingText("");
    setInfo("");
    setOpeningStoryId(null);
    setSharedCover(null);
    setHideDetailCover(false);
    clearAccountPanels();
  }, [clearAccountPanels]);

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
          applyAuthUser(response.user);
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
  }, [applyAuthUser, hasSession]);

  const refreshStories = useCallback(async () => {
    const response = await apiListStories();
    setStories(response.stories);
  }, []);

  const handleAdminGenerated = useCallback(
    async (storyId: string) => {
      await refreshStories();
      setScreen("stories");
      setInfo(storyId ? `新故事已生成：${storyId}` : "新故事已生成，故事首页已刷新");
      setError("");
    },
    [refreshStories],
  );

  const handleOpenStoryFromAdmin = useCallback(async (storyId: string) => {
    const targetId = storyId.trim();
    if (!targetId) {
      setError("story_id 为空，无法打开");
      return;
    }

    setLoadingText("正在打开已生成故事...");
    setError("");
    setInfo("");

    try {
      const response = await apiGetStoryDetail(targetId);
      setActiveStory(response.story);
      setPlayIndex(0);
      setLevelSeed((value) => value + 1);
      setScreen("story");
      setShowAdminGenerator(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingText("");
    }
  }, []);

  const enterStoriesHub = useCallback(
    async (user: UserProfile) => {
      applyAuthUser(user);
      const storiesResponse = await apiListStories();
      setStories(storiesResponse.stories);
      setScreen("stories");
      clearAccountPanels();
    },
    [applyAuthUser, clearAccountPanels],
  );

  const bootstrapSession = useCallback(
    async () => {
      setLoadingText("正在加载故事导航...");
      setError("");
      setInfo("");

      try {
        const [meResponse, storiesResponse] = await Promise.all([apiGetMe(), apiListStories()]);
        applyAuthUser(meResponse.user);
        setStories(storiesResponse.stories);
        setScreen("stories");
        clearAccountPanels();
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
    [applyAuthUser, clearAccountPanels, clearSession],
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
    setInfo("");

    try {
      const response =
        authMode === "login"
          ? await apiLogin(username, password)
          : await apiRegister(username, password);

      await enterStoriesHub(response.user);
      setPasswordInput("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingText("");
    }
  };

  const handleGuestLogin = async (): Promise<void> => {
    setLoadingText("正在进入游客模式...");
    setError("");
    setInfo("");

    try {
      const response = await apiGuestLogin();
      await enterStoriesHub(response.user);
      setInfo("已进入游客模式，数据会保存到当前设备。完成后可升级为正式账号。");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingText("");
    }
  };

  const handleGuestUpgradeSubmit = async (): Promise<void> => {
    const username = upgradeUsernameInput.trim();
    const password = upgradePasswordInput.trim();
    if (!username || !password) {
      setError("请输入升级账号的用户名和密码");
      return;
    }

    setLoadingText("正在升级账号...");
    setError("");
    setInfo("");

    try {
      const response = await apiGuestUpgrade(username, password);
      applyAuthUser(response.user);
      setUpgradeUsernameInput("");
      setUpgradePasswordInput("");
      setShowGuestUpgrade(false);
      setInfo("游客账号已升级为正式账号。");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingText("");
    }
  };

  const handleChangePasswordSubmit = async (): Promise<void> => {
    const currentPassword = currentPasswordInput.trim();
    const nextPassword = nextPasswordInput.trim();
    if (!currentPassword || !nextPassword) {
      setError("请输入当前密码和新密码");
      return;
    }

    setLoadingText("正在更新密码...");
    setError("");
    setInfo("");

    try {
      const response = await apiChangePassword(currentPassword, nextPassword);
      applyAuthUser(response.user);
      setCurrentPasswordInput("");
      setNextPasswordInput("");
      setShowChangePassword(false);
      setInfo("密码已更新。为安全起见，会话已自动轮换。");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingText("");
    }
  };

  const handleForgotPassword = async (): Promise<void> => {
    const username = forgotUsernameInput.trim();
    if (!username) {
      setError("请输入要找回的用户名");
      return;
    }

    setLoadingText("正在生成重置码...");
    setError("");
    setInfo("");

    try {
      const response = await apiForgotPassword(username);
      if (response.reset_token) {
        setResetTokenInput(response.reset_token);
        setInfo(`${response.message}（开发环境重置码：${response.reset_token}）`);
      } else {
        setInfo(response.message);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingText("");
    }
  };

  const handleResetPassword = async (): Promise<void> => {
    const token = resetTokenInput.trim();
    const password = resetPasswordInput.trim();
    if (!token || !password) {
      setError("请输入重置码和新密码");
      return;
    }

    setLoadingText("正在重置密码...");
    setError("");
    setInfo("");

    try {
      await apiResetPassword(token, password);
      setAuthMode("login");
      setPasswordInput("");
      setResetTokenInput("");
      setResetPasswordInput("");
      setInfo("密码重置成功，请用新密码登录。");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
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

  const focusStoryLevel = useCallback((levelId: string) => {
    const element = document.getElementById(`story-level-${levelId}`);
    if (!element) {
      return;
    }

    setActiveJumperLevelId(levelId);
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  useEffect(() => {
    if (screen !== "story" || !activeStory) {
      setActiveJumperLevelId("");
      return;
    }

    const levelIds = activeStory.levels.map((level) => level.id);
    setActiveJumperLevelId((prev) => {
      if (prev && levelIds.includes(prev)) {
        return prev;
      }

      const inProgress = activeStory.levels.find((level) => activeStory.level_progress[level.id]?.status === "in_progress");
      return inProgress?.id || levelIds[0] || "";
    });
  }, [activeStory, screen]);

  useEffect(() => {
    if (screen !== "story" || !activeStory || activeStory.levels.length === 0) {
      return;
    }

    const cards = activeStory.levels
      .map((level) => document.getElementById(`story-level-${level.id}`))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);

    if (cards.length === 0) {
      return;
    }

    let rafId = 0;

    const updateActiveLevel = () => {
      rafId = 0;
      const viewportAnchor = Math.max(150, Math.round(window.innerHeight * 0.32));
      let bestId = "";
      let bestDistance = Number.POSITIVE_INFINITY;

      cards.forEach((card) => {
        const rect = card.getBoundingClientRect();
        const levelId = card.dataset.levelId || "";
        if (!levelId) {
          return;
        }

        const visible = rect.bottom > 90 && rect.top < window.innerHeight - 90;
        if (!visible) {
          return;
        }

        const distance = Math.abs(rect.top - viewportAnchor);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestId = levelId;
        }
      });

      if (!bestId) {
        const firstVisible = cards.find((card) => card.getBoundingClientRect().bottom >= 120) || cards[cards.length - 1];
        bestId = firstVisible?.dataset.levelId || "";
      }

      if (bestId) {
        setActiveJumperLevelId((prev) => (prev === bestId ? prev : bestId));
      }
    };

    const requestUpdate = () => {
      if (rafId) {
        return;
      }
      rafId = window.requestAnimationFrame(updateActiveLevel);
    };

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, [activeStory, screen]);

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

  const roleKey = isGuest ? "guest" : isAdmin ? "admin" : "user";
  const roleLabel = isGuest ? "游客" : isAdmin ? "管理员" : "普通用户";
  const roleHint = isGuest
    ? "游客可试玩并保存本机进度，建议后续升级账号。"
    : isAdmin
      ? "你拥有管理后台权限，可管理用户、关卡和生成任务。"
      : "这是普通用户模式，可专注闯关并刷新个人最佳记录。";

  const storyBookGroups = useMemo(() => buildStoryBookGroups(stories), [stories]);
  const activeBookGroup = useMemo(() => {
    if (selectedBookKey === COLLAPSED_BOOK_KEY) {
      return null;
    }
    return storyBookGroups.find((item) => item.key === selectedBookKey) || null;
  }, [selectedBookKey, storyBookGroups]);

  useEffect(() => {
    if (storyBookGroups.length === 0) {
      setSelectedBookKey("");
      return;
    }

    if (!selectedBookKey) {
      setSelectedBookKey(storyBookGroups[0].key);
      return;
    }

    if (selectedBookKey === COLLAPSED_BOOK_KEY) {
      return;
    }

    if (!storyBookGroups.some((item) => item.key === selectedBookKey)) {
      setSelectedBookKey(storyBookGroups[0].key);
    }
  }, [selectedBookKey, storyBookGroups]);

  if (loadingText) {
    return <div className="screen-message">{loadingText}</div>;
  }

  if (screen === "auth") {
    return (
      <div className="auth-shell">
        <div className="auth-stack">
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
            {info && <div className="form-info">{info}</div>}

            <button className="primary-btn" type="submit">
              {authMode === "login" ? "登录" : "注册并登录"}
            </button>

            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setAuthMode((mode) => (mode === "login" ? "register" : "login"));
                setError("");
                setInfo("");
              }}
            >
              {authMode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
            </button>

            <button type="button" className="nav-btn" onClick={() => void handleGuestLogin()}>
              游客试玩（可稍后升级账号）
            </button>
          </form>

          <section className="auth-card auth-subcard">
            <h2>忘记密码</h2>
            <p>输入用户名生成重置码，然后设置新密码。</p>

            <label className="form-field">
              用户名
              <input
                value={forgotUsernameInput}
                onChange={(event) => setForgotUsernameInput(event.currentTarget.value)}
                placeholder="要找回的用户名"
                autoComplete="username"
              />
            </label>

            <div className="inline-actions">
              <button type="button" className="nav-btn" onClick={() => void handleForgotPassword()}>
                生成重置码
              </button>
            </div>

            <label className="form-field">
              重置码
              <input
                value={resetTokenInput}
                onChange={(event) => setResetTokenInput(event.currentTarget.value)}
                placeholder="输入重置码"
                autoComplete="off"
              />
            </label>

            <label className="form-field">
              新密码
              <input
                type="password"
                value={resetPasswordInput}
                onChange={(event) => setResetPasswordInput(event.currentTarget.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
              />
            </label>

            <div className="inline-actions">
              <button type="button" className="primary-btn" onClick={() => void handleResetPassword()}>
                提交新密码
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (screen === "stories") {
    const totalBookCount = storyBookGroups.length;
    const totalStoryCount = stories.length;
    const totalLevelCount = storyBookGroups.reduce((sum, group) => sum + group.totalLevels, 0);
    const totalCompletedCount = storyBookGroups.reduce((sum, group) => sum + group.completedLevels, 0);

    return (
      <div className={`hub-shell stories-shell stories-home-shell role-shell role-${roleKey}`}>
        <header className="stories-home-nav">
          <div className="stories-home-brand">故事导航</div>
          <div className="toolbar-row nav-right">
            {isGuest ? (
              <button
                type="button"
                className="nav-btn"
                onClick={() => {
                  setShowGuestUpgrade((value) => !value);
                  setShowChangePassword(false);
                  setError("");
                  setInfo("");
                }}
              >
                升级账号
              </button>
            ) : (
              <button
                type="button"
                className="nav-btn"
                onClick={() => {
                  setShowChangePassword((value) => !value);
                  setShowGuestUpgrade(false);
                  setError("");
                  setInfo("");
                }}
              >
                修改密码
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                className="nav-btn"
                onClick={() => {
                  setShowAdminGenerator((value) => !value);
                  setError("");
                  setInfo("");
                }}
              >
                {showAdminGenerator ? "收起管理后台" : "管理后台"}
              </button>
            )}
            <button type="button" className="nav-btn" onClick={handleLogout}>
              退出登录
            </button>
          </div>
        </header>

        {error && <div className="banner-error">{error}</div>}
        {info && <div className="banner-info">{info}</div>}

        {isAdmin && showAdminGenerator && (
          <AdminStoryGenerator
            visible={showAdminGenerator}
            onClose={() => setShowAdminGenerator(false)}
            onGenerated={handleAdminGenerated}
            onOpenStory={handleOpenStoryFromAdmin}
          />
        )}

        {isGuest && showGuestUpgrade && (
          <section className="account-panel">
            <h3>游客账号升级</h3>
            <p>升级后可跨设备登录，并继续当前进度。</p>
            <label className="form-field">
              新用户名
              <input
                value={upgradeUsernameInput}
                onChange={(event) => setUpgradeUsernameInput(event.currentTarget.value)}
                placeholder="至少 3 个字符"
                autoComplete="username"
              />
            </label>
            <label className="form-field">
              新密码
              <input
                type="password"
                value={upgradePasswordInput}
                onChange={(event) => setUpgradePasswordInput(event.currentTarget.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
              />
            </label>
            <div className="inline-actions">
              <button type="button" className="primary-btn" onClick={() => void handleGuestUpgradeSubmit()}>
                完成升级
              </button>
              <button type="button" className="link-btn" onClick={() => setShowGuestUpgrade(false)}>
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
                onChange={(event) => setCurrentPasswordInput(event.currentTarget.value)}
                placeholder="输入当前密码"
                autoComplete="current-password"
              />
            </label>
            <label className="form-field">
              新密码
              <input
                type="password"
                value={nextPasswordInput}
                onChange={(event) => setNextPasswordInput(event.currentTarget.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
              />
            </label>
            <div className="inline-actions">
              <button type="button" className="primary-btn" onClick={() => void handleChangePasswordSubmit()}>
                更新密码
              </button>
              <button type="button" className="link-btn" onClick={() => setShowChangePassword(false)}>
                取消
              </button>
            </div>
          </section>
        )}

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

        <div className="stories-home-divider">
          <span />
          <b>全部书目</b>
          <span />
        </div>

        {storyBookGroups.length > 0 ? (
          <main className="stories-home-main">
            {storyBookGroups.map((group, groupIndex) => {
              const isOpen = activeBookGroup?.key === group.key;
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
                    onClick={() =>
                      setSelectedBookKey((prev) => (prev === group.key ? COLLAPSED_BOOK_KEY : group.key))
                    }
                  >
                    <div className="stories-book-thumb">
                      {coverStory ? (
                        <img src={coverOrFallback(coverStory.cover)} alt={group.title} onError={replaceWithFallbackCover} />
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

                  <div className="stories-book-body" style={{ maxHeight: isOpen ? "3600px" : "0px" }}>
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
                              onClick={() => void openStory(story)}
                            >
                              <div className="stories-story-cover">
                                <img
                                  ref={(node) => {
                                    storyCoverRefs.current[story.id] = node;
                                  }}
                                  src={coverOrFallback(story.cover)}
                                  alt={story.title}
                                  onError={replaceWithFallbackCover}
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
    const storyLevelTotal = activeStory.levels.length;
    const storyProgressPercent = storyLevelTotal > 0 ? Math.round((completedCount / storyLevelTotal) * 100) : 0;
    const overviewTitle = "故事梗概";
    const overviewCustomTitle = (activeStory.story_overview_title || "").trim();
    const overviewCustomLead = overviewCustomTitle.replace(/^故事梗概\s*[：:·-]?\s*/u, "").trim();
    const overviewParagraphs = [
      overviewCustomLead,
      ...(activeStory.story_overview_paragraphs ?? []).map((paragraph) => paragraph.trim()),
    ].filter(Boolean);
    const storyBestTimeMs = activeStory.levels.reduce((best, level) => {
      const value = activeStory.level_progress[level.id]?.best_time_ms || 0;
      if (value <= 0) {
        return best;
      }
      if (best <= 0 || value < best) {
        return value;
      }
      return best;
    }, 0);
    const storyBestTimeText = formatBestTime(storyBestTimeMs);
    const pendingCount = Math.max(0, storyLevelTotal - completedCount);

    return (
      <div className="hub-shell story-shell story-directory-shell story-enter-shell">
        <header className="story-directory-navbar">
          <div className="story-directory-brand">故事目录</div>
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

        <section className="story-directory-hero">
          <img
            ref={storyDetailCoverRef}
            src={coverOrFallback(activeStory.cover)}
            alt={activeStory.title}
            className={`story-directory-hero-cover ${hideDetailCover ? "is-hidden" : ""}`}
            onError={replaceWithFallbackCover}
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
                const bestTimeText = formatBestTime(progress?.best_time_ms);
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
                        onClick={() => openPlayAtIndex(index, inProgress ? 0 : 1)}
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
              <div className="story-jumper-list">
                {activeStory.levels.map((level, index) => {
                  const progress = activeStory.level_progress[level.id];
                  const completed = progress?.status === "completed";
                  const inProgress = progress?.status === "in_progress";
                  const disabled = Boolean(level.asset_missing);
                  const stateClass = completed ? "done" : inProgress ? "current" : "locked";
                  const isLinked = activeJumperLevelId === level.id;

                  return (
                    <button
                      key={`jumper-${level.id}`}
                      type="button"
                      className={`story-jumper-item ${stateClass}${isLinked ? " is-linked" : ""}`}
                      disabled={disabled}
                      onClick={() => focusStoryLevel(level.id)}
                    >
                      <span>{index + 1}</span>
                      <i />
                      <b>{level.title}</b>
                    </button>
                  );
                })}
              </div>
            </section>
          </aside>
        </main>
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
      currentBestTimeMs={activeStory.level_progress[currentLevel.id]?.best_time_ms}
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

function formatBestTime(value?: number): string {
  if (!value || value <= 0) {
    return "";
  }

  const totalMs = Math.floor(value);
  const totalSec = Math.floor(totalMs / 1000);
  const mm = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(totalSec % 60)
    .toString()
    .padStart(2, "0");
  const cs = Math.floor((totalMs % 1000) / 10)
    .toString()
    .padStart(2, "0");
  return `${mm}:${ss}.${cs}`;
}

function buildStoryBookGroups(stories: StoryListItem[]): StoryBookGroup[] {
  const groupsByKey = new Map<string, StoryBookGroup>();

  for (const story of stories) {
    const title = resolveStoryBookTitle(story);
    const key = resolveStoryBookKey(story, title, groupsByKey.size + 1);
    const existing = groupsByKey.get(key);

    if (!existing) {
      groupsByKey.set(key, {
        key,
        title,
        stories: [story],
        totalLevels: Number(story.total_levels || 0),
        completedLevels: Number(story.completed_levels || 0),
      });
      continue;
    }

    existing.stories.push(story);
    existing.totalLevels += Number(story.total_levels || 0);
    existing.completedLevels += Number(story.completed_levels || 0);
  }

  return Array.from(groupsByKey.values());
}

function resolveStoryBookTitle(story: StoryListItem): string {
  const candidate = String(story.book_title || "").trim();
  if (candidate) {
    return candidate;
  }
  return "聊斋志异";
}

function resolveStoryBookKey(story: StoryListItem, fallbackTitle: string, fallbackIndex: number): string {
  const explicit = normalizeBookKey(story.book_id);
  if (explicit) {
    return explicit;
  }

  const inferred = normalizeBookKey(fallbackTitle);
  if (inferred) {
    return inferred;
  }

  return `book_${fallbackIndex}`;
}

function normalizeBookKey(value: unknown): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.slice(0, 48);
}
