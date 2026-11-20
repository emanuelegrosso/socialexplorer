import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chunk,
  createRepositories,
  deleteDatabaseFiles,
  listUserTables,
  openDatabase,
  runChunked,
  runInTransaction,
} from "./index.js";
import {
  T0,
  alice,
  conversation,
  createFixture,
  dataset,
  message,
  provenance,
  seedBasics,
  source,
} from "./test-helpers.js";

describe("datasets, sources, batches, provenance", () => {
  it("upserts datasets idempotently and reports source ids", () => {
    const { repos } = createFixture();
    repos.datasets.upsert(dataset);
    repos.sources.upsert(source);
    repos.datasets.upsert({ ...dataset, name: "Renamed" });
    expect(repos.datasets.list()).toEqual([{ ...dataset, name: "Renamed" }]);
    expect(repos.sources.listByDataset("ds-1")).toEqual([source]);
    expect(repos.sources.get("src-1")).toEqual(source);
    expect(repos.datasets.get("nope")).toBeUndefined();
  });

  it("stores import batches with counts and updates status", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    const batch = {
      id: "b1",
      datasetId: "ds-1",
      sourceId: "src-1",
      status: "previewed" as const,
      startedAt: T0,
      counts: {
        parsed: 3,
        partial: 1,
        unparsed: 0,
        newRecords: 2,
        exactDuplicates: 1,
        ambiguous: 0,
      },
    };
    repos.importBatches.upsert(batch);
    repos.importBatches.upsert({
      ...batch,
      status: "committed",
      completedAt: "2026-01-01T10:05:00Z",
    });
    expect(repos.importBatches.get("b1")).toMatchObject({
      status: "committed",
      completedAt: "2026-01-01T10:05:00Z",
    });
    expect(repos.importBatches.listByDataset("ds-1")).toHaveLength(1);
  });

  it("keeps provenance append-only and queryable by batch", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.importBatches.upsert({
      id: "b1",
      datasetId: "ds-1",
      sourceId: "src-1",
      status: "committing",
      startedAt: T0,
      counts: {
        parsed: 0,
        partial: 0,
        unparsed: 0,
        newRecords: 0,
        exactDuplicates: 0,
        ambiguous: 0,
      },
    });
    expect(repos.provenance.insert(provenance)).toBe(false);
    const withBatch = {
      ...provenance,
      id: "prov-2",
      importBatchId: "b1",
      originalTimestampText: "1/2/26, 10:00",
    };
    expect(repos.provenance.insert(withBatch)).toBe(true);
    expect(repos.provenance.get("prov-2")).toEqual(withBatch);
    expect(repos.provenance.listByBatch("b1")).toEqual([withBatch]);
  });
});

describe("contacts, identifiers, conversations, participants", () => {
  it("keeps JID and LID distinct and never merges by display name", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.contacts.upsert("ds-1", {
      ...alice,
      id: "c-bob",
      displayName: "Alice Synthetic",
      identifiers: [],
    });
    repos.contacts.addIdentifier("ds-1", "c-alice", {
      type: "jid",
      value: "x@s.whatsapp.net",
      confidence: "confirmed",
    });
    repos.contacts.addIdentifier("ds-1", "c-alice", {
      type: "lid",
      value: "x@lid",
      confidence: "probable",
    });
    expect(
      repos.contacts.findByIdentifier("ds-1", "jid", "x@s.whatsapp.net").map((c) => c.id),
    ).toEqual(["c-alice"]);
    expect(repos.contacts.findByIdentifier("ds-1", "lid", "x@s.whatsapp.net")).toEqual([]);
    expect(repos.contacts.listByDataset("ds-1")).toHaveLength(2);
    expect(repos.contacts.get("c-alice")?.identifiers.map((i) => i.type)).toEqual([
      "export-name",
      "jid",
      "lid",
    ]);
  });

  it("is idempotent for identifiers and supports removal", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.contacts.upsert("ds-1", alice);
    repos.contacts.upsert("ds-1", alice);
    expect(repos.contacts.get("c-alice")?.identifiers).toHaveLength(1);
    expect(repos.contacts.removeIdentifier("c-alice", "export-name", "Alice Synthetic")).toBe(true);
    expect(repos.contacts.get("c-alice")?.identifiers).toEqual([]);
  });

  it("looks up conversations by source id and widens participant windows", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    expect(repos.conversations.getBySourceId("ds-1", "chat-a")).toEqual(conversation);
    repos.conversations.upsertParticipant({
      conversationId: "conv-1",
      contactId: "c-alice",
      firstSeenAt: "2026-01-05T00:00:00Z",
      lastSeenAt: "2026-01-06T00:00:00Z",
      confidence: "probable",
    });
    repos.conversations.upsertParticipant({
      conversationId: "conv-1",
      contactId: "c-alice",
      firstSeenAt: "2026-01-02T00:00:00Z",
      lastSeenAt: "2026-01-04T00:00:00Z",
      confidence: "confirmed",
    });
    expect(repos.conversations.listParticipants("conv-1")).toEqual([
      {
        conversationId: "conv-1",
        contactId: "c-alice",
        firstSeenAt: "2026-01-02T00:00:00Z",
        lastSeenAt: "2026-01-06T00:00:00Z",
        confidence: "confirmed",
      },
    ]);
    expect(repos.conversations.removeParticipant("conv-1", "c-alice")).toBe(true);
  });
});

