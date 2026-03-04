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

UPDATE generation_job_meta
SET result_story_id = (
      SELECT CAST(json_extract(g.payload_json, '$.story_id') AS TEXT)
      FROM generation_jobs g
      WHERE g.run_id = generation_job_meta.run_id
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE COALESCE(result_story_id, '') = ''
  AND EXISTS (
    SELECT 1
    FROM generation_jobs g
    WHERE g.run_id = generation_job_meta.run_id
      AND json_valid(g.payload_json)
      AND COALESCE(CAST(json_extract(g.payload_json, '$.story_id') AS TEXT), '') <> ''
  );
