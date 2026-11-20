import type { Message, MessageReaction } from "@social-explorer/contracts";
import type { SqliteDatabase } from "./open.js";
import { bool, escapeLike, nn, stripUndefined, toBool } from "./util.js";

interface MessageRow {
  id: string;
  dataset_id: string;
  conversation_id: string;
  source_message_id: string | null;
  sender_contact_id: string | null;
  timestamp_utc: string | null;
  timestamp_local: string;
  timezone: string;
  direction: Message["direction"];
  kind: Message["kind"];
  text: string | null;
  has_attachment: number;
  is_edited: number | null;
  is_deleted: number | null;
  source_kind: Message["sourceKind"];
  parse_status: Message["parseStatus"];
  provenance_id: string;
}

export interface MessageRangeQuery {
  readonly datasetId: string;
  readonly conversationId?: string;
  readonly start: string;
  readonly end: string;
  readonly limit: number;
}

export interface MessageSearchQuery {
  readonly datasetId: string;
  readonly text: string;
  readonly conversationId?: string;
  readonly limit: number;
}

export interface UpsertResult {
  readonly inserted: number;
  readonly updated: number;
}

const MESSAGE_COLUMNS = `id, dataset_id, conversation_id, source_message_id, sender_contact_id,
  timestamp_utc, timestamp_local, timezone, direction, kind, text, has_attachment, is_edited,
  is_deleted, source_kind, parse_status, provenance_id`;

