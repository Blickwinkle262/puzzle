import { useCallback, useEffect } from "react";

import { apiGetGenerationRun, apiListGenerationRuns } from "../../core/adminApi";
import { AdminGenerationJob, AdminGenerationJobDetail, AdminGenerationScene, AdminGenerationSceneCounts } from "../../core/types";
import { useAdminRunJobActions } from "../useAdminStoryGeneratorSections";
import { AdminSectionKey, PuzzleFlowStep } from "./shared";
import { defaultSceneCounts, errorMessage, formatTime, normalizeFlowStage, normalizeReviewStatus, pickStoryId } from "../../components/admin-story-generator/utils";

type UseAdminPuzzleFlowCoordinatorOptions = {
  activeRunId: string;
  onGenerated: (storyId: string) => Promise<void> | void;
  recentJobs: AdminGenerationJob[];
  reviewRunId: string;
  setRecentJobs: (jobs: AdminGenerationJob[]) => void;
  setActiveJob: (job: AdminGenerationJobDetail | null) => void;
  setActiveRunId: (runId: string) => void;
  setCollapsedSections: (
    updater: (prev: Record<AdminSectionKey, boolean>) => Record<AdminSectionKey, boolean>,
  ) => void;
  setPanelError: (message: string) => void;
  setPanelInfo: (message: string) => void;
  setPuzzleFlowStep: (step: PuzzleFlowStep) => void;
  setReviewCounts: (counts: AdminGenerationSceneCounts) => void;
  setReviewLoading: (loading: boolean) => void;
  setReviewRunId: (runId: string) => void;
  setReviewScenes: (scenes: AdminGenerationScene[]) => void;
  setRunCancellingId: (runId: string) => void;
  setRunDeletingId: (runId: string) => void;
  setShowGenerateDialog: (visible: boolean) => void;
  toErrorMessage: (err: unknown) => string;
  visible: boolean;
};

export function useAdminPuzzleFlowCoordinator({
  activeRunId,
  onGenerated,
  recentJobs,
  reviewRunId,
  setRecentJobs,
  setActiveJob,
  setActiveRunId,
  setCollapsedSections,
  setPanelError,
  setPanelInfo,
  setPuzzleFlowStep,
  setReviewCounts,
  setReviewLoading,
  setReviewRunId,
  setReviewScenes,
  setRunCancellingId,
  setRunDeletingId,
  setShowGenerateDialog,
  toErrorMessage,
  visible,
}: UseAdminPuzzleFlowCoordinatorOptions) {
  const loadRecentJobs = useCallback(async (): Promise<void> => {
    try {
      const response = await apiListGenerationRuns();
      setRecentJobs((response.runs || []).slice(0, 20));
    } catch {
      // ignore recent jobs errors in panel
    }
  }, [setRecentJobs]);

  const loadGenerationReview = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    setReviewLoading(true);
    try {
      const response = await apiGetGenerationRun(targetRunId);
      setReviewRunId(targetRunId);
      setReviewScenes((response.scenes || []).filter((item) => !item.deleted_at));
      setReviewCounts(response.counts || defaultSceneCounts());
      setActiveJob(response.job || null);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setReviewLoading(false);
    }
  }, [
    setActiveJob,
    setPanelError,
    setReviewCounts,
    setReviewLoading,
    setReviewRunId,
    setReviewScenes,
  ]);

  useEffect(() => {
    if (!visible || !activeRunId) {
      return;
    }

    let disposed = false;

    const poll = async (): Promise<void> => {
      try {
        const detail = await apiGetGenerationRun(activeRunId);
        if (disposed) {
          return;
        }

        setActiveJob(detail.job);

        if (reviewRunId && reviewRunId === activeRunId) {
          setReviewScenes((detail.scenes || []).filter((item) => !item.deleted_at));
          setReviewCounts(detail.counts || defaultSceneCounts());
        }

        const job = detail.job;
        const flowStage = normalizeFlowStage(job.flow_stage);

        if (flowStage === "published" || normalizeReviewStatus(job.review_status) === "published") {
          const storyId = pickStoryId(job);
          const publishedAtText = job.published_at ? `（${formatTime(job.published_at)}）` : "";
          setPanelInfo(storyId
            ? `任务已发布：${storyId}${publishedAtText}`
            : `任务已发布${publishedAtText}`);
          setActiveRunId("");
          if (storyId) {
            await onGenerated(storyId);
          }
          await loadGenerationReview(job.run_id);
          await loadRecentJobs();
          return;
        }

        if (flowStage === "review_ready") {
          setPanelInfo(`文案与图片已准备完毕：${job.run_id}`);
          setActiveRunId("");
          await loadGenerationReview(job.run_id);
          await loadRecentJobs();
          return;
        }

        if (job.status === "failed" || job.status === "cancelled" || flowStage === "failed") {
          setPanelError(job.error_message || "生成任务失败");
          setActiveRunId("");
          await loadRecentJobs();
        }
      } catch (err) {
        if (!disposed) {
          setPanelError(errorMessage(err));
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    activeRunId,
    loadGenerationReview,
    loadRecentJobs,
    onGenerated,
    reviewRunId,
    setActiveJob,
    setActiveRunId,
    setPanelError,
    setPanelInfo,
    setReviewCounts,
    setReviewScenes,
    visible,
  ]);

  useEffect(() => {
    if (!visible || !reviewRunId) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadGenerationReview(reviewRunId);
    }, 4000);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadGenerationReview, reviewRunId, visible]);

  const handleViewJobProgress = useCallback((runId: string): void => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    setPanelError("");
    setPanelInfo(`正在查看任务进度：${targetRunId}`);
    setShowGenerateDialog(false);
    setReviewRunId(targetRunId);
    setReviewScenes([]);
    setReviewCounts(defaultSceneCounts());
    setActiveJob(null);
    setActiveRunId(targetRunId);
    setPuzzleFlowStep("generate");
    setCollapsedSections((prev) => ({
      ...prev,
      puzzle: false,
    }));
    void loadGenerationReview(targetRunId);
  }, [
    loadGenerationReview,
    setActiveJob,
    setActiveRunId,
    setCollapsedSections,
    setPanelError,
    setPanelInfo,
    setPuzzleFlowStep,
    setReviewCounts,
    setReviewRunId,
    setReviewScenes,
    setShowGenerateDialog,
  ]);

  const { handleCancelRun, handleDeleteRun, handleOpenReview } = useAdminRunJobActions({
    activeRunId,
    defaultSceneCounts,
    loadGenerationReview,
    loadRecentJobs,
    recentJobs,
    reviewRunId,
    setActiveJob,
    setActiveRunId,
    setCollapsedSections,
    setPanelError,
    setPanelInfo,
    setPuzzleFlowStep,
    setReviewCounts,
    setReviewRunId,
    setReviewScenes,
    setRunCancellingId,
    setRunDeletingId,
    setShowGenerateDialog,
    toErrorMessage,
  });

  return {
    handleCancelRun,
    handleDeleteRun,
    handleOpenReview,
    handleViewJobProgress,
    loadGenerationReview,
    loadRecentJobs,
  };
}
