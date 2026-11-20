import { hashObject } from "@social-explorer/shared";
import {
  CHECKPOINT_MESSAGE_ID_CAP,
  type ConnectorCheckpoint,
  type ConnectorIngestBatch,
  type ConnectorIngestionSink,
  type Contact,
  type Conversation,
  type ConversationParticipant,
  type HistoryStatus,
  type HistoryWarning,
  type IngestOutcome,
  type Message,
  type MessageReaction,
} from "./ingestion-types.js";

const SEEN_CAP = 50_000;

export interface HistoryCoverage {
  status: HistoryStatus;
  progress?: number;
  batchesApplied: number;
  messagesIngested: number;
  duplicatesSkipped: number;
  oldestMessageTimestampMs?: number;
  newestMessageTimestampMs?: number;
  warnings: HistoryWarning[];
}

/**
 * Shared dedup/checkpoint state for history and live processors. Seen ids survive reconnects
 * (same instance) and process restarts (restored from the checkpoint).
 */
export class SyncState {
  private readonly seenMessages = new Set<string>();
  private readonly seenFingerprints = new Map<string, string>();
  readonly newestByConversation = new Map<string, number>();
  readonly coverage: HistoryCoverage = {
    status: "not-started",
    batchesApplied: 0,
    messagesIngested: 0,
    duplicatesSkipped: 0,
    warnings: [],
  };
  lastLiveEventAtMs: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly datasetId: string,
    private readonly sink: ConnectorIngestionSink,
    private readonly now: () => number,
  ) {}

  restore(checkpoint: ConnectorCheckpoint | undefined): void {
    if (checkpoint === undefined) {
      return;
    }
    for (const id of checkpoint.recentMessageIds) {
      this.seenMessages.add(id);
    }
    for (const [conversationId, timestamp] of Object.entries(checkpoint.newestByConversation)) {
      this.newestByConversation.set(conversationId, timestamp);
    }
    this.coverage.status = checkpoint.historyStatus;
    this.coverage.batchesApplied = checkpoint.historyBatchesApplied;
    this.coverage.warnings = [...checkpoint.historyWarnings];
    if (checkpoint.historyProgress !== undefined) {
      this.coverage.progress = checkpoint.historyProgress;
    }
    if (checkpoint.oldestMessageTimestampMs !== undefined) {
      this.coverage.oldestMessageTimestampMs = checkpoint.oldestMessageTimestampMs;
    }
    if (checkpoint.newestMessageTimestampMs !== undefined) {
      this.coverage.newestMessageTimestampMs = checkpoint.newestMessageTimestampMs;
    }
    this.lastLiveEventAtMs = checkpoint.lastLiveEventAtMs;
  }

  hasSeenMessage(id: string): boolean {
    return this.seenMessages.has(id);
  }

  private markSeen(id: string): void {
    this.seenMessages.add(id);
    if (this.seenMessages.size > SEEN_CAP) {
      const oldest = this.seenMessages.values().next();
      if (oldest.done !== true) {
        this.seenMessages.delete(oldest.value);
      }
    }
  }

  /** True when the entity is new or changed since the last time it was sent to the sink. */
  isChanged(kind: string, id: string, value: unknown): boolean {
    return this.seenFingerprints.get(`${kind}:${id}`) !== hashObject(value);
  }

  private remember(kind: string, id: string, value: unknown): void {
    this.seenFingerprints.set(`${kind}:${id}`, hashObject(value));
  }

  addWarning(warning: HistoryWarning): void {
    if (!this.coverage.warnings.includes(warning)) {
      this.coverage.warnings.push(warning);
    }
  }

  removeWarning(warning: HistoryWarning): void {
    this.coverage.warnings = this.coverage.warnings.filter((entry) => entry !== warning);
  }

  checkpoint(): ConnectorCheckpoint {
    const recent = [...this.seenMessages].slice(-CHECKPOINT_MESSAGE_ID_CAP);
    return {
      version: 1,
      datasetId: this.datasetId,
      historyStatus: this.coverage.status,
      historyBatchesApplied: this.coverage.batchesApplied,
      ...(this.coverage.progress === undefined ? {} : { historyProgress: this.coverage.progress }),
      historyWarnings: [...this.coverage.warnings],
      ...(this.coverage.oldestMessageTimestampMs === undefined
        ? {}
        : { oldestMessageTimestampMs: this.coverage.oldestMessageTimestampMs }),
      ...(this.coverage.newestMessageTimestampMs === undefined
        ? {}
        : { newestMessageTimestampMs: this.coverage.newestMessageTimestampMs }),
      newestByConversation: Object.fromEntries(this.newestByConversation),
      recentMessageIds: recent,
      ...(this.lastLiveEventAtMs === undefined ? {} : { lastLiveEventAtMs: this.lastLiveEventAtMs }),
      updatedAtMs: this.now(),
    };
  }

  /**
   * Sends a batch through the single-writer queue. Entities and message ids are only marked as seen
   * after the sink accepts the batch, so a failed batch is retried by the next replay.
   */
  commit(draft: BatchDraft): Promise<IngestOutcome | undefined> {
    const run = async (): Promise<IngestOutcome | undefined> => {
      const inDraft = new Set<string>();
      const messages = draft.messages.filter((message) => {
        if (this.seenMessages.has(message.id) || inDraft.has(message.id)) {
          return false;
        }
        inDraft.add(message.id);
        return true;
      });
      const conversations = draft.conversations.filter((entry) => this.isChanged("conv", entry.id, entry));
      const contacts = draft.contacts.filter((entry) => this.isChanged("contact", entry.id, entry));
      const participants = mergeParticipants(draft.participants);
      const empty =
        messages.length === 0 &&
        conversations.length === 0 &&
        contacts.length === 0 &&
        participants.length === 0 &&
        draft.reactions.length === 0 &&
        draft.removedReactionIds.length === 0 &&
        draft.edits.length === 0 &&
        draft.deletedMessageIds.length === 0 &&
        draft.deletedConversationIds.length === 0;
      this.coverage.duplicatesSkipped += draft.messages.length - messages.length;
      if (empty && !draft.forceCheckpoint) {
        return undefined;
      }
      const prior = { ...this.coverage, warnings: [...this.coverage.warnings] };
      const priorLive = this.lastLiveEventAtMs;
      const priorNewest = new Map(this.newestByConversation);
      const priorSeen = new Set(this.seenMessages);
      for (const message of messages) {
        this.markSeen(message.id);
        const timestamp = message.timestampUtc === undefined ? undefined : Date.parse(message.timestampUtc);
        if (timestamp !== undefined && !Number.isNaN(timestamp)) {
          const newest = this.newestByConversation.get(message.conversationId) ?? 0;
          this.newestByConversation.set(message.conversationId, Math.max(newest, timestamp));
          this.coverage.oldestMessageTimestampMs = Math.min(
            this.coverage.oldestMessageTimestampMs ?? timestamp,
            timestamp,
          );
          this.coverage.newestMessageTimestampMs = Math.max(
            this.coverage.newestMessageTimestampMs ?? timestamp,
            timestamp,
          );
        }
      }
      if (draft.source === "baileys-history") {
        this.coverage.batchesApplied += 1;
        this.coverage.messagesIngested += messages.length;
      } else {
        this.lastLiveEventAtMs = this.now();
      }
      const batch: ConnectorIngestBatch = {
        datasetId: this.datasetId,
        source: draft.source,
        conversations,
        contacts,
        participants,
        messages,
        reactions: draft.reactions,
        removedReactionIds: draft.removedReactionIds,
        edits: draft.edits,
        deletedMessageIds: draft.deletedMessageIds,
        deletedConversationIds: draft.deletedConversationIds,
        checkpoint: this.checkpoint(),
      };
      try {
        const outcome = await this.sink.ingest(batch);
        for (const entry of conversations) {
          this.remember("conv", entry.id, entry);
        }
        for (const entry of contacts) {
          this.remember("contact", entry.id, entry);
        }
        return outcome;
      } catch (error) {
        Object.assign(this.coverage, prior);
        this.lastLiveEventAtMs = priorLive;
        this.newestByConversation.clear();
        for (const [key, value] of priorNewest) {
          this.newestByConversation.set(key, value);
        }
        this.seenMessages.clear();
        for (const id of priorSeen) {
          this.seenMessages.add(id);
        }
        throw error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function mergeParticipants(participants: readonly ConversationParticipant[]): ConversationParticipant[] {
  const merged = new Map<string, ConversationParticipant>();
  for (const entry of participants) {
    const key = `${entry.conversationId}|${entry.contactId}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, entry);
      continue;
    }
    const first = [existing.firstSeenAt, entry.firstSeenAt].filter((v): v is string => v !== undefined).sort()[0];
    const last = [existing.lastSeenAt, entry.lastSeenAt].filter((v): v is string => v !== undefined).sort().at(-1);
    merged.set(key, {
      ...existing,
      ...(first === undefined ? {} : { firstSeenAt: first }),
      ...(last === undefined ? {} : { lastSeenAt: last }),
    });
  }
  return [...merged.values()];
}

export interface BatchDraft {
  source: "baileys-history" | "baileys-live";
  conversations: Conversation[];
  contacts: Contact[];
  participants: ConversationParticipant[];
  messages: Message[];
  reactions: MessageReaction[];
  removedReactionIds: string[];
  edits: { messageId: string; text: string; editedAtMs?: number }[];
  deletedMessageIds: string[];
  deletedConversationIds: string[];
  forceCheckpoint?: boolean;
}

export function emptyDraft(source: BatchDraft["source"]): BatchDraft {
  return {
    source,
    conversations: [],
    contacts: [],
    participants: [],
    messages: [],
    reactions: [],
    removedReactionIds: [],
    edits: [],
    deletedMessageIds: [],
    deletedConversationIds: [],
  };
}
