import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const DEFAULT_DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");

function nowIso() {
  return new Date().toISOString();
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

function safeParseJsonArray(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizePositiveInteger(value) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return null;
  }
  return numberValue;
}

function normalizeShortText(value, limit = 4000) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value).trim();
  if (!text) {
    return "";
  }
  return text.slice(0, limit);
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }
  return false;
}

function normalizeImageStatus(value) {
  const text = normalizeShortText(value, 40).toLowerCase();
  if (text === "success" || text === "failed" || text === "skipped" || text === "queued" || text === "running") {
    return text;
  }
  return "pending";
}

function normalizeAttemptStatus(value) {
  const text = normalizeShortText(value, 40).toLowerCase();
  if (text === "queued" || text === "running" || text === "succeeded" || text === "failed" || text === "cancelled") {
    return text;
  }
  return "queued";
}

function normalizeCharacters(value) {
  const input = Array.isArray(value) ? value : [];
  return input
    .map((item) => normalizeShortText(item, 120))
    .filter((item) => item.length > 0)
    .slice(0, 30);
}

function normalizeGridValue(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 20) {
    return fallback;
  }
  return parsed;
}

function normalizeTimeLimit(value, fallback = 180) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 30 || parsed > 3600) {
    return fallback;
  }
  return parsed;
}

function deriveTextStatus(scene) {
  if (scene.deleted_at) {
    return "deleted";
  }
  if (normalizeShortText(scene.error_message)) {
    return "failed";
  }
  if (normalizeShortText(scene.title) || normalizeShortText(scene.story_text) || normalizeShortText(scene.image_prompt)) {
    return "ready";
  }
  return "pending";
}

function deriveFlowStage(job) {
  const status = normalizeShortText(job.status, 30).toLowerCase();
  const reviewStatus = normalizeShortText(job.review_status, 40).toLowerCase();

  if (status === "queued") {
    return "queued";
  }
  if (status === "running") {
    return "images_generating";
  }
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (status === "succeeded" && reviewStatus === "published") {
    return "published";
  }
  if (status === "succeeded" && reviewStatus === "pending_review") {
    return "review_ready";
  }
  if (status === "succeeded") {
    return "completed";
  }

  return "";
}

function readSummaryCandidates(summaryPath) {
  const summaryFile = normalizeShortText(summaryPath, 800);
  if (!summaryFile || !fs.existsSync(summaryFile)) {
    return [];
  }

  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(summaryFile, "utf-8"));
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.candidates)) {
    return [];
  }

  return payload.candidates
    .map((item, index) => {
      const fallbackIndex = index + 1;
      const sceneIndex = normalizePositiveInteger(item?.scene_index) || fallbackIndex;

      return {
        run_id: "",
        scene_index: sceneIndex,
        scene_id: normalizePositiveInteger(item?.scene_id),
        title: normalizeShortText(item?.title, 500),
        description: normalizeShortText(item?.description, 1000),
        story_text: normalizeShortText(item?.story_text, 20000),
        image_prompt: normalizeShortText(item?.image_prompt, 12000),
        mood: normalizeShortText(item?.mood, 200),
        characters: normalizeCharacters(item?.characters),
        grid_rows: normalizeGridValue(item?.grid_rows, 6),
        grid_cols: normalizeGridValue(item?.grid_cols, 4),
        time_limit_sec: normalizeTimeLimit(item?.time_limit_sec, 180),
        image_status: normalizeImageStatus(item?.image_status),
        image_url: normalizeShortText(item?.image_url, 1600),
        image_path: normalizeShortText(item?.image_path, 1600),
        error_message: normalizeShortText(item?.error_message, 4000),
        selected: item?.selected === undefined
          ? normalizeImageStatus(item?.image_status) === "success"
          : normalizeBoolean(item?.selected),
        created_at: null,
        updated_at: null,
      };
    })
    .filter((item) => Number.isInteger(item.scene_index) && item.scene_index > 0);
}

