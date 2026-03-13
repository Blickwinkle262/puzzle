PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  source_path TEXT NOT NULL UNIQUE,
  source_format TEXT NOT NULL CHECK (source_format IN ('txt', 'epub')),
  language TEXT NOT NULL DEFAULT 'zh',
  genre TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  chapter_title TEXT NOT NULL,
  chapter_text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  used_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(book_id, chapter_index),
  UNIQUE(book_id, checksum)
);

CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_chapters_used ON chapters(used_count, last_used_at);
CREATE INDEX IF NOT EXISTS idx_chapters_genre_hint ON chapters(json_extract(meta_json, '$.genre_hint'));

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  source_format TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  total_chapters INTEGER NOT NULL DEFAULT 0,
  inserted_chapters INTEGER NOT NULL DEFAULT 0,
  updated_chapters INTEGER NOT NULL DEFAULT 0,
  skipped_chapters INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ingest_run_items (
  id INTEGER PRIMARY KEY,
  ingest_run_id INTEGER NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
  chapter_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('inserted', 'updated', 'skipped_duplicate', 'skipped_empty', 'error')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ingest_run_items_run_id ON ingest_run_items(ingest_run_id);

CREATE TABLE IF NOT EXISTS chapter_summary_runs (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('book', 'chapter')),
  scope_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  total_chapters INTEGER NOT NULL DEFAULT 0,
  processed_chapters INTEGER NOT NULL DEFAULT 0,
  succeeded_chapters INTEGER NOT NULL DEFAULT 0,
  failed_chapters INTEGER NOT NULL DEFAULT 0,
  skipped_chapters INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chapter_summary_runs_scope
  ON chapter_summary_runs(scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chapter_summary_run_items (
  id INTEGER PRIMARY KEY,
  summary_run_id INTEGER NOT NULL REFERENCES chapter_summary_runs(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  source_chars INTEGER NOT NULL DEFAULT 0,
  chunks_count INTEGER NOT NULL DEFAULT 0,
  summary_text TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(summary_run_id, chapter_id)
);

CREATE INDEX IF NOT EXISTS idx_chapter_summary_run_items_run
  ON chapter_summary_run_items(summary_run_id, status);

CREATE TABLE IF NOT EXISTS chapter_usage (
  id INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  usage_type TEXT NOT NULL DEFAULT 'puzzle_story',
  status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'released', 'expired')),
  reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  pipeline_run_id TEXT,
  generated_story_id TEXT,
  summary_path TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chapter_usage_lookup
  ON chapter_usage(chapter_id, usage_type, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_chapter_usage_succeeded_once
  ON chapter_usage(chapter_id, usage_type)
  WHERE status = 'succeeded';
