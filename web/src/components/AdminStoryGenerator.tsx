import { useAdminStoryGeneratorCoordinator } from "../hooks/useAdminStoryGeneratorCoordinator";
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
  AdminStatusBanner,
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
      userKeyword,
    },
    usersActions: {
      handleApprovePasswordReset,
      handleRoleToggle,
      loadAdminUsers,
      setUserKeyword,
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
      showGenerateDialog,
    },
    uiActions: {
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
    <section className="account-panel admin-panel">
      <h3>管理后台</h3>
      <p>这里统一处理人员权限、关卡配置（预览/测试）和谜题生成任务。</p>

      <AdminStatusBanner
        activeRunId={activeRunId}
        panelError={panelError}
        panelInfo={panelInfo}
        resumableJob={resumableJob}
        onViewJobProgress={handleViewJobProgress}
      />

      <AdminUserPermissionsSection
        adminUsers={adminUsers}
        collapsed={collapsedSections.users}
        loadingUsers={loadingUsers}
        managedRoles={MANAGED_ROLES}
        passwordResetSubmittingUserId={passwordResetSubmittingUserId}
        roleSubmittingKey={roleSubmittingKey}
        userKeyword={userKeyword}
        formatDurationMs={formatDurationMs}
        formatTime={formatTime}
        onApprovePasswordReset={(user) => {
          void handleApprovePasswordReset(user);
        }}
        onRefreshUsers={() => void loadAdminUsers()}
        onRoleToggle={(user, role) => {
          void handleRoleToggle(user, role);
        }}
        onToggleSection={() => toggleSection("users")}
        onUserKeywordChange={setUserKeyword}
      />

      <AdminChapterSelectionSection
        collapsed={collapsedSections.levelConfig}
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
        managedLevelDifficulties={MANAGED_LEVEL_DIFFICULTIES}
        testRunResult={testRunResult}
        onConfigFormChange={handleConfigFormChange}
        onConfigLevelIdChange={(value) => {
          setConfigLevelId(value);
          setLevelConfigSnapshot(null);
          setTestRunResult(null);
        }}
        onConfigStoryIdChange={(value) => {
          setConfigStoryId(value);
          setConfigLevelId("");
          setLevelConfigSnapshot(null);
          setTestRunResult(null);
        }}
        onLoadConfigStories={() => void loadConfigStories()}
        onLoadLevelConfig={() => void loadLevelConfig()}
        onPreviewLevelConfig={() => void handlePreviewLevelConfig()}
        onSaveLevelConfig={() => void handleSaveLevelConfig()}
        onTestLevelConfig={() => void handleTestLevelConfig()}
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
        llmNoticeError={llmNoticeError}
        llmNoticeInfo={llmNoticeInfo}
        lastModelsFetchedAt={lastLlmModelsFetchedAt}
        llmLastModelsFetchedAtByProviderId={llmLastModelsFetchedAtByProviderId}
        lastLlmTest={lastLlmTest}
        llmProfileSavedAt={llmProfileSavedAt}
        llmProviderSavedAt={llmProviderSavedAt}
        onReload={() => {
          void loadLlmConfig();
        }}
        onProviderChange={handleLlmProviderIdChange}
        onProviderFieldChange={handleLlmProviderFieldChange}
        onProviderKeyFieldChange={handleLlmProviderKeyFieldChange}
        onCreateProviderFieldChange={handleLlmCreateProviderFieldChange}
        onCreateProvider={() => {
          void handleCreateLlmProvider();
        }}
        onDeleteProvider={(providerId) => {
          void handleDeleteLlmProvider(providerId);
        }}
        onProfileScopeChange={(scope) => {
          handleLlmProfileScopeChange(scope);
        }}
        onProfileUserIdInputChange={handleLlmProfileUserIdInputChange}
        onLoadUserProfile={() => {
          void handleLoadLlmUserProfile();
        }}
        onProfileFieldChange={handleLlmProfileFieldChange}
        onSaveProvider={() => {
          void handleSaveLlmProvider();
        }}
        onSaveProfile={() => {
          void handleSaveLlmProfile();
        }}
        onTest={() => {
          void handleTestLlmConfig();
        }}
        onFetchModels={() => {
          void handleFetchLlmModels();
        }}
        onFetchProviderModels={(providerId) => {
          void handleFetchLlmModelsByProvider(providerId);
        }}
        onToggleSection={() => toggleSection("llm")}
      />

      <AdminBookUploadSection
        books={books}
        bookUploadTasks={bookUploadTasks}
        bookSummaryTasks={bookSummaryTasks}
        collapsed={collapsedSections.bookIngest}
        loadingBookUploadTasks={loadingBookUploadTasks}
        loadingBookSummaryTasks={loadingBookSummaryTasks}
        reparsingBook={reparsingBook}
        summaryBookId={summaryBookId}
        generatingBookSummary={generatingBookSummary}
        uploadingBook={uploadingBook}
        onReloadTasks={() => {
          void loadBookUploadTasks();
        }}
        onReloadSummaryTasks={() => {
          void loadBookSummaryTasks();
        }}
        onReparseBook={(targetBookId) => {
          void handleReparseBook(targetBookId);
        }}
        onSummaryBookIdChange={setSummaryBookId}
        onGenerateBookSummary={(targetBookId) => {
          void handleGenerateBookSummary(targetBookId);
        }}
        onUploadBook={(file) => {
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
        puzzleFlowStep={puzzleFlowStep}
        onSetPuzzleFlowStep={setPuzzleFlowStep}
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
                  if (!CHAPTER_PAGE_SIZE_OPTIONS.includes(nextPageSize as (typeof CHAPTER_PAGE_SIZE_OPTIONS)[number])) {
                    return;
                  }
                  setChapterPageSize(nextPageSize);
                  setChapterPage(1);
                }}
                onClose={onClose}
                onIncludeUsedChange={setIncludeUsed}
                onKeywordChange={setKeyword}
                onLoadChapters={() => {
                  void loadChapters();
                }}
                onMaxCharsInputChange={setMaxCharsInput}
                onMinCharsInputChange={setMinCharsInput}
                onNextPage={() => setChapterPage((page) => Math.min(totalChapterPages, page + 1))}
                onOpenGeneratedStory={(storyId) => {
                  void handleOpenGeneratedStory(storyId);
                }}
                onOpenGenerateDialog={() => setShowGenerateDialog(true)}
                onPreviewChapterText={(chapterId) => {
                  void handlePreviewChapterText(chapterId);
                }}
                onPrevPage={() => setChapterPage((page) => Math.max(1, page - 1))}
                onSelectChapterId={setSelectedChapterId}
                onSetPuzzleFlowGenerate={() => setPuzzleFlowStep("generate")}
                loadingChapterTextPreview={loadingChapterTextPreview}
              />
            )}

            {puzzleFlowStep === "generate" && (
              <AdminPuzzleGenerateStage
                activeJob={activeJob}
                activeRunId={activeRunId}
                formatGenerationJobStateLabel={formatGenerationJobStateLabel}
                onBatchGenerateImages={() => {
                  void handleBatchGenerateImages();
                }}
                onDeleteReviewScene={(sceneIndex) => {
                  void handleDeleteReviewScene(sceneIndex);
                }}
                onLoadGenerationReview={(runId) => {
                  void loadGenerationReview(runId);
                }}
                onOpenGenerateDialog={() => setShowGenerateDialog(true)}
                onRetryReviewCandidate={(sceneIndex) => {
                  void handleRetryReviewCandidate(sceneIndex);
                }}
                onSetPuzzleFlowReview={() => setPuzzleFlowStep("review")}
                onSetPuzzleFlowSelect={() => setPuzzleFlowStep("select")}
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
                  void loadGenerationReview(runId);
                }}
                onPublishSelected={() => {
                  void handlePublishSelected();
                }}
                onSetPuzzleFlowGenerate={() => setPuzzleFlowStep("generate")}
                onSetScenePreview={setScenePreview}
                onUpdateReviewScene={(sceneIndex, patch) => {
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
