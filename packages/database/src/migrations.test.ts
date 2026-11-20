import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listAppliedMigrations,
  listUserTables,
  loadMigrations,
  migrateDatabase,
  openDatabase,
  openMemoryDatabase,
  type SqliteDatabase,
} from "./index.js";

const CORE = [
  "datasets",
  "data_sources",
  "conversations",
  "contacts",
  "contact_identifiers",
  "conversation_participants",
  "messages",
  "message_reactions",
  "provenance_records",
  "import_batches",
  "sync_state",
  "sync_checkpoints",
  "app_settings",
  "annotations",
];
const ANALYTICS = ["analytics_daily", "analytics_hourly"];
const IDENTITY = [
  "contact_merges",
  "message_provenance",
  "import_checkpoints",
  "import_batch_contacts",
  "import_batch_conversations",
];
const MEDIA = [
  "media_assets",
  "media_references",
  "external_media_links",
  "story_projects",
  "story_chapters",
  "story_chapter_items",
  "soundtrack_tracks",
  "movie_exports",
];

describe("migrations", () => {
  const dirs: string[] = [];
  const dbs: SqliteDatabase[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads four ordered, checksummed migration files", () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => [m.version, m.name])).toEqual([
      [1, "core_sync"],
      [2, "analytics"],
      [3, "media_storytelling"],
      [4, "identity_ingestion"],
    ]);
    expect(new Set(migrations.map((m) => m.checksum)).size).toBe(4);
  });

  it("creates exactly the 29 canonical tables", () => {
    const db = openMemoryDatabase();
    dbs.push(db);
    const tables = listUserTables(db);
    expect(tables).toHaveLength(29);
    expect(tables).toEqual([...CORE, ...ANALYTICS, ...MEDIA, ...IDENTITY].sort());
  });

  it("records versions and is idempotent on re-run", () => {
    const db = openMemoryDatabase();
    dbs.push(db);
    expect(listAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4]);
    expect(migrateDatabase(db)).toBe(0);
    expect(listAppliedMigrations(db)).toHaveLength(4);
  });

  it("rejects edited migrations and databases newer than the app", () => {
    const db = openMemoryDatabase();
    dbs.push(db);
    db.prepare("UPDATE schema_migrations SET checksum = 'x' WHERE version = 2").run();
    expect(() => migrateDatabase(db)).toThrow("migration_checksum_mismatch:2");
    db.prepare("UPDATE schema_migrations SET checksum = 'x' WHERE version = 2").run();
    db.prepare("INSERT INTO schema_migrations VALUES (99, 'future', 'now', 'x')").run();
    expect(() => migrateDatabase(db, loadMigrations())).toThrow(
      "database_schema_newer_than_app:99",
    );
  });

  it("applies WAL, foreign keys and busy_timeout on file databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "se-db-"));
    dirs.push(dir);
    const db = openDatabase({ filePath: join(dir, "explorer.sqlite"), busyTimeoutMs: 1234 });
    dbs.push(db);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(1234);
  });

  it("enforces foreign keys and check constraints", () => {
    const db = openMemoryDatabase();
    dbs.push(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO data_sources VALUES ('s', 'missing', 'whatsapp', 'whatsapp-zip', 'l', 't')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/u);
    expect(() =>
      db.prepare("INSERT INTO datasets VALUES ('d', '', 't', 'UTC', NULL, NULL)").run(),
    ).toThrow(/CHECK/u);
  });
});