describe("messages", () => {
  it("upserts idempotently and counts inserted vs updated", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    expect(repos.messages.upsertMany([message("m1"), message("m2")])).toEqual({
      inserted: 2,
      updated: 0,
    });
    expect(
      repos.messages.upsertMany([message("m1", { text: "edited", isEdited: true }), message("m3")]),
    ).toEqual({
      inserted: 1,
      updated: 1,
    });
    expect(repos.messages.countByConversation("ds-1", "conv-1")).toBe(3);
    expect(repos.messages.countByDataset("ds-1")).toBe(3);
    expect(repos.messages.get("m1")).toMatchObject({ text: "edited", isEdited: true });
    expect(repos.messages.getBySourceId("ds-1", "conv-1", "s-m2")?.id).toBe("m2");
  });

  it("rejects a different message id re-using the same source message id", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.messages.upsert(message("m1"));
    expect(() => repos.messages.upsert(message("m9", { sourceMessageId: "s-m1" }))).toThrow(
      /UNIQUE/u,
    );
  });

  it("round-trips optional fields", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    const bare = message("m1", {
      senderContactId: undefined,
      timestampUtc: undefined,
      text: undefined,
      sourceMessageId: undefined,
    });
    delete (bare as { senderContactId?: string }).senderContactId;
    delete (bare as { timestampUtc?: string }).timestampUtc;
    delete (bare as { text?: string }).text;
    delete (bare as { sourceMessageId?: string }).sourceMessageId;
    repos.messages.upsert(bare);
    expect(repos.messages.get("m1")).toEqual(bare);
  });

  it("queries inclusive time ranges in order, scoped by conversation", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.conversations.upsert({
      ...conversation,
      id: "conv-2",
      sourceConversationId: "chat-b",
      title: "B",
    });
    repos.messages.upsertMany([
      message("m1", { timestampUtc: "2026-01-02T09:00:00Z" }),
      message("m2", { timestampUtc: "2026-01-03T09:00:00Z" }),
      message("m3", { timestampUtc: "2026-01-04T09:00:00Z" }),
      message("m4", { conversationId: "conv-2", timestampUtc: "2026-01-03T10:00:00Z" }),
    ]);
    const range = {
      datasetId: "ds-1",
      start: "2026-01-02T09:00:00Z",
      end: "2026-01-03T10:00:00Z",
      limit: 10,
    };
    expect(
      repos.messages.listRange({ ...range, conversationId: "conv-1" }).map((m) => m.id),
    ).toEqual(["m1", "m2"]);
    expect(repos.messages.listRange(range).map((m) => m.id)).toEqual(["m1", "m2", "m4"]);
    expect(repos.messages.listRange({ ...range, limit: 1 })).toHaveLength(1);
  });

  it("searches text case-insensitively with literal wildcard handling", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.messages.upsertMany([
      message("m1", { text: "Dinner at 100% sure" }),
      message("m2", { text: "dinner_plans" }),
      message("m3", { text: "nothing" }),
    ]);
    expect(repos.messages.search({ datasetId: "ds-1", text: "DINNER", limit: 10 })).toHaveLength(2);
    expect(
      repos.messages.search({ datasetId: "ds-1", text: "100%", limit: 10 }).map((m) => m.id),
    ).toEqual(["m1"]);
    expect(
      repos.messages.search({ datasetId: "ds-1", text: "r_p", limit: 10 }).map((m) => m.id),
    ).toEqual(["m2"]);
    expect(
      repos.messages.search({ datasetId: "ds-1", conversationId: "conv-1", text: "zzz", limit: 5 }),
    ).toEqual([]);
  });

  it("stores reactions and cascades them with the message", () => {
    const { repos, db } = createFixture();
    seedBasics(repos);
    repos.messages.upsert(message("m1"));
    const reaction = { id: "r1", messageId: "m1", emoji: "👍", provenanceId: "prov-1" };
    repos.messages.upsertReaction(reaction);
    repos.messages.upsertReaction({ ...reaction, emoji: "❤️" });
    expect(repos.messages.listReactions("m1")).toEqual([{ ...reaction, emoji: "❤️" }]);
    repos.messages.delete("m1");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM message_reactions").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("sync, settings, annotations, media, analytics", () => {
  it("upserts sync state and checkpoints", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.sync.upsertState({
      sourceId: "src-1",
      datasetId: "ds-1",
      status: "syncing",
      updatedAt: T0,
    });
    repos.sync.upsertState({
      sourceId: "src-1",
      datasetId: "ds-1",
      status: "partial",
      partialWarning: "gap",
      updatedAt: T0,
    });
    expect(repos.sync.getState("src-1")).toEqual({
      sourceId: "src-1",
      datasetId: "ds-1",
      status: "partial",
      partialWarning: "gap",
      updatedAt: T0,
    });
    repos.sync.upsertCheckpoint({
      sourceId: "src-1",
      kind: "history",
      cursor: { n: 1 },
      updatedAt: T0,
    });
    repos.sync.upsertCheckpoint({
      sourceId: "src-1",
      kind: "history",
      cursor: { n: 2 },
      updatedAt: T0,
    });
    expect(repos.sync.getCheckpoint("src-1", "history")?.cursor).toEqual({ n: 2 });
    expect(repos.sync.listCheckpoints("src-1")).toHaveLength(1);
    expect(repos.sync.deleteCheckpoint("src-1", "history")).toBe(true);
  });

  it("stores JSON settings", () => {
    const { repos } = createFixture();
    repos.settings.set("privacy", { metadataOnly: true }, T0);
    repos.settings.set("theme", "dark", T0);
    repos.settings.set("theme", "navy", T0);
    expect(repos.settings.get("privacy")).toEqual({ metadataOnly: true });
    expect(repos.settings.getAll()).toEqual({ privacy: { metadataOnly: true }, theme: "navy" });
    expect(repos.settings.delete("theme")).toBe(true);
    expect(repos.settings.get("theme")).toBeUndefined();
  });

  it("manages annotations and bookmarks", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    const annotation = {
      id: "a1",
      datasetId: "ds-1",
      targetKind: "message" as const,
      targetId: "m1",
      note: "remember",
      bookmarked: true,
      createdAt: T0,
      updatedAt: T0,
    };
    repos.annotations.upsert(annotation);
    repos.annotations.upsert({ ...annotation, note: "updated", updatedAt: "2026-01-02T00:00:00Z" });
    expect(repos.annotations.get("a1")).toMatchObject({ note: "updated", createdAt: T0 });
    expect(repos.annotations.listByTarget("ds-1", "message", "m1")).toHaveLength(1);
    expect(repos.annotations.listBookmarks("ds-1")).toHaveLength(1);
    expect(repos.annotations.delete("a1")).toBe(true);
  });

  it("stores media assets and references", () => {
    const { repos } = createFixture();
    seedBasics(repos);
    repos.messages.upsert(message("m1", { hasAttachment: true, kind: "image" }));
    const asset = {
      id: "ma1",
      datasetId: "ds-1",
      kind: "image" as const,
      contentHash: "abc",
      availability: "available-local" as const,
      importedAt: T0,
      provenanceId: "prov-1",
      originalName: "IMG-1.jpg",
      byteSize: 10,
    };
    repos.media.upsertAsset(asset);
    repos.media.upsertReference("ds-1", {
      id: "mr1",
      mediaAssetId: "ma1",
      messageId: "m1",
      conversationId: "conv-1",
      timestampLocal: "2026-01-02T10:00:00",
      availability: "available-local",
    });
    expect(repos.media.getAsset("ma1")).toEqual(asset);
    expect(repos.media.findAssetsByHash("ds-1", "abc")).toHaveLength(1);
    expect(repos.media.listReferences("ds-1")).toHaveLength(1);
    expect(repos.media.listReferences("ds-1", "other")).toEqual([]);
  });

  it("rebuilds analytics deterministically from messages", () => {
    const { repos, db } = createFixture();
    seedBasics(repos);
    repos.messages.upsertMany([
      message("m1", { timestampLocal: "2026-01-02T10:05:00", text: "abcd" }),
      message("m2", { timestampLocal: "2026-01-02T10:45:00", text: "ab", hasAttachment: true }),
      message("m3", { timestampLocal: "2026-01-02T23:00:00", senderContactId: undefined }),
    ]);
    expect(repos.rebuildAnalytics("ds-1")).toEqual({ daily: 2, hourly: 2 });
    expect(repos.rebuildAnalytics("ds-1")).toEqual({ daily: 2, hourly: 2 });
    const row = db
      .prepare(
        "SELECT message_count AS n, attachment_count AS a, character_count AS c FROM analytics_daily WHERE sender_key = 'c-alice'",
      )
      .get();
    expect(row).toEqual({ n: 2, a: 1, c: 6 });
  });
});

