import { deflateSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertContentHash,
  MediaPathError,
  managedMediaPath,
  readMediaMetadata,
  resolveContained,
  sniffMedia,
  thumbnailPath,
} from "./index.js";
import { encodeSolidPng } from "./thumbnails.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): number[] => Array.from(Buffer.from(text, "latin1"));

function riff(form: string, rest: number[] = []): Uint8Array {
  return bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii(form), ...rest);
}

describe("sniffMedia (magic bytes)", () => {
  const cases: [string, Uint8Array, string, string][] = [
    ["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), "image/png", "png"],
    ["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0, 0), "image/jpeg", "jpg"],
    ["webp", riff("WEBP"), "image/webp", "webp"],
    ["gif89", bytes(...ascii("GIF89a"), 1, 0), "image/gif", "gif"],
    ["gif87", bytes(...ascii("GIF87a"), 1, 0), "image/gif", "gif"],
    ["wav", riff("WAVE"), "audio/wav", "wav"],
    ["mp3 id3", bytes(...ascii("ID3"), 4, 0), "audio/mpeg", "mp3"],
    ["mp3 frame sync", bytes(0xff, 0xfb, 0x90, 0x00), "audio/mpeg", "mp3"],
    ["ogg", bytes(...ascii("OggS"), 0, 2, ...ascii("vorbis")), "audio/ogg", "ogg"],
    ["opus", bytes(...ascii("OggS"), 0, 2, 0, 0, ...ascii("OpusHead")), "audio/opus", "opus"],
    ["mp4", bytes(0, 0, 0, 24, ...ascii("ftypisom"), 0, 0, 2, 0), "video/mp4", "mp4"],
    ["webm", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f), "video/webm", "webm"],
  ];
  it.each(cases)("recognises %s", (_name, data, mime, ext) => {
    const sniffed = sniffMedia(data);
    expect(sniffed?.mimeType).toBe(mime);
    expect(sniffed?.extension).toBe(ext);
  });

  it("rejects executables, scripts, empty and spoofed content", () => {
    expect(sniffMedia(bytes())).toBeUndefined();
    expect(sniffMedia(bytes(...ascii("MZ\x90\x00")))).toBeUndefined();
    expect(sniffMedia(bytes(...ascii("#!/bin/sh\n")))).toBeUndefined();
    expect(sniffMedia(bytes(...ascii("<svg xmlns=")))).toBeUndefined();
    expect(sniffMedia(bytes(...ascii("%PDF-1.7")))).toBeUndefined();
    expect(sniffMedia(riff("AVI "))).toBeUndefined();
    expect(sniffMedia(bytes(0x89, 0x50, 0x4e, 0x47))).toBeUndefined();
    expect(sniffMedia(bytes(0xff, 0xe1))).toBeUndefined();
  });
});

describe("readMediaMetadata", () => {
  it("reads PNG dimensions via a generated PNG", () => {
    const png = encodeSolidPng(7, 3, [1, 2, 3]);
    expect(readMediaMetadata("image/png", png)).toEqual({ width: 7, height: 3 });
    expect(crc32(Buffer.from("x"))).toBeTypeOf("number");
    expect(deflateSync(Buffer.alloc(1)).length).toBeGreaterThan(0);
  });
  it("reads GIF, JPEG and WebP dimensions", () => {
    expect(readMediaMetadata("image/gif", bytes(...ascii("GIF89a"), 10, 0, 20, 0, 0, 0))).toEqual({
      width: 10,
      height: 20,
    });
    const jpeg = bytes(
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      4,
      0,
      0,
      0xff,
      0xc0,
      0,
      11,
      8,
      0,
      48,
      0,
      64,
      3,
      1,
      0x22,
      0,
    );
    expect(readMediaMetadata("image/jpeg", jpeg)).toEqual({ width: 64, height: 48 });
    const vp8x = riff("WEBP", [
      ...ascii("VP8X"),
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      99,
      0,
      0,
      49,
      0,
      0,
      0,
      0,
    ]);
    expect(readMediaMetadata("image/webp", vp8x)).toEqual({ width: 100, height: 50 });
  });
  it("reads WAV duration and tolerates garbage", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"),
      Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]),
      Buffer.from("data", "latin1"),
      Buffer.from([0x40, 0x06, 0, 0]),
    ]);
    expect(readMediaMetadata("audio/wav", wav)).toEqual({ durationMs: 100 });
    expect(readMediaMetadata("image/png", bytes(1, 2, 3))).toEqual({});
    expect(readMediaMetadata("image/jpeg", bytes(0xff, 0xd8))).toEqual({});
    expect(readMediaMetadata("video/mp4", bytes(1))).toEqual({});
  });
});

describe("managed paths", () => {
  const hash = "ab".repeat(32);
  it("derives paths only from the hash", () => {
    expect(managedMediaPath(hash, "png")).toBe(`media/ab/${hash}.png`);
    expect(thumbnailPath(hash, 256)).toBe(`thumbnails/ab/${hash}-256.png`);
  });
  it("rejects malformed hashes, extensions and sizes", () => {
    expect(() => {
      assertContentHash("../../etc/passwd");
    }).toThrow(MediaPathError);
    expect(() => {
      assertContentHash(hash.toUpperCase());
    }).toThrow(MediaPathError);
    expect(() => managedMediaPath(hash, "../x")).toThrow(MediaPathError);
    expect(() => thumbnailPath(hash, 0)).toThrow(MediaPathError);
  });
  it("contains resolved paths", () => {
    expect(resolveContained("/tmp/app", "media/ab/x.png")).toBe("/tmp/app/media/ab/x.png");
    for (const bad of ["../x", "media/../../x", "/etc/passwd", "a\0b", "", "."]) {
      expect(() => resolveContained("/tmp/app", bad)).toThrow(MediaPathError);
    }
  });
});
