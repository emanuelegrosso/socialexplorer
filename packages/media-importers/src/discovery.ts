import { createHash } from "node:crypto";
import type { MediaAsset } from "@social-explorer/contracts";
import {
  throwIfAborted,
  type ArchiveInput,
  type MediaType,
  type ParsedArchive,
} from "@social-explorer/importers";
import {
  readMediaMetadata,
  sniffMedia,
  type MediaMetadata,
  type SniffedMedia,
} from "@social-explorer/media-core";
import {
  createMediaSource,
  type MediaOrigin,
  type MediaRejection,
  type MediaSource,
} from "./source.js";

/** Bytes kept from the start of each file for magic-byte sniffing and metadata parsing. */
export const DISCOVERY_HEAD_BYTES = 64 * 1024;
export const DEFAULT_MAX_MEDIA_FILE_BYTES = 512 * 1024 * 1024;

export type DiscoveryOutcome = "available" | "missing" | "not-imported" | "unsupported";

export type DiscoveryReason =
  | MediaRejection
  | "media_omitted"
  | "not_found"
  | "mime_mismatch"
  | "unrecognized_content"
  | "unsupported_document"
  | "read_failed";

export interface DiscoveredFile {
  /** SHA-256 of the bytes, lowercase hex. */
  readonly contentHash: string;
  readonly size: number;
  readonly sniffed: SniffedMedia;
  readonly kind: MediaAsset["kind"];
  readonly metadata: MediaMetadata;
  /** Where the bytes can be re-read for the opt-in copy. */
  readonly origin: MediaOrigin;
  /** Original names, for display only. Never used to build disk paths. */
  readonly originalNames: readonly string[];
}

export interface DiscoveredReference {
  readonly sourceFile: string;
  readonly ordinal: number;
  /** Index of this media item within its message. */
  readonly index: number;
  readonly marker: string;
  readonly fileName: string | null;
  readonly declaredType: MediaType;
  readonly outcome: DiscoveryOutcome;
  readonly reason?: DiscoveryReason;
  readonly contentHash?: string;
}

export interface StorageEstimate {
  readonly referencedFiles: number;
  readonly uniqueFiles: number;
  readonly duplicateFiles: number;
  /** Bytes of every distinct source file. */
  readonly sourceBytes: number;
  /** Bytes an opt-in copy would actually write after SHA-256 deduplication. */
  readonly copyBytes: number;
  readonly dedupSavingsBytes: number;
}

export interface MediaDiscovery {
  readonly references: readonly DiscoveredReference[];
  /** Unique files keyed by content hash. */
  readonly files: ReadonlyMap<string, DiscoveredFile>;
  readonly estimate: StorageEstimate;
  /** Media-looking ZIP entries no chat line referred to. */
  readonly unreferencedEntries: readonly string[];
  readonly source: MediaSource;
}

export interface DiscoverMediaOptions {
  readonly archive: ArchiveInput;
  readonly parsed: ParsedArchive;
  readonly companionDir?: string;
  readonly maxFileBytes?: number;
  readonly signal?: AbortSignal;
}

function declaredFamily(type: MediaType): "image" | "video" | "audio" | "other" | "any" {
  switch (type) {
    case "image":
    case "gif":
    case "sticker":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "document":
      return "other";
    default:
      return "any";
  }
}

function assetKind(sniffed: SniffedMedia, fileName: string): MediaAsset["kind"] {
  if (sniffed.kind === "audio" && (/^PTT-/iu.test(fileName) || /\.opus$/iu.test(fileName))) {
    return "voice";
  }
  return sniffed.kind;
}

interface Analysis {
  readonly contentHash: string;
  readonly size: number;
  readonly head: Uint8Array;
}

async function analyze(
  source: MediaSource,
  origin: MediaOrigin,
  signal: AbortSignal | undefined,
): Promise<Analysis> {
  const hash = createHash("sha256");
  const head: Uint8Array[] = [];
  let headLength = 0;
  let size = 0;
  for await (const chunk of source.open(origin, signal)) {
    throwIfAborted(signal);
    hash.update(chunk);
    size += chunk.length;
    if (headLength < DISCOVERY_HEAD_BYTES) {
      const slice = chunk.subarray(0, DISCOVERY_HEAD_BYTES - headLength);
      head.push(slice);
      headLength += slice.length;
    }
  }
  return { contentHash: hash.digest("hex"), size, head: Buffer.concat(head) };
}

