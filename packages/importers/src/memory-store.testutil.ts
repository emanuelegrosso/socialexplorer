import type {
  CommitChunk,
  ExistingContactRef,
  ExistingDatasetIndex,
  ExistingMessageRef,
  ImportCheckpoint,
  ImportCommitSink,
  NormalizedMessage,
} from "./index.js";
import { normalizeSenderKey } from "./index.js";

export function toExistingRef(message: NormalizedMessage, id: string): ExistingMessageRef {
  return {
    id,
    conversationKey: message.conversationKey,
    senderName: message.senderName,
    text: message.text,
    contentKey: message.contentKey,
    timestampUtc: message.timestampUtc,
    timestampPrecision: message.timestampPrecision,
  };
}

export class MemoryIndex implements ExistingDatasetIndex {
  constructor(
    readonly messages: ExistingMessageRef[] = [],
    readonly contacts: ExistingContactRef[] = [],
  ) {}

  findByContentKeys(
    conversationKey: string,
    keys: readonly string[],
  ): Promise<readonly ExistingMessageRef[]> {
    const wanted = new Set(keys);
    return Promise.resolve(
      this.messages.filter(
        (m) => m.conversationKey === conversationKey && wanted.has(m.contentKey),
      ),
    );
  }

  findInTimeWindow(
    conversationKey: string,
    fromUtc: string,
    toUtc: string,
  ): Promise<readonly ExistingMessageRef[]> {
    return Promise.resolve(
      this.messages.filter(
        (m) =>
          m.conversationKey === conversationKey &&
          m.timestampUtc !== null &&
          m.timestampUtc >= fromUtc &&
          m.timestampUtc <= toUtc,
      ),
    );
  }

  findContactsByDisplayName(
    names: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ExistingContactRef[]>> {
    const map = new Map<string, ExistingContactRef[]>();
    for (const name of names) {
      const key = normalizeSenderKey(name);
      const hits = this.contacts.filter((c) => normalizeSenderKey(c.displayName) === key);
      if (hits.length > 0) {
        map.set(key, hits);
      }
    }
    return Promise.resolve(map);
  }
}

/** Transactional in-memory sink; `crashAt` simulates a crash after partially staging a chunk. */
export class MemorySink implements ImportCommitSink {
  readonly rows = new Map<string, string[]>();
  readonly checkpoints = new Map<string, ImportCheckpoint>();
  crashOnChunk: number | null = null;
  failSaveStatus: string | null = null;
  commitCalls = 0;

  loadCheckpoint(batchId: string): Promise<ImportCheckpoint | null> {
    return Promise.resolve(this.checkpoints.get(batchId) ?? null);
  }

  saveCheckpoint(checkpoint: ImportCheckpoint): Promise<void> {
    if (this.failSaveStatus === checkpoint.status) {
      return Promise.reject(new Error("simulated process death"));
    }
    this.checkpoints.set(checkpoint.batchId, checkpoint);
    return Promise.resolve();
  }

  commitChunk(chunk: CommitChunk, checkpoint: ImportCheckpoint): Promise<void> {
    this.commitCalls++;
    const stored = this.checkpoints.get(chunk.batchId);
    if (stored !== undefined && stored.nextChunkIndex > chunk.chunkIndex) {
      return Promise.resolve();
    }
    const staged = [...(this.rows.get(chunk.batchId) ?? [])];
    chunk.items.forEach((item, position) => {
      if (
        this.crashOnChunk === chunk.chunkIndex &&
        position === Math.floor(chunk.items.length / 2)
      ) {
        throw new Error("simulated mid-chunk crash");
      }
      staged.push(`${item.kind}:${item.message.recordId}`);
    });
    this.rows.set(chunk.batchId, staged);
    this.checkpoints.set(chunk.batchId, checkpoint);
    return Promise.resolve();
  }

  rollbackBatch(batchId: string): Promise<void> {
    this.rows.delete(batchId);
    this.checkpoints.delete(batchId);
    return Promise.resolve();
  }
}
