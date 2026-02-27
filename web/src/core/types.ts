export type Side = "top" | "right" | "bottom" | "left";

export type Cell = {
  row: number;
  col: number;
};

export type PieceDef = {
  id: number;
  correctRow: number;
  correctCol: number;
  correctId: [number, number];
};

export type GridConfig = {
  rows: number;
  cols: number;
};

export type LevelAudioConfig = {
  piece_pick?: string;
  piece_drop?: string;
  piece_link?: string;
  piece_unlink?: string;
  win?: string;
  timeout?: string;
};

export type LevelConfig = {
  id: string;
  title: string;
  description: string;
  story_text?: string;
  grid: GridConfig;
  source_image: string;
  content_version?: number;
  legacy_ids?: string[];
  asset_missing?: boolean;
  time_limit_sec?: number;
  shuffle?: {
    seed?: number;
    mode?: string;
  };
  audio?: LevelAudioConfig;
  mobile?: {
    preferred_orientation?: "portrait" | "landscape";
    orientation_hint?: string;
  };
};

export type StoryCampaign = {
  id?: string;
  title?: string;
  description?: string;
  story_overview_title?: string;
  story_overview_paragraphs?: string[];
  levels: LevelConfig[];
};

export type ExpectedEdge = {
  firstId: number;
  secondId: number;
  dx: number;
  dy: number;
};

export type SwapPlan = {
  firstIds: Set<number>;
  secondIds: Set<number>;
  endCells: Record<number, Cell>;
};

export type ProgressStatus = "not_started" | "in_progress" | "completed";

export type UserProfile = {
  id: number;
  username: string;
  is_guest: boolean;
};

export type LevelProgress = {
  story_id?: string;
  level_id?: string;
  status: ProgressStatus;
  best_time_ms?: number;
  best_moves?: number;
  attempts?: number;
  last_played_at?: string;
  completed_at?: string;
  content_version?: number;
};

export type StoryListItem = {
  id: string;
  title: string;
  description: string;
  cover: string;
  cover_missing?: boolean;
  total_levels: number;
  completed_levels: number;
  last_level_id?: string | null;
};

export type StoryDetail = {
  id: string;
  title: string;
  description: string;
  cover: string;
  cover_missing?: boolean;
  story_overview_title?: string;
  story_overview_paragraphs?: string[];
  default_bgm?: string;
  levels: LevelConfig[];
  level_progress: Record<string, LevelProgress>;
};
