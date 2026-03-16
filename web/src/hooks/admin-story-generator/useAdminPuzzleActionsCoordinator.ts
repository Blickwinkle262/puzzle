import { useCallback } from "react";

import {
  apiDeleteRunScene,
  apiGenerateRunSceneImage,
  apiGenerateRunSceneImagesBatch,
  apiGenerateRunText,
  apiPublishRun,
  apiUploadRunSceneImage,
  apiUpdateRunScene,
} from "../../core/adminApi";
import {
  AdminGenerationJobDetail,
  AdminChapterSummary,
  AdminGenerationScene,
  AdminGenerationSceneCounts,
} from "../../core/types";
import {
  createClientRunId,
  defaultSceneCounts,
  errorMessage,
} from "../../components/admin-story-generator/utils";
import { PublishSuccessState } from "./shared";

type ReviewScenePatch = {
  title?: string;
  description?: string;
  story_text?: string;
  image_prompt?: string;
  selected?: boolean;
  grid_rows?: number;
  grid_cols?: number;
  time_limit_sec?: number;
};

type UseAdminPuzzleActionsCoordinatorOptions = {
  onClose: () => void;
  onGenerated: (storyId: string) => Promise<void> | void;
  onOpenStory: (storyId: string) => Promise<void> | void;
  publishSuccess: PublishSuccessState | null;
  reviewLocked: boolean;
  reviewRunId: string;
  reviewScenes: AdminGenerationScene[];
  sceneCountInput: string;
  selectedChapter: AdminChapterSummary | null;
  selectedChapterId: number | null;
  targetDate: string;
  loadGenerationReview: (runId: string) => Promise<void>;
  loadRecentJobs: () => Promise<void>;
  setActiveJob: (job: AdminGenerationJobDetail | null) => void;
  setActiveRunId: (runId: string) => void;
  setPanelError: (message: string) => void;
  setPanelInfo: (message: string) => void;
  setPublishSuccess: (payload: PublishSuccessState | null) => void;
  setPuzzleFlowStep: (step: "generate" | "review") => void;
  setReviewBatchGenerating: (loading: boolean) => void;
  setReviewCounts: (counts: AdminGenerationSceneCounts) => void;
  setReviewDeletingSceneIndex: (sceneIndex: number | null) => void;
  setReviewPublishing: (loading: boolean) => void;
  setReviewRetryingSceneIndex: (sceneIndex: number | null) => void;
  setReviewUploadingSceneIndex: (sceneIndex: number | null) => void;
  setReviewRunId: (runId: string) => void;
  setReviewScenes: (scenes: AdminGenerationScene[]) => void;
  setReviewUpdatingSceneIndex: (sceneIndex: number | null) => void;
  setShowGenerateDialog: (visible: boolean) => void;
  setSubmitting: (loading: boolean) => void;
};

const MIN_SCENE_COUNT = 6;
const DEFAULT_SCENE_COUNT = 12;

