import { createInflateRaw, crc32 } from "node:zlib";
import { throwIfAborted } from "./types.js";

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxEntryUncompressedBytes: number;
  readonly maxTotalUncompressedBytes: number;
  /** Maximum uncompressed/compressed ratio, applied once an entry exceeds `ratioMinBytes`. */
  readonly maxCompressionRatio: number;
  readonly ratioMinBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryUncompressedBytes: 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 4 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  ratioMinBytes: 1024 * 1024,
};

export type ZipSafetyErrorCode =
  | "not_a_zip"
  | "truncated"
  | "zip64_unsupported"
  | "too_many_entries"
  | "unsafe_path"
  | "duplicate_entry"
  | "symlink_entry"
  | "special_file_entry"
  | "encrypted_entry"
  | "unsupported_method"
  | "entry_too_large"
  | "total_too_large"
  | "compression_ratio_exceeded"
  | "size_mismatch"
  | "crc_mismatch"
  | "corrupt_entry";

export class ZipSafetyError extends Error {
  override readonly name = "ZipSafetyError";
  constructor(
    readonly code: ZipSafetyErrorCode,
    message: string,
    readonly entryName?: string,
  ) {
    super(message);
  }
}

export interface ZipEntryInfo {
  /** Normalized, validated relative path using `/` separators. */
  readonly name: string;
  readonly isDirectory: boolean;
  readonly method: 0 | 8;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

export interface ZipArchiveInfo {
  readonly entries: readonly ZipEntryInfo[];
  readonly totalCompressedBytes: number;
  readonly totalUncompressedBytes: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function isZipData(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 0x03 || data[2] === 0x05) &&
    (data[3] === 0x04 || data[3] === 0x06)
  );
}

/**
 * Validates an archive entry name and returns its normalized form.
 * Rejects traversal, absolute paths, drive letters, NUL bytes and backslash tricks.
 */
export function validateZipEntryName(rawName: string): string {
  if (rawName.length === 0 || rawName.includes("\0")) {
    throw new ZipSafetyError("unsafe_path", "Empty or NUL-containing entry name", rawName);
  }
  const unified = rawName.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw new ZipSafetyError("unsafe_path", "Absolute entry path", rawName);
  }
  const segments = unified.split("/");
  const isDir = unified.endsWith("/");
  const parts = isDir ? segments.slice(0, -1) : segments;
  for (const segment of parts) {
    if (segment === ".." || segment === "") {
      throw new ZipSafetyError("unsafe_path", "Path traversal or empty path segment", rawName);
    }
  }
  const normalized = parts.filter((segment) => segment !== ".").join("/");
  if (normalized.length === 0) {
    throw new ZipSafetyError("unsafe_path", "Empty normalized entry path", rawName);
  }
  return isDir ? `${normalized}/` : normalized;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = 22;
  if (view.byteLength < minimum) {
    throw new ZipSafetyError("not_a_zip", "Data is too short to be a ZIP archive");
  }
  const lowest = Math.max(0, view.byteLength - minimum - 0xffff);
  for (let offset = view.byteLength - minimum; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIG) {
      return offset;
    }
  }
  throw new ZipSafetyError("not_a_zip", "End of central directory record not found");
}

export function inspectZip(
  data: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ZipArchiveInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipSafetyError("zip64_unsupported", "ZIP64 archives are not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipSafetyError(
      "too_many_entries",
      `Archive declares ${String(entryCount)} entries (limit ${String(limits.maxEntries)})`,
    );
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipSafetyError("truncated", "Central directory exceeds archive bounds");
  }

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntryInfo[] = [];
  const seen = new Set<string>();
  let cursor = cdOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CEN_SIG) {
      throw new ZipSafetyError("truncated", "Malformed central directory entry");
    }
    const versionMadeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    if (nameStart + nameLength + extraLength + commentLength > eocd) {
      throw new ZipSafetyError("truncated", "Central directory entry exceeds bounds");
    }
    const rawName = decoder.decode(data.subarray(nameStart, nameStart + nameLength));
    cursor = nameStart + nameLength + extraLength + commentLength;

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipSafetyError("zip64_unsupported", "ZIP64 entries are not supported", rawName);
    }
    const name = validateZipEntryName(rawName);
    if (seen.has(name)) {
      throw new ZipSafetyError("duplicate_entry", "Duplicate entry name", rawName);
    }
    seen.add(name);

    const host = versionMadeBy >> 8;
    if (host === 3) {
      const fileType = (externalAttributes >>> 16) & 0xf000;
      if (fileType === 0xa000) {
        throw new ZipSafetyError("symlink_entry", "Symbolic links are not allowed", rawName);
      }
      if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
        throw new ZipSafetyError("special_file_entry", "Special files are not allowed", rawName);
      }
    }
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      throw new ZipSafetyError("encrypted_entry", "Encrypted entries are not supported", rawName);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipSafetyError(
        "unsupported_method",
        `Unsupported compression method ${String(method)}`,
        rawName,
      );
    }
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ZipSafetyError(
        "entry_too_large",
        "Entry exceeds the single-file size limit",
        rawName,
      );
    }
    if (
      uncompressedSize > limits.ratioMinBytes &&
      uncompressedSize / Math.max(compressedSize, 1) > limits.maxCompressionRatio
    ) {
      throw new ZipSafetyError(
        "compression_ratio_exceeded",
        "Entry compression ratio is suspicious",
        rawName,
      );
    }
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new ZipSafetyError(
        "total_too_large",
        "Archive exceeds the total uncompressed size limit",
      );
    }
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      method,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      localHeaderOffset,
    });
  }

  if (
    totalUncompressed > limits.ratioMinBytes &&
    totalUncompressed / Math.max(totalCompressed, 1) > limits.maxCompressionRatio
  ) {
    throw new ZipSafetyError(
      "compression_ratio_exceeded",
      "Archive compression ratio is suspicious",
    );
  }
  return {
    entries,
    totalCompressedBytes: totalCompressed,
    totalUncompressedBytes: totalUncompressed,
  };
}

