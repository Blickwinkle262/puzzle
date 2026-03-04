CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'level_designer', 'operator')),
  granted_by_user_id INTEGER,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bootstrap_generation_jobs', 'bootstrap_fallback')),
  note TEXT NOT NULL DEFAULT '',
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_user ON user_roles(role, user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_granted_by ON user_roles(granted_by_user_id);

INSERT OR IGNORE INTO user_roles (user_id, role, granted_by_user_id, source, note, granted_at)
SELECT u.id, 'admin', NULL, 'bootstrap_generation_jobs', 'seed from generation_jobs.requested_by',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users u
WHERE EXISTS (
  SELECT 1 FROM generation_jobs g
  WHERE lower(g.requested_by) = lower(u.username)
);

INSERT OR IGNORE INTO user_roles (user_id, role, granted_by_user_id, source, note, granted_at)
SELECT u.id, 'admin', NULL, 'bootstrap_fallback', 'fallback first non-guest user',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users u
WHERE u.is_guest = 0
  AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role = 'admin')
ORDER BY u.id ASC
LIMIT 1;
