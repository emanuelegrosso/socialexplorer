import { ContactMergeError } from "@social-explorer/domain";
import { describe, expect, it } from "vitest";
import {
  ingestCanonicalBatch,
  ingestCanonicalBatchChunked,
  type CanonicalBatch,
  type CanonicalMessageInput,
} from "./ingest.js";
import { createFixture, dataset, source } from "./test-helpers.js";

function seed() {
  const { db, repos } = createFixture();
  repos.datasets.upsert(dataset);
  repos.sources.upsert({ ...source, kind: "baileys-connector" });
  return { db, repos };
}

const base = { datasetId: "ds-1", sourceId: "src-1", recordedAt: "2026-01-01T00:00:00.000Z" };

function msg(n: number, overrides: Partial<CanonicalMessageInput> = {}): CanonicalMessageInput {
  return {
    recordKey: `m${String(n)}`,
    sourceMessageId: `wa-${String(n)}`,
    conversationKey: "chat-1@s.whatsapp.net",
    senderKey: "alice",
    timestampUtc: `2026-01-10T10:0${String(n)}:00.000Z`,
    timestampLocal: `2026-01-10T11:0${String(n)}:00`,
    timezone: "Europe/Rome",
    direction: "incoming",
    kind: "text",
    text: `hello ${String(n)}`,
    hasAttachment: false,
    parseStatus: "complete",
    locator: `wa-${String(n)}`,
    ...overrides,
  };
}

const batch = (messages: CanonicalMessageInput[], extra: Partial<CanonicalBatch> = {}): CanonicalBatch => ({
  ...base,
  sourceKind: "baileys-history",
  contacts: [
    {
      key: "alice",
      displayName: "Alice",
      identifiers: [{ type: "jid", value: "15551000001:7@s.whatsapp.net", confidence: "confirmed" }],
    },
  ],
  conversations: [{ key: "chat-1@s.whatsapp.net", title: "Alice", kind: "private" }],
  messages,
  ...extra,
});

