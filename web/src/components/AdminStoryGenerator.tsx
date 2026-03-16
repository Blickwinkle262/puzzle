import { useAdminStoryGeneratorCoordinator } from "../hooks/useAdminStoryGeneratorCoordinator";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  AdminBookReplaceConfirmModal,
  AdminChapterTextPreviewModal,
  AdminBookUploadSection,
  AdminChapterSelectionSection,
  AdminGenerateDialogModal,
  AdminLlmSettingsSection,
  AdminPuzzleGenerateStage,
  AdminPuzzleReviewStage,
  AdminPuzzleSelectStage,
  AdminPublishSection,
  AdminRecentJobsList,
  AdminRunReviewSection,
  AdminScenePreviewModal,
  AdminUserPermissionsSection,
} from "./AdminStoryGeneratorSections";
import {
  formatDurationMs,
  formatGenerationJobStateLabel,
  formatTime,
} from "./admin-story-generator/utils";

type AdminStoryGeneratorProps = {
  visible: boolean;
  onClose: () => void;
  onGenerated: (storyId: string) => Promise<void> | void;
  onOpenStory: (storyId: string) => Promise<void> | void;
};

export function AdminStoryGenerator({ visible, onClose, onGenerated, onOpenStory }: AdminStoryGeneratorProps): JSX.Element | null {
  const isMobile = useIsMobile(920);
  const {
    constants: {
      CHAPTER_PAGE_SIZE_OPTIONS,
      DEFAULT_SCENE_COUNT,
      MANAGED_LEVEL_DIFFICULTIES,
      MANAGED_ROLES,
      PUZZLE_FLOW_SEQUENCE,
      REVIEW_GRID_OPTIONS,
      REVIEW_TIME_OPTIONS,
    },
    usersState: {
      adminUsers,
      loadingUsers,
      passwordResetSubmittingUserId,
      roleSubmittingKey,
      userPage,
      userPageSize,
      userKeyword,
      userRoleFilter,
      userSummary,
      userTotal,
      userTotalPages,
    },
    usersActions: {
      handleApprovePasswordReset,
      handleRoleToggle,
      loadAdminUsers,
      setUserPage,
      setUserKeyword,
      setUserRoleFilter,
    },
    levelConfigState: {
      configLevelId,
      configLevels,
      configPreviewing,
      configSaving,
      configStories,
      configStoryId,
      configTesting,
      levelConfigForm,
      levelConfigSnapshot,
      loadingConfigCatalog,
      loadingLevelConfig,
      testRunResult,
    },
    levelConfigActions: {
      handleConfigFormChange,
      handlePreviewLevelConfig,
      handleSaveLevelConfig,
      handleTestLevelConfig,
      loadConfigStories,
      loadLevelConfig,
      setConfigLevelId,
      setConfigStoryId,
      setLevelConfigSnapshot,
      setTestRunResult,
    },
    llmState: {
      llmProviders,
      llmProfileUserOptions,
      llmEnvKeyOptions,
      selectedLlmProviderId,
      llmProviderDraft,
      llmCreateProviderDraft,
      llmProfileScope,
      llmProfileUserIdInput,
      llmProfile,
      llmEffectiveRuntime,
      llmProfileDraft,
      llmCachedModels,
      loadingLlmConfig,
      savingLlmConfig,
      testingLlmConfig,
      fetchingLlmModels,
      fetchingLlmModelsProviderId,
      lastLlmTest,
      llmFetchedModels,
      llmFetchedModelsByProviderId,
      llmNoticeError,
      llmNoticeInfo,
      lastLlmModelsFetchedAt,
      llmLastModelsFetchedAtByProviderId,
      llmProfileSavedAt,
      llmProviderSavedAt,
    },
    llmActions: {
      loadLlmConfig,
      handleLlmProviderIdChange,
      handleLlmProviderFieldChange,
      handleLlmProviderKeyFieldChange,
      handleLlmCreateProviderFieldChange,
      handleCreateLlmProvider,
      handleDeleteLlmProvider,
      handleLlmProfileScopeChange,
      handleLlmProfileUserIdInputChange,
      handleLoadLlmUserProfile,
      handleLlmProfileFieldChange,
      handleSaveLlmProvider,
      handleSaveLlmProfile,
      handleTestLlmConfig,
      handleFetchLlmModels,
      handleFetchLlmModelsByProvider,
    },
    chapterState: {
      bookId,
      books,
      chapterPage,
      chapterPageSize,
      chapterTotal,
      chapters,
      includeUsed,
      keyword,
      loadingChapters,
      maxCharsInput,
      minCharsInput,
      sceneCountInput,
      selectedChapter,
      selectedChapterId,
      submitting,
      targetDate,
      totalChapterPages,
      chapterTextPreview,
      loadingChapterTextPreview,
      reparsingBook,
      summaryBookId,
      generatingBookSummary,
      bookUploadTasks,
      loadingBookUploadTasks,
      bookSummaryTasks,
      loadingBookSummaryTasks,
      pendingBookReplace,
      uploadingBook,
    },
    chapterActions: {
      handleCancelBookReplace,
      handleConfirmBookReplace,
      handleReparseBook,
      handleGenerateBookSummary,
      handlePreviewChapterText,
      handleUploadBook,
      handleOpenGeneratedStory,
      handleSubmit,
      loadChapters,
      loadBookUploadTasks,
      loadBookSummaryTasks,
      setBookId,
      setChapterPage,
      setChapterPageSize,
      setIncludeUsed,
      setKeyword,
      setMaxCharsInput,
      setMinCharsInput,
      setSceneCountInput,
      setSelectedChapterId,
      setChapterTextPreview,
      setSummaryBookId,
      setTargetDate,
    },
    puzzleState: {
      activeJob,
      activeRunId,
      progress,
      recentJobsListCommonProps,
      resumableJob,
      reviewBatchGenerating,
      reviewCounts,
      reviewDeletingSceneIndex,
      reviewLoading,
      reviewLocked,
      reviewPendingImageCount,
      reviewPublishing,
      reviewReadyCount,
      reviewRetryingSceneIndex,
      reviewRunId,
      reviewScenes,
      reviewUpdatingSceneIndex,
    },
    puzzleActions: {
      handleBatchGenerateImages,
      handleDeleteReviewScene,
      handlePublishSelected,
      handleRetryReviewCandidate,
      handleUpdateReviewScene,
      handleViewJobProgress,
      loadGenerationReview,
      setScenePreview,
    },
    sectionState: {
      canGoNextFlowStep,
      canGoPrevFlowStep,
      canJumpGenerateStep,
      canJumpReviewStep,
      collapsedSections,
      currentFlowStepIndex,
      puzzleFlowStep,
    },
    sectionActions: {
      setPuzzleFlowStep,
      toggleSection,
    },
    publishState: {
      publishSuccess,
      scenePreview,
    },
    publishActions: {
      handleOpenPublishedStory,
      handleStayAfterPublish,
    },
    uiState: {
      panelError,
      panelInfo,
      panelNoticeScope,
      showGenerateDialog,
    },
    uiActions: {
      setPanelNoticeScope,
      setShowGenerateDialog,
    },
  } = useAdminStoryGeneratorCoordinator({
    visible,
    onClose,
    onGenerated,
    onOpenStory,
  });

  if (!visible) {
    return null;
  }

  return (
    <section className={`account-panel admin-panel${isMobile ? " is-mobile" : ""}`}>
      <h3>管理后台</h3>
      <p>这里统一处理人员权限、关卡配置（预览/测试）和谜题生成任务。</p>

      <AdminUserPermissionsSection
        adminUsers={adminUsers}
        collapsed={collapsedSections.users}
        loadingUsers={loadingUsers}
        isMobile={isMobile}
        noticeError={panelNoticeScope === "users" ? panelError : ""}
        noticeInfo={panelNoticeScope === "users" ? panelInfo : ""}
        managedRoles={MANAGED_ROLES}
        passwordResetSubmittingUserId={passwordResetSubmittingUserId}
        roleSubmittingKey={roleSubmittingKey}
        userPage={userPage}
        userPageSize={userPageSize}
        userKeyword={userKeyword}
        userRoleFilter={userRoleFilter}
        userSummary={userSummary}
        userTotal={userTotal}
        userTotalPages={userTotalPages}
        formatDurationMs={formatDurationMs}
        formatTime={formatTime}
        onApprovePasswordReset={(user) => {
          setPanelNoticeScope("users");
          void handleApprovePasswordReset(user);
        }}
        onRefreshUsers={() => {
          setPanelNoticeScope("users");
          void loadAdminUsers();
        }}
        onRoleToggle={(user, role) => {
          setPanelNoticeScope("users");
          void handleRoleToggle(user, role);
        }}
        onRoleFilterChange={(value) => {
          setPanelNoticeScope("users");
          setUserRoleFilter(value);
          setUserPage(1);
        }}
        onUserPageChange={(value) => {
          setPanelNoticeScope("users");
          setUserPage(value);
        }}
        onToggleSection={() => toggleSection("users")}
        onUserKeywordChange={(value) => {
          setPanelNoticeScope("users");
          setUserKeyword(value);
          setUserPage(1);
        }}
      />

      <AdminChapterSelectionSection
        collapsed={collapsedSections.levelConfig}
        isMobile={isMobile}
        configLevelId={configLevelId}
        configLevels={configLevels}
        configPreviewing={configPreviewing}
        configSaving={configSaving}
        configStoryId={configStoryId}
        configStories={configStories}
        configTesting={configTesting}
        levelConfigForm={levelConfigForm}
        levelConfigSnapshot={levelConfigSnapshot}
        loadingConfigCatalog={loadingConfigCatalog}
        loadingLevelConfig={loadingLevelConfig}
        noticeError={panelNoticeScope === "levelConfig" ? panelError : ""}
        noticeInfo={panelNoticeScope === "levelConfig" ? panelInfo : ""}
        managedLevelDifficulties={MANAGED_LEVEL_DIFFICULTIES}
        testRunResult={testRunResult}
        onConfigFormChange={(patch) => {
          setPanelNoticeScope("levelConfig");
          handleConfigFormChange(patch);
        }}
        onConfigLevelIdChange={(value) => {
          setPanelNoticeScope("levelConfig");
          setConfigLevelId(value);
          setLevelConfigSnapshot(null);
          setTestRunResult(null);
        }}
        onConfigStoryIdChange={(value) => {
          setPanelNoticeScope("levelConfig");
          setConfigStoryId(value);
          setConfigLevelId("");
          setLevelConfigSnapshot(null);
          setTestRunResult(null);
        }}
        onLoadConfigStories={() => {
          setPanelNoticeScope("levelConfig");
          void loadConfigStories();
        }}
        onLoadLevelConfig={() => {
          setPanelNoticeScope("levelConfig");
          void loadLevelConfig();
        }}
        onPreviewLevelConfig={() => {
          setPanelNoticeScope("levelConfig");
          void handlePreviewLevelConfig();
        }}
        onSaveLevelConfig={() => {
          setPanelNoticeScope("levelConfig");
          void handleSaveLevelConfig();
        }}
        onTestLevelConfig={() => {
          setPanelNoticeScope("levelConfig");
          void handleTestLevelConfig();
        }}
        onToggleSection={() => toggleSection("levelConfig")}
      />

      <AdminLlmSettingsSection
        collapsed={collapsedSections.llm}
        llmProviders={llmProviders}
        llmProfileUserOptions={llmProfileUserOptions}
        llmEnvKeyOptions={llmEnvKeyOptions}
        selectedLlmProviderId={selectedLlmProviderId}
        llmProviderDraft={llmProviderDraft}
        llmCreateProviderDraft={llmCreateProviderDraft}
        llmProfileScope={llmProfileScope}
        llmProfileUserIdInput={llmProfileUserIdInput}
        llmProfile={llmProfile}
        llmEffectiveRuntime={llmEffectiveRuntime}
        llmProfileDraft={llmProfileDraft}
        llmCachedModels={llmCachedModels}
        loadingLlmConfig={loadingLlmConfig}
        savingLlmConfig={savingLlmConfig}
        testingLlmConfig={testingLlmConfig}
        fetchingLlmModels={fetchingLlmModels}
        fetchingLlmModelsProviderId={fetchingLlmModelsProviderId}
        fetchedModels={llmFetchedModels}
        llmFetchedModelsByProviderId={llmFetchedModelsByProviderId}
        llmNoticeError={llmNoticeError || (panelNoticeScope === "llm" ? panelError : "")}
        llmNoticeInfo={llmNoticeInfo || (panelNoticeScope === "llm" ? panelInfo : "")}
        lastModelsFetchedAt={lastLlmModelsFetchedAt}
        llmLastModelsFetchedAtByProviderId={llmLastModelsFetchedAtByProviderId}
        lastLlmTest={lastLlmTest}
        llmProfileSavedAt={llmProfileSavedAt}
        llmProviderSavedAt={llmProviderSavedAt}
        onReload={() => {
          setPanelNoticeScope("llm");
          void loadLlmConfig();
        }}
        onProviderChange={(value) => {
          setPanelNoticeScope("llm");
          handleLlmProviderIdChange(value);
        }}
        onProviderFieldChange={(patch) => {
          setPanelNoticeScope("llm");
          handleLlmProviderFieldChange(patch);
        }}
        onProviderKeyFieldChange={(patch) => {
          setPanelNoticeScope("llm");
          handleLlmProviderKeyFieldChange(patch);
        }}
        onCreateProviderFieldChange={(patch) => {
          setPanelNoticeScope("llm");
          handleLlmCreateProviderFieldChange(patch);
        }}
        onCreateProvider={() => {
          setPanelNoticeScope("llm");
          void handleCreateLlmProvider();
        }}
        onDeleteProvider={(providerId) => {
          setPanelNoticeScope("llm");
          void handleDeleteLlmProvider(providerId);
        }}
        onProfileScopeChange={(scope) => {
          setPanelNoticeScope("llm");
          handleLlmProfileScopeChange(scope);
        }}
        onProfileUserIdInputChange={(value) => {
          setPanelNoticeScope("llm");
          handleLlmProfileUserIdInputChange(value);
        }}
        onLoadUserProfile={() => {
          setPanelNoticeScope("llm");
          void handleLoadLlmUserProfile();
        }}
        onProfileFieldChange={(patch) => {
          setPanelNoticeScope("llm");
          handleLlmProfileFieldChange(patch);
        }}
        onSaveProvider={() => {
          setPanelNoticeScope("llm");
          void handleSaveLlmProvider();
        }}
        onSaveProfile={() => {
          setPanelNoticeScope("llm");
          void handleSaveLlmProfile();
        }}
        onTest={() => {
          setPanelNoticeScope("llm");
          void handleTestLlmConfig();
        }}
        onFetchModels={() => {
          setPanelNoticeScope("llm");
          void handleFetchLlmModels();
        }}
        onFetchProviderModels={(providerId) => {
          setPanelNoticeScope("llm");
          void handleFetchLlmModelsByProvider(providerId);
        }}
        onToggleSection={() => toggleSection("llm")}
      />

      <AdminBookUploadSection
        books={books}
        bookUploadTasks={bookUploadTasks}
        bookSummaryTasks={bookSummaryTasks}
        collapsed={collapsedSections.bookIngest}
        noticeError={panelNoticeScope === "bookIngest" ? panelError : ""}
        noticeInfo={panelNoticeScope === "bookIngest" ? panelInfo : ""}
        loadingBookUploadTasks={loadingBookUploadTasks}
        loadingBookSummaryTasks={loadingBookSummaryTasks}
        reparsingBook={reparsingBook}
        summaryBookId={summaryBookId}
        generatingBookSummary={generatingBookSummary}
        uploadingBook={uploadingBook}
        onReloadTasks={() => {
          setPanelNoticeScope("bookIngest");
          void loadBookUploadTasks();
        }}
        onReloadSummaryTasks={() => {
          setPanelNoticeScope("bookIngest");
          void loadBookSummaryTasks();
        }}
        onReparseBook={(targetBookId) => {
          setPanelNoticeScope("bookIngest");
          void handleReparseBook(targetBookId);
        }}
        onSummaryBookIdChange={(value) => {
          setPanelNoticeScope("bookIngest");
          setSummaryBookId(value);
        }}
        onGenerateBookSummary={(targetBookId) => {
          setPanelNoticeScope("bookIngest");
          void handleGenerateBookSummary(targetBookId);
        }}
        onUploadBook={(file) => {
          setPanelNoticeScope("bookIngest");
          void handleUploadBook(file);
        }}
        onToggleSection={() => toggleSection("bookIngest")}
      />

      <AdminRunReviewSection
        canGoNextFlowStep={canGoNextFlowStep}
        canGoPrevFlowStep={canGoPrevFlowStep}
        canJumpGenerateStep={canJumpGenerateStep}
        canJumpReviewStep={canJumpReviewStep}
        collapsed={collapsedSections.puzzle}
        currentFlowStepIndex={currentFlowStepIndex}
        flowStepCount={PUZZLE_FLOW_SEQUENCE.length}
        noticeError={panelNoticeScope === "puzzle" ? panelError : ""}
        noticeInfo={panelNoticeScope === "puzzle" ? panelInfo : ""}
        puzzleFlowStep={puzzleFlowStep}
        onSetPuzzleFlowStep={(step) => {
          setPanelNoticeScope("puzzle");
          setPuzzleFlowStep(step);
        }}
        onToggleSection={() => toggleSection("puzzle")}
      >

            {puzzleFlowStep === "select" && (
              <AdminPuzzleSelectStage
                bookId={bookId}
                books={books}
                canJumpGenerateStep={canJumpGenerateStep}
                chapterPage={chapterPage}
                chapterPageSize={chapterPageSize}
                chapterPageSizeOptions={CHAPTER_PAGE_SIZE_OPTIONS}
                chapterTotal={chapterTotal}
                chapters={chapters}
                includeUsed={includeUsed}
                keyword={keyword}
                loadingChapters={loadingChapters}
                maxCharsInput={maxCharsInput}
                minCharsInput={minCharsInput}
                selectedChapter={selectedChapter}
                selectedChapterId={selectedChapterId}
                submitting={submitting}
                totalChapterPages={totalChapterPages}
                onBookIdChange={setBookId}
                onChapterPageSizeChange={(nextPageSize) => {
                  setPanelNoticeScope("puzzle");
                  if (!CHAPTER_PAGE_SIZE_OPTIONS.includes(nextPageSize as (typeof CHAPTER_PAGE_SIZE_OPTIONS)[number])) {
                    return;
                  }
                  setChapterPageSize(nextPageSize);
                  setChapterPage(1);
                }}
                onClose={onClose}
                onIncludeUsedChange={(value) => {
                  setPanelNoticeScope("puzzle");
                  setIncludeUsed(value);
                }}
                onKeywordChange={(value) => {
                  setPanelNoticeScope("puzzle");
                  setKeyword(value);
                }}
                onLoadChapters={() => {
                  setPanelNoticeScope("puzzle");
                  void loadChapters();
                }}
                onMaxCharsInputChange={(value) => {
                  setPanelNoticeScope("puzzle");
                  setMaxCharsInput(value);
                }}
                onMinCharsInputChange={(value) => {
                  setPanelNoticeScope("puzzle");
                  setMinCharsInput(value);
                }}
                onNextPage={() => setChapterPage((page) => Math.min(totalChapterPages, page + 1))}
                onOpenGeneratedStory={(storyId) => {
                  setPanelNoticeScope("puzzle");
                  void handleOpenGeneratedStory(storyId);
                }}
                onOpenGenerateDialog={() => {
                  setPanelNoticeScope("puzzle");
                  setShowGenerateDialog(true);
                }}
                onPreviewChapterText={(chapterId) => {
                  setPanelNoticeScope("puzzle");
                  void handlePreviewChapterText(chapterId);
                }}
                onPrevPage={() => setChapterPage((page) => Math.max(1, page - 1))}
                onSelectChapterId={(value) => {
                  setPanelNoticeScope("puzzle");
                  setSelectedChapterId(value);
                }}
                onSetPuzzleFlowGenerate={() => {
                  setPanelNoticeScope("puzzle");
                  setPuzzleFlowStep("generate");
                }}
                loadingChapterTextPreview={loadingChapterTextPreview}
              />
            )}

            {puzzleFlowStep === "generate" && (
              <AdminPuzzleGenerateStage
                activeJob={activeJob}
                activeRunId={activeRunId}
                formatGenerationJobStateLabel={formatGenerationJobStateLabel}
                onBatchGenerateImages={() => {
                  setPanelNoticeScope("puzzle");
                  void handleBatchGenerateImages();
                }}
                onDeleteReviewScene={(sceneIndex) => {
                  setPanelNoticeScope("puzzle");
                  void handleDeleteReviewScene(sceneIndex);
                }}
                onLoadGenerationReview={(runId) => {
                  setPanelNoticeScope("puzzle");
                  void loadGenerationReview(runId);
                }}
                onOpenGenerateDialog={() => {
                  setPanelNoticeScope("puzzle");
                  setShowGenerateDialog(true);
                }}
                onRetryReviewCandidate={(sceneIndex) => {
                  setPanelNoticeScope("puzzle");
                  void handleRetryReviewCandidate(sceneIndex);
                }}
                onSetPuzzleFlowReview={() => {
                  setPanelNoticeScope("puzzle");
                  setPuzzleFlowStep("review");
                }}
                onSetPuzzleFlowSelect={() => {
                  setPanelNoticeScope("puzzle");
                  setPuzzleFlowStep("select");
                }}
                onSetScenePreview={setScenePreview}
                onViewJobProgress={handleViewJobProgress}
                progress={progress}
                renderRecentJobsGenerate={(
                  <AdminRecentJobsList
                    {...recentJobsListCommonProps}
                    mode="generate"
                  />
                )}
                resumableJob={resumableJob}
                reviewBatchGenerating={reviewBatchGenerating}
                reviewCounts={reviewCounts}
                reviewDeletingSceneIndex={reviewDeletingSceneIndex}
                reviewLoading={reviewLoading}
                reviewLocked={reviewLocked}
                reviewPendingImageCount={reviewPendingImageCount}
                reviewPublishing={reviewPublishing}
                reviewRetryingSceneIndex={reviewRetryingSceneIndex}
                reviewRunId={reviewRunId}
                reviewScenes={reviewScenes}
                selectedChapter={selectedChapter}
                submitting={submitting}
              />
            )}

            {puzzleFlowStep === "review" && (
              <AdminPuzzleReviewStage
                activeJob={activeJob}
                formatTime={formatTime}
                onLoadGenerationReview={(runId) => {
                  setPanelNoticeScope("puzzle");
                  void loadGenerationReview(runId);
                }}
                onPublishSelected={() => {
                  setPanelNoticeScope("puzzle");
                  void handlePublishSelected();
                }}
                onSetPuzzleFlowGenerate={() => {
                  setPanelNoticeScope("puzzle");
                  setPuzzleFlowStep("generate");
                }}
                onSetScenePreview={setScenePreview}
                onUpdateReviewScene={(sceneIndex, patch) => {
                  setPanelNoticeScope("puzzle");
                  void handleUpdateReviewScene(sceneIndex, patch);
                }}
                renderRecentJobsReview={(
                  <AdminRecentJobsList
                    {...recentJobsListCommonProps}
                    mode="review"
                  />
                )}
                reviewBatchGenerating={reviewBatchGenerating}
                reviewCounts={reviewCounts}
                reviewGridOptions={REVIEW_GRID_OPTIONS}
                reviewLoading={reviewLoading}
                reviewLocked={reviewLocked}
                reviewPendingImageCount={reviewPendingImageCount}
                reviewPublishing={reviewPublishing}
                reviewReadyCount={reviewReadyCount}
                reviewRunId={reviewRunId}
                reviewScenes={reviewScenes}
                reviewTimeOptions={REVIEW_TIME_OPTIONS}
                reviewUpdatingSceneIndex={reviewUpdatingSceneIndex}
              />
            )}

      </AdminRunReviewSection>

      <AdminPublishSection
        publishSuccess={publishSuccess}
        onOpenPublishedStory={() => {
          void handleOpenPublishedStory();
        }}
        onStayAfterPublish={handleStayAfterPublish}
      />

      <AdminBookReplaceConfirmModal
        pendingReplace={pendingBookReplace}
        submitting={uploadingBook}
        onCancel={handleCancelBookReplace}
        onConfirm={() => {
          void handleConfirmBookReplace();
        }}
      />

      <AdminScenePreviewModal
        scenePreview={scenePreview}
        onClose={() => setScenePreview(null)}
      />

      <AdminChapterTextPreviewModal
        chapterPreview={chapterTextPreview}
        onClose={() => setChapterTextPreview(null)}
      />

      <AdminGenerateDialogModal
        open={showGenerateDialog}
        defaultSceneCount={DEFAULT_SCENE_COUNT}
        sceneCountInput={sceneCountInput}
        selectedChapter={selectedChapter}
        submitting={submitting}
        targetDate={targetDate}
        onClose={() => setShowGenerateDialog(false)}
        onSceneCountInputChange={setSceneCountInput}
        onSubmit={() => {
          void handleSubmit();
        }}
        onTargetDateChange={setTargetDate}
      />

    </section>
  );
}
