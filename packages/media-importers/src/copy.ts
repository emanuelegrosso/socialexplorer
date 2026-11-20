import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { managedMediaPath, resolveContained } from "@social-explorer/media-core";
import { throwIfAborted } from "@social-explorer/importers";
import type { MediaDiscovery } from "./discovery.js";

export interface CopyOptions {
  /** App-managed root; copies land under `<appRoot>/media/`. */
  readonly appRoot: string;
  readonly signal?: AbortSignal;
}

export interface CopyResult {
  /** content hash -> storage-relative path (`media/xx/<hash>.<ext>`). */
  readonly paths: ReadonlyMap<string, string>;
  readonly copied: number;
  readonly reused: number;
  readonly bytesWritten: number;
  readonly failed: readonly string[];
}

/**
 * Opt-in copy. File names are generated from the SHA-256 and the sniffed type; the archive's
 * original names never reach the file system. Bytes are re-hashed while writing, so a source
 * that changed since discovery is rejected rather than stored under the wrong name.
 */
export async function copyDiscoveredMedia(
  discovery: MediaDiscovery,
  options: CopyOptions,
): Promise<CopyResult> {
  const paths = new Map<string, string>();
  const failed: string[] = [];
  let copied = 0;
  let reused = 0;
  let bytesWritten = 0;

  for (const file of discovery.files.values()) {
    throwIfAborted(options.signal);
    const relativePath = managedMediaPath(file.contentHash, file.sniffed.extension);
    const destination = resolveContained(options.appRoot, relativePath);
    try {
      const existing = await stat(destination).catch(() => undefined);
      if (existing?.isFile() === true && existing.size === file.size) {
        paths.set(file.contentHash, relativePath);
        reused++;
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
      const hash = createHash("sha256");
      let size = 0;
      async function* tap(): AsyncGenerator<Uint8Array> {
        for await (const chunk of discovery.source.open(file.origin, options.signal)) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      }
      try {
        await pipeline(
          Readable.from(tap(), { objectMode: false }),
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        if (hash.digest("hex") !== file.contentHash || size !== file.size) {
          throw new Error("Source changed since discovery");
        }
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      paths.set(file.contentHash, relativePath);
      copied++;
      bytesWritten += size;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      failed.push(file.contentHash);
    }
  }
  return { paths, copied, reused, bytesWritten, failed };
}
