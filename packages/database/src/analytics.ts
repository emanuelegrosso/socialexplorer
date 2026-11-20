import type { SqliteDatabase } from "./open.js";

/** Rebuilds the derived daily/hourly aggregates for one dataset from `messages`. */
export function rebuildAnalytics(
  db: SqliteDatabase,
  datasetId: string,
  now: string = new Date().toISOString(),
): { daily: number; hourly: number } {
  return db.transaction(() => {
    db.prepare("DELETE FROM analytics_daily WHERE dataset_id = ?").run(datasetId);
    db.prepare("DELETE FROM analytics_hourly WHERE dataset_id = ?").run(datasetId);
    const daily = db
      .prepare(
        `INSERT INTO analytics_daily (dataset_id, conversation_id, sender_key, date_local,
           message_count, attachment_count, character_count, computed_at)
         SELECT dataset_id, conversation_id, COALESCE(sender_contact_id, ''), substr(timestamp_local, 1, 10),
           COUNT(*), SUM(has_attachment), SUM(COALESCE(length(text), 0)), @now
         FROM messages WHERE dataset_id = @datasetId
         GROUP BY dataset_id, conversation_id, COALESCE(sender_contact_id, ''), substr(timestamp_local, 1, 10)`,
      )
      .run({ datasetId, now }).changes;
    const hourly = db
      .prepare(
        `INSERT INTO analytics_hourly (dataset_id, conversation_id, sender_key, date_local,
           hour_local, message_count, computed_at)
         SELECT dataset_id, conversation_id, COALESCE(sender_contact_id, ''), substr(timestamp_local, 1, 10),
           CAST(substr(timestamp_local, 12, 2) AS INTEGER), COUNT(*), @now
         FROM messages WHERE dataset_id = @datasetId
         GROUP BY dataset_id, conversation_id, COALESCE(sender_contact_id, ''),
           substr(timestamp_local, 1, 10), CAST(substr(timestamp_local, 12, 2) AS INTEGER)`,
      )
      .run({ datasetId, now }).changes;
    return { daily, hourly };
  })();
}
