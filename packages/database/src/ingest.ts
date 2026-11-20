import type {
  ChatKind,
  Confidence,
  ContactIdentifier,
  Message,
  ParseStatus,
  SourceKind,
} from "@social-explorer/contracts";
import {
  contactColorKey,
  contactId as deriveContactId,
  conversationId as deriveConversationId,
  messageDedupKey,
  messageId as deriveMessageId,
  normalizeIdentifier,
  provenanceId as deriveProvenanceId,
  resolveIdentity,
  type KnownContact,
} from "@social-explorer/domain";
import { deterministicId } from "@social-explorer/shared";
import type { SqliteDatabase } from "./open.js";
import { chunk } from "./transaction.js";

export interface CanonicalContactInput {
  /** Batch-local key referenced by `senderKey`/`reactorKey`/`participantKeys`. */
  readonly key: string;
  readonly displayName: string;
  readonly identifiers: readonly Pick<ContactIdentifier, "type" | "value" | "confidence">[];
  readonly isSelf?: boolean;
  /** Explicit decision (e.g. from a merge review) to attach to an existing contact. */
  readonly linkToContactId?: string;
  /** Mixed into the contact id when only a display name identifies it, so names never collide. */
  readonly idSalt?: string;
}

export interface CanonicalConversationInput {
  readonly key: string;
  readonly title: string;
  readonly kind: ChatKind;
  readonly participantKeys?: readonly string[];
}

export interface CanonicalReactionInput {
  readonly emoji: string;
  readonly reactorKey?: string;
  readonly reactorContactId?: string;
  readonly reactedAtUtc?: string;
}

export interface CanonicalLinkInput {
  readonly url: string;
  readonly provider: "spotify" | "youtube" | "apple-music" | "other";
  readonly linkKind: "music" | "video" | "other";
  readonly title?: string;
}

export interface CanonicalMessageInput {
  /** Stable per-source identity: a Baileys message id or an archive record id. */
  readonly recordKey: string;
  readonly conversationKey: string;
  readonly senderKey?: string | null;
  readonly senderContactId?: string | null;
  readonly sourceMessageId?: string;
  /** Content hash used for cross-archive duplicate detection. */
  readonly fingerprint?: string | null;
  readonly timestampUtc?: string | null;
  readonly timestampLocal?: string | null;
  readonly timestampPrecision?: "minute" | "second" | null;
  readonly timezone: string;
  readonly direction: Message["direction"];
  readonly kind: Message["kind"];
  readonly text?: string | null;
  readonly hasAttachment: boolean;
  readonly isEdited?: boolean;
  readonly isDeleted?: boolean;
  readonly parseStatus: ParseStatus;
  readonly locator: string;
  readonly originalTimestampText?: string | null;
  readonly reactions?: readonly CanonicalReactionInput[];
  readonly links?: readonly CanonicalLinkInput[];
  /** When set, this record is another observation of an already stored message. */
  readonly observationOf?: { readonly messageId: string; readonly reason: "exact_duplicate" | "user_link" };
}

export interface CanonicalBatch {
  readonly datasetId: string;
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly importBatchId?: string | null;
  readonly recordedAt?: string;
  readonly contacts?: readonly CanonicalContactInput[];
  readonly conversations?: readonly CanonicalConversationInput[];
  readonly messages: readonly CanonicalMessageInput[];
}

export interface IngestResult {
  readonly contactIds: ReadonlyMap<string, string>;
  readonly createdContactKeys: readonly string[];
  readonly createdConversationIds: readonly string[];
  readonly contactsCreated: number;
  readonly conversationsCreated: number;
  readonly messagesInserted: number;
  readonly messagesUpdated: number;
  readonly messagesLinked: number;
  readonly exactDuplicateLinks: number;
  readonly userLinks: number;
  readonly provenanceInserted: number;
  readonly reactionsUpserted: number;
  readonly linksInserted: number;
  /** Records without a resolvable timestamp: kept as provenance only, never as messages. */
  readonly unplacedRecords: number;
  readonly parseCounts: Readonly<Record<ParseStatus, number>>;
  /** Contacts that matched an existing one only weakly and were left separate. */
  readonly reviewSuggestions: readonly {
    readonly contactKey: string;
    readonly candidateContactIds: readonly string[];
  }[];
}

export class IngestError extends Error {
  override readonly name = "IngestError";
}

const NAME_ONLY = new Set<ContactIdentifier["type"]>(["export-name"]);

