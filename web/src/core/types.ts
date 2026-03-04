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
  is_admin: boolean;
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


export type AdminBookInfo = {
  id: number;
  title: string;
  author: string;
  genre: string;
  source_format: string;
  chapter_count: number;
  min_char_count: number;
  max_char_count: number;
};

export type AdminChapterSummary = {
  id: number;
  book_id: number;
  book_title: string;
  genre: string;
  chapter_index: number;
  chapter_title: string;
  char_count: number;
  word_count: number;
  used_count: number;
  last_used_at: string | null;
  preview: string;
  has_succeeded_story: boolean;
  generated_story_id?: string | null;
  generated_run_id?: string | null;
  generated_at?: string | null;
  meta_json: Record<string, unknown>;
};

export type AdminBookChaptersResponse = {
  db_path: string;
  total: number;
  has_more: boolean;
  filters: {
    limit: number;
    offset: number;
    min_chars: number | null;
    max_chars: number | null;
    keyword: string;
    include_used: boolean;
    include_toc_like: boolean;
    book_id: number | null;
    book_title: string;
  };
  books: AdminBookInfo[];
  chapters: AdminChapterSummary[];
};

export type AdminGenerationJob = {
  run_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  requested_by: string;
  target_date: string;
  story_file: string;
  dry_run: boolean;
  log_file: string;
  event_log_file: string;
  summary_path: string;
  error_message: string;
  exit_code: number | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
};

export type AdminGenerationEvent = {
  ts?: string;
  event?: string;
  run_id?: string;
  level?: string;
  message?: string;
  progress?: number;
  completed?: number;
  total?: number;
  story_id?: string;
  [key: string]: unknown;
};

export type AdminGenerationJobDetail = AdminGenerationJob & {
  payload?: Record<string, unknown>;
  events: AdminGenerationEvent[];
  log_tail: string[];
  summary?: Record<string, unknown> | null;
};

export type AdminGenerationCreateResponse = {
  ok: boolean;
  run_id: string;
  status: "queued";
  target_date: string;
  dry_run: boolean;
  log_file: string;
  event_log_file: string;
  summary_path: string;
  scene_count: number | null;
  story_file: string;
  chapter: {
    chapter_id: number;
    chapter_index: number;
    chapter_title: string;
    char_count: number;
    book_id: number;
    book_title: string;
  } | null;
};

export type AdminManagedRole = "admin" | "editor" | "level_designer" | "operator";

export type AdminUserSummary = {
  id: number;
  username: string;
  is_guest: boolean;
  created_at: string | null;
  last_login_at: string | null;
  roles: AdminManagedRole[];
  is_admin: boolean;
};

export type AdminUsersResponse = {
  total: number;
  filters: {
    limit: number;
    keyword: string;
    role: string;
  };
  users: AdminUserSummary[];
};