export function createMessageRepository(db: SqliteDatabase) {
  const upsert = db.prepare(`
    INSERT INTO messages (${MESSAGE_COLUMNS}, fingerprint)
    VALUES (@id, @datasetId, @conversationId, @sourceMessageId, @senderContactId,
      @timestampUtc, @timestampLocal, @timezone, @direction, @kind, @text, @hasAttachment, @isEdited,
      @isDeleted, @sourceKind, @parseStatus, @provenanceId, @fingerprint)
    ON CONFLICT (id) DO UPDATE SET
      sender_contact_id = excluded.sender_contact_id, timestamp_utc = excluded.timestamp_utc,
      timestamp_local = excluded.timestamp_local, timezone = excluded.timezone,
      direction = excluded.direction, kind = excluded.kind, text = excluded.text,
      has_attachment = excluded.has_attachment, is_edited = excluded.is_edited,
      is_deleted = excluded.is_deleted, parse_status = excluded.parse_status`);
  const exists = db.prepare("SELECT 1 FROM messages WHERE id = ?");
  const bySourceId = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE dataset_id = ? AND conversation_id = ? AND source_message_id = ?`,
  );
  const getRow = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`);
  const countByConversation = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE dataset_id = ? AND conversation_id = ?",
  );
  const countByDataset = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE dataset_id = ?");
  const rangeAll = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE dataset_id = @datasetId AND timestamp_utc >= @start AND timestamp_utc <= @end
     ORDER BY timestamp_utc, id LIMIT @limit`,
  );
  const rangeConversation = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE dataset_id = @datasetId AND conversation_id = @conversationId
       AND timestamp_utc >= @start AND timestamp_utc <= @end
     ORDER BY timestamp_utc, id LIMIT @limit`,
  );
  const searchAll = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE dataset_id = @datasetId AND text LIKE @pattern ESCAPE '\\'
     ORDER BY timestamp_utc DESC, id LIMIT @limit`,
  );
  const searchConversation = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE dataset_id = @datasetId AND conversation_id = @conversationId AND text LIKE @pattern ESCAPE '\\'
     ORDER BY timestamp_utc DESC, id LIMIT @limit`,
  );
  const remove = db.prepare("DELETE FROM messages WHERE id = ?");

  const upsertReaction = db.prepare(`
    INSERT INTO message_reactions (id, message_id, reactor_contact_id, emoji, reacted_at_utc, provenance_id)
    VALUES (@id, @messageId, @reactorContactId, @emoji, @reactedAtUtc, @provenanceId)
    ON CONFLICT (id) DO UPDATE SET emoji = excluded.emoji, reacted_at_utc = excluded.reacted_at_utc,
      reactor_contact_id = excluded.reactor_contact_id`);
  const reactionRows = db.prepare(
    "SELECT * FROM message_reactions WHERE message_id = ? ORDER BY reacted_at_utc, id",
  );

  const map = (row: MessageRow): Message =>
    stripUndefined({
      id: row.id,
      datasetId: row.dataset_id,
      conversationId: row.conversation_id,
      sourceMessageId: nn(row.source_message_id),
      senderContactId: nn(row.sender_contact_id),
      timestampUtc: nn(row.timestamp_utc),
      timestampLocal: row.timestamp_local,
      timezone: row.timezone,
      direction: row.direction,
      kind: row.kind,
      text: nn(row.text),
      hasAttachment: row.has_attachment === 1,
      isEdited: toBool(row.is_edited),
      isDeleted: toBool(row.is_deleted),
      sourceKind: row.source_kind,
      parseStatus: row.parse_status,
      provenanceId: row.provenance_id,
    });

  const upsertOne = (message: Message, fingerprint: string | null): boolean => {
    const existed = exists.get(message.id) !== undefined;
    upsert.run({
      id: message.id,
      datasetId: message.datasetId,
      conversationId: message.conversationId,
      sourceMessageId: message.sourceMessageId ?? null,
      senderContactId: message.senderContactId ?? null,
      timestampUtc: message.timestampUtc ?? null,
      timestampLocal: message.timestampLocal,
      timezone: message.timezone,
      direction: message.direction,
      kind: message.kind,
      text: message.text ?? null,
      hasAttachment: bool(message.hasAttachment),
      isEdited: bool(message.isEdited),
      isDeleted: bool(message.isDeleted),
      sourceKind: message.sourceKind,
      parseStatus: message.parseStatus,
      provenanceId: message.provenanceId,
      fingerprint,
    });
    return !existed;
  };

  return {
    /** Idempotent by message id; the (dataset, conversation, sourceMessageId) unique index guards re-imports. */
    upsert(message: Message, fingerprint?: string): boolean {
      return upsertOne(message, fingerprint ?? null);
    },
    upsertMany(messages: readonly Message[]): UpsertResult {
      let inserted = 0;
      db.transaction(() => {
        for (const message of messages) {
          if (upsertOne(message, null)) {
            inserted += 1;
          }
        }
      })();
      return { inserted, updated: messages.length - inserted };
    },
    get(id: string): Message | undefined {
      const row = getRow.get(id) as MessageRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    getBySourceId(
      datasetId: string,
      conversationId: string,
      sourceMessageId: string,
    ): Message | undefined {
      const row = bySourceId.get(datasetId, conversationId, sourceMessageId) as
        MessageRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    countByConversation(datasetId: string, conversationId: string): number {
      return (countByConversation.get(datasetId, conversationId) as { n: number }).n;
    },
    countByDataset(datasetId: string): number {
      return (countByDataset.get(datasetId) as { n: number }).n;
    },
    /** Inclusive UTC range ordered chronologically. Messages without a UTC timestamp are excluded. */
    listRange(query: MessageRangeQuery): Message[] {
      const rows =
        query.conversationId === undefined ? rangeAll.all(query) : rangeConversation.all(query);
      return (rows as MessageRow[]).map(map);
    },
    /** Case-insensitive substring search over retained message text (newest first). */
    search(query: MessageSearchQuery): Message[] {
      const params = {
        datasetId: query.datasetId,
        conversationId: query.conversationId,
        pattern: `%${escapeLike(query.text)}%`,
        limit: query.limit,
      };
      const rows =
        query.conversationId === undefined ? searchAll.all(params) : searchConversation.all(params);
      return (rows as MessageRow[]).map(map);
    },
    delete(id: string): boolean {
      return remove.run(id).changes > 0;
    },
    upsertReaction(reaction: MessageReaction): void {
      upsertReaction.run({
        id: reaction.id,
        messageId: reaction.messageId,
        reactorContactId: reaction.reactorContactId ?? null,
        emoji: reaction.emoji,
        reactedAtUtc: reaction.reactedAtUtc ?? null,
        provenanceId: reaction.provenanceId,
      });
    },
    listReactions(messageId: string): MessageReaction[] {
      const rows = reactionRows.all(messageId) as {
        id: string;
        message_id: string;
        reactor_contact_id: string | null;
        emoji: string;
        reacted_at_utc: string | null;
        provenance_id: string;
      }[];
      return rows.map((row) =>
        stripUndefined({
          id: row.id,
          messageId: row.message_id,
          reactorContactId: nn(row.reactor_contact_id),
          emoji: row.emoji,
          reactedAtUtc: nn(row.reacted_at_utc),
          provenanceId: row.provenance_id,
        }),
      );
    },
  };
}
