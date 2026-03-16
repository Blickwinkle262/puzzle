CREATE TABLE IF NOT EXISTS llm_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider_kind TEXT NOT NULL DEFAULT 'compatible' CHECK (provider_kind IN ('compatible')),
  api_base_url TEXT NOT NULL DEFAULT '',
  proxy_url TEXT NOT NULL DEFAULT '',
  no_proxy_hosts TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  owner_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_providers_enabled_updated
  ON llm_providers(enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS llm_provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  key_source TEXT NOT NULL DEFAULT 'env' CHECK (key_source IN ('env', 'custom')),
  env_key_name TEXT NOT NULL DEFAULT '',
  encrypted_key TEXT NOT NULL DEFAULT '',
  key_last4 TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (provider_id) REFERENCES llm_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_provider_keys_provider_active
  ON llm_provider_keys(provider_id, is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS llm_provider_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  model_type TEXT NOT NULL DEFAULT 'text' CHECK (model_type IN ('text', 'image', 'summary')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider_id, model_id, model_type),
  FOREIGN KEY (provider_id) REFERENCES llm_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_provider_models_provider_type
  ON llm_provider_models(provider_id, model_type, fetched_at DESC);

CREATE TABLE IF NOT EXISTS llm_user_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  provider_id INTEGER NOT NULL,
  story_prompt_model TEXT NOT NULL DEFAULT '',
  text2image_model TEXT NOT NULL DEFAULT '',
  summary_model TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('global', 'user')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES llm_providers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_user_profiles_user_scope_default
  ON llm_user_profiles(user_id, scope)
  WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  provider_id INTEGER,
  action TEXT NOT NULL,
  diff_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(diff_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (provider_id) REFERENCES llm_providers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_provider_created
  ON llm_audit_logs(provider_id, created_at DESC);

ALTER TABLE generation_jobs
  ADD COLUMN effective_provider_id INTEGER REFERENCES llm_providers(id) ON DELETE SET NULL;

ALTER TABLE generation_jobs
  ADD COLUMN effective_model_snapshot TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(effective_model_snapshot));

CREATE INDEX IF NOT EXISTS idx_generation_jobs_effective_provider
  ON generation_jobs(effective_provider_id, created_at DESC);
