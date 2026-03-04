CREATE TABLE IF NOT EXISTS level_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  base_level_id TEXT,
  draft_level_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'testing', 'published', 'archived')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'generator', 'import')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_level_drafts_story_status ON level_drafts(story_id, status);
CREATE INDEX IF NOT EXISTS idx_level_drafts_updated_at ON level_drafts(updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_level_drafts_active
ON level_drafts(story_id, draft_level_id)
WHERE status IN ('draft', 'testing');