function contactIdFor(
  datasetId: string,
  input: CanonicalContactInput,
  sourceId: string,
): string {
  const identifiers = input.identifiers.map(normalizeIdentifier);
  const stable = identifiers.find((identifier) => !NAME_ONLY.has(identifier.type) && identifier.type !== "other");
  if (stable !== undefined) {
    return deriveContactId(datasetId, stable.type, stable.value);
  }
  const first = identifiers[0] ?? { type: "export-name" as const, value: input.displayName };
  return deriveContactId(datasetId, first.type, `${first.value}\u0000${input.idSalt ?? sourceId}`);
}

function hasContact(db: SqliteDatabase, id: string): boolean {
  return db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(id) !== undefined;
}

function loadKnown(db: SqliteDatabase, datasetId: string): KnownContact[] {
  const identifiers = db
    .prepare(
      "SELECT contact_id, type, value, source_id, confidence FROM contact_identifiers WHERE dataset_id = ? ORDER BY contact_id",
    )
    .all(datasetId) as {
    contact_id: string;
    type: ContactIdentifier["type"];
    value: string;
    source_id: string | null;
    confidence: Confidence;
  }[];
  const byContact = new Map<string, ContactIdentifier[]>();
  for (const row of identifiers) {
    const list = byContact.get(row.contact_id) ?? [];
    list.push({ type: row.type, value: row.value, confidence: row.confidence });
    byContact.set(row.contact_id, list);
  }
  const contacts = db
    .prepare("SELECT id, display_name, merged_into_contact_id FROM contacts WHERE dataset_id = ?")
    .all(datasetId) as { id: string; display_name: string; merged_into_contact_id: string | null }[];
  return contacts.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    identifiers: byContact.get(row.id) ?? [],
    mergedIntoContactId: row.merged_into_contact_id,
  }));
}

/**
 * Single canonical entry point for Archive Import, Baileys history and Baileys live events.
 * Runs in one transaction; every write is idempotent so replays never duplicate rows.
 */
export function ingestCanonicalBatch(db: SqliteDatabase, batch: CanonicalBatch): IngestResult {
  return db.transaction(() => ingestInTransaction(db, batch))();
}

