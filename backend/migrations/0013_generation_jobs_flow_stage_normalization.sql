UPDATE generation_jobs
SET flow_stage = CASE
    WHEN status IN ('failed', 'cancelled') THEN 'failed'
    WHEN status = 'queued' THEN 'text_generating'
    WHEN status = 'running' THEN CASE
      WHEN COALESCE(flow_stage, '') IN ('text_generating', 'text_ready', 'images_generating') THEN flow_stage
      ELSE 'images_generating'
    END
    WHEN status = 'succeeded' AND COALESCE(review_status, '') = 'published' THEN 'published'
    WHEN status = 'succeeded' AND COALESCE(review_status, '') = 'pending_review' THEN 'review_ready'
    WHEN status = 'succeeded'
      AND COALESCE(dry_run, 0) = 0
      AND json_valid(payload_json)
      AND CAST(COALESCE(json_extract(payload_json, '$.review_mode'), 0) AS INTEGER) = 1 THEN 'review_ready'
    WHEN status = 'succeeded' THEN 'published'
    ELSE 'text_generating'
  END,
  updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE COALESCE(flow_stage, '') IN ('', 'queued', 'completed', 'failed', 'published', 'review_ready', 'images_generating', 'text_generating', 'text_ready');
