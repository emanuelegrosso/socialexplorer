import { crc32, deflateRawSync } from "node:zlib";

export interface TestZipEntry {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8;
  /** Unix mode placed in the high 16 bits of the external attributes (host = Unix). */
  unixMode?: number;
  declaredUncompressedSize?: number;
  declaredCrc?: number;
}

/** Minimal ZIP writer for adversarial tests; deliberately lets tests forge metadata. */
export function buildZip(entries: readonly TestZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name);
    const crc = entry.declaredCrc ?? crc32(raw);
    const size = entry.declaredUncompressedSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.unixMode === undefined ? 0 : (entry.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}
