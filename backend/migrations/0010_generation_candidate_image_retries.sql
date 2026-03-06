CREATE TABLE IF NOT EXISTS generation_candidate_image_retries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  scene_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  requested_by TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id, scene_index) REFERENCES generation_job_level_candidates(run_id, scene_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_generation_candidate_retries_claim
  ON generation_candidate_image_retries(status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_generation_candidate_retries_scene
  ON generation_candidate_image_retries(run_id, scene_index, created_at);
