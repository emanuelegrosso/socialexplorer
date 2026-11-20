import {
  contactSchema,
  conversationParticipantSchema,
  conversationSchema,
  messageReactionSchema,
  messageSchema,
  type Contact,
  type Conversation,
  type ConversationParticipant,
  type Message,
  type MessageReaction,
} from "@social-explorer/contracts";
import { z } from "zod";

export const HISTORY_WARNING_CODES = [
  "history-paused",
  "history-completion-inferred",
  "history-interrupted",
  "history-empty",
  "history-coverage-limited",
] as const;

export const historyWarningSchema = z.enum(HISTORY_WARNING_CODES);
export type HistoryWarning = z.infer<typeof historyWarningSchema>;

export const historyStatusSchema = z.enum(["not-started", "syncing", "complete", "partial"]);
export type HistoryStatus = z.infer<typeof historyStatusSchema>;

export const CHECKPOINT_MESSAGE_ID_CAP = 5_000;

export const checkpointSchema = z.strictObject({
  version: z.literal(1),
  datasetId: z.string().min(1),
  historyStatus: historyStatusSchema,
  historyBatchesApplied: z.number().int().nonnegative(),
  historyProgress: z.number().min(0).max(100).optional(),
  historyWarnings: z.array(historyWarningSchema),
  oldestMessageTimestampMs: z.number().int().nonnegative().optional(),
  newestMessageTimestampMs: z.number().int().nonnegative().optional(),
  newestByConversation: z.record(z.string(), z.number().int().nonnegative()),
  recentMessageIds: z.array(z.string()).max(CHECKPOINT_MESSAGE_ID_CAP),
  lastLiveEventAtMs: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type ConnectorCheckpoint = z.infer<typeof checkpointSchema>;

export const ingestBatchSchema = z.strictObject({
  datasetId: z.string().min(1),
  source: z.enum(["baileys-history", "baileys-live"]),
  conversations: z.array(conversationSchema),
  contacts: z.array(contactSchema),
  participants: z.array(conversationParticipantSchema),
  messages: z.array(messageSchema),
  reactions: z.array(messageReactionSchema),
  removedReactionIds: z.array(z.string().min(1)),
  edits: z.array(
    z.strictObject({
      messageId: z.string().min(1),
      text: z.string(),
      editedAtMs: z.number().int().nonnegative().optional(),
    }),
  ),
  deletedMessageIds: z.array(z.string().min(1)),
  deletedConversationIds: z.array(z.string().min(1)),
  checkpoint: checkpointSchema,
});
export type ConnectorIngestBatch = z.infer<typeof ingestBatchSchema>;

export interface IngestOutcome {
  readonly insertedMessages: number;
  readonly duplicateMessages: number;
}

/**
 * Persistence boundary for the connector. The SQLite ingestion layer implements this; the connector
 * never touches a database directly. Implementations MUST apply a batch and its checkpoint
 * atomically and treat canonical ids as idempotent upserts.
 */
export interface ConnectorIngestionSink {
  loadCheckpoint(datasetId: string): Promise<ConnectorCheckpoint | undefined>;
  ingest(batch: ConnectorIngestBatch): Promise<IngestOutcome>;
}

export type { Contact, Conversation, ConversationParticipant, Message, MessageReaction };
