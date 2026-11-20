import type {
  ConnectorCheckpoint,
  ConnectorIngestBatch,
  ConnectorIngestionSink,
  Contact,
  Conversation,
  ConversationParticipant,
  IngestOutcome,
  Message,
  MessageReaction,
} from "./ingestion-types.js";

/** Reference in-memory sink with the semantics SQLite ingestion must provide. Used in tests. */
export class InMemoryIngestionSink implements ConnectorIngestionSink {
  readonly conversations = new Map<string, Conversation>();
  readonly contacts = new Map<string, Contact>();
  readonly participants = new Map<string, ConversationParticipant>();
  readonly messages = new Map<string, Message>();
  readonly reactions = new Map<string, MessageReaction>();
  readonly checkpoints = new Map<string, ConnectorCheckpoint>();
  batches = 0;
  failNext = false;

  loadCheckpoint(datasetId: string): Promise<ConnectorCheckpoint | undefined> {
    return Promise.resolve(this.checkpoints.get(datasetId));
  }

  ingest(batch: ConnectorIngestBatch): Promise<IngestOutcome> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("synthetic sink failure"));
    }
    this.batches += 1;
    for (const conversation of batch.conversations) {
      this.conversations.set(conversation.id, conversation);
    }
    for (const contact of batch.contacts) {
      this.contacts.set(contact.id, contact);
    }
    for (const participant of batch.participants) {
      this.participants.set(`${participant.conversationId}|${participant.contactId}`, participant);
    }
    let inserted = 0;
    let duplicates = 0;
    for (const message of batch.messages) {
      if (this.messages.has(message.id)) {
        duplicates += 1;
      } else {
        inserted += 1;
      }
      this.messages.set(message.id, message);
    }
    for (const reaction of batch.reactions) {
      this.reactions.set(reaction.id, reaction);
    }
    for (const id of batch.removedReactionIds) {
      this.reactions.delete(id);
    }
    for (const edit of batch.edits) {
      const existing = this.messages.get(edit.messageId);
      if (existing !== undefined) {
        this.messages.set(edit.messageId, { ...existing, text: edit.text, isEdited: true });
      }
    }
    for (const id of batch.deletedMessageIds) {
      const existing = this.messages.get(id);
      if (existing !== undefined) {
        this.messages.set(id, {
          id: existing.id,
          datasetId: existing.datasetId,
          conversationId: existing.conversationId,
          ...(existing.sourceMessageId === undefined ? {} : { sourceMessageId: existing.sourceMessageId }),
          ...(existing.senderContactId === undefined ? {} : { senderContactId: existing.senderContactId }),
          ...(existing.timestampUtc === undefined ? {} : { timestampUtc: existing.timestampUtc }),
          timestampLocal: existing.timestampLocal,
          timezone: existing.timezone,
          direction: existing.direction,
          kind: existing.kind,
          hasAttachment: existing.hasAttachment,
          ...(existing.isEdited === undefined ? {} : { isEdited: existing.isEdited }),
          isDeleted: true,
          sourceKind: existing.sourceKind,
          parseStatus: existing.parseStatus,
          provenanceId: existing.provenanceId,
        });
      }
    }
    this.checkpoints.set(batch.datasetId, batch.checkpoint);
    return Promise.resolve({ insertedMessages: inserted, duplicateMessages: duplicates });
  }
}
