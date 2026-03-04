CREATE TABLE IF NOT EXISTS level_overrides (
  story_id TEXT NOT NULL,
  level_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  grid_rows INTEGER CHECK (grid_rows IS NULL OR grid_rows BETWEEN 2 AND 20),
  grid_cols INTEGER CHECK (grid_cols IS NULL OR grid_cols BETWEEN 2 AND 20),
  time_limit_sec INTEGER CHECK (time_limit_sec IS NULL OR time_limit_sec BETWEEN 30 AND 3600),
  difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('easy', 'normal', 'hard', 'nightmare')),
  difficulty_factor REAL CHECK (difficulty_factor IS NULL OR (difficulty_factor > 0 AND difficulty_factor <= 5)),
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version >= 1),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  updated_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (story_id, level_id),
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (
    (grid_rows IS NULL AND grid_cols IS NULL)
    OR (grid_rows IS NOT NULL AND grid_cols IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_level_overrides_story ON level_overrides(story_id);
CREATE INDEX IF NOT EXISTS idx_level_overrides_updated_at ON level_overrides(updated_at);