export async function discoverMedia(options: DiscoverMediaOptions): Promise<MediaDiscovery> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_MEDIA_FILE_BYTES;
  const source = await createMediaSource({
    archive: options.archive,
    zip: options.parsed.zip,
    ...(options.companionDir === undefined ? {} : { companionDir: options.companionDir }),
    maxFileBytes,
  });

  const analyses = new Map<string, Analysis | "failed">();
  const files = new Map<string, DiscoveredFile>();
  const references: DiscoveredReference[] = [];
  const referencedNames = new Set<string>();
  const sourceFiles = new Map<string, number>();

  for (const conversation of options.parsed.conversations) {
    for (const record of conversation.records) {
      for (const [index, media] of record.media.entries()) {
        throwIfAborted(options.signal);
        const common = {
          sourceFile: record.sourceFile,
          ordinal: record.ordinal,
          index,
          marker: media.marker,
          fileName: media.fileName,
          declaredType: media.mediaType,
        };
        if (media.kind === "omitted" || media.fileName === null) {
          references.push({ ...common, outcome: "not-imported", reason: "media_omitted" });
          continue;
        }
        const name = media.fileName;
        referencedNames.add(name);
        const lookup = await source.lookup(name);
        if (lookup.status === "missing") {
          references.push({ ...common, outcome: "missing", reason: "not_found" });
          continue;
        }
        if (lookup.status === "rejected") {
          references.push({ ...common, outcome: "unsupported", reason: lookup.reason });
          continue;
        }
        const family = declaredFamily(media.mediaType);
        if (family === "other") {
          references.push({ ...common, outcome: "unsupported", reason: "unsupported_document" });
          continue;
        }
        const originKey =
          lookup.origin.kind === "zip"
            ? `zip:${lookup.origin.entry.name}`
            : `folder:${lookup.origin.fileName}`;
        let analysis = analyses.get(originKey);
        if (analysis === undefined) {
          try {
            analysis = await analyze(source, lookup.origin, options.signal);
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              throw error;
            }
            analysis = "failed";
          }
          analyses.set(originKey, analysis);
        }
        if (analysis === "failed") {
          references.push({ ...common, outcome: "unsupported", reason: "read_failed" });
          continue;
        }
        const sniffed = sniffMedia(analysis.head);
        if (sniffed === undefined) {
          references.push({ ...common, outcome: "unsupported", reason: "unrecognized_content" });
          continue;
        }
        if (family !== "any" && family !== sniffed.kind) {
          references.push({ ...common, outcome: "unsupported", reason: "mime_mismatch" });
          continue;
        }
        sourceFiles.set(originKey, analysis.size);
        const existing = files.get(analysis.contentHash);
        files.set(analysis.contentHash, {
          contentHash: analysis.contentHash,
          size: analysis.size,
          sniffed,
          kind: assetKind(sniffed, name),
          metadata: readMediaMetadata(sniffed.mimeType, analysis.head),
          origin: existing?.origin ?? lookup.origin,
          originalNames: [...new Set([...(existing?.originalNames ?? []), name])],
        });
        references.push({
          ...common,
          outcome: "available",
          contentHash: analysis.contentHash,
        });
      }
    }
  }

  const sourceBytes = [...sourceFiles.values()].reduce((sum, value) => sum + value, 0);
  const copyBytes = [...files.values()].reduce((sum, file) => sum + file.size, 0);
  const estimate: StorageEstimate = {
    referencedFiles: sourceFiles.size,
    uniqueFiles: files.size,
    duplicateFiles: sourceFiles.size - files.size,
    sourceBytes,
    copyBytes,
    dedupSavingsBytes: sourceBytes - copyBytes,
  };
  const chatFiles = new Set(options.parsed.conversations.map((c) => c.sourceFile));
  const unreferencedEntries = source.zipFileNames.filter((name) => {
    const base = name.split("/").pop() ?? name;
    return !referencedNames.has(base) && !referencedNames.has(name) && !chatFiles.has(name);
  });
  return { references, files, estimate, unreferencedEntries, source };
}
