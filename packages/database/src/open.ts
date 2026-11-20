import Database from "better-sqlite3";
import { migrateDatabase } from "./migrate.js";

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** Absolute file path, or ":memory:" for tests. */
  readonly filePath: string;
  readonly readonly?: boolean;
  readonly busyTimeoutMs?: number;
  /** Skip running pending migrations (migrations always skipped when readonly). */
  readonly skipMigrations?: boolean;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const readonly = options.readonly ?? false;
  const db = new Database(options.filePath, { readonly, fileMustExist: readonly });
  db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
  db.pragma("foreign_keys = ON");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  if (!readonly && options.skipMigrations !== true) {
    migrateDatabase(db);
  }
  return db;
}

export function openMemoryDatabase(): SqliteDatabase {
  return openDatabase({ filePath: ":memory:" });
}
