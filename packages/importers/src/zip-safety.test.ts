import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZIP_LIMITS,
  ZipSafetyError,
  inspectZip,
  isZipData,
  parseArchive,
  previewArchiveImport,
  readZipEntry,
  validateZipEntryName,
  type ZipSafetyErrorCode,
} from "./index.js";
import { fixture, ZIP_FIXTURES } from "./fixtures.testutil.js";
import { buildZip } from "./zip-builder.testutil.js";

const CHAT = "15/01/2026, 09:16 - Alice Example: hi\n";

function expectCode(fn: () => unknown, code: ZipSafetyErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ZipSafetyError);
    expect((error as ZipSafetyError).code).toBe(code);
    return;
  }
  throw new Error(`expected ZipSafetyError ${code}`);
}

describe("ZIP fixtures", () => {
  it.each(ZIP_FIXTURES)("inspects %s safely", async (path) => {
    const { data } = fixture(path);
    expect(isZipData(data)).toBe(true);
    const info = inspectZip(data);
    expect(info.entries.length).toBeGreaterThanOrEqual(2);
    const chat = info.entries.find((entry) => entry.name.endsWith(".txt"));
    expect(chat).toBeDefined();
    if (chat) {
      const bytes = await readZipEntry(data, chat);
      expect(bytes.length).toBe(chat.uncompressedSize);
    }
  });

  it.each(ZIP_FIXTURES)("lists media entries of %s without extracting them", async (path) => {
    const archive = await parseArchive(fixture(path));
    expect(archive.container).toBe("zip");
    expect(archive.mediaEntries.length).toBeGreaterThan(0);
  });
});

describe("entry name validation", () => {
  it.each([
    ["../evil.txt"],
    ["a/../../evil.txt"],
    ["/etc/passwd"],
    ["C:\\Windows\\system.ini"],
    ["c:/x.txt"],
    ["..\\evil.txt"],
    ["\\absolute.txt"],
    ["a//b.txt"],
    ["bad\0name.txt"],
    [""],
  ])("rejects %j", (name) => {
    expectCode(() => validateZipEntryName(name), "unsafe_path");
  });

  it("normalizes safe names", () => {
    expect(validateZipEntryName("./media/IMG.png")).toBe("media/IMG.png");
    expect(validateZipEntryName("folder\\file.txt")).toBe("folder/file.txt");
    expect(validateZipEntryName("dir/")).toBe("dir/");
  });
});

describe("adversarial archives", () => {
  it("rejects path traversal entries", () => {
    const zip = buildZip([{ name: "../evil.txt", data: "x" }]);
    expectCode(() => inspectZip(zip), "unsafe_path");
  });

  it("rejects traversal through the parser/preview path", async () => {
    const zip = buildZip([
      { name: "_chat.txt", data: CHAT },
      { name: "..\\..\\evil.txt", data: "x" },
    ]);
    await expect(previewArchiveImport({ name: "evil.zip", data: zip })).rejects.toBeInstanceOf(
      ZipSafetyError,
    );
  });

  it("rejects symlink entries", () => {
    const zip = buildZip([{ name: "link.txt", data: "/etc/passwd", unixMode: 0o120777 }]);
    expectCode(() => inspectZip(zip), "symlink_entry");
  });

  it("rejects special files but accepts regular unix modes", () => {
    expectCode(
      () => inspectZip(buildZip([{ name: "dev", data: "", unixMode: 0o020644 }])),
      "special_file_entry",
    );
    expect(
      inspectZip(buildZip([{ name: "_chat.txt", data: CHAT, unixMode: 0o100644 }])).entries,
    ).toHaveLength(1);
  });

  it("rejects archives with too many entries", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `f${String(index)}.txt`,
      data: "x",
    }));
    expectCode(
      () => inspectZip(buildZip(entries), { ...DEFAULT_ZIP_LIMITS, maxEntries: 10 }),
      "too_many_entries",
    );
  });

  it("rejects duplicate entry names", () => {
    const zip = buildZip([
      { name: "a.txt", data: "1" },
      { name: "a.txt", data: "2" },
    ]);
    expectCode(() => inspectZip(zip), "duplicate_entry");
  });

  it("rejects ZIP bombs by compression ratio", () => {
    const zip = buildZip([{ name: "_chat.txt", data: Buffer.alloc(8 * 1024 * 1024, 0x61) }]);
    expect(zip.length).toBeLessThan(100_000);
    expectCode(() => inspectZip(zip), "compression_ratio_exceeded");
  });

  it("rejects entries over the single-file limit", () => {
    const zip = buildZip([{ name: "big.txt", data: Buffer.alloc(2048, 1) }]);
    expectCode(
      () => inspectZip(zip, { ...DEFAULT_ZIP_LIMITS, maxEntryUncompressedBytes: 1024 }),
      "entry_too_large",
    );
  });

  it("rejects archives over the total uncompressed limit", () => {
    const zip = buildZip([
      { name: "a.txt", data: Buffer.alloc(700, 1), method: 0 },
      { name: "b.txt", data: Buffer.alloc(700, 2), method: 0 },
    ]);
    expectCode(
      () => inspectZip(zip, { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 1000 }),
      "total_too_large",
    );
  });

  it("detects entries that lie about their uncompressed size while streaming", async () => {
    const zip = buildZip([
      { name: "_chat.txt", data: Buffer.alloc(5000, 0x61), declaredUncompressedSize: 10 },
    ]);
    const info = inspectZip(zip);
    const entry = info.entries[0];
    expect(entry).toBeDefined();
    if (entry) {
      await expect(readZipEntry(zip, entry)).rejects.toMatchObject({ code: "size_mismatch" });
    }
  });

  it("detects CRC mismatches", async () => {
    const zip = buildZip([{ name: "_chat.txt", data: CHAT, declaredCrc: 1234 }]);
    const entry = inspectZip(zip).entries[0];
    if (!entry) {
      throw new Error("missing entry");
    }
    await expect(readZipEntry(zip, entry)).rejects.toMatchObject({ code: "crc_mismatch" });
  });

  it("enforces the running extraction budget", async () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.alloc(900, 1), method: 0 }]);
    const entry = inspectZip(zip).entries[0];
    if (!entry) {
      throw new Error("missing entry");
    }
    await expect(
      readZipEntry(zip, entry, {
        limits: { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 500 },
        budget: { extractedBytes: 0 },
      }),
    ).rejects.toMatchObject({ code: "total_too_large" });
  });

  it("rejects non-zip and truncated data", () => {
    expectCode(() => inspectZip(Buffer.from("definitely not a zip file at all")), "not_a_zip");
    const zip = buildZip([{ name: "_chat.txt", data: CHAT }]);
    expect(() => inspectZip(zip.subarray(0, zip.length - 30))).toThrow(ZipSafetyError);
  });

  it("rejects ZIPs with no chat file", async () => {
    const zip = buildZip([{ name: "IMG.png", data: "png" }]);
    await expect(parseArchive({ name: "x.zip", data: zip })).rejects.toMatchObject({
      code: "no_chat_file",
    });
  });
});
