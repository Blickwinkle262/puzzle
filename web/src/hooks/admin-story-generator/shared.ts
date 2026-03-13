export type PuzzleFlowStep = "select" | "generate" | "review";

export type AdminSectionKey = "users" | "levelConfig" | "bookIngest" | "puzzle";

export type ScenePreviewState = {
  run_id: string;
  scene_index: number;
  title: string;
  image_url: string;
  image_prompt: string;
};

export type PublishSuccessState = {
  run_id: string;
  story_id: string;
  level_count: number;
};
