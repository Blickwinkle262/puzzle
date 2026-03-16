import { useCallback, useReducer, useState } from "react";

import {
  AdminGenerationJob,
  AdminGenerationJobDetail,
  AdminGenerationScene,
  AdminGenerationSceneCounts,
} from "../../core/types";
import { AdminSectionKey, PuzzleFlowStep } from "./shared";

type RunReviewFlowState = {
  collapsedSections: Record<AdminSectionKey, boolean>;
  puzzleFlowStep: PuzzleFlowStep;
};

type RunReviewFlowAction =
  | {
      type: "set-puzzle-flow-step";
      step: PuzzleFlowStep;
    }
  | {
      type: "set-collapsed-sections";
      updater: (prev: Record<AdminSectionKey, boolean>) => Record<AdminSectionKey, boolean>;
    };

const INITIAL_FLOW_STATE: RunReviewFlowState = {
  collapsedSections: {
    users: true,
    levelConfig: true,
    llm: true,
    bookIngest: true,
    puzzle: true,
  },
  puzzleFlowStep: "select",
};

function runReviewFlowReducer(state: RunReviewFlowState, action: RunReviewFlowAction): RunReviewFlowState {
  if (action.type === "set-puzzle-flow-step") {
    if (state.puzzleFlowStep === action.step) {
      return state;
    }
    return {
      ...state,
      puzzleFlowStep: action.step,
    };
  }

  if (action.type === "set-collapsed-sections") {
    const nextCollapsedSections = action.updater(state.collapsedSections);
    if (nextCollapsedSections === state.collapsedSections) {
      return state;
    }
    return {
      ...state,
      collapsedSections: nextCollapsedSections,
    };
  }

  return state;
}

export function useAdminRunReviewState(defaultSceneCounts: () => AdminGenerationSceneCounts) {
  const [recentJobs, setRecentJobs] = useState<AdminGenerationJob[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [activeJob, setActiveJob] = useState<AdminGenerationJobDetail | null>(null);
  const [reviewRunId, setReviewRunId] = useState("");
  const [reviewScenes, setReviewScenes] = useState<AdminGenerationScene[]>([]);
  const [reviewCounts, setReviewCounts] = useState<AdminGenerationSceneCounts>(defaultSceneCounts);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewPublishing, setReviewPublishing] = useState(false);
  const [reviewBatchGenerating, setReviewBatchGenerating] = useState(false);
  const [reviewUpdatingSceneIndex, setReviewUpdatingSceneIndex] = useState<number | null>(null);
  const [reviewRetryingSceneIndex, setReviewRetryingSceneIndex] = useState<number | null>(null);
  const [reviewUploadingSceneIndex, setReviewUploadingSceneIndex] = useState<number | null>(null);
  const [reviewDeletingSceneIndex, setReviewDeletingSceneIndex] = useState<number | null>(null);
  const [runCancellingId, setRunCancellingId] = useState("");
  const [runDeletingId, setRunDeletingId] = useState("");
  const [flowState, dispatchFlow] = useReducer(runReviewFlowReducer, INITIAL_FLOW_STATE);

  const setPuzzleFlowStep = useCallback((step: PuzzleFlowStep) => {
    dispatchFlow({
      type: "set-puzzle-flow-step",
      step,
    });
  }, []);

  const setCollapsedSections = useCallback((
    updater: (prev: Record<AdminSectionKey, boolean>) => Record<AdminSectionKey, boolean>,
  ) => {
    dispatchFlow({
      type: "set-collapsed-sections",
      updater,
    });
  }, []);

  return {
    activeJob,
    activeRunId,
    collapsedSections: flowState.collapsedSections,
    puzzleFlowStep: flowState.puzzleFlowStep,
    recentJobs,
    reviewBatchGenerating,
    reviewCounts,
    reviewDeletingSceneIndex,
    reviewLoading,
    reviewPublishing,
    reviewRetryingSceneIndex,
    reviewUploadingSceneIndex,
    reviewRunId,
    reviewScenes,
    reviewUpdatingSceneIndex,
    runCancellingId,
    runDeletingId,
    setActiveJob,
    setActiveRunId,
    setCollapsedSections,
    setPuzzleFlowStep,
    setRecentJobs,
    setReviewBatchGenerating,
    setReviewCounts,
    setReviewDeletingSceneIndex,
    setReviewLoading,
    setReviewPublishing,
    setReviewRetryingSceneIndex,
    setReviewUploadingSceneIndex,
    setReviewRunId,
    setReviewScenes,
    setReviewUpdatingSceneIndex,
    setRunCancellingId,
    setRunDeletingId,
  };
}
