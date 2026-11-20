import { createHash, randomUUID } from "node:crypto";
import type {
  ArchiveCommitResult,
  ArchiveConfirmResult,
  ArchivePickFileResult,
  ArchivePreview,
  IpcRequest,
} from "@social-explorer/contracts";
import {
  SqliteExistingDatasetIndex,
  SqliteImportCommitSink,
  ensureDataset,
  registerArchiveSource,
  type Repositories,
  type SqliteDatabase,
} from "@social-explorer/database";
import {
  ConfirmationError,
  ImportCommitError,
  IncompletePlanError,
  MergeResolutionError,
  applyConfirmation,
  buildMergeReviewPlan,
  commitArchiveImport,
  previewArchiveImport,
  resolveMergePlan,
  type ArchivePreviewResult,
  type MergeReviewPlan,
  type NormalizedConversation,
} from "@social-explorer/importers";
import { createAnalyticsEngine } from "@social-explorer/analytics";
import { IpcRejectedError } from "./ipc-router.js";

export interface PickedArchive {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ArchiveImportServiceOptions {
  readonly db: SqliteDatabase;
  readonly repositories: Repositories;
  /** Shows the native open dialog in production; injected so tests need no Electron. */
  readonly pickFile?: (() => Promise<PickedArchive | undefined>) | undefined;
  readonly now?: () => string;
}

interface Staged {
  readonly id: string;
  readonly name: string;
  readonly data: Uint8Array;
  readonly contentHash: string;
  parsed?: ArchivePreviewResult;
  confirmed?: {
    readonly datasetId: string;
    readonly timezone: string;
    readonly selfNames: readonly string[];
    readonly conversations: readonly NormalizedConversation[];
    readonly review: MergeReviewPlan;
    readonly batchId: string;
  };
}

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

/**
 * Main-process owner of the Archive Import workflow. Archive bytes never cross IPC: the renderer
 * only holds opaque staged ids returned by `pickFile`.
 */
export class ArchiveImportService {
  private readonly staged = new Map<string, Staged>();
  private readonly now: () => string;

