import type { SqliteDatabase } from "@social-explorer/database";
import { aggregateDaily, aggregateHourly } from "./aggregate.js";
import { loadMessageFacts, type MessageFact } from "./facts.js";

/** Bump when aggregation semantics change; stale versions are rebuilt on demand. */
export const ANALYTICS_VERSION = 1;
const SETTINGS_KEY = "analytics.version";

export interface RebuildResult {
  readonly datasetId: string;
  readonly daily: number;
  readonly hourly: number;
  readonly messages: number;
  readonly version: number;
}

function versionKey(datasetId: string): string {
  return `${SETTINGS_KEY}:${datasetId}`;
}

/**
 * Rebuilds `analytics_daily` / `analytics_hourly` for one dataset from committed canonical
 * messages. Fully derived and idempotent: running it twice yields identical tables.
 */
export function rebuildAnalyticsTables(
  db: SqliteDatabase,
  datasetId: string,
  options: { readonly now?: string; readonly facts?: readonly MessageFact[] } = {},
): RebuildResult {
  const now = options.now ?? new Date().toISOString();
  const facts = options.facts ?? loadMessageFacts(db, datasetId);
  const daily = aggregateDaily(facts);
  const hourly = aggregateHourly(facts);
  db.transaction(() => {
    db.prepare("DELETE FROM analytics_daily WHERE dataset_id = ?").run(datasetId);
    db.prepare("DELETE FROM analytics_hourly WHERE dataset_id = ?").run(datasetId);
    const insertDaily = db.prepare(
      `INSERT INTO analytics_daily (dataset_id, conversation_id, sender_key, date_local,
         message_count, attachment_count, character_count, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const bucket of daily) {
      insertDaily.run(datasetId, bucket.conversationId, bucket.senderKey, bucket.dateLocal,
        bucket.messageCount, bucket.attachmentCount, bucket.characterCount, now);
    }
    const insertHourly = db.prepare(
      `INSERT INTO analytics_hourly (dataset_id, conversation_id, sender_key, date_local,
         hour_local, message_count, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const bucket of hourly) {
      insertHourly.run(datasetId, bucket.conversationId, bucket.senderKey, bucket.dateLocal,
        bucket.hour, bucket.messageCount, now);
    }
    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(versionKey(datasetId), JSON.stringify({ version: ANALYTICS_VERSION, messages: facts.length }), now);
  })();
  return { datasetId, daily: daily.length, hourly: hourly.length, messages: facts.length, version: ANALYTICS_VERSION };
}

export function analyticsVersion(db: SqliteDatabase, datasetId: string): number | undefined {
  const row = db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(versionKey(datasetId)) as
    { value_json: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.value_json) as { version: number }).version;
}

export function isAnalyticsCurrent(db: SqliteDatabase, datasetId: string): boolean {
  return analyticsVersion(db, datasetId) === ANALYTICS_VERSION;
}
