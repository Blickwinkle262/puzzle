CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_username_snapshot TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(after_json)),
  meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor_time ON admin_audit_logs(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target_time ON admin_audit_logs(target_type, target_id, created_at);
