#!/usr/bin/env node
// Deterministically builds tiny, 100% synthetic WhatsApp-style ZIP exports.
// Usage: node build-zips.mjs [--out <dir>]
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exportsDir = resolve(here, "..", "exports");
const outArgIndex = process.argv.indexOf("--out");
const outDir =
  outArgIndex === -1 ? resolve(here, "..", "zips") : resolve(process.argv[outArgIndex + 1] ?? "");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function minimalPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const pixel = deflateSync(Buffer.from([0, 0x2a, 0x6f, 0xb5]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixel),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function minimalWav() {
  const samples = 800;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function placeholderMp4() {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isommp41", "ascii"),
  ]);
  const free = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("free", "ascii")]);
  return Buffer.concat([ftyp, free]);
}

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const localRecord = Buffer.concat([local, nameBuffer, content]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuffer]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const text = (file) => readFileSync(join(exportsDir, file));
const png = minimalPng();
const wav = minimalWav();
const mp4 = placeholderMp4();

const archives = {
  "android-private-with-media.zip": [
    ["WhatsApp Chat with Alice Example.txt", text("android-private.txt")],
    ["IMG-20260115-WA0001.png", png],
    ["PTT-20260115-WA0002.wav", wav],
  ],
  "android-group-with-media.zip": [
    ["WhatsApp Chat with Synthetic Hiking Club.txt", text("android-group.txt")],
    ["VID-20260120-WA0003.mp4", mp4],
    ["AUD-20260120-WA0004.wav", wav],
  ],
  "ios-private-with-media.zip": [
    ["_chat.txt", text("ios-private.txt")],
    ["00000001-PHOTO-2026-01-15-09-21-00.png", png],
    ["00000002-AUDIO-2026-01-15-09-22-45.wav", wav],
  ],
  "ios-group-with-media.zip": [
    ["_chat.txt", text("ios-group.txt")],
    ["00000003-VIDEO-2026-01-20-18-10-00.mp4", mp4],
  ],
};

mkdirSync(outDir, { recursive: true });
for (const [name, entries] of Object.entries(archives)) {
  writeFileSync(join(outDir, name), buildZip(entries));
}
