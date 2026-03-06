import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { runMigrations } from "./migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const DEFAULT_DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");

function parseArgs(argv) {
  const options = {
    dbPath: "",
    strict: false,
    skipBackfill: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();

    if (arg === "--strict") {
      options.strict = true;
      continue;
    }

    if (arg === "--skip-backfill") {
      options.skipBackfill = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--db" || arg === "--db-path") {
      const next = String(argv[index + 1] || "").trim();
      if (!next) {
        throw new Error(`${arg} requires a value`);
      }
      options.dbPath = path.resolve(next);
      index += 1;
      continue;
    }

    throw new Error(`unsupported arg: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node src/upgrade-generation-scene-first.js [options]\n\nOptions:\n  --db, --db-path <path>   sqlite file path (default: env DB_PATH or backend/data/puzzle.sqlite)\n  --skip-backfill          only run migrations, skip legacy backfill\n  --strict                 exit with code 1 when consistency checks fail\n  -h, --help               show this help\n`);
}

function normalizeDbPath(explicitDbPath) {
  if (explicitDbPath) {
    return explicitDbPath;
  }

  const envDbPath = String(process.env.DB_PATH || "").trim();
  if (envDbPath) {
    return path.resolve(envDbPath);
  }

  return path.resolve(DEFAULT_DB_PATH);
}

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

function runBackfillScript(scriptName, dbPath) {
  const scriptPath = path.join(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`backfill script not found: ${scriptPath}`);
  }

  console.log(`[upgrade] running ${scriptName}`);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      DB_PATH: dbPath,
    },
    encoding: "utf-8",
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error(`script failed: ${scriptName} (exit=${result.status})`);
  }
}

function queryGroupedCounts(db, sql, keyName) {
  return db.prepare(sql).all().map((row) => ({
    [keyName]: String(row[keyName] || "").trim() || "(empty)",
    count: Number(row.count || 0),
  }));
}

function collectReport(db) {
  const report = {
    jobs_total: Number(db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get()?.count || 0),
    jobs_without_scenes: Number(
      db.prepare(
        `
        SELECT COUNT(*) AS count
        FROM generation_jobs j
        WHERE NOT EXISTS (
          SELECT 1
          FROM generation_job_scenes s
          WHERE s.run_id = j.run_id
        )
      `,
      ).get()?.count || 0,
    ),
    orphan_scenes: Number(
      db.prepare(
        `
        SELECT COUNT(*) AS count
        FROM generation_job_scenes s
        LEFT JOIN generation_jobs j ON j.run_id = s.run_id
        WHERE j.run_id IS NULL
      `,
      ).get()?.count || 0,
    ),
    orphan_attempts: Number(
      db.prepare(
        `
        SELECT COUNT(*) AS count
        FROM generation_job_scene_image_attempts a
        LEFT JOIN generation_job_scenes s
          ON s.run_id = a.run_id
         AND s.scene_index = a.scene_index
        WHERE s.run_id IS NULL
      `,
      ).get()?.count || 0,
    ),
    scenes_total: Number(db.prepare("SELECT COUNT(*) AS count FROM generation_job_scenes").get()?.count || 0),
    scene_attempts_total: Number(
      db.prepare("SELECT COUNT(*) AS count FROM generation_job_scene_image_attempts").get()?.count || 0,
    ),
    flow_stage_distribution: queryGroupedCounts(
      db,
      `SELECT COALESCE(flow_stage, '') AS flow_stage, COUNT(*) AS count FROM generation_jobs GROUP BY COALESCE(flow_stage, '') ORDER BY count DESC, flow_stage ASC`,
      "flow_stage",
    ),
    review_status_distribution: queryGroupedCounts(
      db,
      `SELECT COALESCE(review_status, '') AS review_status, COUNT(*) AS count FROM generation_jobs GROUP BY COALESCE(review_status, '') ORDER BY count DESC, review_status ASC`,
      "review_status",
    ),
    job_status_distribution: queryGroupedCounts(
      db,
      `SELECT COALESCE(status, '') AS status, COUNT(*) AS count FROM generation_jobs GROUP BY COALESCE(status, '') ORDER BY count DESC, status ASC`,
      "status",
    ),
    scene_text_status_distribution: queryGroupedCounts(
      db,
      `SELECT COALESCE(text_status, '') AS text_status, COUNT(*) AS count FROM generation_job_scenes GROUP BY COALESCE(text_status, '') ORDER BY count DESC, text_status ASC`,
      "text_status",
    ),
    scene_image_status_distribution: queryGroupedCounts(
      db,
      `SELECT COALESCE(image_status, '') AS image_status, COUNT(*) AS count FROM generation_job_scenes GROUP BY COALESCE(image_status, '') ORDER BY count DESC, image_status ASC`,
      "image_status",
    ),
  };

  report.sample_runs_without_scenes = db
    .prepare(
      `
      SELECT run_id, status, review_status, flow_stage, created_at
      FROM generation_jobs j
      WHERE NOT EXISTS (
        SELECT 1
        FROM generation_job_scenes s
        WHERE s.run_id = j.run_id
      )
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `,
    )
    .all()
    .map((row) => ({
      run_id: String(row.run_id || ""),
      status: String(row.status || ""),
      review_status: String(row.review_status || ""),
      flow_stage: String(row.flow_stage || ""),
      created_at: String(row.created_at || ""),
    }));

  return report;
}

function hasRequiredTables(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name || "")),
  );

  return (
    tables.has("generation_jobs")
    && tables.has("generation_job_scenes")
    && tables.has("generation_job_scene_image_attempts")
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = normalizeDbPath(options.dbPath);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`db not found: ${dbPath}`);
  }

  console.log(`[upgrade] database: ${dbPath}`);

  const migrationDb = openDb(dbPath);
  try {
    const migrationResult = runMigrations(migrationDb, { logger: console });
    console.log(
      `[upgrade] migrations done. applied=${migrationResult.applied.length}, skipped=${migrationResult.skipped.length}`,
    );
  } finally {
    migrationDb.close();
  }

  if (!options.skipBackfill) {
    runBackfillScript("backfill-generation-review-state.js", dbPath);
    runBackfillScript("backfill-generation-scenes-v2.js", dbPath);
  } else {
    console.log("[upgrade] skip backfill by --skip-backfill");
  }

  const reportDb = openDb(dbPath);
  try {
    if (!hasRequiredTables(reportDb)) {
      throw new Error("required tables not found after migration");
    }

    const report = collectReport(reportDb);
    console.log("[upgrade] consistency report:");
    console.log(JSON.stringify(report, null, 2));

    const hasCriticalIssue = report.orphan_scenes > 0 || report.orphan_attempts > 0;
    if (hasCriticalIssue && options.strict) {
      throw new Error("strict mode failed: orphan records detected");
    }

    if (report.jobs_without_scenes > 0) {
      console.warn(
        `[upgrade] warning: ${report.jobs_without_scenes} generation_jobs still have no scenes. Check sample_runs_without_scenes.`,
      );
    }
  } finally {
    reportDb.close();
  }

  console.log("[upgrade] generation scene-first upgrade completed");
}

try {
  main();
} catch (error) {
  console.error("[upgrade] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