describe("dataset deletion and storage independence", () => {
  it("deletes a dataset and every dependent row in one statement", () => {
    const { repos, db } = createFixture();
    seedBasics(repos);
    repos.messages.upsert(message("m1"));
    repos.media.upsertAsset({
      id: "ma1",
      datasetId: "ds-1",
      kind: "image",
      availability: "missing",
      importedAt: T0,
      provenanceId: "prov-1",
    });
    db.prepare(
      "INSERT INTO story_projects VALUES ('sp1', 'ds-1', 'Movie', NULL, NULL, 'draft', '16:9', ?, ?)",
    ).run(T0, T0);
    repos.rebuildAnalytics("ds-1");
    expect(repos.datasets.delete("ds-1")).toBe(true);
    for (const table of listUserTables(db)) {
      if (table === "app_settings") continue;
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        table,
      ).toBe(0);
    }
  });

  it("deleting database files never touches connector auth storage", () => {
    const root = mkdtempSync(join(tmpdir(), "se-indep-"));
    try {
      const dbDir = join(root, "database");
      const authDir = join(root, "connector-auth");
      mkdirSync(dbDir);
      mkdirSync(authDir);
      writeFileSync(join(authDir, "creds.enc"), "secret");
      const filePath = join(dbDir, "explorer.sqlite");
      const db = openDatabase({ filePath });
      createRepositories(db).datasets.upsert(dataset);
      db.close();
      deleteDatabaseFiles(filePath);
      expect(readdirSync(dbDir)).toEqual([]);
      expect(existsSync(join(authDir, "creds.enc"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("transaction helpers", () => {
  it("chunks arrays and validates size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it("commits per chunk and rolls back only the failing chunk", () => {
    const { repos, db } = createFixture();
    seedBasics(repos);
    const messages = [
      message("m1"),
      message("m2"),
      message("m3", { conversationId: "missing" }),
      message("m4"),
    ];
    expect(() =>
      runChunked(db, messages, 2, (batch) => {
        for (const m of batch) repos.messages.upsert(m);
      }),
    ).toThrow(/FOREIGN KEY/u);
    expect(repos.messages.countByDataset("ds-1")).toBe(2);
  });

  it("rolls back whole transactions on error", () => {
    const { repos, db } = createFixture();
    seedBasics(repos);
    expect(() =>
      runInTransaction(db, () => {
        repos.messages.upsert(message("m1"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(repos.messages.countByDataset("ds-1")).toBe(0);
    expect(
      runChunked(db, [message("a"), message("b"), message("c")], 2, (b) =>
        repos.messages.upsertMany(b),
      ),
    ).toBe(2);
  });
});
