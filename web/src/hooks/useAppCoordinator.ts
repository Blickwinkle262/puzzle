import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
} from "../core/api";
import { LevelProgress, StoryDetail, StoryListItem, UserProfile } from "../core/types";
import { useAuthSession } from "./useAuthSession";
import { usePlayFlow } from "./usePlayFlow";
import { useStoryHub } from "./useStoryHub";

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

export function useAppCoordinator() {
  const {
    applyAuthUser,
    authMode,
    clearAccountPanels,
    currentPasswordInput,
    error,
    forgotUsernameInput,
    hasSession,
    info,
    isAdmin,
    isGuest,
    loadingText,
    nextPasswordInput,
    passwordInput,
    resetPasswordInput,
    resetTokenInput,
    screen,
    setAuthMode,
    setCurrentPasswordInput,
    setError,
    setForgotUsernameInput,
    setHasSession,
    setInfo,
    setIsAdmin,
    setIsGuest,
    setLoadingText,
    setNextPasswordInput,
    setPasswordInput,
    setResetPasswordInput,
    setResetTokenInput,
    setScreen,
    setShowAdminGenerator,
    setShowChangePassword,
    setShowGuestUpgrade,
    setUpgradePasswordInput,
    setUpgradeUsernameInput,
    setUserName,
    setUsernameInput,
    showAdminGenerator,
    showChangePassword,
    showGuestUpgrade,
    upgradePasswordInput,
    upgradeUsernameInput,
    userName,
    usernameInput,
  } = useAuthSession();

  const {
    activeStory,
    hideDetailCover,
    openingStoryId,
    selectedBookKey,
    setActiveStory,
    setHideDetailCover,
    setOpeningStoryId,
    setSelectedBookKey,
    setSharedCover,
    setStories,
    sharedCover,
    stories,
    storyCoverRefs,
    storyDetailCoverRef,
  } = useStoryHub();

  const {
    activeJumperLevelId,
    levelSeed,
    mobileJumperDragRef,
    mobileJumperOffset,
    playIndex,
    setActiveJumperLevelId,
    setLevelSeed,
    setMobileJumperOffset,
    setPlayIndex,
    setShowMobileJumper,
    showMobileJumper,
  } = usePlayFlow();

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
    setShowMobileJumper(false);
    setMobileJumperOffset({ x: 0, y: 0 });
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
    if (screen !== "story") {
      setShowMobileJumper(false);
    }
  }, [screen, activeStory?.id]);

  useEffect(() => {
    if (screen !== "story") {
      setMobileJumperOffset({ x: 0, y: 0 });
    }
  }, [screen, activeStory?.id]);

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

  return {
    COLLAPSED_BOOK_KEY,
    activeBookGroup,
    activeJumperLevelId,
    activeStory,
    authMode,
    completedCount,
    completedMap,
    coverOrFallback,
    currentPasswordInput,
    error,
    focusStoryLevel,
    forgotUsernameInput,
    formatBestTime,
    handleAdminGenerated,
    handleAuthSubmit,
    handleChangePasswordSubmit,
    handleForgotPassword,
    handleGuestLogin,
    handleGuestUpgradeSubmit,
    handleLogout,
    handleOpenStoryFromAdmin,
    handleResetPassword,
    hideDetailCover,
    info,
    isAdmin,
    isGuest,
    levelSeed,
    loadingText,
    mobileJumperDragRef,
    mobileJumperOffset,
    nextPasswordInput,
    openPlayAtIndex,
    openStory,
    openingStoryId,
    passwordInput,
    playIndex,
    resetPasswordInput,
    resetTokenInput,
    replaceWithFallbackCover,
    roleHint,
    roleKey,
    roleLabel,
    screen,
    setAuthMode,
    setCurrentPasswordInput,
    setError,
    setForgotUsernameInput,
    setInfo,
    setLevelSeed,
    setMobileJumperOffset,
    setNextPasswordInput,
    setPasswordInput,
    setResetPasswordInput,
    setResetTokenInput,
    setScreen,
    setSelectedBookKey,
    setShowAdminGenerator,
    setShowChangePassword,
    setShowGuestUpgrade,
    setShowMobileJumper,
    setUpgradePasswordInput,
    setUpgradeUsernameInput,
    setUsernameInput,
    sharedCover,
    showAdminGenerator,
    showChangePassword,
    showGuestUpgrade,
    showMobileJumper,
    storyBookGroups,
    storyCoverRefs,
    storyDetailCoverRef,
    stories,
    submitLevelProgress,
    upgradePasswordInput,
    upgradeUsernameInput,
    userName,
    usernameInput,
  };
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

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
