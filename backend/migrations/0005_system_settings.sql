CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_by_user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO system_settings (key, value_json, updated_at)
VALUES (
  'timer_policy_v1',
  '{"base_seconds":45,"per_piece_seconds":4,"min_seconds":60,"max_seconds":600,"difficulty_factor":{"easy":1.2,"normal":1.0,"hard":0.85,"nightmare":0.7}}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
