import type { SqliteDatabase } from "./open.js";

/** Merged contacts count towards their primary; uncommitted batches and system rows are excluded. */
export const SENDER_KEY = "COALESCE(sc.merged_into_contact_id, m.sender_contact_id, '')";
export const FROM_VISIBLE = `FROM visible_messages m
  LEFT JOIN contacts sc ON sc.id = m.sender_contact_id
  WHERE m.dataset_id = @datasetId AND m.kind <> 'system'`;

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
         SELECT m.dataset_id, m.conversation_id, ${SENDER_KEY}, substr(m.timestamp_local, 1, 10),
           COUNT(*), SUM(m.has_attachment), SUM(COALESCE(length(m.text), 0)), @now
         ${FROM_VISIBLE}
         GROUP BY m.dataset_id, m.conversation_id, ${SENDER_KEY}, substr(m.timestamp_local, 1, 10)`,
      )
      .run({ datasetId, now }).changes;
    const hourly = db
      .prepare(
        `INSERT INTO analytics_hourly (dataset_id, conversation_id, sender_key, date_local,
           hour_local, message_count, computed_at)
         SELECT m.dataset_id, m.conversation_id, ${SENDER_KEY}, substr(m.timestamp_local, 1, 10),
           CAST(substr(m.timestamp_local, 12, 2) AS INTEGER), COUNT(*), @now
         ${FROM_VISIBLE}
         GROUP BY m.dataset_id, m.conversation_id, ${SENDER_KEY},
           substr(m.timestamp_local, 1, 10), CAST(substr(m.timestamp_local, 12, 2) AS INTEGER)`,
      )
      .run({ datasetId, now }).changes;
    return { daily, hourly };
  })();
}
