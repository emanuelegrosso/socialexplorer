import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { MediaAsset } from "@social-explorer/contracts";
import { readMediaMetadata } from "./metadata.js";
import { resolveContained, THUMBNAIL_DIR, thumbnailPath } from "./paths.js";

export interface ThumbnailRequest {
  readonly contentHash: string;
  readonly mimeType: string;
  readonly kind: MediaAsset["kind"];
  readonly bytes: Uint8Array;
  readonly maxEdge: number;
}

export interface ThumbnailResult {
  /** PNG bytes. */
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Pluggable thumbnail generator. Real implementations (sharp, ffmpeg, Electron
 * nativeImage...) can be injected by the desktop shell; return `undefined` to fall back.
 */
export interface ThumbnailGenerator {
  readonly id: string;
  generate(request: ThumbnailRequest): Promise<ThumbnailResult | undefined>;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodeSolidPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const KIND_TINT: Readonly<Record<MediaAsset["kind"], number>> = {
  image: 0,
  video: 60,
  audio: 120,
  voice: 180,
  document: 240,
  unknown: 300,
};

/**
 * Deterministic, dependency-free fallback: a solid-colour PNG derived from the content hash
 * and media kind, scaled to the source aspect ratio when known. Same input, same bytes.
 */
export const placeholderThumbnailGenerator: ThumbnailGenerator = {
  id: "placeholder-v1",
  generate(request) {
    const digest = createHash("sha256").update(request.contentHash).digest();
    const tint = KIND_TINT[request.kind];
    const rgb: [number, number, number] = [
      (((digest[0] ?? 0) + tint) % 156) + 80,
      (((digest[1] ?? 0) + tint * 2) % 156) + 80,
      (((digest[2] ?? 0) + tint * 3) % 156) + 80,
    ];
    const meta = readMediaMetadata(request.mimeType, request.bytes);
    const edge = Math.max(1, Math.min(request.maxEdge, 512));
    let width = edge;
    let height = edge;
    if (meta.width !== undefined && meta.height !== undefined) {
      const scale = Math.min(edge / meta.width, edge / meta.height, 1);
      width = Math.max(1, Math.round(meta.width * scale));
      height = Math.max(1, Math.round(meta.height * scale));
    }
    return Promise.resolve({ bytes: encodeSolidPng(width, height, rgb), width, height });
  },
};

export interface ThumbnailCacheOptions {
  readonly appRoot: string;
  readonly generator?: ThumbnailGenerator;
  readonly defaultEdge?: number;
}

export interface ThumbnailEntry {
  readonly contentHash: string;
  readonly relativePath: string;
  readonly generator: string;
  readonly created: boolean;
}

export interface RebuildReport {
  readonly generated: number;
  readonly skipped: number;
  readonly failed: readonly string[];
}

export function createThumbnailCache(options: ThumbnailCacheOptions) {
  const primary = options.generator;
  const fallback = placeholderThumbnailGenerator;
  const defaultEdge = options.defaultEdge ?? 256;

  async function ensure(
    asset: Pick<MediaAsset, "contentHash" | "storageRelativePath" | "mimeType" | "kind">,
    maxEdge = defaultEdge,
  ): Promise<ThumbnailEntry | undefined> {
    if (asset.contentHash === undefined || asset.storageRelativePath === undefined) {
      return undefined;
    }
    const relativePath = thumbnailPath(asset.contentHash, maxEdge);
    const target = resolveContained(options.appRoot, relativePath);
    try {
      await stat(target);
      return { contentHash: asset.contentHash, relativePath, generator: "cache", created: false };
    } catch {
      // not cached yet
    }
    const source = resolveContained(options.appRoot, asset.storageRelativePath);
    const bytes = await readFile(source);
    const request: ThumbnailRequest = {
      contentHash: asset.contentHash,
      mimeType: asset.mimeType ?? "application/octet-stream",
      kind: asset.kind,
      bytes,
      maxEdge,
    };
    let generatorId = fallback.id;
    let result: ThumbnailResult | undefined;
    if (primary !== undefined) {
      try {
        result = await primary.generate(request);
        generatorId = primary.id;
      } catch {
        result = undefined;
      }
    }
    if (result === undefined) {
      result = await fallback.generate(request);
      generatorId = fallback.id;
    }
    if (result === undefined) {
      return undefined;
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${String(process.pid)}.tmp`;
    await writeFile(temporary, result.bytes);
    await rename(temporary, target);
    return { contentHash: asset.contentHash, relativePath, generator: generatorId, created: true };
  }

  return {
    ensure,
    pathFor(contentHash: string, maxEdge = defaultEdge): string {
      return thumbnailPath(contentHash, maxEdge);
    },
    /** Deletes the entire derived cache. Originals and database rows are untouched. */
    async purge(): Promise<void> {
      await rm(resolveContained(options.appRoot, THUMBNAIL_DIR), { recursive: true, force: true });
    },
    /** Purges then regenerates thumbnails for every locally available asset. */
    async rebuild(assets: readonly MediaAsset[], maxEdge = defaultEdge): Promise<RebuildReport> {
      await this.purge();
      let generated = 0;
      let skipped = 0;
      const failed: string[] = [];
      for (const asset of assets) {
        if (asset.availability !== "available-local") {
          skipped++;
          continue;
        }
        try {
          const entry = await ensure(asset, maxEdge);
          if (entry === undefined) {
            skipped++;
          } else {
            generated++;
          }
        } catch {
          failed.push(asset.id);
        }
      }
      return { generated, skipped, failed };
    },
  };
}

export type ThumbnailCache = ReturnType<typeof createThumbnailCache>;
