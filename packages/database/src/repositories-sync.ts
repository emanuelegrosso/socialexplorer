import type { SqliteDatabase } from "./open.js";
import { nn, stripUndefined } from "./util.js";

export type SyncStatus = "idle" | "syncing" | "partial" | "complete" | "error" | "logged-out";

export interface SyncState {
  readonly sourceId: string;
  readonly datasetId: string;
  readonly status: SyncStatus;
  readonly lastSyncAt?: string;
  readonly lastErrorCode?: string;
  readonly coverageStart?: string;
  readonly coverageEnd?: string;
  readonly partialWarning?: string;
  readonly updatedAt: string;
}

export interface SyncCheckpoint {
  readonly sourceId: string;
  readonly kind: string;
  readonly cursor: unknown;
  readonly updatedAt: string;
}

interface SyncStateRow {
  source_id: string;
  dataset_id: string;
  status: SyncStatus;
  last_sync_at: string | null;
  last_error_code: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  partial_warning: string | null;
  updated_at: string;
}

export function createSyncRepository(db: SqliteDatabase) {
  const upsertState = db.prepare(`
    INSERT INTO sync_state (source_id, dataset_id, status, last_sync_at, last_error_code,
      coverage_start, coverage_end, partial_warning, updated_at)
    VALUES (@sourceId, @datasetId, @status, @lastSyncAt, @lastErrorCode,
      @coverageStart, @coverageEnd, @partialWarning, @updatedAt)
    ON CONFLICT (source_id) DO UPDATE SET status = excluded.status, last_sync_at = excluded.last_sync_at,
      last_error_code = excluded.last_error_code, coverage_start = excluded.coverage_start,
      coverage_end = excluded.coverage_end, partial_warning = excluded.partial_warning,
      updated_at = excluded.updated_at`);
  const getState = db.prepare("SELECT * FROM sync_state WHERE source_id = ?");
  const upsertCheckpoint = db.prepare(`
    INSERT INTO sync_checkpoints (source_id, kind, cursor_json, updated_at)
    VALUES (@sourceId, @kind, @cursorJson, @updatedAt)
    ON CONFLICT (source_id, kind) DO UPDATE SET cursor_json = excluded.cursor_json,
      updated_at = excluded.updated_at`);
  const getCheckpoint = db.prepare(
    "SELECT source_id, kind, cursor_json, updated_at FROM sync_checkpoints WHERE source_id = ? AND kind = ?",
  );
  const listCheckpoints = db.prepare(
    "SELECT source_id, kind, cursor_json, updated_at FROM sync_checkpoints WHERE source_id = ? ORDER BY kind",
  );
  const removeCheckpoint = db.prepare(
    "DELETE FROM sync_checkpoints WHERE source_id = ? AND kind = ?",
  );

  interface CheckpointRow {
    source_id: string;
    kind: string;
    cursor_json: string;
    updated_at: string;
  }
  const mapCheckpoint = (row: CheckpointRow): SyncCheckpoint => ({
    sourceId: row.source_id,
    kind: row.kind,
    cursor: JSON.parse(row.cursor_json) as unknown,
    updatedAt: row.updated_at,
  });

  return {
    upsertState(state: SyncState): void {
      upsertState.run({
        sourceId: state.sourceId,
        datasetId: state.datasetId,
        status: state.status,
        lastSyncAt: state.lastSyncAt ?? null,
        lastErrorCode: state.lastErrorCode ?? null,
        coverageStart: state.coverageStart ?? null,
        coverageEnd: state.coverageEnd ?? null,
        partialWarning: state.partialWarning ?? null,
        updatedAt: state.updatedAt,
      });
    },
    getState(sourceId: string): SyncState | undefined {
      const row = getState.get(sourceId) as SyncStateRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return stripUndefined({
        sourceId: row.source_id,
        datasetId: row.dataset_id,
        status: row.status,
        lastSyncAt: nn(row.last_sync_at),
        lastErrorCode: nn(row.last_error_code),
        coverageStart: nn(row.coverage_start),
        coverageEnd: nn(row.coverage_end),
        partialWarning: nn(row.partial_warning),
        updatedAt: row.updated_at,
      }) as SyncState;
    },
    upsertCheckpoint(checkpoint: SyncCheckpoint): void {
      upsertCheckpoint.run({
        sourceId: checkpoint.sourceId,
        kind: checkpoint.kind,
        cursorJson: JSON.stringify(checkpoint.cursor),
        updatedAt: checkpoint.updatedAt,
      });
    },
    getCheckpoint(sourceId: string, kind: string): SyncCheckpoint | undefined {
      const row = getCheckpoint.get(sourceId, kind) as CheckpointRow | undefined;
      return row === undefined ? undefined : mapCheckpoint(row);
    },
    listCheckpoints(sourceId: string): SyncCheckpoint[] {
      return (listCheckpoints.all(sourceId) as CheckpointRow[]).map(mapCheckpoint);
    },
    deleteCheckpoint(sourceId: string, kind: string): boolean {
      return removeCheckpoint.run(sourceId, kind).changes > 0;
    },
  };
}

export function createSettingsRepository(db: SqliteDatabase) {
  const set = db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`);
  const get = db.prepare("SELECT value_json FROM app_settings WHERE key = ?");
  const all = db.prepare("SELECT key, value_json FROM app_settings ORDER BY key");
  const remove = db.prepare("DELETE FROM app_settings WHERE key = ?");
  return {
    set(key: string, value: unknown, now: string = new Date().toISOString()): void {
      set.run(key, JSON.stringify(value), now);
    },
    get(key: string): unknown {
      const row = get.get(key) as { value_json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.value_json) as unknown);
    },
    getAll(): Record<string, unknown> {
      const rows = all.all() as { key: string; value_json: string }[];
      return Object.fromEntries(
        rows.map((row) => [row.key, JSON.parse(row.value_json) as unknown]),
      );
    },
    delete(key: string): boolean {
      return remove.run(key).changes > 0;
    },
  };
}