export interface ZipExtractionBudget {
  extractedBytes: number;
}

export interface StreamZipEntryOptions {
  readonly limits?: ZipLimits;
  readonly budget?: ZipExtractionBudget;
  readonly signal?: AbortSignal;
}

function locateEntryData(data: Uint8Array, entry: ZipEntryInfo): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > data.length || view.getUint32(offset, true) !== LOC_SIG) {
    throw new ZipSafetyError("corrupt_entry", "Invalid local file header", entry.name);
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > data.length) {
    throw new ZipSafetyError("truncated", "Entry data exceeds archive bounds", entry.name);
  }
  return data.subarray(start, end);
}

/**
 * Streams one validated entry's bytes in memory, enforcing declared size, per-entry,
 * total and CRC limits. Nothing is ever written to disk.
 */
export async function* streamZipEntry(
  data: Uint8Array,
  entry: ZipEntryInfo,
  options: StreamZipEntryOptions = {},
): AsyncGenerator<Uint8Array> {
  const limits = options.limits ?? DEFAULT_ZIP_LIMITS;
  if (entry.isDirectory) {
    return;
  }
  const compressed = locateEntryData(data, entry);
  let produced = 0;
  let crc = 0;

  const account = (chunk: Uint8Array): void => {
    produced += chunk.length;
    if (options.budget) {
      options.budget.extractedBytes += chunk.length;
      if (options.budget.extractedBytes > limits.maxTotalUncompressedBytes) {
        throw new ZipSafetyError(
          "total_too_large",
          "Extraction exceeded total size limit",
          entry.name,
        );
      }
    }
    if (produced > entry.uncompressedSize || produced > limits.maxEntryUncompressedBytes) {
      throw new ZipSafetyError(
        "size_mismatch",
        "Entry expanded beyond its declared size",
        entry.name,
      );
    }
    crc = crc32(chunk, crc);
  };

  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) {
      throw new ZipSafetyError("size_mismatch", "Stored entry size mismatch", entry.name);
    }
    const step = 64 * 1024;
    for (let offset = 0; offset < compressed.length; offset += step) {
      throwIfAborted(options.signal);
      const chunk = compressed.subarray(offset, offset + step);
      account(chunk);
      yield chunk;
    }
  } else {
    const inflater = createInflateRaw();
    inflater.on("error", () => undefined);
    inflater.end(Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength));
    try {
      for await (const chunk of inflater as AsyncIterable<Buffer>) {
        throwIfAborted(options.signal);
        account(chunk);
        yield chunk;
      }
    } catch (error) {
      if (
        error instanceof ZipSafetyError ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      throw new ZipSafetyError("corrupt_entry", "Entry could not be inflated", entry.name);
    } finally {
      inflater.destroy();
    }
  }

  if (produced !== entry.uncompressedSize) {
    throw new ZipSafetyError(
      "size_mismatch",
      "Entry size differs from its declared size",
      entry.name,
    );
  }
  if (crc >>> 0 !== entry.crc32) {
    throw new ZipSafetyError("crc_mismatch", "Entry CRC-32 mismatch", entry.name);
  }
}

export async function readZipEntry(
  data: Uint8Array,
  entry: ZipEntryInfo,
  options: StreamZipEntryOptions = {},
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of streamZipEntry(data, entry, options)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
