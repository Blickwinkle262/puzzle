CREATE TABLE IF NOT EXISTS generation_job_meta (
  run_id TEXT PRIMARY KEY,
  requested_by_user_id INTEGER,
  chapter_id INTEGER,
  book_id INTEGER,
  usage_id INTEGER,
  result_story_id TEXT,
  job_kind TEXT NOT NULL DEFAULT 'story_generation' CHECK (job_kind IN ('story_generation', 'level_generation')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES generation_jobs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_job_meta_chapter ON generation_job_meta(chapter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_job_meta_book ON generation_job_meta(book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_job_meta_requester ON generation_job_meta(requested_by_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_job_meta_result_story ON generation_job_meta(result_story_id);

INSERT OR IGNORE INTO generation_job_meta (
  run_id,
  requested_by_user_id,
  chapter_id,
  book_id,
  usage_id,
  result_story_id,
  job_kind,
  created_at,
  updated_at
)
SELECT
  g.run_id,
  (SELECT u.id FROM users u WHERE lower(u.username) = lower(g.requested_by) LIMIT 1),
  CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.chapter_id') AS INTEGER) ELSE NULL END,
  CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.book_id') AS INTEGER) ELSE NULL END,
  CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.usage_id') AS INTEGER) ELSE NULL END,
  CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.story_id') AS TEXT) ELSE NULL END,
  'story_generation',
  COALESCE(g.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  COALESCE(g.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM generation_jobs g;