function ingestInTransaction(db: SqliteDatabase, batch: CanonicalBatch): IngestResult {
  const { datasetId, sourceId } = batch;
  const recordedAt = batch.recordedAt ?? new Date().toISOString();
  const batchId = batch.importBatchId ?? null;
  if (db.prepare("SELECT 1 FROM data_sources WHERE id = ? AND dataset_id = ?").get(sourceId, datasetId) === undefined) {
    throw new IngestError(`unknown source ${sourceId} for dataset ${datasetId}`);
  }

  const upsertContact = db.prepare(`
    INSERT INTO contacts (id, dataset_id, display_name, aliases_json, is_self, color_key)
    VALUES (@id, @datasetId, @displayName, '[]', @isSelf, @colorKey)
    ON CONFLICT (id) DO UPDATE SET is_self = MAX(contacts.is_self, excluded.is_self)`);
  const addAlias = db.prepare("SELECT aliases_json, display_name FROM contacts WHERE id = ?");
  const setAliases = db.prepare("UPDATE contacts SET aliases_json = ? WHERE id = ?");
  const upsertIdentifier = db.prepare(`
    INSERT INTO contact_identifiers (dataset_id, contact_id, type, value, source_id, confidence)
    VALUES (@datasetId, @contactId, @type, @value, @sourceId, @confidence)
    ON CONFLICT (contact_id, type, value) DO NOTHING`);

  const contactIds = new Map<string, string>();
  const createdContactKeys: string[] = [];
  const reviewSuggestions: { contactKey: string; candidateContactIds: string[] }[] = [];
  const known = (batch.contacts?.length ?? 0) > 0 ? loadKnown(db, datasetId) : [];

  for (const input of batch.contacts ?? []) {
    const identifiers = input.identifiers.map((identifier) => ({
      ...normalizeIdentifier(identifier),
      confidence: identifier.confidence,
    }));
    let targetId: string;
    let created = false;
    if (input.linkToContactId !== undefined) {
      if (!hasContact(db, input.linkToContactId)) {
        throw new IngestError(`cannot link to unknown contact ${input.linkToContactId}`);
      }
      targetId = input.linkToContactId;
    } else {
      const resolution = resolveIdentity(identifiers, known);
      if (resolution.kind === "linked") {
        targetId = resolution.contactId;
      } else {
        targetId = contactIdFor(datasetId, input, sourceId);
        created = !hasContact(db, targetId);
        if (resolution.kind === "needs-review") {
          const candidateContactIds = [
            ...new Set(resolution.matches.map((m) => m.contactId)),
          ].filter((id) => id !== targetId);
          if (candidateContactIds.length > 0) {
            reviewSuggestions.push({ contactKey: input.key, candidateContactIds });
          }
        }
      }
    }
    upsertContact.run({
      id: targetId,
      datasetId,
      displayName: input.displayName,
      isSelf: input.isSelf === true ? 1 : 0,
      colorKey: contactColorKey(targetId),
    });
    for (const identifier of identifiers) {
      upsertIdentifier.run({
        datasetId,
        contactId: targetId,
        type: identifier.type,
        value: identifier.value,
        sourceId,
        confidence: identifier.confidence,
      });
    }
    const aliasRow = addAlias.get(targetId) as { aliases_json: string; display_name: string };
    if (aliasRow.display_name !== input.displayName) {
      const aliases = new Set(JSON.parse(aliasRow.aliases_json) as string[]);
      aliases.add(input.displayName);
      setAliases.run(JSON.stringify([...aliases].sort()), targetId);
    }
    contactIds.set(input.key, targetId);
    if (created) {
      createdContactKeys.push(input.key);
    }
  }

  const conversationIds = new Map<string, string>();
  const createdConversationIds: string[] = [];
  const upsertConversation = db.prepare(`
    INSERT INTO conversations (id, dataset_id, source_conversation_id, title, kind)
    VALUES (@id, @datasetId, @key, @title, @kind)
    ON CONFLICT (id) DO UPDATE SET title = excluded.title, kind = excluded.kind`);
  const conversationExists = db.prepare("SELECT 1 FROM conversations WHERE id = ?");
  const registerConversation = (key: string, title: string, kind: ChatKind): string => {
    const known = conversationIds.get(key);
    if (known !== undefined) {
      return known;
    }
    const id = deriveConversationId(datasetId, key);
    const existed = conversationExists.get(id) !== undefined;
    upsertConversation.run({ id, datasetId, key, title, kind });
    if (!existed) {
      createdConversationIds.push(id);
    }
    conversationIds.set(key, id);
    return id;
  };
  for (const conversation of batch.conversations ?? []) {
    registerConversation(conversation.key, conversation.title, conversation.kind);
  }
  const lookupConversation = (key: string): string => {
    const found = conversationIds.get(key);
    if (found !== undefined) {
      return found;
    }
    const id = deriveConversationId(datasetId, key);
    if (conversationExists.get(id) === undefined) {
      throw new IngestError(`message references unknown conversation ${key}`);
    }
    conversationIds.set(key, id);
    return id;
  };

  const insertProvenance = db.prepare(`
    INSERT INTO provenance_records (id, dataset_id, source_id, import_batch_id, source_kind,
      original_timestamp_text, source_locator, parse_status, recorded_at)
    VALUES (@id, @datasetId, @sourceId, @importBatchId, @sourceKind, @originalTimestampText,
      @sourceLocator, @parseStatus, @recordedAt)
    ON CONFLICT (id) DO NOTHING`);
  const upsertMessage = db.prepare(`
    INSERT INTO messages (id, dataset_id, conversation_id, source_message_id, sender_contact_id,
      timestamp_utc, timestamp_local, timezone, direction, kind, text, has_attachment, is_edited,
      is_deleted, source_kind, parse_status, provenance_id, fingerprint, timestamp_precision)
    VALUES (@id, @datasetId, @conversationId, @sourceMessageId, @senderContactId, @timestampUtc,
      @timestampLocal, @timezone, @direction, @kind, @text, @hasAttachment, @isEdited, @isDeleted,
      @sourceKind, @parseStatus, @provenanceId, @fingerprint, @timestampPrecision)
    ON CONFLICT (id) DO UPDATE SET
      sender_contact_id = excluded.sender_contact_id, timestamp_utc = excluded.timestamp_utc,
      timestamp_local = excluded.timestamp_local, timezone = excluded.timezone,
      direction = excluded.direction, kind = excluded.kind, text = excluded.text,
      has_attachment = excluded.has_attachment, is_edited = excluded.is_edited,
      is_deleted = excluded.is_deleted, parse_status = excluded.parse_status,
      timestamp_precision = excluded.timestamp_precision`);
  const messageExists = db.prepare("SELECT 1 FROM messages WHERE id = ?");
  const linkProvenance = db.prepare(`
    INSERT INTO message_provenance (message_id, provenance_id, reason)
    VALUES (?, ?, ?) ON CONFLICT (message_id, provenance_id) DO NOTHING`);
  const upsertParticipant = db.prepare(`
    INSERT INTO conversation_participants (conversation_id, contact_id, first_seen_at, last_seen_at, confidence)
    VALUES (@conversationId, @contactId, @seen, @seen, @confidence)
    ON CONFLICT (conversation_id, contact_id) DO UPDATE SET
      first_seen_at = CASE WHEN conversation_participants.first_seen_at IS NULL THEN excluded.first_seen_at
        WHEN excluded.first_seen_at IS NULL THEN conversation_participants.first_seen_at
        ELSE MIN(conversation_participants.first_seen_at, excluded.first_seen_at) END,
      last_seen_at = CASE WHEN conversation_participants.last_seen_at IS NULL THEN excluded.last_seen_at
        WHEN excluded.last_seen_at IS NULL THEN conversation_participants.last_seen_at
        ELSE MAX(conversation_participants.last_seen_at, excluded.last_seen_at) END`);
  const upsertReaction = db.prepare(`
    INSERT INTO message_reactions (id, message_id, reactor_contact_id, emoji, reacted_at_utc, provenance_id)
    VALUES (@id, @messageId, @reactorContactId, @emoji, @reactedAtUtc, @provenanceId)
    ON CONFLICT (id) DO UPDATE SET reacted_at_utc = excluded.reacted_at_utc`);
  const insertLink = db.prepare(`
    INSERT INTO external_media_links (id, message_id, url, provider, title, link_kind)
    VALUES (@id, @messageId, @url, @provider, @title, @linkKind)
    ON CONFLICT (message_id, url) DO NOTHING`);

  const resolveContact = (key?: string | null, explicit?: string | null): string | null => {
    if (explicit !== undefined && explicit !== null) {
      return explicit;
    }
    if (key === undefined || key === null) {
      return null;
    }
    const resolved = contactIds.get(key);
    if (resolved === undefined) {
      throw new IngestError(`unknown contact key ${key}`);
    }
    return resolved;
  };

  const counters = {
    messagesInserted: 0,
    messagesUpdated: 0,
    messagesLinked: 0,
    exactDuplicateLinks: 0,
    userLinks: 0,
    provenanceInserted: 0,
    reactionsUpserted: 0,
    linksInserted: 0,
    unplacedRecords: 0,
  };
  const parseCounts: Record<ParseStatus, number> = { complete: 0, partial: 0, unparsed: 0 };

  for (const message of batch.messages) {
    parseCounts[message.parseStatus] += 1;
    const conversationId = lookupConversation(message.conversationKey);
    const provId = deriveProvenanceId(datasetId, sourceId, `${message.conversationKey}\u001f${message.locator}`);
    counters.provenanceInserted += insertProvenance.run({
      id: provId,
      datasetId,
      sourceId,
      importBatchId: batchId,
      sourceKind: batch.sourceKind,
      originalTimestampText: message.originalTimestampText ?? null,
      sourceLocator: message.locator,
      parseStatus: message.parseStatus,
      recordedAt,
    }).changes;

    if (message.observationOf !== undefined) {
      const { messageId, reason } = message.observationOf;
      if (messageExists.get(messageId) === undefined) {
        throw new IngestError(`cannot link to unknown message ${messageId}`);
      }
      linkProvenance.run(messageId, provId, reason);
      counters.messagesLinked += 1;
      if (reason === "exact_duplicate") {
        counters.exactDuplicateLinks += 1;
      } else {
        counters.userLinks += 1;
      }
      continue;
    }

    if (message.timestampLocal === null || message.timestampLocal === undefined) {
      counters.unplacedRecords += 1;
      continue;
    }

    const senderContactId = resolveContact(message.senderKey, message.senderContactId);
    const dedupKey =
      message.sourceMessageId === undefined
        ? message.recordKey
        : messageDedupKey({
            conversationKey: message.conversationKey,
            sourceMessageId: message.sourceMessageId,
            participantKey: senderContactId ?? "",
          });
    const id = deriveMessageId(datasetId, conversationId, dedupKey);
    const existed = messageExists.get(id) !== undefined;
    upsertMessage.run({
      id,
      datasetId,
      conversationId,
      sourceMessageId: message.sourceMessageId ?? null,
      senderContactId,
      timestampUtc: message.timestampUtc ?? null,
      timestampLocal: message.timestampLocal,
      timezone: message.timezone,
      direction: message.direction,
      kind: message.kind,
      text: message.text ?? null,
      hasAttachment: message.hasAttachment ? 1 : 0,
      isEdited: message.isEdited === undefined ? null : message.isEdited ? 1 : 0,
      isDeleted: message.isDeleted === undefined ? null : message.isDeleted ? 1 : 0,
      sourceKind: batch.sourceKind,
      parseStatus: message.parseStatus,
      provenanceId: provId,
      fingerprint: message.fingerprint ?? null,
      timestampPrecision: message.timestampPrecision ?? null,
    });
    linkProvenance.run(id, provId, "original");
    if (existed) {
      counters.messagesUpdated += 1;
    } else {
      counters.messagesInserted += 1;
    }
    if (senderContactId !== null && message.kind !== "system") {
      upsertParticipant.run({
        conversationId,
        contactId: senderContactId,
        seen: message.timestampUtc ?? null,
        confidence: "probable",
      });
    }
    for (const reaction of message.reactions ?? []) {
      const reactor = resolveContact(reaction.reactorKey, reaction.reactorContactId);
      counters.reactionsUpserted += upsertReaction.run({
        id: deterministicId("rxn", [id, reactor ?? "", reaction.emoji]),
        messageId: id,
        reactorContactId: reactor,
        emoji: reaction.emoji,
        reactedAtUtc: reaction.reactedAtUtc ?? null,
        provenanceId: provId,
      }).changes > 0
        ? 1
        : 0;
    }
    for (const link of message.links ?? []) {
      counters.linksInserted += insertLink.run({
        id: deterministicId("lnk", [id, link.url]),
        messageId: id,
        url: link.url,
        provider: link.provider,
        title: link.title ?? null,
        linkKind: link.linkKind,
      }).changes;
    }
  }

  for (const conversation of batch.conversations ?? []) {
    const id = lookupConversation(conversation.key);
    for (const key of conversation.participantKeys ?? []) {
      const contact = resolveContact(key);
      if (contact !== null) {
        upsertParticipant.run({
          conversationId: id,
          contactId: contact,
          seen: null,
          confidence: "probable",
        });
      }
    }
  }

  return {
    contactIds,
    createdContactKeys,
    createdConversationIds,
    contactsCreated: createdContactKeys.length,
    conversationsCreated: createdConversationIds.length,
    ...counters,
    parseCounts,
    reviewSuggestions,
  };
}

