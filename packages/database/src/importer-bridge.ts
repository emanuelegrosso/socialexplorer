import type { DataSource, Dataset, Message } from "@social-explorer/contracts";
import { datasetId as deriveDatasetId, sourceId as deriveSourceId } from "@social-explorer/domain";
import {
  normalizeSenderKey,
  type CommitChunk,
  type CommitItem,
  type ContactResolution,
  type ExistingContactRef,
  type ExistingDatasetIndex,
  type ExistingMessageRef,
  type ImportBatchStatus,
  type ImportCheckpoint,
  type ImportCommitSink,
  type NormalizedConversation,
  type NormalizedMessage,
} from "@social-explorer/importers";
import {
  ingestCanonicalBatch,
  type CanonicalContactInput,
  type CanonicalConversationInput,
  type CanonicalLinkInput,
  type CanonicalMessageInput,
  type IngestResult,
} from "./ingest.js";
import type { SqliteDatabase } from "./open.js";

export interface EnsureDatasetInput {
  readonly name: string;
  readonly timezone: string;
  readonly now?: string;
}

/** Creates a dataset, or returns the existing one with the same deterministic id. */
export function ensureDataset(db: SqliteDatabase, input: EnsureDatasetInput): Dataset {
  const createdAt = input.now ?? new Date().toISOString();
  const id = deriveDatasetId(input.name, createdAt);
  db.prepare(
    "INSERT INTO datasets (id, name, created_at, timezone) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
  ).run(id, input.name, createdAt, input.timezone);
  const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(id) as {
    id: string;
    name: string;
    created_at: string;
    timezone: string;
  };
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    timezone: row.timezone,
    sourceIds: [],
  };
}

export interface ArchiveSourceInput {
  readonly datasetId: string;
  readonly name: string;
  /** Content hash so two different archives with the same file name stay distinct sources. */
  readonly contentHash: string;
  readonly container: "txt" | "zip";
  readonly platform: "android" | "ios";
  readonly now?: string;
}

