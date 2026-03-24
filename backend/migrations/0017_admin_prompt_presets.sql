CREATE TABLE IF NOT EXISTS admin_prompt_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  system_prompt_text TEXT NOT NULL DEFAULT '',
  user_prompt_template_text TEXT NOT NULL DEFAULT '',
  image_prompt_suffix_text TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_prompt_presets_updated_at ON admin_prompt_presets(updated_at DESC, id DESC);
