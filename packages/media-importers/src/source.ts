import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  inspectZip,
  streamZipEntry,
  type ArchiveInput,
  type ZipArchiveInfo,
  type ZipEntryInfo,
} from "@social-explorer/importers";

export type MediaRejection =
  | "unsafe_name"
  | "ambiguous_name"
  | "symlink"
  | "not_regular_file"
  | "outside_root"
  | "too_large"
  | "unreadable";

export type MediaOrigin =
  | { readonly kind: "zip"; readonly entry: ZipEntryInfo }
  | { readonly kind: "folder"; readonly fileName: string; readonly size: number };

export type LookupResult =
  | { readonly status: "found"; readonly origin: MediaOrigin }
  | { readonly status: "missing" }
  | { readonly status: "rejected"; readonly reason: MediaRejection };

/**
 * A reference name comes from untrusted chat text. It must be a bare file name: no separators
 * (either flavour), no traversal, no NUL, no drive letters.
 */
export function isSafeReferenceName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes("\0") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".." &&
    !/^[A-Za-z]:/u.test(name)
  );
}

export interface MediaSource {
  readonly zip: ZipArchiveInfo | null;
  lookup(fileName: string): Promise<LookupResult>;
  open(origin: MediaOrigin, signal?: AbortSignal): AsyncGenerator<Uint8Array>;
  /** Media-looking ZIP entries (non-chat) for orphan reporting. */
  readonly zipFileNames: readonly string[];
}

export interface MediaSourceOptions {
  readonly archive: ArchiveInput;
  readonly zip?: ZipArchiveInfo | null;
  /** Optional folder holding companion media files next to a TXT export. */
  readonly companionDir?: string;
  readonly maxFileBytes: number;
}

function basename(name: string): string {
  return name.split("/").pop() ?? name;
}

async function* streamFolderFile(
  rootReal: string,
  fileName: string,
  expectedSize: number,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const path = join(rootReal, fileName);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expectedSize || info.size > maxBytes) {
      throw new Error("Companion file changed after validation");
    }
    const real = await realpath(path);
    if (!real.startsWith(rootReal + sep)) {
      throw new Error("Companion file escaped its root");
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error("Companion file exceeded size limit");
      }
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

export async function createMediaSource(options: MediaSourceOptions): Promise<MediaSource> {
  const isZip = options.archive.data.length > 4 && options.archive.data[0] === 0x50;
  let zip: ZipArchiveInfo | null = options.zip ?? null;
  if (zip === null && isZip) {
    try {
      zip = inspectZip(options.archive.data);
    } catch {
      zip = null;
    }
  }
  const files = (zip?.entries ?? []).filter((entry) => !entry.isDirectory);
  const byName = new Map(files.map((entry) => [entry.name, entry]));
  const byBase = new Map<string, ZipEntryInfo[]>();
  for (const entry of files) {
    const key = basename(entry.name);
    byBase.set(key, [...(byBase.get(key) ?? []), entry]);
  }

  let rootReal: string | undefined;
  if (options.companionDir !== undefined) {
    rootReal = await realpath(options.companionDir);
  }

  return {
    zip,
    zipFileNames: files.map((entry) => entry.name),
    async lookup(fileName) {
      if (!isSafeReferenceName(fileName)) {
        return { status: "rejected", reason: "unsafe_name" };
      }
      const exact = byName.get(fileName);
      const candidates = exact === undefined ? (byBase.get(fileName) ?? []) : [exact];
      if (candidates.length > 1) {
        return { status: "rejected", reason: "ambiguous_name" };
      }
      const entry = candidates[0];
      if (entry !== undefined) {
        if (entry.uncompressedSize > options.maxFileBytes) {
          return { status: "rejected", reason: "too_large" };
        }
        return { status: "found", origin: { kind: "zip", entry } };
      }
      if (rootReal === undefined) {
        return { status: "missing" };
      }
      const path = join(rootReal, fileName);
      let info;
      try {
        info = await lstat(path);
      } catch {
        return { status: "missing" };
      }
      if (info.isSymbolicLink()) {
        return { status: "rejected", reason: "symlink" };
      }
      if (!info.isFile()) {
        return { status: "rejected", reason: "not_regular_file" };
      }
      try {
        const real = await realpath(path);
        if (!real.startsWith(rootReal + sep)) {
          return { status: "rejected", reason: "outside_root" };
        }
      } catch {
        return { status: "rejected", reason: "unreadable" };
      }
      if (info.size > options.maxFileBytes) {
        return { status: "rejected", reason: "too_large" };
      }
      return { status: "found", origin: { kind: "folder", fileName, size: info.size } };
    },
    open(origin, signal) {
      if (origin.kind === "zip") {
        return streamZipEntry(options.archive.data, origin.entry, {
          ...(signal === undefined ? {} : { signal }),
        });
      }
      if (rootReal === undefined) {
        throw new Error("No companion folder configured");
      }
      return streamFolderFile(rootReal, origin.fileName, origin.size, options.maxFileBytes);
    },
  };
}