export function registerArchiveSource(db: SqliteDatabase, input: ArchiveSourceInput): DataSource {
  const label = `${input.name} (${input.contentHash.slice(0, 12)})`;
  const id = deriveSourceId(input.datasetId, label);
  const kind: DataSource["kind"] =
    input.container === "zip"
      ? "whatsapp-zip"
      : input.platform === "ios"
        ? "whatsapp-ios-txt"
        : "whatsapp-android-txt";
  const createdAt = input.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO data_sources (id, dataset_id, platform, kind, label, created_at)
     VALUES (?, ?, 'whatsapp', ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(id, input.datasetId, kind, label, createdAt);
  return { id, datasetId: input.datasetId, platform: "whatsapp", kind, label, createdAt };
}

interface RefRow {
  id: string;
  fingerprint: string | null;
  text: string | null;
  timestamp_utc: string | null;
  timestamp_precision: "minute" | "second" | null;
  sender: string | null;
}

const REF_SELECT = `SELECT m.id, m.fingerprint, m.text, m.timestamp_utc, m.timestamp_precision,
    c.display_name AS sender
  FROM messages m LEFT JOIN contacts c ON c.id = m.sender_contact_id`;

const NOT_IN_EXCLUDED = `m.provenance_id NOT IN
  (SELECT id FROM provenance_records WHERE import_batch_id = ?)`;

/**
 * Read-only view of one dataset for `buildMergeReviewPlan`. Display-name matches only consider
 * contacts created from exports (`export-name` identity); contacts identified by a phone/JID are
 * never offered, so a name can never merge across identity types.
 */
export class SqliteExistingDatasetIndex implements ExistingDatasetIndex {
  /**
   * `excludeBatchId` hides rows staged by a partially committed batch so that planning a resume
   * of that batch reproduces the original plan instead of treating its own rows as duplicates.
   */
  constructor(
    private readonly db: SqliteDatabase,
    private readonly datasetId: string,
    private readonly options: { readonly excludeBatchId?: string } = {},
  ) {}

  private get excluded(): string {
    return this.options.excludeBatchId ?? "";
  }

  private conversationFor(conversationKey: string): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM conversations WHERE dataset_id = ? AND source_conversation_id = ?")
      .get(this.datasetId, conversationKey) as { id: string } | undefined;
    return row?.id;
  }

  private toRef(conversationKey: string, row: RefRow): ExistingMessageRef {
    return {
      id: row.id,
      conversationKey,
      senderName: row.sender,
      text: row.text ?? "",
      contentKey: row.fingerprint ?? "",
      timestampUtc: row.timestamp_utc,
      timestampPrecision: row.timestamp_precision,
    };
  }

  findByContentKeys(
    conversationKey: string,
    contentKeys: readonly string[],
  ): Promise<readonly ExistingMessageRef[]> {
    const conversationId = this.conversationFor(conversationKey);
    if (conversationId === undefined || contentKeys.length === 0) {
      return Promise.resolve([]);
    }
    const rows = this.db
      .prepare(
        `${REF_SELECT} WHERE m.dataset_id = ? AND m.conversation_id = ?
           AND m.fingerprint IN (SELECT value FROM json_each(?))
           AND ${NOT_IN_EXCLUDED} ORDER BY m.timestamp_utc, m.id`,
      )
      .all(this.datasetId, conversationId, JSON.stringify(contentKeys), this.excluded) as RefRow[];
    return Promise.resolve(rows.map((row) => this.toRef(conversationKey, row)));
  }

  findInTimeWindow(
    conversationKey: string,
    fromUtc: string,
    toUtc: string,
  ): Promise<readonly ExistingMessageRef[]> {
    const conversationId = this.conversationFor(conversationKey);
    if (conversationId === undefined) {
      return Promise.resolve([]);
    }
    const rows = this.db
      .prepare(
        `${REF_SELECT} WHERE m.dataset_id = ? AND m.conversation_id = ?
           AND m.timestamp_utc >= ? AND m.timestamp_utc <= ?
           AND ${NOT_IN_EXCLUDED} ORDER BY m.timestamp_utc, m.id`,
      )
      .all(this.datasetId, conversationId, fromUtc, toUtc, this.excluded) as RefRow[];
    return Promise.resolve(rows.map((row) => this.toRef(conversationKey, row)));
  }

  findContactsByDisplayName(
    displayNames: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ExistingContactRef[]>> {
    const wanted = new Set(displayNames.map((name) => normalizeSenderKey(name)));
    const rows = this.db
      .prepare(
        `SELECT i.contact_id AS id, i.value AS value
         FROM contact_identifiers i WHERE i.dataset_id = ? AND i.type = 'export-name'
           AND i.contact_id NOT IN
             (SELECT contact_id FROM import_batch_contacts WHERE batch_id = ? AND created = 1)`,
      )
      .all(this.datasetId, this.excluded) as { id: string; value: string }[];
    const merged = new Map(
      (
        this.db
          .prepare(
            "SELECT id, merged_into_contact_id AS target FROM contacts WHERE dataset_id = ? AND merged_into_contact_id IS NOT NULL",
          )
          .all(this.datasetId) as { id: string; target: string }[]
      ).map((row) => [row.id, row.target]),
    );
    const names = new Map(
      (
        this.db
          .prepare("SELECT id, display_name FROM contacts WHERE dataset_id = ?")
          .all(this.datasetId) as { id: string; display_name: string }[]
      ).map((row) => [row.id, row.display_name]),
    );
    const result = new Map<string, Map<string, ExistingContactRef>>();
    for (const row of rows) {
      const key = normalizeSenderKey(row.value);
      if (!wanted.has(key)) {
        continue;
      }
      const effective = merged.get(row.id) ?? row.id;
      const bucket = result.get(key) ?? new Map<string, ExistingContactRef>();
      bucket.set(effective, { id: effective, displayName: names.get(effective) ?? row.value });
      result.set(key, bucket);
    }
    return Promise.resolve(
      new Map(
        [...result].map(([key, bucket]) => [
          key,
          [...bucket.values()].sort((a, b) => a.id.localeCompare(b.id)),
        ]),
      ),
    );
  }
}

const DB_STATUS: Readonly<Record<ImportBatchStatus, string>> = {
  pending: "previewed",
  parsing: "previewed",
  previewing: "previewed",
  committing: "committing",
  committed: "committed",
  failed: "failed",
  canceled: "cancelled",
};

interface CheckpointRow {
  batch_id: string;
  plan_id: string;
  status: ImportBatchStatus;
  chunk_size: number;
  total_chunks: number;
  next_chunk_index: number;
  committed_items: number;
  error: string | null;
}

export interface SqliteImportCommitSinkOptions {
  readonly db: SqliteDatabase;
  readonly datasetId: string;
  readonly sourceId: string;
  readonly timezone: string;
  /** Conversation metadata (title/kind) for every `conversationKey` in the plan. */
  readonly conversations: readonly NormalizedConversation[];
  /** Names the user confirmed as themselves ("self"). */
  readonly selfNames?: readonly string[];
  readonly now?: () => string;
}

export interface CommitTotals {
  readonly messagesInserted: number;
  readonly messagesLinked: number;
  readonly contactsCreated: number;
  readonly conversationsCreated: number;
  readonly unplacedRecords: number;
}

function linkInput(
  link: NormalizedMessage["links"][number],
): CanonicalLinkInput {
  const provider = link.provider === "apple_music" ? "apple-music" : link.provider;
  return {
    url: link.url,
    provider,
    linkKind: provider === "spotify" || provider === "apple-music" ? "music" : provider === "youtube" ? "video" : "other",
  };
}

function messageKind(message: NormalizedMessage): Message["kind"] {
  if (message.systemEvent !== null || message.direction === "system") {
    return "system";
  }
  const media = message.media[0];
  if (media !== undefined) {
    switch (media.mediaType) {
      case "image":
      case "sticker":
        return "image";
      case "video":
      case "gif":
        return "video";
      case "audio":
        return "audio";
      case "document":
        return "document";
      default:
        return "unknown";
    }
  }
  if (message.mediaOmitted) {
    return "unknown";
  }
  if (message.parseStatus === "unparsed") {
    return "unknown";
  }
  return message.links.length > 0 && message.text.trim() === message.links[0]?.url ? "link" : "text";
}

/** Maps an importer record to the canonical ingestion shape (shared with future connectors). */
export function toCanonicalMessage(
  message: NormalizedMessage,
  timezone: string,
  item?: Extract<CommitItem, { kind: "link" }>,
): CanonicalMessageInput {
  const hasSender = message.direction !== "system" && message.senderName !== null;
  return {
    recordKey: message.recordId,
    conversationKey: message.conversationKey,
    senderKey: hasSender ? normalizeSenderKey(message.senderName) : null,
    fingerprint: message.contentKey,
    timestampUtc: message.timestampUtc,
    timestampLocal: message.timestampLocal,
    timestampPrecision: message.timestampPrecision,
    timezone,
    direction: message.direction === "system" ? "unknown" : message.direction,
    kind: messageKind(message),
    text: message.text,
    hasAttachment: message.media.length > 0 || message.mediaOmitted,
    isDeleted: message.deleted,
    parseStatus: message.parseStatus,
    locator: `${message.sourceFile}:${String(message.lineStart)}-${String(message.lineEnd)}`,
    originalTimestampText: message.timestampText,
    links: message.links.map(linkInput),
    ...(item === undefined
      ? {}
      : { observationOf: { messageId: item.existingId, reason: item.reason } }),
  };
}

/**
 * Persists importer commit chunks. Each chunk and its checkpoint are written in one SQLite
 * transaction, so a crash leaves either the whole chunk plus the advanced checkpoint or neither.
 */
export class SqliteImportCommitSink implements ImportCommitSink {
  private readonly conversations: ReadonlyMap<string, NormalizedConversation>;
  private readonly selfKeys: ReadonlySet<string>;
  private readonly now: () => string;
  private totals = {
    messagesInserted: 0,
    messagesLinked: 0,
    contactsCreated: 0,
    conversationsCreated: 0,
    unplacedRecords: 0,
  };

  constructor(private readonly options: SqliteImportCommitSinkOptions) {
    this.conversations = new Map(options.conversations.map((c) => [c.conversationKey, c]));
    this.selfKeys = new Set((options.selfNames ?? []).map((name) => normalizeSenderKey(name)));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Totals persisted by this sink instance (resumed chunks from earlier runs are not counted). */
  get persisted(): CommitTotals {
    return { ...this.totals };
  }

  private ensureBatch(checkpoint: ImportCheckpoint): void {
    const { db, datasetId, sourceId } = this.options;
    db.prepare(
      `INSERT INTO import_batches (id, dataset_id, source_id, status, started_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(checkpoint.batchId, datasetId, sourceId, DB_STATUS[checkpoint.status], this.now());
  }

  private writeCheckpoint(checkpoint: ImportCheckpoint): void {
    const { db } = this.options;
    this.ensureBatch(checkpoint);
    db.prepare(
      `INSERT INTO import_checkpoints (batch_id, plan_id, status, chunk_size, total_chunks,
         next_chunk_index, committed_items, error, updated_at)
       VALUES (@batchId, @planId, @status, @chunkSize, @totalChunks, @nextChunkIndex,
         @committedItems, @error, @updatedAt)
       ON CONFLICT (batch_id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status,
         chunk_size = excluded.chunk_size, total_chunks = excluded.total_chunks,
         next_chunk_index = excluded.next_chunk_index, committed_items = excluded.committed_items,
         error = excluded.error, updated_at = excluded.updated_at`,
    ).run({ ...checkpoint, updatedAt: this.now() });
    const finished = checkpoint.status === "committed";
    db.prepare("UPDATE import_batches SET status = ?, completed_at = ? WHERE id = ?").run(
      DB_STATUS[checkpoint.status],
      finished || checkpoint.status === "canceled" || checkpoint.status === "failed"
        ? this.now()
        : null,
      checkpoint.batchId,
    );
    if (finished) {
      const { datasetId } = this.options;
      const range = db
        .prepare(
          "SELECT MIN(timestamp_utc) AS start, MAX(timestamp_utc) AS end FROM visible_messages WHERE dataset_id = ?",
        )
        .get(datasetId) as { start: string | null; end: string | null };
      db.prepare("UPDATE datasets SET coverage_start = ?, coverage_end = ? WHERE id = ?").run(
        range.start,
        range.end,
        datasetId,
      );
    }
  }

  loadCheckpoint(batchId: string): Promise<ImportCheckpoint | null> {
    const row = this.options.db
      .prepare("SELECT * FROM import_checkpoints WHERE batch_id = ?")
      .get(batchId) as CheckpointRow | undefined;
    return Promise.resolve(
      row === undefined
        ? null
        : {
            batchId: row.batch_id,
            planId: row.plan_id,
            status: row.status,
            chunkSize: row.chunk_size,
            totalChunks: row.total_chunks,
            nextChunkIndex: row.next_chunk_index,
            committedItems: row.committed_items,
            error: row.error,
          },
    );
  }

  saveCheckpoint(checkpoint: ImportCheckpoint): Promise<void> {
    this.options.db.transaction(() => {
      this.writeCheckpoint(checkpoint);
    })();
    return Promise.resolve();
  }

  commitChunk(chunk: CommitChunk, checkpoint: ImportCheckpoint): Promise<void> {
    const { db, datasetId, sourceId, timezone } = this.options;
    db.transaction(() => {
      const stored = db
        .prepare("SELECT next_chunk_index FROM import_checkpoints WHERE batch_id = ?")
        .get(chunk.batchId) as { next_chunk_index: number } | undefined;
      if (stored !== undefined && stored.next_chunk_index > chunk.chunkIndex) {
        return;
      }
      this.ensureBatch(checkpoint);

      const mapped = new Map(
        (
          db
            .prepare("SELECT name_key, contact_id FROM import_batch_contacts WHERE batch_id = ?")
            .all(chunk.batchId) as { name_key: string; contact_id: string }[]
        ).map((row) => [row.name_key, row.contact_id]),
      );
      const contacts = chunk.contacts.map((resolution) => this.contactInput(resolution, chunk.batchId));
      const messages = chunk.items.map((item) => {
        const input = toCanonicalMessage(
          item.message,
          timezone,
          item.kind === "link" ? item : undefined,
        );
        const key = input.senderKey;
        const resolved = key === null || key === undefined ? undefined : mapped.get(key);
        return resolved === undefined ? input : { ...input, senderKey: null, senderContactId: resolved };
      });
      const usedKeys = [...new Set(chunk.items.map((item) => item.message.conversationKey))];
      const conversations: CanonicalConversationInput[] = usedKeys.map((key) => {
        const meta = this.conversations.get(key);
        return {
          key,
          title: meta?.title ?? key,
          kind: meta === undefined ? "other" : meta.isGroup ? "group" : "private",
        };
      });
      const result: IngestResult = ingestCanonicalBatch(db, {
        datasetId,
        sourceId,
        sourceKind: "archive-import",
        importBatchId: chunk.batchId,
        recordedAt: this.now(),
        contacts,
        conversations,
        messages,
      });

      const saveMapping = db.prepare(
        `INSERT INTO import_batch_contacts (batch_id, name_key, contact_id, created)
         VALUES (?, ?, ?, ?) ON CONFLICT (batch_id, name_key) DO NOTHING`,
      );
      for (const [key, contactId] of result.contactIds) {
        saveMapping.run(chunk.batchId, key, contactId, result.createdContactKeys.includes(key) ? 1 : 0);
      }
      const saveConversation = db.prepare(
        "INSERT INTO import_batch_conversations (batch_id, conversation_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      );
      for (const id of result.createdConversationIds) {
        saveConversation.run(chunk.batchId, id);
      }
      db.prepare(
        `UPDATE import_batches SET parsed_count = parsed_count + @complete,
           partial_count = partial_count + @partial, unparsed_count = unparsed_count + @unparsed,
           new_records_count = new_records_count + @inserted,
           exact_duplicates_count = exact_duplicates_count + @exact,
           ambiguous_count = ambiguous_count + @user WHERE id = @id`,
      ).run({
        id: chunk.batchId,
        ...result.parseCounts,
        inserted: result.messagesInserted,
        exact: result.exactDuplicateLinks,
        user: result.userLinks,
      });
      this.totals = {
        messagesInserted: this.totals.messagesInserted + result.messagesInserted,
        messagesLinked: this.totals.messagesLinked + result.messagesLinked,
        contactsCreated: this.totals.contactsCreated + result.contactsCreated,
        conversationsCreated: this.totals.conversationsCreated + result.conversationsCreated,
        unplacedRecords: this.totals.unplacedRecords + result.unplacedRecords,
      };
      this.writeCheckpoint(checkpoint);
    })();
    return Promise.resolve();
  }

  private contactInput(resolution: ContactResolution, batchId: string): CanonicalContactInput {
    const key = normalizeSenderKey(resolution.displayName);
    return {
      key,
      displayName: resolution.displayName,
      identifiers: [
        { type: "export-name", value: resolution.displayName, confidence: "unknown" },
      ],
      isSelf: this.selfKeys.has(key),
      idSalt: batchId,
      ...(resolution.action === "link" && resolution.existingId !== null
        ? { linkToContactId: resolution.existingId }
        : {}),
    };
  }

  /** Removes everything this batch staged; rows of earlier batches are never touched. */
  rollbackBatch(batchId: string): Promise<void> {
    const { db } = this.options;
    db.transaction(() => {
      db.prepare(
        "DELETE FROM messages WHERE provenance_id IN (SELECT id FROM provenance_records WHERE import_batch_id = ?)",
      ).run(batchId);
      db.prepare("DELETE FROM provenance_records WHERE import_batch_id = ?").run(batchId);
      db.prepare(
        `DELETE FROM conversations WHERE id IN
           (SELECT conversation_id FROM import_batch_conversations WHERE batch_id = ?)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id)`,
      ).run(batchId);
      db.prepare(
        `DELETE FROM contacts WHERE id IN
           (SELECT contact_id FROM import_batch_contacts WHERE batch_id = ? AND created = 1)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE sender_contact_id = contacts.id)
         AND NOT EXISTS (SELECT 1 FROM contacts child WHERE child.merged_into_contact_id = contacts.id)`,
      ).run(batchId);
      db.prepare("DELETE FROM import_batch_contacts WHERE batch_id = ?").run(batchId);
      db.prepare("DELETE FROM import_batch_conversations WHERE batch_id = ?").run(batchId);
      db.prepare("DELETE FROM import_checkpoints WHERE batch_id = ?").run(batchId);
      db.prepare("UPDATE import_batches SET status = 'cancelled', completed_at = ? WHERE id = ?").run(
        this.now(),
        batchId,
      );
    })();
    return Promise.resolve();
  }
}

/**
 * Crash recovery: batches left `committing` by a previous process become `failed`, which the
 * importer resumes from the stored checkpoint when commit is called again with the same id.
 */
export function markInterruptedImports(db: SqliteDatabase, now = new Date().toISOString()): string[] {
  return db.transaction(() => {
    const ids = (
      db.prepare("SELECT id FROM import_batches WHERE status = 'committing' ORDER BY id").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    for (const id of ids) {
      db.prepare("UPDATE import_batches SET status = 'failed', completed_at = ? WHERE id = ?").run(now, id);
      db.prepare(
        "UPDATE import_checkpoints SET status = 'failed', error = 'interrupted', updated_at = ? WHERE batch_id = ?",
      ).run(now, id);
    }
    return ids;
  })();
}
