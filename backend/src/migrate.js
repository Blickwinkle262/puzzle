import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");
const DEFAULT_DB_PATH = path.join(ROOT_DIR, "backend", "data", "puzzle.sqlite");
const DEFAULT_MIGRATIONS_DIR = path.join(ROOT_DIR, "backend", "migrations");

function nowIso() {
  return new Date().toISOString();
}

function parseMigrationMeta(fileName) {
  const baseName = fileName.replace(/\.sql$/i, "");
  const underscoreIndex = baseName.indexOf("_");

  if (underscoreIndex <= 0) {
    return {
      version: baseName,
      description: baseName,
    };
  }

  const version = baseName.slice(0, underscoreIndex);
  const description = baseName.slice(underscoreIndex + 1).replace(/_/g, " ");

  return {
    version,
    description,
  };
}

function listMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  return fs
    .readdirSync(migrationsDir)
    .filter((fileName) => /^\d+_[\w-]+\.sql$/i.test(fileName))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

function resolveLogger(logger) {
  if (logger && typeof logger.info === "function" && typeof logger.warn === "function") {
    return logger;
  }

  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
  };
}

export function runMigrations(database, options = {}) {
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const logger = resolveLogger(options.logger);

  ensureMigrationTable(database);

  const migrationFiles = listMigrationFiles(migrationsDir);
  if (migrationFiles.length === 0) {
    logger.warn(`[migrate] no migration files found in ${migrationsDir}`);
    return { applied: [], skipped: [] };
  }

  const appliedVersions = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => String(row.version)),
  );

  const applyMigration = database.transaction((meta, sqlText) => {
    if (sqlText.trim()) {
      database.exec(sqlText);
    }

    database
      .prepare("INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)")
      .run(meta.version, meta.description, nowIso());
  });

  const applied = [];
  const skipped = [];

  for (const fileName of migrationFiles) {
    const meta = parseMigrationMeta(fileName);

    if (appliedVersions.has(meta.version)) {
      skipped.push(meta.version);
      continue;
    }

    const filePath = path.join(migrationsDir, fileName);
    const sqlText = fs.readFileSync(filePath, "utf-8");

    applyMigration(meta, sqlText);
    applied.push(meta.version);
    logger.info(`[migrate] applied ${meta.version} (${fileName})`);
  }

  return { applied, skipped };
}

export function runMigrationsFromDisk(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const logger = resolveLogger(options.logger);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");

  try {
    const result = runMigrations(database, { migrationsDir, logger });
    logger.info(
      `[migrate] done. applied=${result.applied.length}, skipped=${result.skipped.length}, db=${dbPath}`,
    );
    return result;
  } finally {
    database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    runMigrationsFromDisk();
  } catch (error) {
    console.error("[migrate] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
