import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const synthetic = join(root, "fixtures", "synthetic");
const zipsDir = join(synthetic, "zips");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function zipEntryNames(buffer: Buffer): string[] {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe("synthetic text exports", () => {
  it("contain required edge cases", () => {
    const android = readFileSync(join(synthetic, "exports", "android-private.txt"), "utf8");
    const ios = readFileSync(join(synthetic, "exports", "ios-private.txt"), "utf8");
    expect(android).toContain("<Media omitted>");
    expect(android).toContain("(file attached)");
    expect(android).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} - /mu);
    expect(android).toContain("open.spotify.com");
    expect(android).toContain("youtube.com");
    expect(android).toContain("music.apple.com");
    expect(ios).toMatch(/^\[\d{2}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}\] /mu);
    expect(ios).toContain("\u200E");
    expect(ios).toContain("\u200F");
    expect(ios).toContain("<attached:");
  });
});

describe("synthetic ZIP fixtures", () => {
  it("are byte-identical to the deterministic generator output", () => {
    const out = mkdtempSync(join(tmpdir(), "se-zips-"));
    execFileSync(process.execPath, [join(synthetic, "tools", "build-zips.mjs"), "--out", out]);
    const committed = readdirSync(zipsDir).sort();
    expect(committed).toEqual(readdirSync(out).sort());
    expect(committed).toHaveLength(4);
    for (const name of committed) {
      expect(readFileSync(join(zipsDir, name)).equals(readFileSync(join(out, name)))).toBe(true);
    }
  });

  it("contain a chat text file plus synthetic media", () => {
    const names = zipEntryNames(readFileSync(join(zipsDir, "android-private-with-media.zip")));
    expect(names).toEqual(
      expect.arrayContaining([
        "WhatsApp Chat with Alice Example.txt",
        "IMG-20260115-WA0001.png",
        "PTT-20260115-WA0002.wav",
      ]),
    );
    expect(zipEntryNames(readFileSync(join(zipsDir, "ios-private-with-media.zip")))).toContain("_chat.txt");
  });
});

describe("fixture and doc hygiene", () => {
  it("contains only synthetic identifiers", () => {
    const files = [...listFiles(synthetic).filter((f) => /\.(txt|json|md)$/u.test(f))];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const email of content.match(/[\w.+-]+@[\w-]+\.[\w.-]+/gu) ?? []) {
        expect(email).toMatch(/@(s\.whatsapp\.net|g\.us|lid)$/u);
      }
      for (const jid of content.match(/\d{6,}@s\.whatsapp\.net/gu) ?? []) {
        expect(jid).toMatch(/^1555100000\d@s\.whatsapp\.net$/u);
      }
      for (const phone of content.match(/\+\d[\d\s-]{7,}\d/gu) ?? []) {
        expect(phone.replace(/\D/gu, "")).toMatch(/^1555/u);
      }
    }
  });
});
