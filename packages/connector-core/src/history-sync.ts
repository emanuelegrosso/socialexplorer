import type { PortHistorySet, PortHistoryStatus } from "@social-explorer/baileys-adapter";
import { DraftBuilder } from "./draft-builder.js";
import type { CanonicalMapper } from "./mapper.js";
import type { SyncState } from "./sync-state.js";

export interface HistorySyncResult {
  readonly insertedMessages: number;
  readonly duplicateMessages: number;
}

/** Processes `messaging-history.set` chunks and `messaging-history.status` milestones. */
export class HistorySyncProcessor {
  constructor(
    private readonly mapper: CanonicalMapper,
    private readonly state: SyncState,
  ) {}

  async handleChunk(chunk: PortHistorySet): Promise<HistorySyncResult> {
    const coverage = this.state.coverage;
    if (coverage.status === "not-started" || coverage.status === "partial") {
      coverage.status = "syncing";
      this.state.removeWarning("history-interrupted");
    }
    if (typeof chunk.progress === "number") {
      coverage.progress = Math.max(0, Math.min(100, chunk.progress));
    }
    const builder = new DraftBuilder(this.mapper, "baileys-history")
      .addContacts(chunk.contacts)
      .addChats(chunk.chats)
      .addMessages(chunk.messages);
    builder.draft.forceCheckpoint = true;
    const seenBefore = builder.draft.messages.filter((m) => this.state.hasSeenMessage(m.id)).length;
    const outcome = await this.state.commit(builder.draft);
    if (chunk.isLatest === true && coverage.progress === undefined) {
      coverage.progress = 100;
    }
    return {
      insertedMessages: outcome?.insertedMessages ?? 0,
      duplicateMessages: (outcome?.duplicateMessages ?? 0) + seenBefore,
    };
  }

  handleStatus(status: PortHistoryStatus): void {
    const coverage = this.state.coverage;
    if (status.status === "paused") {
      coverage.status = "partial";
      this.state.addWarning("history-paused");
      return;
    }
    this.state.removeWarning("history-paused");
    this.state.addWarning("history-coverage-limited");
    if (!status.explicit) {
      coverage.status = "partial";
      this.state.addWarning("history-completion-inferred");
      return;
    }
    this.state.removeWarning("history-completion-inferred");
    coverage.status = "complete";
    coverage.progress = 100;
    if (coverage.messagesIngested === 0 && coverage.newestMessageTimestampMs === undefined) {
      this.state.addWarning("history-empty");
    }
  }

  /** Called when the connection drops while history is still arriving. */
  markInterrupted(): void {
    if (this.state.coverage.status === "syncing") {
      this.state.coverage.status = "partial";
      this.state.addWarning("history-interrupted");
    }
  }
}
