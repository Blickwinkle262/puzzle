CREATE TABLE IF NOT EXISTS generation_job_level_candidates (
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
  image_status TEXT NOT NULL DEFAULT 'pending' CHECK (image_status IN ('pending', 'success', 'failed', 'skipped')),
  image_url TEXT,
  image_path TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (run_id, scene_index),
  FOREIGN KEY (run_id) REFERENCES generation_jobs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_generation_job_level_candidates_run_id
  ON generation_job_level_candidates(run_id, scene_index);

CREATE INDEX IF NOT EXISTS idx_generation_job_level_candidates_status
  ON generation_job_level_candidates(image_status, updated_at);
