import {
  createRepositories,
  openMemoryDatabase,
  type Repositories,
  type SqliteDatabase,
} from "@social-explorer/database";

const T0 = "2026-01-01T10:00:00Z";

export function seedSynthetic(messageIds: readonly string[] = ["m-1", "m-2"]): {
  db: SqliteDatabase;
  repos: Repositories;
} {
  const db = openMemoryDatabase();
  const repos = createRepositories(db);
  repos.datasets.upsert({ id: "ds-1", name: "Synthetic", createdAt: T0, timezone: "UTC", sourceIds: ["src-1"] });
  repos.sources.upsert({ id: "src-1", datasetId: "ds-1", platform: "whatsapp", kind: "whatsapp-android-txt", label: "synthetic.txt", createdAt: T0 });
  repos.provenance.insert({ id: "prov-1", datasetId: "ds-1", sourceId: "src-1", sourceKind: "archive-import", parseStatus: "complete", recordedAt: T0 });
  repos.contacts.upsert("ds-1", { id: "c-alice", displayName: "Alice Synthetic", aliases: [], identifiers: [{ type: "export-name", value: "Alice Synthetic", confidence: "probable" }], isSelf: false, colorKey: "c1" });
  repos.conversations.upsert({ id: "conv-1", datasetId: "ds-1", sourceConversationId: "chat-a", title: "Synthetic Chat", kind: "private" });
  for (const id of messageIds) {
    repos.messages.upsert({
      id, datasetId: "ds-1", conversationId: "conv-1", sourceMessageId: `s-${id}`, senderContactId: "c-alice",
      timestampUtc: "2026-01-02T09:00:00Z", timestampLocal: "2026-01-02T09:00:00", timezone: "UTC",
      direction: "incoming", kind: "text", text: `synthetic text ${id}`, hasAttachment: false,
      sourceKind: "archive-import", parseStatus: "complete", provenanceId: "prov-1",
    });
  }
  return { db, repos };
}
