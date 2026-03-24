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
  book_id?: string;
  book_title?: string;
  cover_missing?: boolean;
  book_placeholder?: boolean;
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
  summary_text?: string;
  summary_status?: "" | "running" | "succeeded" | "failed" | "queued";
  summary_updated_at?: string | null;
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

export type AdminChapterTextResponse = {
  ok: boolean;
  db_path: string;
  chapter: {
    id: number;
    book_id: number;
    book_title: string;
    book_author: string;
    chapter_index: number;
    chapter_title: string;
    char_count: number;
    word_count: number;
    chapter_text: string;
    meta_json: Record<string, unknown>;
  };
};

export type AdminBookUploadResponse = {
  ok: boolean;
  run_id?: string;
  status?: "queued" | "running" | "succeeded" | "failed";
  db_path: string;
  stored_file: string;
  source_sha256?: string;
  ingest?: {
    ok?: boolean;
    run_id?: string;
    book_title?: string;
    book_author?: string;
    format?: string;
    inserted?: number;
    updated?: number;
    skipped?: number;
    total?: number;
    [key: string]: unknown;
  };
};

export type AdminBookIngestTask = {
  run_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  source_path: string;
  source_format: string;
  source_name: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  error_message: string;
};

export type AdminBookSummaryTask = {
  run_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  scope_type: "book" | "chapter";
  scope_id: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error_message: string;
};

export type AdminBookSummaryTaskItem = {
  chapter_id: number;
  chapter_index: number;
  chapter_title: string;
  status: "succeeded" | "failed" | "skipped";
  source_chars: number;
  chunks_count: number;
  error_message: string;
  updated_at: string | null;
};

export type AdminStoryBookOption = {
  book_id: string;
  book_title: string;
  chapter_count: number;
};

export type AdminStoryMeta = {
  id: string;
  title: string;
  description: string;
  book_id: string;
  book_title: string;
  story_overview_title: string;
  story_overview_paragraphs: string[];
  has_override?: boolean;
};

export type AdminStoryMetaResponse = {
  ok: boolean;
  story: AdminStoryMeta;
  books: AdminStoryBookOption[];
};

