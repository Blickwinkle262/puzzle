import { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { AdminStoryGenerator } from "./AdminStoryGenerator";
import { useAppCoordinator } from "../hooks/useAppCoordinator";
import { AuthPage } from "../pages/AuthPage";
import { PlayPage } from "../pages/PlayPage";
import { StoriesPage } from "../pages/StoriesPage";
import { StoryPage } from "../pages/StoryPage";

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

export function AppRouterShell(): JSX.Element {
  const {
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
  } = useAppCoordinator();

  const sharedCoverStyle = sharedCover ? buildSharedCoverStyle(sharedCover) : undefined;
  const sharedCoverOverlay = sharedCover && sharedCover.phase === "run" ? (
    <div className="shared-cover-overlay" style={sharedCoverStyle}>
      <img src={sharedCover.coverSrc} alt="" />
    </div>
  ) : null;

  if (loadingText) {
    return <div className="screen-message">{loadingText}</div>;
  }

  if (screen === "auth") {
    return (
      <AuthPage
        authMode={authMode}
        error={error}
        forgotUsernameInput={forgotUsernameInput}
        info={info}
        passwordInput={passwordInput}
        resetPasswordInput={resetPasswordInput}
        usernameInput={usernameInput}
        onForgotPassword={() => void handleForgotPassword()}
        onForgotUsernameInputChange={setForgotUsernameInput}
        onGuestLogin={() => void handleGuestLogin()}
        onPasswordInputChange={setPasswordInput}
        onResetPasswordInputChange={setResetPasswordInput}
        onSubmit={handleAuthSubmit}
        onToggleAuthMode={() => {
          setAuthMode((mode) => (mode === "login" ? "register" : "login"));
          setError("");
          setInfo("");
        }}
        onUsernameInputChange={setUsernameInput}
      />
    );
  }

  if (screen === "stories") {
    const totalBookCount = storyBookGroups.length;
    const totalStoryCount = stories.length;
    const totalLevelCount = storyBookGroups.reduce((sum, group) => sum + group.totalLevels, 0);
    const totalCompletedCount = storyBookGroups.reduce((sum, group) => sum + group.completedLevels, 0);
    const hideStoriesHero = isAdmin && showAdminGenerator;

    return (
      <StoriesPage
        activeBookKey={activeBookGroup?.key || ""}
        adminGeneratorNode={isAdmin && showAdminGenerator ? (
          <AdminStoryGenerator
            visible={showAdminGenerator}
            onClose={() => setShowAdminGenerator(false)}
            onGenerated={handleAdminGenerated}
            onOpenStory={handleOpenStoryFromAdmin}
          />
        ) : null}
        currentPasswordInput={currentPasswordInput}
        error={error}
        hideStoriesHero={hideStoriesHero}
        info={info}
        isAdmin={isAdmin}
        isGuest={isGuest}
        nextPasswordInput={nextPasswordInput}
        openingStoryId={openingStoryId}
        roleHint={roleHint}
        roleKey={roleKey}
        roleLabel={roleLabel}
        sharedCoverOverlay={sharedCoverOverlay}
        showAdminGenerator={showAdminGenerator}
        showChangePassword={showChangePassword}
        showGuestUpgrade={showGuestUpgrade}
        storyBookGroups={storyBookGroups}
        totalBookCount={totalBookCount}
        totalCompletedCount={totalCompletedCount}
        totalLevelCount={totalLevelCount}
        totalStoryCount={totalStoryCount}
        upgradePasswordInput={upgradePasswordInput}
        upgradeUsernameInput={upgradeUsernameInput}
        userName={userName}
        onChangePasswordSubmit={() => void handleChangePasswordSubmit()}
        onCoverError={replaceWithFallbackCover}
        onCoverOrFallback={coverOrFallback}
        onCurrentPasswordInputChange={setCurrentPasswordInput}
        onGuestUpgradeSubmit={() => void handleGuestUpgradeSubmit()}
        onHideChangePassword={() => setShowChangePassword(false)}
        onHideGuestUpgrade={() => setShowGuestUpgrade(false)}
        onLogout={() => void handleLogout()}
        onNextPasswordInputChange={setNextPasswordInput}
        onOpenStory={(story) => void openStory(story)}
        onStoryCoverRefChange={(storyId, node) => {
          storyCoverRefs.current[storyId] = node;
        }}
        onToggleAdminGenerator={() => {
          setShowAdminGenerator((value) => !value);
          setError("");
          setInfo("");
        }}
        onToggleBook={(bookKey) => {
          setSelectedBookKey((prev) => (prev === bookKey ? COLLAPSED_BOOK_KEY : bookKey));
        }}
        onToggleChangePassword={() => {
          setShowChangePassword((value) => !value);
          setShowGuestUpgrade(false);
          setError("");
          setInfo("");
        }}
        onToggleGuestUpgrade={() => {
          setShowGuestUpgrade((value) => !value);
          setShowChangePassword(false);
          setError("");
          setInfo("");
        }}
        onUpgradePasswordInputChange={setUpgradePasswordInput}
        onUpgradeUsernameInputChange={setUpgradeUsernameInput}
      />
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
    const activeJumperIndex = Math.max(
      1,
      activeStory.levels.findIndex((level) => level.id === activeJumperLevelId) + 1,
    );

    const renderJumperItems = (keyPrefix: string, closeAfterClick = false): JSX.Element[] => {
      return activeStory.levels.map((level, index) => {
        const progress = activeStory.level_progress[level.id];
        const completed = progress?.status === "completed";
        const inProgress = progress?.status === "in_progress";
        const disabled = Boolean(level.asset_missing);
        const stateClass = completed ? "done" : inProgress ? "current" : "locked";
        const isLinked = activeJumperLevelId === level.id;

        return (
          <button
            key={`${keyPrefix}-${level.id}`}
            type="button"
            className={`story-jumper-item ${stateClass}${isLinked ? " is-linked" : ""}`}
            disabled={disabled}
            onClick={() => {
              focusStoryLevel(level.id);
              if (closeAfterClick) {
                setShowMobileJumper(false);
              }
            }}
          >
            <span>{index + 1}</span>
            <i />
            <b>{level.title}</b>
          </button>
        );
      });
    };

    const mobileJumperStyle: CSSProperties = {
      transform: `translate(${mobileJumperOffset.x}px, ${mobileJumperOffset.y}px)`,
    };

    const handleMobileJumperPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
      mobileJumperDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseOffsetX: mobileJumperOffset.x,
        baseOffsetY: mobileJumperOffset.y,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handleMobileJumperPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
      const dragState = mobileJumperDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6) {
        dragState.moved = true;
      }

      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 375;
      const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 667;
      const nextX = clamp(dragState.baseOffsetX + deltaX, -(viewportWidth - 84), 16);
      const nextY = clamp(dragState.baseOffsetY + deltaY, -(viewportHeight - 84), 16);
      setMobileJumperOffset({ x: nextX, y: nextY });
    };

    const handleMobileJumperPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
      const dragState = mobileJumperDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      mobileJumperDragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);

      if (!dragState.moved) {
        setShowMobileJumper((value) => !value);
      }
    };

    return (
      <StoryPage
        activeJumperIndex={activeJumperIndex}
        activeJumperLevelId={activeJumperLevelId}
        activeStory={activeStory}
        completedCount={completedCount}
        error={error}
        hideDetailCover={hideDetailCover}
        mobileJumperStyle={mobileJumperStyle}
        overviewParagraphs={overviewParagraphs}
        overviewTitle={overviewTitle}
        pendingCount={pendingCount}
        renderDesktopJumperItems={renderJumperItems("desktop")}
        renderMobileJumperItems={renderJumperItems("mobile", true)}
        sharedCoverOverlay={sharedCoverOverlay}
        showMobileJumper={showMobileJumper}
        storyBestTimeText={storyBestTimeText}
        storyLevelTotal={storyLevelTotal}
        storyProgressPercent={storyProgressPercent}
        onBackToStories={() => setScreen("stories")}
        onCoverError={replaceWithFallbackCover}
        onCoverOrFallback={coverOrFallback}
        onFormatBestTime={formatBestTime}
        onLogout={() => void handleLogout()}
        onMobileJumperPointerDown={handleMobileJumperPointerDown}
        onMobileJumperPointerMove={handleMobileJumperPointerMove}
        onMobileJumperPointerUp={handleMobileJumperPointerUp}
        onOpenPlayAtIndex={openPlayAtIndex}
        onStoryDetailCoverRefChange={(node) => {
          storyDetailCoverRef.current = node;
        }}
      />
    );
  }

  const currentLevel = activeStory.levels[Math.max(0, Math.min(playIndex, activeStory.levels.length - 1))];
  const totalLevels = activeStory.levels.length;
  const allCompleted = completedCount >= totalLevels;

  return (
    <PlayPage
      activeStory={activeStory}
      allCompleted={allCompleted}
      completedCount={completedCount}
      completedMap={completedMap}
      currentLevel={currentLevel}
      levelSeed={levelSeed}
      playIndex={playIndex}
      totalLevels={totalLevels}
      onBackToStory={() => setScreen("story")}
      onJumpUnfinished={() => {
        const firstUnfinished = activeStory.levels.findIndex((level) => !completedMap[level.id] && !level.asset_missing);
        const fallbackIndex = activeStory.levels.findIndex((level) => !level.asset_missing);
        const target = firstUnfinished >= 0 ? firstUnfinished : fallbackIndex >= 0 ? fallbackIndex : 0;
        openPlayAtIndex(target, 1);
      }}
      onLevelSolved={(levelId, elapsedMs, countAsCompleted) => {
        if (!countAsCompleted) {
          return;
        }
        const solvedLevel = activeStory.levels.find((level) => level.id === levelId);
        void submitLevelProgress(levelId, {
          story_id: activeStory.id,
          status: "completed",
          attempts_increment: 0,
          best_time_ms: elapsedMs !== null && elapsedMs > 0 ? elapsedMs : undefined,
          content_version: solvedLevel?.content_version,
        });
      }}
      onNextLevel={() => openPlayAtIndex(playIndex + 1, 1)}
      onPrevLevel={() => openPlayAtIndex(playIndex - 1, 1)}
      onRestartLevel={() => {
        setLevelSeed((value) => value + 1);
      }}
    />
  );
}

function buildSharedCoverStyle(transition: SharedCoverTransition): CSSProperties {
  const target = transition.phase === "run" && transition.to ? transition.to : transition.from;
  return {
    left: target.left,
    top: target.top,
    width: target.width,
    height: target.height,
    transition: transition.phase === "run" ? "all 420ms cubic-bezier(0.2, 0.75, 0.3, 1)" : "none",
  };
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
