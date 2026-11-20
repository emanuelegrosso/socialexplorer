import type { ChatKind } from "@social-explorer/contracts";
import type { SqliteDatabase } from "@social-explorer/database";

export interface MessageFact {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationKind: ChatKind;
  /** Effective sender: a manually merged contact is already resolved to its primary. */
  readonly senderId: string | null;
  readonly timestampUtc: string | null;
  readonly timestampMs: number | null;
  readonly localDate: string;
  readonly hour: number;
  /** 0 = Monday ... 6 = Sunday. */
  readonly weekday: number;
  readonly hasAttachment: boolean;
  readonly characters: number;
  /** True when the importer could only partially parse the source record. */
  readonly partial: boolean;
}

export interface ConversationInfo {
  readonly id: string;
  readonly title: string;
  readonly kind: ChatKind;
  /** Effective (merge-resolved) participant contact ids. */
  readonly participantIds: ReadonlySet<string>;
}

export interface ContactInfo {
  readonly id: string;
  readonly displayName: string;
  readonly isSelf: boolean;
  readonly colorKey: string;
  readonly aliases: readonly string[];
}

export interface EntityContext {
  readonly datasetId: string;
  readonly timezone: string;
  readonly contacts: ReadonlyMap<string, ContactInfo>;
  readonly conversations: ReadonlyMap<string, ConversationInfo>;
}

export function weekdayOf(localDate: string): number {
  const date = new Date(
    Date.UTC(Number(localDate.slice(0, 4)), Number(localDate.slice(5, 7)) - 1, Number(localDate.slice(8, 10))),
  );
  return (date.getUTCDay() + 6) % 7;
}

export function factFromLocal(
  base: Omit<MessageFact, "localDate" | "hour" | "weekday" | "timestampMs"> & { timestampLocal: string },
): MessageFact {
  const { timestampLocal, ...rest } = base;
  const localDate = timestampLocal.slice(0, 10);
  return {
    ...rest,
    localDate,
    hour: Number(timestampLocal.slice(11, 13)),
    weekday: weekdayOf(localDate),
    timestampMs: base.timestampUtc === null ? null : Date.parse(base.timestampUtc),
  };
}

interface FactRow {
  id: string;
  conversation_id: string;
  kind: ChatKind;
  sender: string | null;
  timestamp_utc: string | null;
  timestamp_local: string;
  has_attachment: number;
  chars: number | null;
  parse_status: string;
}

export interface FactRange {
  /** Inclusive UTC lower bound. */
  readonly startUtc: string;
  /** Exclusive UTC upper bound. */
  readonly endUtc: string;
}

/**
 * Canonical messages of committed batches only (system notices excluded), in chronological order.
 * With `range`, only messages that have a UTC timestamp inside it are returned.
 */
export function loadMessageFacts(
  db: SqliteDatabase,
  datasetId: string,
  range?: FactRange,
): MessageFact[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.conversation_id, c.kind,
         COALESCE(sc.merged_into_contact_id, m.sender_contact_id) AS sender,
         m.timestamp_utc, m.timestamp_local, m.has_attachment, length(m.text) AS chars,
         m.parse_status
       FROM visible_messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN contacts sc ON sc.id = m.sender_contact_id
       WHERE m.dataset_id = @datasetId AND m.kind <> 'system'
         AND (@startUtc IS NULL OR (m.timestamp_utc >= @startUtc AND m.timestamp_utc < @endUtc))
       ORDER BY COALESCE(m.timestamp_utc, m.timestamp_local), m.id`,
    )
    .all({
      datasetId,
      startUtc: range?.startUtc ?? null,
      endUtc: range?.endUtc ?? null,
    }) as FactRow[];
  return rows.map((row) =>
    factFromLocal({
      messageId: row.id,
      conversationId: row.conversation_id,
      conversationKind: row.kind,
      senderId: row.sender,
      timestampUtc: row.timestamp_utc,
      timestampLocal: row.timestamp_local,
      hasAttachment: row.has_attachment === 1,
      characters: row.chars ?? 0,
      partial: row.parse_status !== "complete",
    }),
  );
}

export function loadEntityContext(db: SqliteDatabase, datasetId: string): EntityContext {
  const dataset = db.prepare("SELECT timezone FROM datasets WHERE id = ?").get(datasetId) as
    { timezone: string } | undefined;
  if (dataset === undefined) {
    throw new Error("dataset_not_found");
  }
  const contactRows = db
    .prepare(
      "SELECT id, display_name, aliases_json, is_self, color_key, merged_into_contact_id AS merged FROM contacts WHERE dataset_id = ? ORDER BY id",
    )
    .all(datasetId) as {
    id: string;
    display_name: string;
    aliases_json: string;
    is_self: number;
    color_key: string;
    merged: string | null;
  }[];
  const merged = new Map(contactRows.flatMap((row) => (row.merged === null ? [] : [[row.id, row.merged] as const])));
  const effective = (id: string): string => merged.get(id) ?? id;
  const contacts = new Map<string, ContactInfo>();
  for (const row of contactRows) {
    if (row.merged === null) {
      contacts.set(row.id, {
        id: row.id,
        displayName: row.display_name,
        isSelf: row.is_self === 1,
        colorKey: row.color_key,
        aliases: JSON.parse(row.aliases_json) as string[],
      });
    }
  }
  const participants = new Map<string, Set<string>>();
  const participantRows = db
    .prepare(
      `SELECT cp.conversation_id AS conv, cp.contact_id AS contact FROM conversation_participants cp
       JOIN conversations c ON c.id = cp.conversation_id WHERE c.dataset_id = ?`,
    )
    .all(datasetId) as { conv: string; contact: string }[];
  for (const row of participantRows) {
    const set = participants.get(row.conv) ?? new Set<string>();
    set.add(effective(row.contact));
    participants.set(row.conv, set);
  }
  const conversations = new Map<string, ConversationInfo>();
  const conversationRows = db
    .prepare("SELECT id, title, kind FROM conversations WHERE dataset_id = ? ORDER BY id")
    .all(datasetId) as { id: string; title: string; kind: ChatKind }[];
  for (const row of conversationRows) {
    conversations.set(row.id, {
      id: row.id,
      title: row.title,
      kind: row.kind,
      participantIds: participants.get(row.id) ?? new Set<string>(),
    });
  }
  return { datasetId, timezone: dataset.timezone, contacts, conversations };
}
