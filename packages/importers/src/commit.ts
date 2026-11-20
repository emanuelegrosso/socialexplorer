import type { CommitItem, ContactResolution, ResolvedMergePlan } from "./merge.js";
import { ImportAbortedError } from "./types.js";

export type ImportBatchStatus =
  "pending" | "parsing" | "previewing" | "committing" | "committed" | "failed" | "canceled";

const TRANSITIONS: Readonly<Record<ImportBatchStatus, readonly ImportBatchStatus[]>> = {
  pending: ["parsing", "failed", "canceled"],
  parsing: ["previewing", "failed", "canceled"],
  previewing: ["committing", "failed", "canceled"],
  committing: ["committing", "committed", "failed", "canceled"],
  committed: [],
  failed: ["committing", "canceled"],
  canceled: ["committing"],
};

export function canTransition(from: ImportBatchStatus, to: ImportBatchStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface ImportCheckpoint {
  readonly batchId: string;
  readonly planId: string;
  readonly status: ImportBatchStatus;
  readonly chunkSize: number;
  readonly totalChunks: number;
  /** Index of the next chunk that has NOT been durably committed. */
  readonly nextChunkIndex: number;
  readonly committedItems: number;
  readonly error: string | null;
}

export interface CommitChunk {
  readonly batchId: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly items: readonly CommitItem[];
  /** Contact decisions travel with chunk 0 so messages never precede their contacts. */
  readonly contacts: readonly ContactResolution[];
}

/**
 * Persistence boundary implemented by `@social-explorer/database` in a later wave.
 *
 * Contract:
 * - `commitChunk` applies the chunk and persists `checkpoint` (with `nextChunkIndex` already
 *   advanced) in ONE transaction. A crash mid-chunk must leave neither partial rows nor an
 *   advanced checkpoint.
 * - It must be idempotent: if the stored checkpoint already covers `chunk.chunkIndex`, no-op.
 * - Rows of a batch must stay invisible to analytics until the batch is `committed`.
 */
export interface ImportCommitSink {
  loadCheckpoint(batchId: string): Promise<ImportCheckpoint | null>;
  saveCheckpoint(checkpoint: ImportCheckpoint): Promise<void>;
  commitChunk(chunk: CommitChunk, checkpoint: ImportCheckpoint): Promise<void>;
  rollbackBatch(batchId: string): Promise<void>;
}

export interface CommitProgress {
  readonly batchId: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly committedItems: number;
  readonly totalItems: number;
}

export interface CommitArchiveOptions {
  readonly batchId: string;
  readonly plan: ResolvedMergePlan;
  readonly sink: ImportCommitSink;
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CommitProgress) => void;
  /** Default `rollback`: cancel removes everything staged for the batch. */
  readonly onCancel?: "rollback" | "keep";
  /** Default `keep`: a failed batch stays resumable by calling commit again with the same id. */
  readonly onFailure?: "rollback" | "keep";
}

export interface CommitResult {
  readonly batchId: string;
  readonly status: ImportBatchStatus;
  readonly committedChunks: number;
  readonly totalChunks: number;
  readonly committedItems: number;
  readonly resumedFromChunk: number;
  readonly rolledBack: boolean;
}

export class ImportCommitError extends Error {
  override readonly name = "ImportCommitError";
  constructor(
    message: string,
    readonly batchId: string,
    readonly committedChunks: number,
    readonly rolledBack: boolean,
    options?: { cause: unknown },
  ) {
    super(message, options);
  }
}

export class IncompletePlanError extends Error {
  override readonly name = "IncompletePlanError";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Commits a fully resolved merge plan in chunks, checkpointing after every chunk so that
 * calling it again with the same `batchId` resumes after a crash, failure or cancellation.
 */
export async function commitArchiveImport(options: CommitArchiveOptions): Promise<CommitResult> {
  const { batchId, plan, sink, signal } = options;
  if (!plan.complete) {
    throw new IncompletePlanError(
      `${String(plan.unresolved.length)} ambiguous record(s) still need an explicit resolution`,
    );
  }
  const chunkSize = options.chunkSize ?? 500;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("chunkSize must be a positive integer");
  }

