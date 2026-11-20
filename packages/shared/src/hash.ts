import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function sha256Hex(material: string): string {
  return bytesToHex(sha256(utf8ToBytes(material)));
}

export function fnv1a64Hex(material: string): string {
  let hash = FNV_OFFSET;
  for (const byte of utf8ToBytes(material)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

const SEPARATOR = "\u001f";

export function joinKey(parts: readonly string[]): string {
  return parts.join(SEPARATOR);
}

export function deterministicId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${sha256Hex(joinKey(parts)).slice(0, 24)}`;
}

export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${body.join(",")}}`;
}

export function hashObject(value: unknown): string {
  return sha256Hex(stableStringify(value));
}