function main() {
  const dbPath = path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`db not found: ${dbPath}`);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  try {
    const hasScenes = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generation_job_scenes' LIMIT 1")
      .get();
    const hasAttempts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generation_job_scene_image_attempts' LIMIT 1")
      .get();

    if (!hasScenes || !hasAttempts) {
      throw new Error("缺少 generation_job_scenes / generation_job_scene_image_attempts，请先执行 migrate");
    }

    const jobs = db
      .prepare(
        `
        SELECT run_id, status, review_status, dry_run, payload_json, summary_path, created_at, updated_at, flow_stage
        FROM generation_jobs
        ORDER BY created_at ASC, id ASC
      `,
      )
      .all();

    const selectLegacyCandidates = db.prepare(
      `
      SELECT run_id, scene_index, scene_id, title, description, story_text,
             image_prompt, mood, characters_json, grid_rows, grid_cols,
             time_limit_sec, image_status, image_url, image_path,
             error_message, selected, created_at, updated_at
      FROM generation_job_level_candidates
      WHERE run_id = ?
      ORDER BY scene_index ASC
    `,
    );

    const selectLegacyRetries = db.prepare(
      `
      SELECT id, run_id, scene_index, status, error_message,
             created_at, started_at, ended_at, updated_at
      FROM generation_candidate_image_retries
      WHERE run_id = ?
      ORDER BY scene_index ASC, created_at ASC, id ASC
    `,
    );

    const insertScene = db.prepare(
      `
      INSERT OR IGNORE INTO generation_job_scenes (
        run_id,
        scene_index,
        scene_id,
        title,
        description,
        story_text,
        image_prompt,
        mood,
        characters_json,
        grid_rows,
        grid_cols,
        time_limit_sec,
        text_status,
        image_status,
        image_url,
        image_path,
        error_message,
        selected,
        deleted_at,
        source_kind,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );

    const insertAttempt = db.prepare(
      `
      INSERT OR IGNORE INTO generation_job_scene_image_attempts (
        run_id,
        scene_index,
        attempt_no,
        status,
        provider,
        model,
        image_prompt,
        image_url,
        image_path,
        error_message,
        latency_ms,
        created_at,
        started_at,
        ended_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );

    const updateFlowStage = db.prepare(
      `
      UPDATE generation_jobs
      SET flow_stage = ?,
          updated_at = ?
      WHERE run_id = ?
        AND COALESCE(flow_stage, '') = ''
    `,
    );

    const tx = db.transaction((jobRows) => {
      const counters = {
        jobs: Number(jobRows.length || 0),
        scene_inserted: 0,
        attempt_inserted: 0,
        flow_stage_updated: 0,
        from_level_candidates: 0,
        from_summary: 0,
      };

      for (const job of jobRows) {
        const runId = normalizeShortText(job.run_id, 160);
        if (!runId) {
          continue;
        }

        const payload = safeParseJsonObject(job.payload_json);
        const imageModel = normalizeShortText(payload.image_model || "", 200);
        const now = nowIso();
        const sceneCreatedAt = normalizeShortText(job.created_at, 40) || now;
        const sceneUpdatedAt = normalizeShortText(job.updated_at, 40) || now;

        const legacyRows = selectLegacyCandidates.all(runId);
        const normalizedLegacyRows = legacyRows.map((row) => ({
          run_id: runId,
          scene_index: normalizePositiveInteger(row.scene_index),
          scene_id: normalizePositiveInteger(row.scene_id),
          title: normalizeShortText(row.title, 500),
          description: normalizeShortText(row.description, 1000),
          story_text: normalizeShortText(row.story_text, 20000),
          image_prompt: normalizeShortText(row.image_prompt, 12000),
          mood: normalizeShortText(row.mood, 200),
          characters: normalizeCharacters(safeParseJsonArray(row.characters_json)),
          grid_rows: normalizeGridValue(row.grid_rows, 6),
          grid_cols: normalizeGridValue(row.grid_cols, 4),
          time_limit_sec: normalizeTimeLimit(row.time_limit_sec, 180),
          image_status: normalizeImageStatus(row.image_status),
          image_url: normalizeShortText(row.image_url, 1600),
          image_path: normalizeShortText(row.image_path, 1600),
          error_message: normalizeShortText(row.error_message, 4000),
          selected: normalizeBoolean(row.selected),
          created_at: normalizeShortText(row.created_at, 40) || sceneCreatedAt,
          updated_at: normalizeShortText(row.updated_at, 40) || sceneUpdatedAt,
        }))
          .filter((row) => Number.isInteger(row.scene_index) && row.scene_index > 0);

        const sceneRows = normalizedLegacyRows.length > 0
          ? normalizedLegacyRows
          : readSummaryCandidates(job.summary_path).map((item) => ({
            ...item,
            run_id: runId,
            created_at: sceneCreatedAt,
            updated_at: sceneUpdatedAt,
          }));

        if (normalizedLegacyRows.length > 0) {
          counters.from_level_candidates += 1;
        } else if (sceneRows.length > 0) {
          counters.from_summary += 1;
        }

        const sceneMetaByIndex = new Map();

        for (const scene of sceneRows) {
          const textStatus = deriveTextStatus(scene);
          const imageStatus = normalizeImageStatus(scene.image_status);
          const selected = scene.selected && imageStatus === "success";
          const result = insertScene.run(
            runId,
            scene.scene_index,
            scene.scene_id,
            scene.title,
            scene.description,
            scene.story_text,
            scene.image_prompt,
            scene.mood,
            JSON.stringify(scene.characters),
            scene.grid_rows,
            scene.grid_cols,
            scene.time_limit_sec,
            textStatus,
            imageStatus,
            scene.image_url,
            scene.image_path,
            scene.error_message,
            selected ? 1 : 0,
            null,
            normalizedLegacyRows.length > 0 ? "legacy" : "summary",
            scene.created_at || sceneCreatedAt,
            scene.updated_at || sceneUpdatedAt,
          );
          counters.scene_inserted += Number(result?.changes || 0);
          sceneMetaByIndex.set(scene.scene_index, {
            image_status: imageStatus,
            image_prompt: scene.image_prompt,
            image_url: scene.image_url,
            image_path: scene.image_path,
            error_message: scene.error_message,
          });
        }

        const retries = selectLegacyRetries.all(runId);
        const retriesByScene = new Map();
        for (const retry of retries) {
          const sceneIndex = normalizePositiveInteger(retry.scene_index);
          if (!sceneIndex) {
            continue;
          }
          const bucket = retriesByScene.get(sceneIndex) || [];
          bucket.push(retry);
          retriesByScene.set(sceneIndex, bucket);
        }

        for (const [sceneIndex, meta] of sceneMetaByIndex.entries()) {
          const terminalImage = meta.image_status === "success" || meta.image_status === "failed" || meta.image_status === "skipped";
          let baseAttemptNo = 0;

          if (terminalImage) {
            baseAttemptNo = 1;
            const baseAttemptStatus = meta.image_status === "success" ? "succeeded" : "failed";
            const inserted = insertAttempt.run(
              runId,
              sceneIndex,
              baseAttemptNo,
              baseAttemptStatus,
              "legacy",
              imageModel,
              meta.image_prompt,
              meta.image_url,
              meta.image_path,
              meta.error_message,
              null,
              sceneCreatedAt,
              null,
              sceneUpdatedAt,
              sceneUpdatedAt,
            );
            counters.attempt_inserted += Number(inserted?.changes || 0);
          }

          const retryRows = retriesByScene.get(sceneIndex) || [];
          let attemptNo = baseAttemptNo;
          for (const retry of retryRows) {
            attemptNo += 1;
            const inserted = insertAttempt.run(
              runId,
              sceneIndex,
              attemptNo,
              normalizeAttemptStatus(retry.status),
              "legacy_retry",
              imageModel,
              meta.image_prompt,
              "",
              "",
              normalizeShortText(retry.error_message, 4000),
              null,
              normalizeShortText(retry.created_at, 40) || sceneCreatedAt,
              normalizeShortText(retry.started_at, 40) || null,
              normalizeShortText(retry.ended_at, 40) || null,
              normalizeShortText(retry.updated_at, 40) || sceneUpdatedAt,
            );
            counters.attempt_inserted += Number(inserted?.changes || 0);
          }
        }

        const flowStage = deriveFlowStage(job);
        if (flowStage) {
          const updated = updateFlowStage.run(flowStage, now, runId);
          counters.flow_stage_updated += Number(updated?.changes || 0);
        }
      }

      return counters;
    });

    const result = tx(jobs);
    console.log("[backfill:generation-scenes-v2] done", result);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error("[backfill:generation-scenes-v2] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