export function useAdminPuzzleActionsCoordinator({
  onClose,
  onGenerated,
  onOpenStory,
  publishSuccess,
  reviewLocked,
  reviewRunId,
  reviewScenes,
  sceneCountInput,
  selectedChapter,
  selectedChapterId,
  targetDate,
  loadGenerationReview,
  loadRecentJobs,
  setActiveJob,
  setActiveRunId,
  setPanelError,
  setPanelInfo,
  setPublishSuccess,
  setPuzzleFlowStep,
  setReviewBatchGenerating,
  setReviewCounts,
  setReviewDeletingSceneIndex,
  setReviewPublishing,
  setReviewRetryingSceneIndex,
  setReviewUploadingSceneIndex,
  setReviewRunId,
  setReviewScenes,
  setReviewUpdatingSceneIndex,
  setShowGenerateDialog,
  setSubmitting,
}: UseAdminPuzzleActionsCoordinatorOptions) {
  const handleUpdateReviewScene = useCallback(async (
    sceneIndex: number,
    payload: ReviewScenePatch,
  ): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewUpdatingSceneIndex(sceneIndex);
    setPanelError("");

    try {
      await apiUpdateRunScene(reviewRunId, sceneIndex, payload);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewUpdatingSceneIndex(null);
    }
  }, [
    loadGenerationReview,
    reviewLocked,
    reviewRunId,
    setPanelError,
    setReviewUpdatingSceneIndex,
  ]);

  const handlePublishSelected = useCallback(async (): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewPublishing(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const response = await apiPublishRun(reviewRunId);
      setPanelInfo(`发布完成：${response.story_id}（${response.level_count} 关）`);
      await loadGenerationReview(reviewRunId);
      await loadRecentJobs();
      if (response.story_id) {
        await onGenerated(response.story_id);
        setPublishSuccess({
          run_id: reviewRunId,
          story_id: response.story_id,
          level_count: Number(response.level_count || 0),
        });
      }
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewPublishing(false);
    }
  }, [
    loadGenerationReview,
    loadRecentJobs,
    onGenerated,
    reviewLocked,
    reviewRunId,
    setPanelError,
    setPanelInfo,
    setPublishSuccess,
    setReviewPublishing,
  ]);

  const handleOpenPublishedStory = useCallback(async (): Promise<void> => {
    if (!publishSuccess?.story_id) {
      return;
    }

    setPanelError("");
    try {
      await onOpenStory(publishSuccess.story_id);
      setPublishSuccess(null);
      onClose();
    } catch (err) {
      setPanelError(errorMessage(err));
    }
  }, [onClose, onOpenStory, publishSuccess, setPanelError, setPublishSuccess]);

  const handleStayAfterPublish = useCallback((): void => {
    setPublishSuccess(null);
  }, [setPublishSuccess]);

  const handleRetryReviewCandidate = useCallback(async (sceneIndex: number): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewRetryingSceneIndex(sceneIndex);
    setPanelError("");

    try {
      await apiGenerateRunSceneImage(reviewRunId, sceneIndex);
      setPanelInfo(`已重新出图：scene ${sceneIndex}`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewRetryingSceneIndex(null);
    }
  }, [
    loadGenerationReview,
    reviewLocked,
    reviewRunId,
    setPanelError,
    setPanelInfo,
    setReviewRetryingSceneIndex,
  ]);

  const handleBatchGenerateImages = useCallback(async (): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    setReviewBatchGenerating(true);
    setPanelError("");

    try {
      const pendingSceneIndexes = reviewScenes
        .filter((scene) => scene.image_status === "pending" || scene.image_status === "failed" || scene.image_status === "skipped")
        .map((scene) => scene.scene_index);
      await apiGenerateRunSceneImagesBatch(reviewRunId, {
        scene_indexes: pendingSceneIndexes,
        concurrency: 3,
      });
      setPanelInfo(`批量出图已完成：${pendingSceneIndexes.length} 个 scene`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewBatchGenerating(false);
    }
  }, [
    loadGenerationReview,
    reviewLocked,
    reviewRunId,
    reviewScenes,
    setPanelError,
    setPanelInfo,
    setReviewBatchGenerating,
  ]);

  const handleUploadReviewSceneImage = useCallback(async (sceneIndex: number, file: File): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    if (!(file instanceof File) || file.size <= 0) {
      setPanelError("请选择要上传的图片文件");
      return;
    }

    const fileType = String(file.type || "").toLowerCase();
    const hasSupportedType = fileType === "image/png"
      || fileType === "image/jpeg"
      || fileType === "image/webp"
      || /\.(png|jpe?g|webp)$/i.test(String(file.name || ""));
    if (!hasSupportedType) {
      setPanelError("仅支持 PNG/JPG/WebP 图片");
      return;
    }

    setReviewUploadingSceneIndex(sceneIndex);
    setPanelError("");

    try {
      await apiUploadRunSceneImage(reviewRunId, sceneIndex, { file });
      setPanelInfo(`已上传图片：scene ${sceneIndex}`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewUploadingSceneIndex(null);
    }
  }, [
    loadGenerationReview,
    reviewLocked,
    reviewRunId,
    setPanelError,
    setPanelInfo,
    setReviewUploadingSceneIndex,
  ]);

  const handleDeleteReviewScene = useCallback(async (sceneIndex: number): Promise<void> => {
    if (!reviewRunId || reviewLocked) {
      return;
    }

    const confirmed = window.confirm(`确认删除 scene ${sceneIndex} 吗？`);
    if (!confirmed) {
      return;
    }

    setReviewDeletingSceneIndex(sceneIndex);
    setPanelError("");
    try {
      await apiDeleteRunScene(reviewRunId, sceneIndex);
      setPanelInfo(`已删除 scene ${sceneIndex}`);
      await loadGenerationReview(reviewRunId);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewDeletingSceneIndex(null);
    }
  }, [
    loadGenerationReview,
    reviewLocked,
    reviewRunId,
    setPanelError,
    setPanelInfo,
    setReviewDeletingSceneIndex,
  ]);

  const handleOpenGeneratedStory = useCallback(async (storyId: string): Promise<void> => {
    const targetId = storyId.trim();
    if (!targetId) {
      setPanelError("未找到可打开的 story_id");
      return;
    }

    setPanelError("");
    setPanelInfo(`正在打开故事：${targetId}`);
    try {
      await onOpenStory(targetId);
    } catch (err) {
      setPanelError(errorMessage(err));
    }
  }, [onOpenStory, setPanelError, setPanelInfo]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!selectedChapterId) {
      setPanelError("请先选择一个章节");
      return;
    }

    const requestedSceneCount = Number(sceneCountInput);
    if (!Number.isInteger(requestedSceneCount) || requestedSceneCount < MIN_SCENE_COUNT) {
      setPanelError(`生成张数必须是大于 5 的整数（建议 ${DEFAULT_SCENE_COUNT}）`);
      return;
    }

    if (selectedChapter?.has_succeeded_story) {
      const storyHint = selectedChapter.generated_story_id ? `（已生成：${selectedChapter.generated_story_id}）` : "";
      const confirmed = window.confirm(`该章节已生成过${storyHint}，确认重新生成吗？`);
      if (!confirmed) {
        return;
      }
    }

    setSubmitting(true);
    setPanelError("");
    setPanelInfo("");
    setShowGenerateDialog(false);

    try {
      const runId = createClientRunId();
      await apiGenerateRunText(runId, {
        chapter_id: selectedChapterId,
        target_date: targetDate,
        scene_count: requestedSceneCount,
      });

      setReviewRunId(runId);
      setReviewScenes([]);
      setReviewCounts(defaultSceneCounts());
      setActiveRunId(runId);
      setActiveJob(null);
      setPuzzleFlowStep("generate");
      setPanelInfo(`文案已生成：${runId}（目标 ${requestedSceneCount} 张），请在第二步确认拆分并触发出图`);
      await loadGenerationReview(runId);
      await loadRecentJobs();
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    loadGenerationReview,
    loadRecentJobs,
    sceneCountInput,
    selectedChapter,
    selectedChapterId,
    setActiveJob,
    setActiveRunId,
    setPanelError,
    setPanelInfo,
    setPuzzleFlowStep,
    setReviewCounts,
    setReviewRunId,
    setReviewScenes,
    setShowGenerateDialog,
    setSubmitting,
    targetDate,
  ]);

  return {
    handleBatchGenerateImages,
    handleDeleteReviewScene,
    handleOpenGeneratedStory,
    handleOpenPublishedStory,
    handlePublishSelected,
    handleRetryReviewCandidate,
    handleUploadReviewSceneImage,
    handleStayAfterPublish,
    handleSubmit,
    handleUpdateReviewScene,
  };
}
