ALTER TABLE generation_jobs ADD COLUMN review_status TEXT NOT NULL DEFAULT '';

ALTER TABLE generation_jobs ADD COLUMN published_at TEXT;

CREATE INDEX IF NOT EXISTS idx_generation_jobs_review_status_updated
  ON generation_jobs(review_status, updated_at);

UPDATE generation_jobs
SET review_status = 'pending_review'
WHERE status = 'succeeded'
  AND COALESCE(review_status, '') = ''
  AND COALESCE(dry_run, 0) = 0
  AND json_valid(payload_json)
  AND CAST(COALESCE(json_extract(payload_json, '$.review_mode'), 0) AS INTEGER) = 1;