  constructor(private readonly options: ArchiveImportServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private get(stagedId: string): Staged {
    const staged = this.staged.get(stagedId);
    if (staged === undefined) {
      throw new IpcRejectedError("unknown or expired staged archive");
    }
    return staged;
  }

  /** Stages bytes directly (tests, drag-and-drop handled in main). */
  stage(archive: PickedArchive): string {
    const id = randomUUID();
    this.staged.set(id, {
      id,
      name: archive.name,
      data: archive.data,
      contentHash: createHash("sha256").update(archive.data).digest("hex"),
    });
    return id;
  }

  async pickFile(): Promise<ArchivePickFileResult> {
    if (this.options.pickFile === undefined) {
      throw new IpcRejectedError("file selection is not available");
    }
    const picked = await this.options.pickFile();
    if (picked === undefined) {
      return { canceled: true };
    }
    return {
      canceled: false,
      stagedId: this.stage(picked),
      name: picked.name,
      sizeBytes: picked.data.length,
    };
  }

  async preview(stagedId: string): Promise<ArchivePreview> {
    const staged = this.get(stagedId);
    try {
      staged.parsed ??= await previewArchiveImport({ name: staged.name, data: staged.data });
    } catch {
      throw new IpcRejectedError("the archive could not be read as a WhatsApp export");
    }
    const { preview } = staged.parsed;
    return {
      stagedId,
      name: preview.name,
      container: preview.container,
      platform: preview.platform,
      conversationCount: preview.conversationCount,
      totalRecords: preview.totalRecords,
      countsByParseStatus: { ...preview.countsByParseStatus },
      dateRange: preview.dateRange === null ? null : { ...preview.dateRange },
      conversations: preview.conversations.map((conversation) => ({
        sourceFile: conversation.sourceFile,
        title: conversation.title,
        isGroup: conversation.isGroup,
        messageCount: conversation.messageCount,
        systemMessageCount: conversation.systemMessageCount,
      })),
      contactCandidates: preview.contactCandidates.map((c) => ({ ...c })),
      mediaReferenceCount: preview.mediaReferenceCount,
      externalLinkCount: preview.externalLinkCount,
      confirmation: {
        timezoneCandidates: preview.confirmation.timezoneCandidates.map((c) => ({
          timezone: c.timezone,
          source: c.source,
          recommended: c.recommended,
        })),
        selfCandidates: preview.confirmation.selfCandidates.map((c) => ({
          name: c.name,
          messageCount: c.messageCount,
          selfEvidence: c.selfEvidence,
          likelyOther: c.likelyOther,
          recommended: c.recommended,
        })),
        dateOrderReviews: preview.confirmation.dateOrderReviews.map((r) => ({
          conversation: r.conversation,
          dateOrder: r.dateOrder,
          confidence: r.confidence,
          requiresConfirmation: r.requiresConfirmation,
        })),
      },
    };
  }

  async confirm(request: IpcRequest<"archive-import:confirm">): Promise<ArchiveConfirmResult> {
    const staged = this.get(request.stagedId);
    if (staged.parsed === undefined) {
      throw new IpcRejectedError("preview the archive before confirming it");
    }
    const { db, repositories } = this.options;
    const existing =
      request.datasetId === undefined ? undefined : repositories.datasets.get(request.datasetId);
    if (request.datasetId !== undefined && existing === undefined) {
      throw new IpcRejectedError("dataset not found");
    }
    if (existing === undefined && request.datasetName === undefined) {
      throw new IpcRejectedError("choose an existing dataset or provide a dataset name");
    }
    if (existing !== undefined && existing.timezone !== request.timezone) {
      throw new IpcRejectedError(`this dataset uses time zone ${existing.timezone}`);
    }
    let conversations: NormalizedConversation[];
    try {
      conversations = applyConfirmation(staged.parsed.archive, {
        timezone: request.timezone,
        selfNames: request.selfNames,
      });
    } catch (error) {
      if (error instanceof ConfirmationError) {
        throw new IpcRejectedError(error.message);
      }
      throw error;
    }
    const dataset =
      existing ??
      ensureDataset(db, {
        name: request.datasetName ?? "Imported chats",
        timezone: request.timezone,
        now: this.now(),
      });
    const batchId = `batch_${createHash("sha256")
      .update([dataset.id, staged.contentHash, request.timezone, [...request.selfNames].sort().join("\u001f")].join("\u0000"))
      .digest("hex")
      .slice(0, 24)}`;
    const index = new SqliteExistingDatasetIndex(db, dataset.id, { excludeBatchId: batchId });
    const review = await buildMergeReviewPlan(conversations, index);
    staged.confirmed = {
      datasetId: dataset.id,
      timezone: request.timezone,
      selfNames: request.selfNames,
      conversations,
      review,
      batchId,
    };
    return {
      stagedId: staged.id,
      datasetId: dataset.id,
      planId: review.planId,
      counts: {
        new: review.counts.new,
        exactDuplicate: review.counts.exact_duplicate,
        ambiguous: review.counts.ambiguous,
      },
      contacts: review.contacts.map((c) => ({ displayName: c.displayName, status: c.status })),
      reviews: review.reviews.map((item) =>
        item.kind === "message"
          ? {
              reviewId: item.reviewId,
              kind: "message" as const,
              ...(item.item.reason === null ? {} : { reason: item.item.reason }),
              summary: `${item.item.message.senderName ?? "System"}: ${excerpt(item.item.message.text)} (${item.item.message.timestampLocal ?? "no timestamp"})`,
              candidates: item.item.candidates.map((candidate) => ({
                id: candidate.id,
                label: `${candidate.senderName ?? "System"}: ${excerpt(candidate.text)} (${candidate.timestampUtc ?? "no timestamp"})`,
              })),
            }
          : {
              reviewId: item.reviewId,
              kind: "contact" as const,
              reason: "several existing contacts share this display name",
              summary: item.contact.displayName,
              candidates: item.contact.candidates.map((candidate) => ({
                id: candidate.id,
                label: candidate.displayName,
              })),
            },
      ),
    };
  }

  async commit(request: IpcRequest<"archive-import:commit">): Promise<ArchiveCommitResult> {
    const staged = this.get(request.stagedId);
    const confirmed = staged.confirmed;
    if (staged.parsed === undefined || confirmed === undefined) {
      throw new IpcRejectedError("confirm the archive before committing it");
    }
    const { db } = this.options;
    let plan;
    try {
      plan = resolveMergePlan(confirmed.review, request.resolutions);
    } catch (error) {
      if (error instanceof MergeResolutionError) {
        throw new IpcRejectedError(error.message);
      }
      throw error;
    }
    if (!plan.complete) {
      throw new IpcRejectedError(
        `${String(plan.unresolved.length)} review item(s) still need a decision`,
      );
    }
    const source = registerArchiveSource(db, {
      datasetId: confirmed.datasetId,
      name: staged.name,
      contentHash: staged.contentHash,
      container: staged.parsed.preview.container,
      platform: staged.parsed.preview.platform,
      now: this.now(),
    });
    const sink = new SqliteImportCommitSink({
      db,
      datasetId: confirmed.datasetId,
      sourceId: source.id,
      timezone: confirmed.timezone,
      conversations: confirmed.conversations,
      selfNames: confirmed.selfNames,
      now: this.now,
    });
    let result;
    try {
      result = await commitArchiveImport({
        batchId: confirmed.batchId,
        plan,
        sink,
        ...(request.chunkSize === undefined ? {} : { chunkSize: request.chunkSize }),
      });
    } catch (error) {
      if (error instanceof IncompletePlanError || error instanceof RangeError) {
        throw new IpcRejectedError(error.message);
      }
      if (error instanceof ImportCommitError) {
        const checkpoint = await sink.loadCheckpoint(confirmed.batchId);
        return {
          stagedId: staged.id,
          datasetId: confirmed.datasetId,
          batchId: confirmed.batchId,
          status: "failed",
          totalChunks: checkpoint?.totalChunks ?? 0,
          committedItems: checkpoint?.committedItems ?? 0,
          resumedFromChunk: checkpoint?.nextChunkIndex ?? 0,
          persisted: sink.persisted,
        };
      }
      throw error;
    }
    if (result.status === "committed") {
      createAnalyticsEngine(db).rebuild(confirmed.datasetId);
      this.staged.delete(staged.id);
    }
    return {
      stagedId: staged.id,
      datasetId: confirmed.datasetId,
      batchId: result.batchId,
      status: result.status === "committed" ? "committed" : "canceled",
      totalChunks: result.totalChunks,
      committedItems: result.committedItems,
      resumedFromChunk: result.resumedFromChunk,
      persisted: sink.persisted,
    };
  }

  cancel(stagedId: string): boolean {
    return this.staged.delete(stagedId);
  }
}
