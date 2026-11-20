import { isAbsolute, relative, resolve, sep } from "node:path";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/u;

export class MediaPathError extends Error {
  override readonly name = "MediaPathError";
}

export function assertContentHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new MediaPathError("Content hash must be 64 lowercase hex characters");
  }
}

/** Relative path of an app-managed copy: generated only from the content hash. */
export function managedMediaPath(contentHash: string, extension: string): string {
  assertContentHash(contentHash);
  if (!EXTENSION_PATTERN.test(extension)) {
    throw new MediaPathError("Unsafe generated extension");
  }
  return `media/${contentHash.slice(0, 2)}/${contentHash}.${extension}`;
}

export const THUMBNAIL_DIR = "thumbnails";

/** Relative path of a cached thumbnail; the cache is fully derived and rebuildable. */
export function thumbnailPath(contentHash: string, maxEdge: number): string {
  assertContentHash(contentHash);
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 4096) {
    throw new MediaPathError("Thumbnail size out of range");
  }
  return `${THUMBNAIL_DIR}/${contentHash.slice(0, 2)}/${contentHash}-${String(maxEdge)}.png`;
}

/**
 * Resolves `relativePath` under `root` and refuses anything that would leave it
 * (absolute paths, `..`, NUL bytes). Purely lexical; symlinks are handled by callers.
 */
export function resolveContained(root: string, relativePath: string): string {
  if (relativePath.length === 0 || relativePath.includes("\0") || isAbsolute(relativePath)) {
    throw new MediaPathError("Unsafe relative path");
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, relativePath);
  const rel = relative(rootResolved, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new MediaPathError("Path escapes the managed root");
  }
  return target;
}
