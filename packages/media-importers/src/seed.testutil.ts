import type { Message } from "@social-explorer/contracts";
import {
  createRepositories,
  openMemoryDatabase,
  type Repositories,
  type SqliteDatabase,
} from "@social-explorer/database";

export const T0 = "2026-01-01T10:00:00Z";

export function createSeededDatabase(): { db: SqliteDatabase; repos: Repositories } {
  const db = openMemoryDatabase();
  const repos = createRepositories(db);
  repos.datasets.upsert({
    id: "ds-1",
    name: "Synthetic",
    createdAt: T0,
    timezone: "Europe/Rome",
    sourceIds: ["src-1"],
  });
  repos.sources.upsert({
    id: "src-1",
    datasetId: "ds-1",
    platform: "whatsapp",
    kind: "whatsapp-android-txt",
    label: "synthetic.txt",
    createdAt: T0,
  });
  repos.provenance.insert({
    id: "prov-1",
    datasetId: "ds-1",
    sourceId: "src-1",
    sourceKind: "archive-import",
    parseStatus: "complete",
    recordedAt: T0,
  });
  for (const [id, name] of [
    ["c-alice", "Alice"],
    ["c-bob", "Bob"],
  ] as const) {
    repos.contacts.upsert("ds-1", {
      id,
      displayName: name,
      aliases: [],
      identifiers: [{ type: "export-name", value: name, confidence: "probable" }],
      isSelf: false,
      colorKey: "c1",
    });
  }
  for (const id of ["conv-1", "conv-2"]) {
    repos.conversations.upsert({
      id,
      datasetId: "ds-1",
      sourceConversationId: id,
      title: id,
      kind: "private",
    });
  }
  return { db, repos };
}

export function addMessage(
  repos: Repositories,
  id: string,
  overrides: Partial<Message> = {},
): void {
  repos.messages.upsert({
    id,
    datasetId: "ds-1",
    conversationId: "conv-1",
    sourceMessageId: `s-${id}`,
    senderContactId: "c-alice",
    timestampUtc: "2026-01-02T09:00:00Z",
    timestampLocal: "2026-01-02T10:00:00",
    timezone: "Europe/Rome",
    direction: "incoming",
    kind: "text",
    text: `hello ${id}`,
    hasAttachment: false,
    sourceKind: "archive-import",
    parseStatus: "complete",
    provenanceId: "prov-1",
    ...overrides,
  });
}
