import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

const DEFAULT_DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");
const DEFAULT_BOOKS_DB_PATH = path.join(ROOT_DIR, "scripts", "book_ingest", "data", "books.sqlite");

function nowIso() {
  return new Date().toISOString();
}

function toPositiveInteger(value) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return null;
  }
  return numberValue;
}

function toShortText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 160);
}

function safeParseJsonObject(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function ensureMetaBaseFromJobs(db) {
  const inserted = db
    .prepare(
      `
      INSERT OR IGNORE INTO generation_job_meta (
        run_id,
        requested_by_user_id,
        chapter_id,
        book_id,
        usage_id,
        result_story_id,
        job_kind,
        created_at,
        updated_at
      )
      SELECT
        g.run_id,
        (SELECT u.id FROM users u WHERE lower(u.username) = lower(g.requested_by) LIMIT 1),
        CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.chapter_id') AS INTEGER) ELSE NULL END,
        CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.book_id') AS INTEGER) ELSE NULL END,
        CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.usage_id') AS INTEGER) ELSE NULL END,
        CASE WHEN json_valid(g.payload_json) THEN CAST(json_extract(g.payload_json, '$.story_id') AS TEXT) ELSE NULL END,
        'story_generation',
        COALESCE(g.created_at, ?),
        COALESCE(g.updated_at, ?)
      FROM generation_jobs g
    `,
    )
    .run(nowIso(), nowIso()).changes;

  const updatedStoryId = db
    .prepare(
      `
      UPDATE generation_job_meta
      SET result_story_id = (
            SELECT CAST(json_extract(g.payload_json, '$.story_id') AS TEXT)
            FROM generation_jobs g
            WHERE g.run_id = generation_job_meta.run_id
          ),
          updated_at = ?
      WHERE COALESCE(result_story_id, '') = ''
        AND EXISTS (
          SELECT 1
          FROM generation_jobs g
          WHERE g.run_id = generation_job_meta.run_id
            AND json_valid(g.payload_json)
            AND COALESCE(CAST(json_extract(g.payload_json, '$.story_id') AS TEXT), '') <> ''
        )
    `,
    )
    .run(nowIso()).changes;

  return {
    inserted,
    updated_story_id_from_payload: updatedStoryId,
  };
}

function listUsageRows(booksDb) {
  return booksDb
    .prepare(
      `
      SELECT
        cu.pipeline_run_id AS run_id,
        cu.generated_story_id AS story_id,
        c.id AS chapter_id,
        c.book_id AS book_id,
        COALESCE(cu.updated_at, cu.created_at) AS updated_at
      FROM chapter_usage cu
      JOIN chapters c ON c.id = cu.chapter_id
      WHERE cu.usage_type = 'puzzle_story'
        AND cu.status = 'succeeded'
        AND COALESCE(cu.pipeline_run_id, '') <> ''
        AND COALESCE(cu.generated_story_id, '') <> ''
      ORDER BY COALESCE(cu.updated_at, cu.created_at) DESC, cu.id DESC
    `,
    )
    .all();
}

function backfillFromBooksUsage(db, booksDb) {
  const rows = listUsageRows(booksDb);
  if (rows.length === 0) {
    return {
      scanned: 0,
      linked: 0,
      skipped_missing_job: 0,
    };
  }

  const hasJobStmt = db.prepare("SELECT run_id, payload_json, created_at FROM generation_jobs WHERE run_id = ? LIMIT 1");
  const upsertStmt = db.prepare(
    `
    INSERT INTO generation_job_meta (
      run_id,
      requested_by_user_id,
      chapter_id,
      book_id,
      usage_id,
      result_story_id,
      job_kind,
      created_at,
      updated_at
    ) VALUES (?, NULL, ?, ?, NULL, ?, 'story_generation', ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      chapter_id = COALESCE(excluded.chapter_id, generation_job_meta.chapter_id),
      book_id = COALESCE(excluded.book_id, generation_job_meta.book_id),
      result_story_id = CASE
        WHEN COALESCE(excluded.result_story_id, '') <> '' THEN excluded.result_story_id
        ELSE generation_job_meta.result_story_id
      END,
      updated_at = excluded.updated_at
  `,
  );

  const tx = db.transaction((usageRows) => {
    let linked = 0;
    let skippedMissingJob = 0;

    for (const row of usageRows) {
      const runId = toShortText(String(row.run_id || ""));
      const storyId = toShortText(String(row.story_id || ""));
      if (!runId || !storyId) {
        continue;
      }

      const job = hasJobStmt.get(runId);
      if (!job) {
        skippedMissingJob += 1;
        continue;
      }

      const payload = safeParseJsonObject(job.payload_json);
      const chapterId = toPositiveInteger(row.chapter_id) || toPositiveInteger(payload.chapter_id);
      const bookId = toPositiveInteger(row.book_id) || toPositiveInteger(payload.book_id);
      const createdAt = toShortText(String(job.created_at || "")) || nowIso();
      const updatedAt = toShortText(String(row.updated_at || "")) || nowIso();

      upsertStmt.run(runId, chapterId, bookId, storyId, createdAt, updatedAt);
      linked += 1;
    }

    return {
      scanned: usageRows.length,
      linked,
      skipped_missing_job: skippedMissingJob,
    };
  });

  return tx(rows);
}

function main() {
  const dbPath = path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH);
  const booksDbPath = path.resolve(process.env.BOOK_INGEST_DB_PATH || DEFAULT_BOOKS_DB_PATH);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`puzzle db not found: ${dbPath}`);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  try {
    const hasMetaTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generation_job_meta' LIMIT 1")
      .get();
    if (!hasMetaTable) {
      console.log("[backfill] generation_job_meta not found, skip.");
      return;
    }

    const baseResult = ensureMetaBaseFromJobs(db);
    console.log("[backfill] base sync:", baseResult);

    if (!fs.existsSync(booksDbPath)) {
      console.log(`[backfill] books db not found, skip usage sync: ${booksDbPath}`);
      return;
    }

    const booksDb = new Database(booksDbPath, { readonly: true, fileMustExist: true });
    try {
      const usageResult = backfillFromBooksUsage(db, booksDb);
      console.log("[backfill] usage sync:", usageResult);
    } finally {
      booksDb.close();
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error("[backfill] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
