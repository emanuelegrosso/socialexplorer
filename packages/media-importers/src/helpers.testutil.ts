import { readFileSync } from "node:fs";
import { parseArchive, type ArchiveInput, type ParsedArchive } from "@social-explorer/importers";
import type { SqliteDatabase, Repositories } from "@social-explorer/database";
import type { MediaDiscovery, ResolvedMessage } from "./index.js";
import { addMessage } from "./seed.testutil.js";
import { buildZip, type TestZipEntry } from "./zip-builder.testutil.js";

const root = new URL("../../../fixtures/synthetic/", import.meta.url);

export const FIXTURE_ZIPS = [
  "android-private-with-media.zip",
  "android-group-with-media.zip",
  "ios-private-with-media.zip",
  "ios-group-with-media.zip",
] as const;

export function loadFixture(name: string): ArchiveInput {
  return { name, data: readFileSync(new URL(`zips/${name}`, root)) };
}

export const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63d0cadf0a000215014fcdca43b90000000049454e44ae426082",
  "hex",
);

export function chatZip(
  chatLines: readonly string[],
  files: readonly TestZipEntry[],
): ArchiveInput {
  const header = "15/01/2026, 09:15 - Messages and calls are end-to-end encrypted.";
  const chat = [
    header,
    ...chatLines.map(
      (line, i) => `15/01/2026, 09:${String(20 + i).padStart(2, "0")} - Alice Example: ${line}`,
    ),
  ].join("\n");
  return {
    name: "chat.zip",
    data: buildZip([{ name: "WhatsApp Chat with Alice Example.txt", data: chat }, ...files]),
  };
}

export async function parse(input: ArchiveInput): Promise<ParsedArchive> {
  return parseArchive(input);
}

/** Creates one persisted message per distinct (file, ordinal) in the discovery. */
export function seedMessagesFor(
  repos: Repositories,
  discovery: MediaDiscovery,
): (sourceFile: string, ordinal: number) => ResolvedMessage | undefined {
  const known = new Map<string, ResolvedMessage>();
  for (const ref of discovery.references) {
    const key = `${ref.sourceFile}#${String(ref.ordinal)}`;
    if (!known.has(key)) {
      const id = `m-${String(known.size)}`;
      addMessage(repos, id, { kind: "image", hasAttachment: true });
      known.set(key, {
        messageId: id,
        conversationId: "conv-1",
        timestampUtc: "2026-01-02T09:00:00Z",
        timestampLocal: "2026-01-02T10:00:00",
      });
    }
  }
  return (sourceFile, ordinal) => known.get(`${sourceFile}#${String(ordinal)}`);
}

export function countRows(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
