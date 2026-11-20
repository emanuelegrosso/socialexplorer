import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverMedia, isSafeReferenceName, type DiscoveredReference } from "./index.js";
import { chatZip, FIXTURE_ZIPS, loadFixture, parse, PNG_1X1 } from "./helpers.testutil.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "se-media-imp-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const summary = (refs: readonly DiscoveredReference[]): string[] =>
  refs.map(
    (r) => `${r.fileName ?? "-"}:${r.outcome}${r.reason === undefined ? "" : `/${r.reason}`}`,
  );

describe("synthetic fixture ZIPs", () => {
  it("discovers real PNG/WAV/MP4 attachments and records omitted markers truthfully", async () => {
    const expected: Record<(typeof FIXTURE_ZIPS)[number], string[]> = {
      "android-private-with-media.zip": [
        "-:not-imported/media_omitted",
        "IMG-20260115-WA0001.png:available",
        "PTT-20260115-WA0002.wav:available",
      ],
      "android-group-with-media.zip": [
        "-:not-imported/media_omitted",
        "VID-20260120-WA0003.mp4:available",
        "AUD-20260120-WA0004.wav:available",
      ],
      "ios-private-with-media.zip": [
        "-:not-imported/media_omitted",
        "00000001-PHOTO-2026-01-15-09-21-00.png:available",
        "00000002-AUDIO-2026-01-15-09-22-45.wav:available",
        "-:not-imported/media_omitted",
      ],
      "ios-group-with-media.zip": [
        "00000003-VIDEO-2026-01-20-18-10-00.mp4:available",
        "-:not-imported/media_omitted",
      ],
    };
    for (const name of FIXTURE_ZIPS) {
      const input = loadFixture(name);
      const discovery = await discoverMedia({ archive: input, parsed: await parse(input) });
      expect(summary(discovery.references), name).toEqual(expected[name]);
      expect(discovery.unreferencedEntries).toEqual([]);
    }
  });

  it("hashes, sniffs and measures files", async () => {
    const input = loadFixture("android-private-with-media.zip");
    const discovery = await discoverMedia({ archive: input, parsed: await parse(input) });
    const files = [...discovery.files.values()];
    const png = files.find((f) => f.sniffed.mimeType === "image/png");
    const wav = files.find((f) => f.sniffed.mimeType === "audio/wav");
    expect(png).toMatchObject({ kind: "image", size: 69, metadata: { width: 1, height: 1 } });
    expect(png?.contentHash).toBe(createHash("sha256").update(PNG_1X1).digest("hex"));
    expect(wav).toMatchObject({ kind: "voice", size: 1644, metadata: { durationMs: 100 } });
    const group = loadFixture("android-group-with-media.zip");
    const groupDiscovery = await discoverMedia({ archive: group, parsed: await parse(group) });
    const kinds = [...groupDiscovery.files.values()]
      .map((f) => `${f.kind}:${f.sniffed.mimeType}`)
      .sort();
    expect(kinds).toEqual(["audio:audio/wav", "video:video/mp4"]);
  });

  it("estimates storage before any copy and accounts for deduplication", async () => {
    const input = loadFixture("ios-private-with-media.zip");
    const discovery = await discoverMedia({ archive: input, parsed: await parse(input) });
    expect(discovery.estimate).toEqual({
      referencedFiles: 2,
      uniqueFiles: 2,
      duplicateFiles: 0,
      sourceBytes: 69 + 1644,
      copyBytes: 69 + 1644,
      dedupSavingsBytes: 0,
    });
    const dup = chatZip(
      ["a.png (file attached)", "b.png (file attached)", "c.png (file attached)"],
      [
        { name: "a.png", data: PNG_1X1 },
        { name: "b.png", data: PNG_1X1 },
        { name: "c.png", data: Buffer.concat([PNG_1X1, Buffer.from([0])]) },
      ],
    );
    const d = await discoverMedia({ archive: dup, parsed: await parse(dup) });
    expect(d.estimate).toMatchObject({
      referencedFiles: 3,
      uniqueFiles: 2,
      duplicateFiles: 1,
      dedupSavingsBytes: PNG_1X1.length,
      copyBytes: PNG_1X1.length * 2 + 1,
    });
    expect([...d.files.values()].find((f) => f.size === PNG_1X1.length)?.originalNames).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("reports missing files and unreferenced ZIP entries", async () => {
    const input = chatZip(
      ["ghost.png (file attached)", "<Media omitted>"],
      [{ name: "orphan.png", data: PNG_1X1 }],
    );
    const d = await discoverMedia({ archive: input, parsed: await parse(input) });
    expect(summary(d.references)).toEqual([
      "ghost.png:missing/not_found",
      "-:not-imported/media_omitted",
    ]);
    expect(d.unreferencedEntries).toEqual(["orphan.png"]);
    expect(d.files.size).toBe(0);
  });
});

describe("adversarial names and content", () => {
  it("never resolves traversal, separators, drive letters or NUL", async () => {
    for (const bad of [
      "../../evil.png",
      "a/../b.png",
      "sub/IMG.png",
      "..\\evil.png",
      "C:evil.png",
    ]) {
      expect(isSafeReferenceName(bad), bad).toBe(false);
    }
    expect(isSafeReferenceName("IMG-1.png")).toBe(true);
    expect(isSafeReferenceName("..")).toBe(false);
    expect(isSafeReferenceName("a\0b.png")).toBe(false);
    const input = chatZip(
      ["../../evil.png (file attached)", "dir\\evil.png (file attached)"],
      [{ name: "evil.png", data: PNG_1X1 }],
    );
    const d = await discoverMedia({ archive: input, parsed: await parse(input) });
    for (const ref of d.references) {
      expect(ref.outcome).not.toBe("available");
    }
    expect(d.files.size).toBe(0);
  });

  it("verifies magic bytes instead of trusting extensions", async () => {
    const input = chatZip(
      [
        "fake.png (file attached)",
        "script.jpg (file attached)",
        "song.mp3 (file attached)",
        "doc.pdf (file attached)",
        "photo.jpg (file attached)",
      ],
      [
        { name: "fake.png", data: "MZ\x90\x00not an image" },
        { name: "script.jpg", data: "#!/bin/sh\nrm -rf /\n" },
        { name: "song.mp3", data: PNG_1X1 },
        { name: "doc.pdf", data: "%PDF-1.4" },
        { name: "photo.jpg", data: PNG_1X1 },
      ],
    );
    const d = await discoverMedia({ archive: input, parsed: await parse(input) });
    expect(summary(d.references)).toEqual([
      "fake.png:unsupported/unrecognized_content",
      "script.jpg:unsupported/unrecognized_content",
      "song.mp3:unsupported/mime_mismatch",
      "doc.pdf:unsupported/unsupported_document",
      "photo.jpg:available",
    ]);
    expect([...d.files.values()][0]?.sniffed.extension).toBe("png");
  });

  it("flags ambiguous basenames and oversize files", async () => {
    const input = chatZip(
      ["x.png (file attached)", "big.png (file attached)"],
      [
        { name: "a/x.png", data: PNG_1X1 },
        { name: "b/x.png", data: PNG_1X1 },
        { name: "big.png", data: Buffer.concat([PNG_1X1, Buffer.alloc(500)]) },
      ],
    );
    const d = await discoverMedia({
      archive: input,
      parsed: await parse(input),
      maxFileBytes: 200,
    });
    expect(summary(d.references)).toEqual([
      "x.png:unsupported/ambiguous_name",
      "big.png:unsupported/too_large",
    ]);
  });

  it("honours abort signals", async () => {
    const input = loadFixture("android-private-with-media.zip");
    const parsed = await parse(input);
    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverMedia({ archive: input, parsed, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("companion folders (TXT exports)", () => {
  const txt = (names: string[]) => ({
    name: "WhatsApp Chat with Alice Example.txt",
    data: Buffer.from(
      names
        .map((n, i) => `15/01/2026, 09:${String(20 + i)} - Alice Example: ${n} (file attached)`)
        .join("\n"),
    ),
  });

  it("reads regular files and refuses symlinks to anything", async () => {
    const dir = join(scratch, "media");
    const outside = join(scratch, "outside");
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(dir, "ok.png"), PNG_1X1);
    writeFileSync(join(outside, "secret.png"), PNG_1X1);
    symlinkSync(join(outside, "secret.png"), join(dir, "link.png"));
    symlinkSync(join(dir, "ok.png"), join(dir, "inner-link.png"));
    symlinkSync(outside, join(dir, "dirlink.png"));
    mkdirSync(join(dir, "folder.png"));
    const input = txt([
      "ok.png",
      "link.png",
      "inner-link.png",
      "dirlink.png",
      "folder.png",
      "nothere.png",
    ]);
    const d = await discoverMedia({
      archive: input,
      parsed: await parse(input),
      companionDir: dir,
    });
    expect(summary(d.references)).toEqual([
      "ok.png:available",
      "link.png:unsupported/symlink",
      "inner-link.png:unsupported/symlink",
      "dirlink.png:unsupported/symlink",
      "folder.png:unsupported/not_regular_file",
      "nothere.png:missing/not_found",
    ]);
    expect(d.files.size).toBe(1);
  });

  it("treats everything as missing without a companion folder", async () => {
    const input = txt(["ok.png"]);
    const d = await discoverMedia({ archive: input, parsed: await parse(input) });
    expect(summary(d.references)).toEqual(["ok.png:missing/not_found"]);
  });
});

describe("storage helpers", () => {
  it("scratch dir is isolated", () => {
    expect(readdirSync(scratch)).toEqual([]);
    expect(statSync(scratch).isDirectory()).toBe(true);
  });
});