  const items = plan.commitItems;
  const needsFirstChunk = items.length > 0 || plan.contacts.length > 0;
  const totalChunks = needsFirstChunk ? Math.max(1, Math.ceil(items.length / chunkSize)) : 0;

  const existing = await sink.loadCheckpoint(batchId);
  if (existing !== null) {
    if (existing.planId !== plan.planId) {
      throw new IncompletePlanError(`Batch "${batchId}" belongs to a different merge plan`);
    }
    if (existing.chunkSize !== chunkSize) {
      throw new RangeError(
        `Batch "${batchId}" was started with chunkSize ${String(existing.chunkSize)}`,
      );
    }
    if (existing.status === "committed") {
      return {
        batchId,
        status: "committed",
        committedChunks: existing.totalChunks,
        totalChunks: existing.totalChunks,
        committedItems: existing.committedItems,
        resumedFromChunk: existing.totalChunks,
        rolledBack: false,
      };
    }
  }

  let checkpoint: ImportCheckpoint = {
    batchId,
    planId: plan.planId,
    status: "committing",
    chunkSize,
    totalChunks,
    nextChunkIndex: existing?.nextChunkIndex ?? 0,
    committedItems: existing?.committedItems ?? 0,
    error: null,
  };
  const resumedFromChunk = checkpoint.nextChunkIndex;

  const rollback = async (): Promise<boolean> => {
    try {
      await sink.rollbackBatch(batchId);
      return true;
    } catch {
      return false;
    }
  };

  try {
    await sink.saveCheckpoint(checkpoint);
    for (let index = checkpoint.nextChunkIndex; index < totalChunks; index++) {
      if (signal?.aborted === true) {
        throw new ImportAbortedError();
      }
      const slice = items.slice(index * chunkSize, (index + 1) * chunkSize);
      const next: ImportCheckpoint = {
        ...checkpoint,
        nextChunkIndex: index + 1,
        committedItems: checkpoint.committedItems + slice.length,
      };
      await sink.commitChunk(
        {
          batchId,
          chunkIndex: index,
          totalChunks,
          items: slice,
          contacts: index === 0 ? plan.contacts : [],
        },
        next,
      );
      checkpoint = next;
      options.onProgress?.({
        batchId,
        chunkIndex: index,
        totalChunks,
        committedItems: checkpoint.committedItems,
        totalItems: items.length,
      });
    }
    if (signal?.aborted === true && checkpoint.nextChunkIndex < totalChunks) {
      throw new ImportAbortedError();
    }
    checkpoint = { ...checkpoint, status: "committed", error: null };
    await sink.saveCheckpoint(checkpoint);
    return {
      batchId,
      status: "committed",
      committedChunks: totalChunks,
      totalChunks,
      committedItems: checkpoint.committedItems,
      resumedFromChunk,
      rolledBack: false,
    };
  } catch (error) {
    if (error instanceof ImportAbortedError) {
      const rolledBack = (options.onCancel ?? "rollback") === "rollback" ? await rollback() : false;
      if (!rolledBack) {
        await sink.saveCheckpoint({ ...checkpoint, status: "canceled" }).catch(() => undefined);
      }
      return {
        batchId,
        status: "canceled",
        committedChunks: rolledBack ? 0 : checkpoint.nextChunkIndex,
        totalChunks,
        committedItems: rolledBack ? 0 : checkpoint.committedItems,
        resumedFromChunk,
        rolledBack,
      };
    }
    const rolledBack = (options.onFailure ?? "keep") === "rollback" ? await rollback() : false;
    if (!rolledBack) {
      await sink
        .saveCheckpoint({ ...checkpoint, status: "failed", error: describe(error) })
        .catch(() => undefined);
    }
    throw new ImportCommitError(
      `Import batch "${batchId}" failed: ${describe(error)}`,
      batchId,
      rolledBack ? 0 : checkpoint.nextChunkIndex,
      rolledBack,
      { cause: error },
    );
  }
}
