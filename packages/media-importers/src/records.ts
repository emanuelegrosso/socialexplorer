import { createHash } from "node:crypto";
import type { MediaAsset, MediaReference } from "@social-explorer/contracts";
import {
  createMediaStorytellingRepository,
  runInTransaction,
  type SqliteDatabase,
} from "@social-explorer/database";
import { assertAssetInvariants, assertReferenceInvariants } from "@social-explorer/media-core";
import type { CopyResult } from "./copy.js";
import type { MediaDiscovery } from "./discovery.js";

export type MediaImportMode = "reference-only" | "copy";

export interface ResolvedMessage {
  readonly messageId?: string;
  readonly conversationId: string;
  readonly timestampUtc?: string;
  readonly timestampLocal: string;
}

export interface MediaRecordContext {
  readonly datasetId: string;
  readonly provenanceId: string;
  readonly importedAt: string;
  readonly mode: MediaImportMode;
  /** Required for mode "copy". */
  readonly copy?: CopyResult;
  /** Maps a parsed record to its persisted message and conversation. */
  readonly resolveMessage: (sourceFile: string, ordinal: number) => ResolvedMessage | undefined;
}

export interface MediaRecordPlan {
  readonly assets: readonly MediaAsset[];
  readonly references: readonly MediaReference[];
  readonly skippedReferences: number;
}

function digestId(prefix: string, ...parts: readonly (string | number)[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
}

export function assetIdFor(datasetId: string, contentHash: string): string {
  return digestId("asset", datasetId, contentHash);
}

export function referenceIdFor(
  datasetId: string,
  sourceFile: string,
  ordinal: number,
  index: number,
): string {
  return digestId("mref", datasetId, sourceFile, ordinal, index);
}

/** Builds deterministic (idempotent) asset and reference records from a discovery. */
export function planMediaRecords(
  discovery: MediaDiscovery,
  context: MediaRecordContext,
): MediaRecordPlan {
  if (context.mode === "copy" && context.copy === undefined) {
    throw new Error("copy mode requires a CopyResult");
  }
  const assets = new Map<string, MediaAsset>();
  const references: MediaReference[] = [];
  let skipped = 0;

  const assetFor = (hash: string): MediaAsset | undefined => {
    const cached = assets.get(hash);
    if (cached !== undefined) {
      return cached;
    }
    const file = discovery.files.get(hash);
    if (file === undefined) {
      return undefined;
    }
    const storagePath = context.mode === "copy" ? context.copy?.paths.get(hash) : undefined;
    const asset: MediaAsset = {
      id: assetIdFor(context.datasetId, hash),
      datasetId: context.datasetId,
      kind: file.kind,
      originalName: file.originalNames[0] ?? "unnamed",
      mimeType: file.sniffed.mimeType,
      byteSize: file.size,
      ...file.metadata,
      contentHash: hash,
      ...(storagePath === undefined ? {} : { storageRelativePath: storagePath }),
      availability: storagePath === undefined ? "not-imported" : "available-local",
      importedAt: context.importedAt,
      provenanceId: context.provenanceId,
    };
    assertAssetInvariants(asset);
    assets.set(hash, asset);
    return asset;
  };

  for (const ref of discovery.references) {
    const message = context.resolveMessage(ref.sourceFile, ref.ordinal);
    if (message === undefined) {
      skipped++;
      continue;
    }
    const asset = ref.contentHash === undefined ? undefined : assetFor(ref.contentHash);
    const availability: MediaReference["availability"] =
      asset !== undefined
        ? asset.availability
        : ref.outcome === "available"
          ? "not-imported"
          : ref.outcome;
    const reference: MediaReference = {
      id: referenceIdFor(context.datasetId, ref.sourceFile, ref.ordinal, ref.index),
      ...(asset === undefined ? {} : { mediaAssetId: asset.id }),
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      conversationId: message.conversationId,
      ...(message.timestampUtc === undefined ? {} : { timestampUtc: message.timestampUtc }),
      timestampLocal: message.timestampLocal,
      availability,
    };
    assertReferenceInvariants(reference, asset);
    references.push(reference);
  }
  return { assets: [...assets.values()], references, skippedReferences: skipped };
}

/** Persists a plan atomically. Never writes to messages, contacts or connector tables. */
export function persistMediaRecords(
  db: SqliteDatabase,
  datasetId: string,
  plan: MediaRecordPlan,
): void {
  const repo = createMediaStorytellingRepository(db);
  runInTransaction(db, () => {
    for (const asset of plan.assets) {
      repo.upsertAsset(asset);
    }
    for (const reference of plan.references) {
      repo.upsertReference(datasetId, reference);
    }
  });
}
