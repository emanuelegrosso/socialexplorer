import type {
  Contact,
  Conversation,
  DataSource,
  Dataset,
  Message,
  ProvenanceRecord,
} from "@social-explorer/contracts";
import {
  createRepositories,
  openMemoryDatabase,
  type Repositories,
  type SqliteDatabase,
} from "./index.js";

export const T0 = "2026-01-01T10:00:00Z";

export function createFixture(): { db: SqliteDatabase; repos: Repositories } {
  const db = openMemoryDatabase();
  return { db, repos: createRepositories(db) };
}

export const dataset: Dataset = {
  id: "ds-1",
  name: "Synthetic Dataset",
  createdAt: T0,
  timezone: "Europe/Rome",
  sourceIds: ["src-1"],
};

export const source: DataSource = {
  id: "src-1",
  datasetId: "ds-1",
  platform: "whatsapp",
  kind: "whatsapp-android-txt",
  label: "synthetic.txt",
  createdAt: T0,
};

export const provenance: ProvenanceRecord = {
  id: "prov-1",
  datasetId: "ds-1",
  sourceId: "src-1",
  sourceKind: "archive-import",
  parseStatus: "complete",
  recordedAt: T0,
};

export const alice: Contact = {
  id: "c-alice",
  displayName: "Alice Synthetic",
  aliases: ["Ali"],
  identifiers: [{ type: "export-name", value: "Alice Synthetic", confidence: "probable" }],
  isSelf: false,
  colorKey: "c1",
};

export const conversation: Conversation = {
  id: "conv-1",
  datasetId: "ds-1",
  sourceConversationId: "chat-a",
  title: "Synthetic Chat",
  kind: "private",
};

export function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
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
  };
}

export function seedBasics(repos: Repositories): void {
  repos.datasets.upsert(dataset);
  repos.sources.upsert(source);
  repos.provenance.insert(provenance);
  repos.contacts.upsert("ds-1", alice);
  repos.conversations.upsert(conversation);
}
