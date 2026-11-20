import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaAsset } from "@social-explorer/contracts";
import { createRepositories, openMemoryDatabase, type Repositories, type SqliteDatabase } from "@social-explorer/database";

const T0 = "2026-01-01T10:00:00Z";

export function seedSynthetic(): { db: SqliteDatabase; repos: Repositories } {
  const db = openMemoryDatabase();
  const repos = createRepositories(db);
  repos.datasets.upsert({ id: "ds-1", name: "Synthetic", createdAt: T0, timezone: "UTC", sourceIds: ["src-1"] });
  repos.sources.upsert({ id: "src-1", datasetId: "ds-1", platform: "whatsapp", kind: "whatsapp-android-txt", label: "synthetic.txt", createdAt: T0 });
  repos.provenance.insert({ id: "prov-1", datasetId: "ds-1", sourceId: "src-1", sourceKind: "archive-import", parseStatus: "complete", recordedAt: T0 });
  repos.contacts.upsert("ds-1", { id: "c-alice", displayName: "Alice Synthetic", aliases: [], identifiers: [{ type: "export-name", value: "Alice Synthetic", confidence: "probable" }], isSelf: false, colorKey: "c1" });
  repos.conversations.upsert({ id: "conv-1", datasetId: "ds-1", sourceConversationId: "chat-a", title: "Synthetic Chat", kind: "private" });
  repos.messages.upsert({
    id: "m-1", datasetId: "ds-1", conversationId: "conv-1", sourceMessageId: "s-m-1", senderContactId: "c-alice",
    timestampUtc: "2026-01-02T09:00:00Z", timestampLocal: "2026-01-02T09:00:00", timezone: "UTC",
    direction: "incoming", kind: "text", text: "synthetic secret text", hasAttachment: false,
    sourceKind: "archive-import", parseStatus: "complete", provenanceId: "prov-1",
  });
  return { db, repos };
}

export function addAsset(repos: Repositories, id: string, kind: MediaAsset["kind"], relativePath = `${id}.bin`): void {
  repos.media.upsertAsset({
    id, datasetId: "ds-1", kind, originalName: `${id}.bin`, availability: "available-local",
    storageRelativePath: relativePath, importedAt: T0, provenanceId: "prov-1",
  });
}

/** 16-bit mono PCM sine tone as a WAV file (synthetic audio, no copyright). */
export function writeSineWav(path: string, seconds = 3, hz = 440): void {
  const rate = 8000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, buffer);
}

/** Minimal valid 1×1 PNG (ffmpeg-decodable synthetic fixture). */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