describe("ingestCanonicalBatch", () => {
  it("is idempotent for history replays and persists reactions and links once", () => {
    const { db, repos } = seed();
    const messages = [
      msg(1, {
        reactions: [{ emoji: "👍", reactorKey: "alice", reactedAtUtc: "2026-01-10T10:05:00.000Z" }],
        links: [{ url: "https://youtu.be/EXAMPLE0001", provider: "youtube", linkKind: "video" }],
      }),
      msg(2),
    ];
    const first = ingestCanonicalBatch(db, batch(messages));
    expect(first).toMatchObject({ messagesInserted: 2, contactsCreated: 1, conversationsCreated: 1, reactionsUpserted: 1, linksInserted: 1 });
    const replay = ingestCanonicalBatch(db, batch(messages));
    expect(replay).toMatchObject({ messagesInserted: 0, messagesUpdated: 2, contactsCreated: 0, conversationsCreated: 0, linksInserted: 0 });
    expect(repos.messages.countByDataset("ds-1")).toBe(2);
    const id = (db.prepare("SELECT id FROM messages WHERE source_message_id = 'wa-1'").get() as { id: string }).id;
    expect(repos.messages.listReactions(id)).toHaveLength(1);
    expect(repos.contacts.listByDataset("ds-1")[0]?.identifiers).toEqual([
      expect.objectContaining({ type: "jid", value: "15551000001@s.whatsapp.net" }),
    ]);
  });

  it("applies edit and delete semantics to the same canonical row", () => {
    const { db, repos } = seed();
    ingestCanonicalBatch(db, batch([msg(1)]));
    ingestCanonicalBatch(db, { ...batch([msg(1, { text: "edited", isEdited: true })]), sourceKind: "baileys-live" });
    ingestCanonicalBatch(db, { ...batch([msg(1, { text: "edited", isEdited: true, isDeleted: true })]), sourceKind: "baileys-live" });
    const stored = repos.messages.listRange({ datasetId: "ds-1", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z", limit: 10 });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ text: "edited", isEdited: true, isDeleted: true, sourceKind: "baileys-history" });
  });

  it("supports all three source kinds", () => {
    const { db } = seed();
    for (const [index, sourceKind] of (["archive-import", "baileys-history", "baileys-live"] as const).entries()) {
      const result = ingestCanonicalBatch(db, { ...batch([msg(index + 1)]), sourceKind });
      expect(result.messagesInserted).toBe(1);
    }
    expect(
      db.prepare("SELECT DISTINCT source_kind FROM messages ORDER BY source_kind").all(),
    ).toEqual([{ source_kind: "archive-import" }, { source_kind: "baileys-history" }, { source_kind: "baileys-live" }]);
  });

  it("auto-links only identical phone/JID and never merges by display name alone", () => {
    const { db, repos } = seed();
    ingestCanonicalBatch(db, batch([msg(1)]));
    const sameJid = ingestCanonicalBatch(db, {
      ...batch([msg(2)]),
      contacts: [{ key: "alice", displayName: "Alice B", identifiers: [{ type: "jid", value: "15551000001@s.whatsapp.net", confidence: "confirmed" }] }],
    });
    expect(sameJid.contactsCreated).toBe(0);
    const namesake = ingestCanonicalBatch(db, {
      ...batch([msg(3)]),
      contacts: [
        { key: "alice", displayName: "Alice", identifiers: [{ type: "export-name", value: "Alice", confidence: "unknown" }] },
      ],
    });
    expect(namesake.contactsCreated).toBe(1);
    expect(repos.contacts.listByDataset("ds-1")).toHaveLength(2);
    const lidOnly = ingestCanonicalBatch(db, {
      ...batch([msg(4)]),
      contacts: [{ key: "alice", displayName: "Alice", identifiers: [{ type: "lid", value: "00000001@lid", confidence: "probable" }] }],
    });
    expect(lidOnly.contactsCreated).toBe(1);
    const jidOwner = repos.contacts
      .listByDataset("ds-1")
      .find((c) => c.identifiers.some((identifier) => identifier.type === "jid"));
    expect(jidOwner?.aliases).toContain("Alice B");
  });

  it("surfaces weak matches as review suggestions without merging", () => {
    const { db } = seed();
    ingestCanonicalBatch(db, {
      ...batch([msg(1)]),
      contacts: [{ key: "alice", displayName: "Alice", identifiers: [{ type: "lid", value: "00000001@lid", confidence: "probable" }, { type: "export-name", value: "Alice", confidence: "unknown" }] }],
    });
    const second = ingestCanonicalBatch(db, {
      ...batch([msg(2)], { sourceId: "src-1" }),
      contacts: [{ key: "alice", displayName: "Alice", identifiers: [{ type: "export-name", value: "Alice", confidence: "unknown" }], idSalt: "other" }],
    });
    expect(second.reviewSuggestions).toHaveLength(1);
    expect(second.reviewSuggestions[0]?.candidateContactIds).toHaveLength(1);
  });

  it("rejects unknown sources and conversations, and rolls back the failing batch", () => {
    const { db, repos } = seed();
    expect(() => ingestCanonicalBatch(db, { ...batch([msg(1)]), sourceId: "nope" })).toThrow(/unknown source/u);
    expect(() =>
      ingestCanonicalBatch(db, batch([msg(1), msg(2, { conversationKey: "missing" })], { conversations: [] })),
    ).toThrow(/unknown conversation/u);
    expect(repos.messages.countByDataset("ds-1")).toBe(0);
    expect(repos.contacts.listByDataset("ds-1")).toHaveLength(0);
  });

  it("commits chunk by chunk and replays safely", () => {
    const { db, repos } = seed();
    const messages = [1, 2, 3, 4, 5].map((n) => msg(n));
    const result = ingestCanonicalBatchChunked(db, batch(messages), 2);
    expect(result.messagesInserted).toBe(5);
    expect(result.contactsCreated).toBe(1);
    expect(ingestCanonicalBatchChunked(db, batch(messages), 2).messagesInserted).toBe(0);
    expect(repos.messages.countByDataset("ds-1")).toBe(5);
  });
});

describe("contact merge / unmerge", () => {
  function twoContacts() {
    const { db, repos } = seed();
    ingestCanonicalBatch(db, {
      ...batch([msg(1), msg(2, { senderKey: "alias" })]),
      contacts: [
        { key: "alice", displayName: "Alice", identifiers: [{ type: "jid", value: "15551000001@s.whatsapp.net", confidence: "confirmed" }] },
        { key: "alias", displayName: "Alice (new)", identifiers: [{ type: "lid", value: "00000001@lid", confidence: "probable" }] },
      ],
    });
    const contacts = repos.contacts.listByDataset("ds-1");
    const primary = contacts.find((c) => c.displayName === "Alice")?.id ?? "";
    const secondary = contacts.find((c) => c.displayName === "Alice (new)")?.id ?? "";
    return { db, repos, primary, secondary };
  }

  it("merges explicitly, preserves originals, and unmerge restores everything", () => {
    const { db, repos, primary, secondary } = twoContacts();
    const before = db.prepare("SELECT id, sender_contact_id FROM messages ORDER BY id").all();
    const identifiersBefore = db.prepare("SELECT * FROM contact_identifiers ORDER BY id").all();

    const merge = repos.identity.mergeContacts("ds-1", primary, secondary, { now: "2026-01-02T00:00:00.000Z", reason: "same person" });
    expect(merge).toMatchObject({ primaryContactId: primary, secondaryContactId: secondary });
    expect(db.prepare("SELECT id, sender_contact_id FROM messages ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM contact_identifiers ORDER BY id").all()).toEqual(identifiersBefore);
    expect(db.prepare("SELECT provenance_id FROM messages").all()).toHaveLength(2);

    const active = repos.identity.listActiveContacts("ds-1");
    expect(active.map((c) => c.id)).toEqual([primary]);
    expect(active[0]?.mergedContactIds).toEqual([secondary]);
    expect(active[0]?.identifiers.map((i) => i.type).sort()).toEqual(["jid", "lid"]);
    expect(active[0]?.aliases).toContain("Alice (new)");
    expect(repos.rebuildAnalytics("ds-1")).toEqual({ daily: 1, hourly: 1 });
    expect(db.prepare("SELECT sender_key, message_count FROM analytics_daily").all()).toEqual([{ sender_key: primary, message_count: 2 }]);

    const unmerged = repos.identity.unmergeContact("ds-1", secondary, "2026-01-03T00:00:00.000Z");
    expect(unmerged.unmergedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(repos.identity.listActiveContacts("ds-1")).toHaveLength(2);
    expect(repos.identity.mergeMap("ds-1").size).toBe(0);
    repos.rebuildAnalytics("ds-1");
    expect(db.prepare("SELECT sender_key FROM analytics_daily ORDER BY sender_key").all()).toHaveLength(2);
    expect(repos.identity.listMerges("ds-1")).toHaveLength(1);
    expect(repos.identity.mergeContacts("ds-1", primary, secondary).secondaryContactId).toBe(secondary);
  });

  it("rejects invalid merges and unmerging a contact that is not merged", () => {
    const { repos, primary, secondary } = twoContacts();
    const code = (run: () => unknown): string | undefined => {
      try {
        run();
      } catch (error) {
        return error instanceof ContactMergeError ? error.code : "other";
      }
      return undefined;
    };
    expect(code(() => repos.identity.mergeContacts("ds-1", primary, primary))).toBe("same_contact");
    expect(code(() => repos.identity.mergeContacts("ds-1", primary, "ghost"))).toBe("unknown_contact");
    expect(code(() => repos.identity.unmergeContact("ds-1", secondary))).toBe("unknown_contact");
    repos.identity.mergeContacts("ds-1", primary, secondary);
    expect(code(() => repos.identity.mergeContacts("ds-1", secondary, primary))).toBe("primary_is_merged");
    expect(code(() => repos.identity.mergeContacts("ds-1", primary, secondary))).toBe("secondary_already_merged");
  });

  it("suggests but never performs merges and matches identifiers with confidence", () => {
    const { repos, primary, secondary } = twoContacts();
    expect(repos.identity.suggestMerges("ds-1")).toEqual([]);
    expect(repos.identity.listMerges("ds-1")).toEqual([]);
    const matches = repos.identity.matchIdentifiers("ds-1", [{ type: "lid", value: "00000001@lid" }]);
    expect(matches).toEqual([expect.objectContaining({ contactId: secondary, confidence: "probable", autoLinkable: false })]);
    expect(repos.identity.resolveIdentity("ds-1", [{ type: "jid", value: "15551000001@s.whatsapp.net" }])).toMatchObject({ kind: "linked", contactId: primary });
  });
});
