import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const DEFAULT_DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");
const DEFAULT_SUMMARY_DIR = path.join(ROOT_DIR, "backend", "data", "generated", "summaries", "story_generator");

function normalizeRunId(value) {
  if (typeof value !== "string") {
    return "";
  }
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) {
    return "";
  }
  return cleaned.slice(0, 80);
}

function normalizeTargetDate(value) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeReviewStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "pending_review" || text === "published") {
    return text;
  }
  return "";
}

function normalizeIsoTime(value) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.trim();
  return text ? text : "";
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

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return false;
}

function buildSummaryFileName(targetDate, runId) {
  return `story_${targetDate}_${runId}.json`;
}

function resolveSummarySource(currentPath, fallbackDatePath) {
  const current = String(currentPath || "").trim();
  if (current && fs.existsSync(current) && fs.statSync(current).isFile()) {
    return current;
  }

  if (fallbackDatePath && fs.existsSync(fallbackDatePath) && fs.statSync(fallbackDatePath).isFile()) {
    return fallbackDatePath;
  }

  return "";
}

function main() {
  const dbPath = path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH);
  const summaryDir = path.resolve(process.env.STORY_GENERATOR_SUMMARY_DIR || DEFAULT_SUMMARY_DIR);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`db not found: ${dbPath}`);
  }

  fs.mkdirSync(summaryDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  try {
    const columns = db.prepare("PRAGMA table_info(generation_jobs)").all();
    const hasReviewStatus = columns.some((column) => column.name === "review_status");
    const hasPublishedAt = columns.some((column) => column.name === "published_at");
    if (!hasReviewStatus || !hasPublishedAt) {
      throw new Error("generation_jobs 缺少 review_status/published_at，请先执行 migrate");
    }

    const rows = db
      .prepare(
        `
        SELECT id, run_id, status, target_date, dry_run, payload_json,
               summary_path, review_status, published_at, created_at
        FROM generation_jobs
        ORDER BY created_at ASC, id ASC
      `,
      )
      .all();

    const updateStmt = db.prepare(
      `
      UPDATE generation_jobs
      SET summary_path = ?,
          review_status = ?,
          published_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    );

    const now = new Date().toISOString();
    const tx = db.transaction((jobRows) => {
      const summaryPathUpdated = {
        copied: 0,
        rewritten: 0,
      };
      const reviewStateUpdated = {
        pending_review: 0,
        published: 0,
        cleared: 0,
      };

      for (const row of jobRows) {
        const payload = safeParseJsonObject(row.payload_json);
        const normalizedRunId = normalizeRunId(row.run_id) || `run_${String(row.id)}`;
        const normalizedDate = normalizeTargetDate(row.target_date)
          || normalizeTargetDate(String(row.created_at || "").slice(0, 10))
          || now.slice(0, 10);

        const currentSummaryPath = String(row.summary_path || "").trim();
        const summaryDirForJob = currentSummaryPath ? path.dirname(currentSummaryPath) : summaryDir;
        const nextSummaryPath = path.join(summaryDirForJob, buildSummaryFileName(normalizedDate, normalizedRunId));
        const fallbackDatePath = path.join(summaryDirForJob, `story_${normalizedDate}.json`);

        const summarySource = resolveSummarySource(currentSummaryPath, fallbackDatePath);
        if (summarySource && summarySource !== nextSummaryPath && !fs.existsSync(nextSummaryPath)) {
          fs.mkdirSync(path.dirname(nextSummaryPath), { recursive: true });
          fs.copyFileSync(summarySource, nextSummaryPath);
          summaryPathUpdated.copied += 1;
        }

        const effectiveSummaryPath = fs.existsSync(nextSummaryPath) ? nextSummaryPath : (summarySource || nextSummaryPath);
        if (effectiveSummaryPath !== currentSummaryPath) {
          summaryPathUpdated.rewritten += 1;
        }

        const summary = readJsonSafe(effectiveSummaryPath);
        const rawPublishedAt = normalizeIsoTime(summary?.publish?.published_at);
        const persistedPublishedAt = normalizeIsoTime(row.published_at);
        const reviewMode = !Boolean(row.dry_run) && toBoolean(payload.review_mode);

        let nextReviewStatus = normalizeReviewStatus(row.review_status);
        let nextPublishedAt = persistedPublishedAt || null;

        if (String(row.status || "") === "succeeded" && reviewMode) {
          if (rawPublishedAt || persistedPublishedAt) {
            nextReviewStatus = "published";
            nextPublishedAt = rawPublishedAt || persistedPublishedAt;
            reviewStateUpdated.published += nextReviewStatus !== normalizeReviewStatus(row.review_status) ? 1 : 0;
          } else {
            const wasStatus = nextReviewStatus;
            nextReviewStatus = "pending_review";
            nextPublishedAt = null;
            if (wasStatus !== "pending_review") {
              reviewStateUpdated.pending_review += 1;
            }
          }
        } else if (nextReviewStatus !== "published") {
          if (nextReviewStatus !== "") {
            reviewStateUpdated.cleared += 1;
          }
          nextReviewStatus = "";
          nextPublishedAt = null;
        }

        const shouldUpdate = effectiveSummaryPath !== currentSummaryPath
          || nextReviewStatus !== normalizeReviewStatus(row.review_status)
          || (nextPublishedAt || null) !== (persistedPublishedAt || null);

        if (!shouldUpdate) {
          continue;
        }

        updateStmt.run(effectiveSummaryPath, nextReviewStatus, nextPublishedAt, now, row.id);
      }

      return {
        total: jobRows.length,
        summary: summaryPathUpdated,
        review: reviewStateUpdated,
      };
    });

    const result = tx(rows);
    console.log("[backfill:review-state] done", result);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error("[backfill:review-state] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
