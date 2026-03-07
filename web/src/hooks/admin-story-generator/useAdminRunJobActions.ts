import { useCallback } from "react";

import {
  AdminGenerationJob,
  AdminGenerationJobDetail,
  AdminGenerationScene,
  AdminGenerationSceneCounts,
} from "../../core/types";
import { apiCancelRun, apiDeleteRun } from "../../core/adminApi";
import { AdminSectionKey, PuzzleFlowStep } from "./shared";

type UseAdminRunJobActionsOptions = {
  activeRunId: string;
  recentJobs: AdminGenerationJob[];
  reviewRunId: string;
  defaultSceneCounts: () => AdminGenerationSceneCounts;
  loadGenerationReview: (runId: string) => Promise<void>;
  loadRecentJobs: () => Promise<void>;
  setActiveJob: (job: AdminGenerationJobDetail | null) => void;
  setActiveRunId: (runId: string) => void;
  setCollapsedSections: (
    updater: (prev: Record<AdminSectionKey, boolean>) => Record<AdminSectionKey, boolean>,
  ) => void;
  setPanelError: (message: string) => void;
  setPanelInfo: (message: string) => void;
  setPuzzleFlowStep: (step: PuzzleFlowStep) => void;
  setReviewCounts: (counts: AdminGenerationSceneCounts) => void;
  setReviewRunId: (runId: string) => void;
  setReviewScenes: (scenes: AdminGenerationScene[]) => void;
  setRunCancellingId: (runId: string) => void;
  setRunDeletingId: (runId: string) => void;
  setShowGenerateDialog: (visible: boolean) => void;
  toErrorMessage: (err: unknown) => string;
};

export function useAdminRunJobActions({
  activeRunId,
  recentJobs,
  reviewRunId,
  defaultSceneCounts,
  loadGenerationReview,
  loadRecentJobs,
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
}: UseAdminRunJobActionsOptions) {
  const handleOpenReview = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    setPanelError("");
    setPanelInfo(`加载审核数据：${targetRunId}`);
    setShowGenerateDialog(false);
    setActiveRunId("");
    setActiveJob(null);
    setPuzzleFlowStep("review");
    setCollapsedSections((prev) => ({
      ...prev,
      puzzle: false,
    }));
    await loadGenerationReview(targetRunId);
  }, [
    loadGenerationReview,
    setActiveJob,
    setActiveRunId,
    setCollapsedSections,
    setPanelError,
    setPanelInfo,
    setPuzzleFlowStep,
    setShowGenerateDialog,
  ]);

  const handleCancelRun = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    const confirmed = window.confirm(`确认取消任务 ${targetRunId} 吗？`);
    if (!confirmed) {
      return;
    }

    setRunCancellingId(targetRunId);
    setPanelError("");
    try {
      await apiCancelRun(targetRunId, "cancelled by admin from panel");
      setPanelInfo(`任务已取消：${targetRunId}`);

      if (activeRunId === targetRunId) {
        setActiveRunId("");
        setActiveJob(null);
      }

      if (reviewRunId === targetRunId) {
        await loadGenerationReview(targetRunId);
      }

      await loadRecentJobs();
    } catch (err) {
      setPanelError(toErrorMessage(err));
    } finally {
      setRunCancellingId("");
    }
  }, [
    activeRunId,
    loadGenerationReview,
    loadRecentJobs,
    reviewRunId,
    setActiveJob,
    setActiveRunId,
    setPanelError,
    setPanelInfo,
    setRunCancellingId,
    toErrorMessage,
  ]);

  const handleDeleteRun = useCallback(async (runId: string): Promise<void> => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      return;
    }

    const targetJob = recentJobs.find((item) => item.run_id === targetRunId) || null;
    const force = targetJob?.status === "running";
    const confirmed = window.confirm(
      force
        ? `任务 ${targetRunId} 仍在运行，确认强制删除吗？`
        : `确认删除任务 ${targetRunId} 吗？`,
    );
    if (!confirmed) {
      return;
    }

    setRunDeletingId(targetRunId);
    setPanelError("");
    try {
      await apiDeleteRun(targetRunId, {
        force,
      });
      setPanelInfo(`任务已删除：${targetRunId}`);

      if (activeRunId === targetRunId) {
        setActiveRunId("");
        setActiveJob(null);
      }

      if (reviewRunId === targetRunId) {
        setReviewRunId("");
        setReviewScenes([]);
        setReviewCounts(defaultSceneCounts());
      }

      await loadRecentJobs();
    } catch (err) {
      setPanelError(toErrorMessage(err));
    } finally {
      setRunDeletingId("");
    }
  }, [
    activeRunId,
    defaultSceneCounts,
    loadRecentJobs,
    recentJobs,
    reviewRunId,
    setActiveJob,
    setActiveRunId,
    setPanelError,
    setPanelInfo,
    setReviewCounts,
    setReviewRunId,
    setReviewScenes,
    setRunDeletingId,
    toErrorMessage,
  ]);

  return {
    handleCancelRun,
    handleDeleteRun,
    handleOpenReview,
  };
}
