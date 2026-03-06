ALTER TABLE generation_jobs ADD COLUMN flow_stage TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_generation_jobs_flow_stage_updated
  ON generation_jobs(flow_stage, updated_at);

CREATE TABLE IF NOT EXISTS generation_job_scenes (
  run_id TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  scene_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  story_text TEXT NOT NULL DEFAULT '',
  image_prompt TEXT NOT NULL DEFAULT '',
  mood TEXT NOT NULL DEFAULT '',
  characters_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(characters_json)),
  grid_rows INTEGER NOT NULL DEFAULT 6,
  grid_cols INTEGER NOT NULL DEFAULT 4,
  time_limit_sec INTEGER NOT NULL DEFAULT 180,
  text_status TEXT NOT NULL DEFAULT 'ready' CHECK (text_status IN ('pending', 'ready', 'failed', 'deleted')),
  image_status TEXT NOT NULL DEFAULT 'pending' CHECK (image_status IN ('pending', 'queued', 'running', 'success', 'failed', 'skipped')),
  image_url TEXT,
  image_path TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  deleted_at TEXT,
  source_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (source_kind IN ('legacy', 'summary', 'review', 'manual', 'pipeline')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (run_id, scene_index),
  FOREIGN KEY (run_id) REFERENCES generation_jobs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_generation_job_scenes_run
  ON generation_job_scenes(run_id, scene_index);

CREATE INDEX IF NOT EXISTS idx_generation_job_scenes_image_status
  ON generation_job_scenes(image_status, updated_at);

CREATE TABLE IF NOT EXISTS generation_job_scene_image_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  image_prompt TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  image_path TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (run_id, scene_index, attempt_no),
  FOREIGN KEY (run_id, scene_index) REFERENCES generation_job_scenes(run_id, scene_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_generation_job_scene_attempts_claim
  ON generation_job_scene_image_attempts(status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_generation_job_scene_attempts_scene
  ON generation_job_scene_image_attempts(run_id, scene_index, attempt_no);

UPDATE generation_jobs
SET flow_stage = CASE
    WHEN status = 'queued' THEN 'queued'
    WHEN status = 'running' THEN 'images_generating'
    WHEN status IN ('failed', 'cancelled') THEN 'failed'
    WHEN status = 'succeeded' AND COALESCE(review_status, '') = 'published' THEN 'published'
    WHEN status = 'succeeded' AND COALESCE(review_status, '') = 'pending_review' THEN 'review_ready'
    WHEN status = 'succeeded' THEN 'completed'
    ELSE ''
  END
WHERE COALESCE(flow_stage, '') = '';