export type AdminGenerationJob = {
  run_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  review_status?: "" | "pending_review" | "published";
  flow_stage?: "" | "text_generating" | "text_ready" | "images_generating" | "review_ready" | "published" | "failed";
  requested_by: string;
  target_date: string;
  story_file: string;
  dry_run: boolean;
  log_file: string;
  event_log_file: string;
  summary_path: string;
  published_at?: string | null;
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

export type AdminGenerationCandidate = {
  run_id: string;
  scene_index: number;
  scene_id: number | null;
  title: string;
  description: string;
  story_text: string;
  image_prompt: string;
  mood: string;
  characters: string[];
  grid_rows: number;
  grid_cols: number;
  time_limit_sec: number;
  image_status: "pending" | "queued" | "running" | "success" | "failed" | "skipped";
  image_url: string;
  image_path: string;
  error_message: string;
  selected: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type AdminGenerationCandidateCounts = {
  total: number;
  success: number;
  failed: number;
  pending: number;
  selected: number;
  ready_for_publish: number;
};

export type AdminGenerationCandidateRetryTask = {
  retry_id: number;
  run_id: string;
  scene_index: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  requested_by: string;
  attempts: number;
  error_message: string;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
};

export type AdminGenerationJobDetail = AdminGenerationJob & {
  payload?: Record<string, unknown>;
  events?: AdminGenerationEvent[];
  log_tail?: string[];
  summary?: Record<string, unknown> | null;
  candidates?: AdminGenerationCandidate[];
  candidate_counts?: AdminGenerationCandidateCounts;
};

export type AdminGenerationReviewResponse = {
  job: AdminGenerationJobDetail;
  candidates: AdminGenerationCandidate[];
  counts: AdminGenerationCandidateCounts;
  publish?: {
    review_status?: "" | "pending_review" | "published";
    published_at?: string | null;
  };
};

export type AdminGenerationPublishResponse = {
  ok: boolean;
  run_id: string;
  story_id: string;
  manifest: string;
  cover: string;
  level_count: number;
  selected_count: number;
  published_at: string;
  counts: AdminGenerationCandidateCounts;
};

export type AdminGenerationRetryImageResponse = {
  ok: boolean;
  retry_id: number;
  retry: AdminGenerationCandidateRetryTask;
  candidate: AdminGenerationCandidate | null;
};

export type AdminGenerationScene = {
  run_id: string;
  scene_index: number;
  scene_id: number | null;
  title: string;
  description: string;
  story_text: string;
  image_prompt: string;
  mood: string;
  characters: string[];
  grid_rows: number;
  grid_cols: number;
  time_limit_sec: number;
  text_status: "pending" | "ready" | "failed" | "deleted";
  image_status: "pending" | "queued" | "running" | "success" | "failed" | "skipped";
  image_url: string;
  image_path: string;
  error_message: string;
  selected: boolean;
  deleted_at: string | null;
  source_kind: "legacy" | "summary" | "review" | "manual" | "pipeline";
  created_at: string | null;
  updated_at: string | null;
};

export type AdminGenerationSceneAttempt = {
  id: number;
  run_id: string;
  scene_index: number;
  attempt_no: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  provider: string;
  model: string;
  image_prompt: string;
  image_url: string;
  image_path: string;
  error_message: string;
  latency_ms: number | null;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
};

export type AdminGenerationSceneCounts = {
  total: number;
  text_ready: number;
  text_failed: number;
  images_success: number;
  images_failed: number;
  images_pending: number;
  images_running: number;
  selected: number;
  ready_for_publish: number;
  deleted: number;
};

export type AdminGenerationRunDetailResponse = {
  job: AdminGenerationJobDetail;
  scenes: AdminGenerationScene[];
  counts: AdminGenerationSceneCounts;
  attempts_by_scene: Record<string, AdminGenerationSceneAttempt[]>;
  attempts: AdminGenerationSceneAttempt[];
};

export type AdminGenerationRunOverrides = {
  chapter_text_override: string;
  chapter_text_override_chars: number;
  system_prompt_text: string;
  system_prompt_chars: number;
  user_prompt_template_text: string;
  user_prompt_template_chars: number;
  image_prompt_suffix_text: string;
  image_prompt_suffix_chars: number;
};

export type AdminGenerationRunOverridesResponse = {
  ok: boolean;
  run_id: string;
  overrides: AdminGenerationRunOverrides;
};

export type AdminGenerationRunMutateResponse = {
  ok: boolean;
  run_id: string;
  job: AdminGenerationJobDetail;
  scenes?: AdminGenerationScene[];
  scene?: AdminGenerationScene | null;
  counts?: AdminGenerationSceneCounts;
  attempt?: AdminGenerationSceneAttempt | null;
  processed?: number;
  story_id?: string;
  manifest?: string;
  cover?: string;
  level_count?: number;
  selected_count?: number;
  published_at?: string;
};

export type AdminGenerationCreateResponse = {
  ok: boolean;
  run_id: string;
  status: "queued";
  target_date: string;
  dry_run: boolean;
  review_mode?: boolean;
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
  best_time_level_count: number;
  fastest_level_time_ms: number | null;
  completed_level_count: number;
  pending_password_reset_count: number;
  last_password_reset_requested_at: string | null;
  is_admin: boolean;
};

export type AdminUsersResponse = {
  total: number;
  has_more: boolean;
  summary: {
    total_users: number;
    guest_users: number;
    admin_users: number;
    pending_reset_users: number;
  };
  filters: {
    limit: number;
    offset: number;
    page: number;
    keyword: string;
    role: string;
  };
  users: AdminUserSummary[];
};

export type AdminPromptPreset = {
  id: number;
  name: string;
  system_prompt_text: string;
  user_prompt_template_text: string;
  image_prompt_suffix_text: string;
  is_builtin: boolean;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type AdminPromptPresetsResponse = {
  ok: boolean;
  presets: AdminPromptPreset[];
};

export type AdminPromptPresetResponse = {
  ok: boolean;
  preset: AdminPromptPreset;
};

export type AdminPromptPresetDeleteResponse = {
  ok: boolean;
  deleted_preset_id: number;
};

export type AdminLlmApiKeyOption = {
  key: string;
  label: string;
  configured: boolean;
};

export type AdminLlmConnectionTestResult = {
  provider_kind: "compatible";
  api_base_url: string;
  resolved_base_url: string;
  api_key_selector: string;
  text_model: string;
  summary_model: string;
  image_model: string;
  proxy_url: string;
  no_proxy: string;
  key_available: boolean;
  text_model_exists: boolean;
  summary_model_exists: boolean;
  image_model_exists: boolean;
  models_count: number;
  models_preview: string[];
};

export type AdminLlmConnectionTestResponse = {
  ok: boolean;
  test: AdminLlmConnectionTestResult;
};

export type AdminLlmModelOption = {
  id: string;
  text: boolean;
  image: boolean;
  summary: boolean;
};

export type AdminLlmModelsFetchResult = {
  provider_kind: "compatible";
  api_base_url: string;
  resolved_base_url: string;
  api_key_selector: string;
  text_model: string;
  summary_model: string;
  image_model: string;
  proxy_url: string;
  no_proxy: string;
  key_available: boolean;
  models_count: number;
  fetched_at: string;
  models: AdminLlmModelOption[];
};

export type AdminLlmModelsFetchResponse = {
  ok: boolean;
  fetch: AdminLlmModelsFetchResult;
};

export type AdminLlmProviderKeySource = "env" | "custom";

export type AdminLlmProviderKey = {
  id: number;
  key_source: AdminLlmProviderKeySource;
  env_key_name: string;
  key_last4: string;
  key_masked: string;
  has_key: boolean;
  is_active: boolean;
};

export type AdminLlmProvider = {
  id: number;
  name: string;
  provider_kind: "compatible";
  api_base_url: string;
  proxy_url: string;
  no_proxy_hosts: string;
  enabled: boolean;
  owner_user_id: number | null;
  created_at: string;
  updated_at: string;
  models_count: number;
  key: AdminLlmProviderKey | null;
};

export type AdminLlmProviderModel = {
  id: number;
  provider_id: number;
  model_id: string;
  model_type: "text" | "summary" | "image";
  enabled: boolean;
  fetched_at: string;
};

export type AdminLlmRuntimeState = {
  provider_id: number | null;
  provider_name: string;
  profile_scope: string;
  provider_kind: "compatible";
  api_base_url: string;
  api_key_selector: string;
  key_available: boolean;
  text_model: string;
  summary_model: string;
  image_model: string;
  proxy_url: string;
  no_proxy: string;
};

export type AdminLlmProfile = {
  id: number;
  scope: "global" | "user";
  user_id: number | null;
  provider_id: number | null;
  story_provider_id: number | null;
  summary_provider_id: number | null;
  text2image_provider_id: number | null;
  provider_name: string;
  story_provider_name: string;
  summary_provider_name: string;
  text2image_provider_name: string;
  provider_kind: "compatible";
  story_prompt_model: string;
  text_model: string;
  summary_model: string;
  text2image_model: string;
  image_model: string;
  is_default: boolean;
  updated_at: string;
};

export type AdminLlmEnvKeysResponse = {
  ok: boolean;
  key_options: AdminLlmApiKeyOption[];
};

export type AdminLlmProvidersResponse = {
  ok: boolean;
  providers: AdminLlmProvider[];
};

export type AdminLlmProviderResponse = {
  ok: boolean;
  provider: AdminLlmProvider;
};

export type AdminLlmProviderDeleteResponse = {
  ok: boolean;
  deleted_provider_id: number;
};

export type AdminLlmProviderModelsResponse = {
  ok: boolean;
  provider: AdminLlmProvider;
  models: AdminLlmProviderModel[];
};

export type AdminLlmProfileResponse = {
  ok: boolean;
  profile: AdminLlmProfile | null;
  effective: AdminLlmRuntimeState;
};

export type AdminLevelDifficulty = "easy" | "normal" | "hard" | "nightmare";

export type AdminLevelEffectiveConfig = {
  grid_rows: number;
  grid_cols: number;
  piece_count: number;
  time_limit_sec: number | null;
  difficulty: AdminLevelDifficulty;
  content_version: number;
};

export type AdminLevelOverrideConfig = {
  enabled: boolean;
  grid_rows: number | null;
  grid_cols: number | null;
  time_limit_sec: number | null;
  difficulty: AdminLevelDifficulty | null;
  difficulty_factor: number | null;
  content_version: number | null;
  updated_by_user_id: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export type AdminLevelConfigSnapshot = {
  story_id: string;
  level_id: string;
  level_title: string;
  base_config: AdminLevelEffectiveConfig;
  override_config: AdminLevelOverrideConfig | null;
  effective_config: AdminLevelEffectiveConfig;
  preview_override_config?: AdminLevelOverrideConfig | null;
  preview_effective_config?: AdminLevelEffectiveConfig;
};

export type AdminLevelConfigResponse = AdminLevelConfigSnapshot & {
  ok?: boolean;
};

export type AdminLevelTestRunResponse = {
  ok: boolean;
  mode: "admin_test";
  save_progress: false;
  message: string;
  test_run_id: string;
  story_id: string;
  level_id: string;
  level: Record<string, unknown>;
  config: AdminLevelConfigSnapshot;
};

export type AdminLevelConfigPatch = {
  enabled?: boolean;
  grid_rows?: number | null;
  grid_cols?: number | null;
  time_limit_sec?: number | null;
  difficulty?: AdminLevelDifficulty | null;
  difficulty_factor?: number | null;
  content_version?: number | null;
};
