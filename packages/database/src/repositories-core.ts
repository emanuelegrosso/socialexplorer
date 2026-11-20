import type {
  Annotation,
  Contact,
  ContactIdentifier,
  Conversation,
  ConversationParticipant,
  DataSource,
  Dataset,
  ImportBatch,
  ProvenanceRecord,
} from "@social-explorer/contracts";
import type { SqliteDatabase } from "./open.js";
import { bool, nn, parseJsonArray, stripUndefined } from "./util.js";

interface DatasetRow {
  id: string;
  name: string;
  created_at: string;
  timezone: string;
  coverage_start: string | null;
  coverage_end: string | null;
}

interface SourceRow {
  id: string;
  dataset_id: string;
  platform: "whatsapp";
  kind: DataSource["kind"];
  label: string;
  created_at: string;
}

export function createDatasetRepository(db: SqliteDatabase) {
  const upsert = db.prepare(`
    INSERT INTO datasets (id, name, created_at, timezone, coverage_start, coverage_end)
    VALUES (@id, @name, @createdAt, @timezone, @coverageStart, @coverageEnd)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone,
      coverage_start = excluded.coverage_start, coverage_end = excluded.coverage_end`);
  const getRow = db.prepare("SELECT * FROM datasets WHERE id = ?");
  const listRows = db.prepare("SELECT * FROM datasets ORDER BY created_at, id");
  const sourceIds = db.prepare(
    "SELECT id FROM data_sources WHERE dataset_id = ? ORDER BY created_at, id",
  );
  const remove = db.prepare("DELETE FROM datasets WHERE id = ?");
  const coverage = db.prepare(
    "SELECT MIN(timestamp_utc) AS start, MAX(timestamp_utc) AS end FROM messages WHERE dataset_id = ?",
  );
  const setCoverage = db.prepare(
    "UPDATE datasets SET coverage_start = ?, coverage_end = ? WHERE id = ?",
  );

  const map = (row: DatasetRow): Dataset =>
    stripUndefined({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      timezone: row.timezone,
      sourceIds: (sourceIds.all(row.id) as { id: string }[]).map((source) => source.id),
      coverageStart: nn(row.coverage_start),
      coverageEnd: nn(row.coverage_end),
    });

  return {
    upsert(dataset: Dataset): void {
      upsert.run({
        id: dataset.id,
        name: dataset.name,
        createdAt: dataset.createdAt,
        timezone: dataset.timezone,
        coverageStart: dataset.coverageStart ?? null,
        coverageEnd: dataset.coverageEnd ?? null,
      });
    },
    get(id: string): Dataset | undefined {
      const row = getRow.get(id) as DatasetRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    list(): Dataset[] {
      return (listRows.all() as DatasetRow[]).map(map);
    },
    /** Cascades to every dataset-scoped table. Never touches connector auth storage. */
    delete(id: string): boolean {
      return remove.run(id).changes > 0;
    },
    refreshCoverage(id: string): void {
      const row = coverage.get(id) as { start: string | null; end: string | null };
      setCoverage.run(row.start, row.end, id);
    },
  };
}

export function createSourceRepository(db: SqliteDatabase) {
  const upsert = db.prepare(`
    INSERT INTO data_sources (id, dataset_id, platform, kind, label, created_at)
    VALUES (@id, @datasetId, @platform, @kind, @label, @createdAt)
    ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, label = excluded.label`);
  const getRow = db.prepare("SELECT * FROM data_sources WHERE id = ?");
  const listRows = db.prepare(
    "SELECT * FROM data_sources WHERE dataset_id = ? ORDER BY created_at, id",
  );
  const remove = db.prepare("DELETE FROM data_sources WHERE id = ?");
  const map = (row: SourceRow): DataSource => ({
    id: row.id,
    datasetId: row.dataset_id,
    platform: row.platform,
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at,
  });
  return {
    upsert(source: DataSource): void {
      upsert.run(source);
    },
    get(id: string): DataSource | undefined {
      const row = getRow.get(id) as SourceRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    listByDataset(datasetId: string): DataSource[] {
      return (listRows.all(datasetId) as SourceRow[]).map(map);
    },
    delete(id: string): boolean {
      return remove.run(id).changes > 0;
    },
  };
}

interface BatchRow {
  id: string;
  dataset_id: string;
  source_id: string;
  status: ImportBatch["status"];
  started_at: string;
  completed_at: string | null;
  parsed_count: number;
  partial_count: number;
  unparsed_count: number;
  new_records_count: number;
  exact_duplicates_count: number;
  ambiguous_count: number;
}

export function createImportBatchRepository(db: SqliteDatabase) {
  const upsert = db.prepare(`
    INSERT INTO import_batches (id, dataset_id, source_id, status, started_at, completed_at,
      parsed_count, partial_count, unparsed_count, new_records_count, exact_duplicates_count, ambiguous_count)
    VALUES (@id, @datasetId, @sourceId, @status, @startedAt, @completedAt,
      @parsed, @partial, @unparsed, @newRecords, @exactDuplicates, @ambiguous)
    ON CONFLICT (id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at,
      parsed_count = excluded.parsed_count, partial_count = excluded.partial_count,
      unparsed_count = excluded.unparsed_count, new_records_count = excluded.new_records_count,
      exact_duplicates_count = excluded.exact_duplicates_count, ambiguous_count = excluded.ambiguous_count`);
  const getRow = db.prepare("SELECT * FROM import_batches WHERE id = ?");
  const listRows = db.prepare(
    "SELECT * FROM import_batches WHERE dataset_id = ? ORDER BY started_at, id",
  );
  const map = (row: BatchRow): ImportBatch =>
    stripUndefined({
      id: row.id,
      datasetId: row.dataset_id,
      sourceId: row.source_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: nn(row.completed_at),
      counts: {
        parsed: row.parsed_count,
        partial: row.partial_count,
        unparsed: row.unparsed_count,
        newRecords: row.new_records_count,
        exactDuplicates: row.exact_duplicates_count,
        ambiguous: row.ambiguous_count,
      },
    });
  return {
    upsert(batch: ImportBatch): void {
      upsert.run({
        id: batch.id,
        datasetId: batch.datasetId,
        sourceId: batch.sourceId,
        status: batch.status,
        startedAt: batch.startedAt,
        completedAt: batch.completedAt ?? null,
        ...batch.counts,
      });
    },
    get(id: string): ImportBatch | undefined {
      const row = getRow.get(id) as BatchRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    listByDataset(datasetId: string): ImportBatch[] {
      return (listRows.all(datasetId) as BatchRow[]).map(map);
    },
  };
}

interface ProvenanceRow {
  id: string;
  dataset_id: string;
  source_id: string;
  import_batch_id: string | null;
  source_kind: ProvenanceRecord["sourceKind"];
  original_timestamp_text: string | null;
  source_locator: string | null;
  parse_status: ProvenanceRecord["parseStatus"];
  recorded_at: string;
}

export function createProvenanceRepository(db: SqliteDatabase) {
  const insert = db.prepare(`
    INSERT INTO provenance_records (id, dataset_id, source_id, import_batch_id, source_kind,
      original_timestamp_text, source_locator, parse_status, recorded_at)
    VALUES (@id, @datasetId, @sourceId, @importBatchId, @sourceKind,
      @originalTimestampText, @sourceLocator, @parseStatus, @recordedAt)
    ON CONFLICT (id) DO NOTHING`);
  const getRow = db.prepare("SELECT * FROM provenance_records WHERE id = ?");
  const byBatch = db.prepare(
    "SELECT * FROM provenance_records WHERE import_batch_id = ? ORDER BY recorded_at, id",
  );
  const map = (row: ProvenanceRow): ProvenanceRecord =>
    stripUndefined({
      id: row.id,
      datasetId: row.dataset_id,
      sourceId: row.source_id,
      importBatchId: nn(row.import_batch_id),
      sourceKind: row.source_kind,
      originalTimestampText: nn(row.original_timestamp_text),
      sourceLocator: nn(row.source_locator),
      parseStatus: row.parse_status,
      recordedAt: row.recorded_at,
    });
  return {
    /** Provenance is append-only: re-inserting an existing id is a no-op. */
    insert(record: ProvenanceRecord): boolean {
      return (
        insert.run({
          id: record.id,
          datasetId: record.datasetId,
          sourceId: record.sourceId,
          importBatchId: record.importBatchId ?? null,
          sourceKind: record.sourceKind,
          originalTimestampText: record.originalTimestampText ?? null,
          sourceLocator: record.sourceLocator ?? null,
          parseStatus: record.parseStatus,
          recordedAt: record.recordedAt,
        }).changes > 0
      );
    },
    get(id: string): ProvenanceRecord | undefined {
      const row = getRow.get(id) as ProvenanceRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    listByBatch(importBatchId: string): ProvenanceRecord[] {
      return (byBatch.all(importBatchId) as ProvenanceRow[]).map(map);
    },
  };
}

interface ContactRow {
  id: string;
  display_name: string;
  aliases_json: string;
  is_self: number;
  color_key: string;
}

interface IdentifierRow {
  type: ContactIdentifier["type"];
  value: string;
  source_id: string | null;
  confidence: ContactIdentifier["confidence"];
}

export function createContactRepository(db: SqliteDatabase) {
  const upsertContact = db.prepare(`
    INSERT INTO contacts (id, dataset_id, display_name, aliases_json, is_self, color_key)
    VALUES (@id, @datasetId, @displayName, @aliasesJson, @isSelf, @colorKey)
    ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name,
      aliases_json = excluded.aliases_json, is_self = excluded.is_self, color_key = excluded.color_key`);
  const upsertIdentifier = db.prepare(`
    INSERT INTO contact_identifiers (dataset_id, contact_id, type, value, source_id, confidence)
    VALUES (@datasetId, @contactId, @type, @value, @sourceId, @confidence)
    ON CONFLICT (contact_id, type, value) DO UPDATE SET
      source_id = excluded.source_id, confidence = excluded.confidence`);
  const getRow = db.prepare("SELECT * FROM contacts WHERE id = ?");
  const listRows = db.prepare(
    "SELECT * FROM contacts WHERE dataset_id = ? ORDER BY display_name, id",
  );
  const identifierRows = db.prepare(
    "SELECT type, value, source_id, confidence FROM contact_identifiers WHERE contact_id = ? ORDER BY type, value",
  );
  const findByIdentifier = db.prepare(
    "SELECT DISTINCT contact_id FROM contact_identifiers WHERE dataset_id = ? AND type = ? AND value = ? ORDER BY contact_id",
  );
  const removeIdentifier = db.prepare(
    "DELETE FROM contact_identifiers WHERE contact_id = ? AND type = ? AND value = ?",
  );
  const remove = db.prepare("DELETE FROM contacts WHERE id = ?");

  const mapIdentifier = (row: IdentifierRow): ContactIdentifier =>
    stripUndefined({
      type: row.type,
      value: row.value,
      sourceId: nn(row.source_id),
      confidence: row.confidence,
    });
  const map = (row: ContactRow): Contact => ({
    id: row.id,
    displayName: row.display_name,
    aliases: parseJsonArray(row.aliases_json),
    identifiers: (identifierRows.all(row.id) as IdentifierRow[]).map(mapIdentifier),
    isSelf: row.is_self === 1,
    colorKey: row.color_key,
  });

  const addIdentifier = (
    datasetId: string,
    contactId: string,
    identifier: ContactIdentifier,
  ): void => {
    upsertIdentifier.run({
      datasetId,
      contactId,
      type: identifier.type,
      value: identifier.value,
      sourceId: identifier.sourceId ?? null,
      confidence: identifier.confidence,
    });
  };

  return {
    /** Upserts the contact and adds (never removes) its identifiers atomically. */
    upsert(datasetId: string, contact: Contact): void {
      db.transaction(() => {
        upsertContact.run({
          id: contact.id,
          datasetId,
          displayName: contact.displayName,
          aliasesJson: JSON.stringify(contact.aliases),
          isSelf: contact.isSelf ? 1 : 0,
          colorKey: contact.colorKey,
        });
        for (const identifier of contact.identifiers) {
          addIdentifier(datasetId, contact.id, identifier);
        }
      })();
    },
    addIdentifier,
    removeIdentifier(contactId: string, type: ContactIdentifier["type"], value: string): boolean {
      return removeIdentifier.run(contactId, type, value).changes > 0;
    },
    /** Returns every contact holding the identifier; callers must resolve ambiguity explicitly. */
    findByIdentifier(datasetId: string, type: ContactIdentifier["type"], value: string): Contact[] {
      const ids = findByIdentifier.all(datasetId, type, value) as { contact_id: string }[];
      return ids.flatMap(({ contact_id }) => {
        const row = getRow.get(contact_id) as ContactRow | undefined;
        return row === undefined ? [] : [map(row)];
      });
    },
    get(id: string): Contact | undefined {
      const row = getRow.get(id) as ContactRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    listByDataset(datasetId: string): Contact[] {
      return (listRows.all(datasetId) as ContactRow[]).map(map);
    },
    delete(id: string): boolean {
      return remove.run(id).changes > 0;
    },
  };
}

interface ConversationRow {
  id: string;
  dataset_id: string;
  source_conversation_id: string | null;
  title: string;
  kind: Conversation["kind"];
  group_entity_id: string | null;
}

interface ParticipantRow {
  conversation_id: string;
  contact_id: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  confidence: ConversationParticipant["confidence"];
}

export function createConversationRepository(db: SqliteDatabase) {
  const upsert = db.prepare(`
    INSERT INTO conversations (id, dataset_id, source_conversation_id, title, kind, group_entity_id)
    VALUES (@id, @datasetId, @sourceConversationId, @title, @kind, @groupEntityId)
    ON CONFLICT (id) DO UPDATE SET title = excluded.title, kind = excluded.kind,
      source_conversation_id = excluded.source_conversation_id, group_entity_id = excluded.group_entity_id`);
  const getRow = db.prepare("SELECT * FROM conversations WHERE id = ?");
  const listRows = db.prepare(
    "SELECT * FROM conversations WHERE dataset_id = ? ORDER BY title, id",
  );
  const bySource = db.prepare(
    "SELECT * FROM conversations WHERE dataset_id = ? AND source_conversation_id = ?",
  );
  const remove = db.prepare("DELETE FROM conversations WHERE id = ?");
  const upsertParticipant = db.prepare(`
    INSERT INTO conversation_participants (conversation_id, contact_id, first_seen_at, last_seen_at, confidence)
    VALUES (@conversationId, @contactId, @firstSeenAt, @lastSeenAt, @confidence)
    ON CONFLICT (conversation_id, contact_id) DO UPDATE SET
      first_seen_at = CASE
        WHEN conversation_participants.first_seen_at IS NULL THEN excluded.first_seen_at
        WHEN excluded.first_seen_at IS NULL THEN conversation_participants.first_seen_at
        ELSE MIN(conversation_participants.first_seen_at, excluded.first_seen_at) END,
      last_seen_at = CASE
        WHEN conversation_participants.last_seen_at IS NULL THEN excluded.last_seen_at
        WHEN excluded.last_seen_at IS NULL THEN conversation_participants.last_seen_at
        ELSE MAX(conversation_participants.last_seen_at, excluded.last_seen_at) END,
      confidence = excluded.confidence`);
  const participantRows = db.prepare(
    "SELECT * FROM conversation_participants WHERE conversation_id = ? ORDER BY contact_id",
  );
  const removeParticipant = db.prepare(
    "DELETE FROM conversation_participants WHERE conversation_id = ? AND contact_id = ?",
  );

  const map = (row: ConversationRow): Conversation =>
    stripUndefined({
      id: row.id,
      datasetId: row.dataset_id,
      sourceConversationId: nn(row.source_conversation_id),
      title: row.title,
      kind: row.kind,
      groupEntityId: nn(row.group_entity_id),
    });
  const mapParticipant = (row: ParticipantRow): ConversationParticipant =>
    stripUndefined({
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      firstSeenAt: nn(row.first_seen_at),
      lastSeenAt: nn(row.last_seen_at),
      confidence: row.confidence,
    });

  return {
    upsert(conversation: Conversation): void {
      upsert.run({
        id: conversation.id,
        datasetId: conversation.datasetId,
        sourceConversationId: conversation.sourceConversationId ?? null,
        title: conversation.title,
        kind: conversation.kind,
        groupEntityId: conversation.groupEntityId ?? null,
      });
    },
    get(id: string): Conversation | undefined {
      const row = getRow.get(id) as ConversationRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    getBySourceId(datasetId: string, sourceConversationId: string): Conversation | undefined {
      const row = bySource.get(datasetId, sourceConversationId) as ConversationRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    listByDataset(datasetId: string): Conversation[] {
      return (listRows.all(datasetId) as ConversationRow[]).map(map);
    },
    delete(id: string): boolean {
      return remove.run(id).changes > 0;
    },
    /** Widens the first/last seen window instead of overwriting it, so re-imports stay idempotent. */
    upsertParticipant(participant: ConversationParticipant): void {
      upsertParticipant.run({
        conversationId: participant.conversationId,
        contactId: participant.contactId,
        firstSeenAt: participant.firstSeenAt ?? null,
        lastSeenAt: participant.lastSeenAt ?? null,
        confidence: participant.confidence,
      });
    },
    listParticipants(conversationId: string): ConversationParticipant[] {
      return (participantRows.all(conversationId) as ParticipantRow[]).map(mapParticipant);
    },
    removeParticipant(conversationId: string, contactId: string): boolean {
      return removeParticipant.run(conversationId, contactId).changes > 0;
    },
  };
}

interface AnnotationRow {
  id: string;
  dataset_id: string;
  target_kind: Annotation["targetKind"];
  target_id: string;
  note: string | null;
  bookmarked: number;
  created_at: string;
  updated_at: string;
}

export function createAnnotationRepository(db: SqliteDatabase) {
  const upsert = db.prepare(`
    INSERT INTO annotations (id, dataset_id, target_kind, target_id, note, bookmarked, created_at, updated_at)
    VALUES (@id, @datasetId, @targetKind, @targetId, @note, @bookmarked, @createdAt, @updatedAt)
    ON CONFLICT (id) DO UPDATE SET note = excluded.note, bookmarked = excluded.bookmarked,
      updated_at = excluded.updated_at`);
  const getRow = db.prepare("SELECT * FROM annotations WHERE id = ?");
  const byTarget = db.prepare(
    "SELECT * FROM annotations WHERE dataset_id = ? AND target_kind = ? AND target_id = ? ORDER BY created_at, id",
  );
  const bookmarks = db.prepare(
    "SELECT * FROM annotations WHERE dataset_id = ? AND bookmarked = 1 ORDER BY created_at, id",
  );
  const remove = db.prepare("DELETE FROM annotations WHERE id = ?");
  const map = (row: AnnotationRow): Annotation =>
    stripUndefined({
      id: row.id,
      datasetId: row.dataset_id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      note: nn(row.note),
      bookmarked: row.bookmarked === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  return {
    upsert(annotation: Annotation): void {
      upsert.run({
        id: annotation.id,
        datasetId: annotation.datasetId,
        targetKind: annotation.targetKind,
        targetId: annotation.targetId,
        note: annotation.note ?? null,
        bookmarked: bool(annotation.bookmarked),
        createdAt: annotation.createdAt,
        updatedAt: annotation.updatedAt,
      });
    },
    get(id: string): Annotation | undefined {
      const row = getRow.get(id) as AnnotationRow | undefined;
      return row === undefined ? undefined : map(row);
    },
    listByTarget(
      datasetId: string,
      targetKind: Annotation["targetKind"],
      targetId: string,
    ): Annotation[] {
      return (byTarget.all(datasetId, targetKind, targetId) as AnnotationRow[]).map(map);
    },
    listBookmarks(datasetId: string): Annotation[] {
      return (bookmarks.all(datasetId) as AnnotationRow[]).map(map);
    },
    delete(id: string): boolean {
      return remove.run(id).changes > 0;
    },
  };
}
