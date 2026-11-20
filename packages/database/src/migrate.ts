import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./open.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
  readonly checksum: string;
}

const MIGRATION_FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/u;

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/", import.meta.url));

export function loadMigrations(directory: string = MIGRATIONS_DIRECTORY): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(directory).sort()) {
    const match = MIGRATION_FILE.exec(file);
    if (match === null) {
      continue;
    }
    const sql = readFileSync(`${directory}/${file}`, "utf8");
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? file,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new Error(`migration_sequence_gap:${String(migration.version)}`);
    }
  }
  return migrations;
}

export function listAppliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  const rows = db
    .prepare(
      "SELECT version, name, applied_at AS appliedAt, checksum FROM schema_migrations ORDER BY version",
    )
    .all() as AppliedMigration[];
  return rows;
}

export function migrateDatabase(
  db: SqliteDatabase,
  migrations: readonly Migration[] = loadMigrations(),
): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER NOT NULL PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum   TEXT NOT NULL
    ) STRICT;
  `);
  const applied = new Map(listAppliedMigrations(db).map((row) => [row.version, row]));
  const latestKnown = migrations.at(-1)?.version ?? 0;
  for (const version of applied.keys()) {
    if (version > latestKnown) {
      throw new Error(`database_schema_newer_than_app:${String(version)}`);
    }
  }

  let count = 0;
  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing !== undefined) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(`migration_checksum_mismatch:${String(migration.version)}`);
      }
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString(), migration.checksum);
    })();
    count += 1;
  }
  return count;
}

export function listUserTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}