export function mergeIngestResults(results: readonly IngestResult[]): IngestResult {
  const sum = (pick: (result: IngestResult) => number): number =>
    results.reduce((total, result) => total + pick(result), 0);
  const contactIds = new Map<string, string>();
  for (const result of results) {
    for (const [key, value] of result.contactIds) {
      contactIds.set(key, value);
    }
  }
  return {
    contactIds,
    createdContactKeys: results.flatMap((r) => r.createdContactKeys),
    createdConversationIds: results.flatMap((r) => r.createdConversationIds),
    contactsCreated: sum((r) => r.contactsCreated),
    conversationsCreated: sum((r) => r.conversationsCreated),
    messagesInserted: sum((r) => r.messagesInserted),
    messagesUpdated: sum((r) => r.messagesUpdated),
    messagesLinked: sum((r) => r.messagesLinked),
    exactDuplicateLinks: sum((r) => r.exactDuplicateLinks),
    userLinks: sum((r) => r.userLinks),
    provenanceInserted: sum((r) => r.provenanceInserted),
    reactionsUpserted: sum((r) => r.reactionsUpserted),
    linksInserted: sum((r) => r.linksInserted),
    unplacedRecords: sum((r) => r.unplacedRecords),
    parseCounts: {
      complete: sum((r) => r.parseCounts.complete),
      partial: sum((r) => r.parseCounts.partial),
      unparsed: sum((r) => r.parseCounts.unparsed),
    },
    reviewSuggestions: results.flatMap((r) => r.reviewSuggestions),
  };
}

/**
 * Same as `ingestCanonicalBatch` but commits `chunkSize` messages per transaction (contacts and
 * conversations are re-applied idempotently with each chunk). A failure rolls back only the failing chunk and a
 * rerun is idempotent, which is how large Baileys history batches are persisted.
 */
export function ingestCanonicalBatchChunked(
  db: SqliteDatabase,
  batch: CanonicalBatch,
  chunkSize = 500,
): IngestResult {
  const slices = chunk(batch.messages, chunkSize);
  if (slices.length === 0) {
    return ingestCanonicalBatch(db, batch);
  }
  const results = slices.map((slice) => ingestCanonicalBatch(db, { ...batch, messages: slice }));
  return mergeIngestResults(results);
}
