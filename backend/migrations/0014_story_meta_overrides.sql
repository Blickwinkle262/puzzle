CREATE TABLE IF NOT EXISTS story_meta_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL UNIQUE,
  book_id TEXT NOT NULL,
  book_title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  story_overview_title TEXT NOT NULL DEFAULT '',
  story_overview_paragraphs_json TEXT NOT NULL DEFAULT '[]',
  updated_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_story_meta_overrides_updated_at
  ON story_meta_overrides(updated_at DESC);

