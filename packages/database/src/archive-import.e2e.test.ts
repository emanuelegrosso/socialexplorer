import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  applyConfirmation,
  buildMergeReviewPlan,
  commitArchiveImport,
  previewArchiveImport,
  resolveMergePlan,
  type MergeResolutions,
} from "@social-explorer/importers";
import { describe, expect, it } from "vitest";
import {
  SqliteExistingDatasetIndex,
  SqliteImportCommitSink,
  createRepositories,
  ensureDataset,
  markInterruptedImports,
  openMemoryDatabase,
  registerArchiveSource,
  type SqliteDatabase,
} from "./index.js";

const root = new URL("../../../fixtures/synthetic/", import.meta.url);
const TZ = "Europe/Rome";
const NOW = "2026-02-01T00:00:00.000Z";

function load(relative: string): { name: string; data: Uint8Array } {
  return { name: relative.split("/").pop() ?? relative, data: readFileSync(new URL(relative, root)) };
}

interface RunOptions {
  readonly batchId: string;
  readonly resolutions?: MergeResolutions;
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
  readonly failAfterChunks?: number;
}

async function importArchive(db: SqliteDatabase, datasetId: string, relative: string, options: RunOptions) {
  const input = load(relative);
  const { preview, archive } = await previewArchiveImport(input);
  const selfNames = ["Alice Example"];
  const conversations = applyConfirmation(archive, { timezone: TZ, selfNames });
  const index = new SqliteExistingDatasetIndex(db, datasetId, { excludeBatchId: options.batchId });
  const review = await buildMergeReviewPlan(conversations, index);
  const plan = resolveMergePlan(review, options.resolutions ?? {});
  const source = registerArchiveSource(db, {
    datasetId,
    name: input.name,
    contentHash: createHash("sha256").update(input.data).digest("hex"),
    container: preview.container,
    platform: preview.platform,
    now: NOW,
  });
  const sink = new SqliteImportCommitSink({
    db,
    datasetId,
    sourceId: source.id,
    timezone: TZ,
    conversations,
    selfNames,
    now: () => NOW,
  });
  let chunks = 0;
  const commitChunk = sink.commitChunk.bind(sink);
  if (options.failAfterChunks !== undefined) {
    const limit = options.failAfterChunks;
    sink.commitChunk = (chunk, checkpoint) => {
      if (chunks >= limit) {
        return Promise.reject(new Error("simulated crash"));
      }
      chunks += 1;
      return commitChunk(chunk, checkpoint);
    };
  }
  return {
    review,
    plan,
    sink,
    run: () =>
      commitArchiveImport({
        batchId: options.batchId,
        plan,
        sink,
        chunkSize: options.chunkSize ?? 4,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
  };
}

function setup() {
  const db = openMemoryDatabase();
  const dataset = ensureDataset(db, { name: "Synthetic", timezone: TZ, now: NOW });
  return { db, repos: createRepositories(db), datasetId: dataset.id };
}

const count = (db: SqliteDatabase, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("archive import -> SQLite (synthetic fixtures)", () => {
  it.each([
    ["exports/android-private.txt", false],
    ["exports/ios-private.txt", false],
    ["zips/android-private-with-media.zip", false],
    ["zips/ios-private-with-media.zip", false],
    ["exports/android-group.txt", true],
    ["zips/android-group-with-media.zip", true],
    ["exports/ios-group.txt", true],
    ["zips/ios-group-with-media.zip", true],
  ] as const)("persists %s through preview, review, commit", async (file, isGroup) => {
    const { db, datasetId } = setup();
    const job = await importArchive(db, datasetId, file, { batchId: `b-${file}` });
    expect(job.plan.complete).toBe(true);
    const result = await job.run();
    expect(result.status).toBe("committed");
    const conversations = createRepositories(db).conversations.listByDataset(datasetId);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.kind).toBe(isGroup ? "group" : "private");
    const stored = count(db, "messages");
    expect(stored).toBeGreaterThan(5);
    expect(job.sink.persisted.messagesInserted).toBe(stored);
    const batch = createRepositories(db).importBatches.get(`b-${file}`);
    expect(batch?.status).toBe("committed");
    expect(batch?.counts.newRecords).toBe(stored);
    expect(createRepositories(db).datasets.get(datasetId)?.coverageStart).toBeDefined();
  });

  it("stores canonical fields: UTC conversion, sender contacts, links, self direction", async () => {
    const { db, repos, datasetId } = setup();
    await (await importArchive(db, datasetId, "exports/android-private.txt", { batchId: "b1" })).run();
    const alice = repos.contacts.listByDataset(datasetId).find((c) => c.displayName === "Alice Example");
    const bob = repos.contacts.listByDataset(datasetId).find((c) => c.displayName === "Bob Sample");
    expect(alice?.isSelf).toBe(true);
    expect(bob?.isSelf).toBe(false);
    expect(alice?.identifiers).toEqual([
      expect.objectContaining({ type: "export-name", value: "Alice Example", confidence: "unknown" }),
    ]);
    const first = db
      .prepare("SELECT * FROM messages WHERE text LIKE 'Hello Bob%'")
      .get() as Record<string, unknown>;
    expect(first["timestamp_local"]).toBe("2026-01-15T09:16:00");
    expect(first["timestamp_utc"]).toBe("2026-01-15T08:16:00.000Z");
    expect(first["timestamp_precision"]).toBe("minute");
    expect(first["direction"]).toBe("outgoing");
    expect(first["sender_contact_id"]).toBe(alice?.id);
    const links = db.prepare("SELECT provider, link_kind FROM external_media_links ORDER BY provider").all();
    expect(links).toEqual(
      expect.arrayContaining([
        { provider: "spotify", link_kind: "music" },
        { provider: "youtube", link_kind: "video" },
        { provider: "apple-music", link_kind: "music" },
      ]),
    );
    expect(count(db, "provenance_records")).toBeGreaterThanOrEqual(count(db, "messages"));
    const system = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'").get() as { n: number };
    expect(system.n).toBeGreaterThan(0);
  });

  it("keeps unparseable records as provenance only, never as messages", async () => {
    const { db, datasetId } = setup();
    const job = await importArchive(db, datasetId, "exports/android-private.txt", { batchId: "b1" });
    await job.run();
    expect(job.sink.persisted.unplacedRecords).toBeGreaterThan(0);
    const unplaced = db
      .prepare(
        "SELECT COUNT(*) AS n FROM provenance_records p WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.provenance_id = p.id)",
      )
      .get() as { n: number };
    expect(unplaced.n).toBe(job.sink.persisted.unplacedRecords);
  });

  it("is idempotent: re-running the same commit changes nothing", async () => {
    const { db, datasetId } = setup();
    const job = await importArchive(db, datasetId, "exports/android-group.txt", { batchId: "b1" });
    await job.run();
    const before = ["messages", "contacts", "provenance_records", "message_provenance", "conversations"].map((t) => count(db, t));
    const again = await job.run();
    expect(again.status).toBe("committed");
    expect(["messages", "contacts", "provenance_records", "message_provenance", "conversations"].map((t) => count(db, t))).toEqual(before);
  });

  it("deduplicates a multi-archive re-import (TXT then ZIP of the same group chat)", async () => {
    const { db, datasetId } = setup();
    const first = await importArchive(db, datasetId, "exports/android-group.txt", { batchId: "b1" });
    await first.run();
    const stored = count(db, "messages");
    const contacts = count(db, "contacts");
    const provenanceBefore = count(db, "provenance_records");

    const second = await importArchive(db, datasetId, "zips/android-group-with-media.zip", { batchId: "b2" });
    expect(second.review.counts.new).toBe(0);
    expect(second.review.counts.exact_duplicate + second.review.counts.ambiguous).toBeGreaterThan(0);
    const unresolved = second.review.reviews.filter((r) => r.kind === "message");
    const resolutions: MergeResolutions = Object.fromEntries(
      unresolved.map((r) => [r.reviewId, { action: "skip_incoming" } as const]),
    );
    const resolved = await importArchive(db, datasetId, "zips/android-group-with-media.zip", {
      batchId: "b2",
      resolutions,
    });
    const result = await resolved.run();
    expect(result.status).toBe("committed");
    expect(count(db, "messages")).toBe(stored);
    expect(count(db, "contacts")).toBe(contacts);
    expect(count(db, "conversations")).toBe(1);
    expect(count(db, "provenance_records")).toBeGreaterThan(provenanceBefore);
    const observed = db
      .prepare("SELECT COUNT(*) AS n FROM message_provenance WHERE reason = 'exact_duplicate'")
      .get() as { n: number };
    expect(observed.n).toBe(resolved.review.counts.exact_duplicate);
    expect(resolved.sink.persisted.messagesInserted).toBe(0);
  });

  it("reuses the same contacts when an iOS export of the same group is imported", async () => {
    const { db, repos, datasetId } = setup();
    await (await importArchive(db, datasetId, "exports/android-group.txt", { batchId: "b1" })).run();
    const probe = await importArchive(db, datasetId, "exports/ios-group.txt", { batchId: "b2" });
    const resolutions: MergeResolutions = Object.fromEntries(
      probe.review.reviews.map((r) => [r.reviewId, { action: "keep_both" } as const]),
    );
    await (await importArchive(db, datasetId, "exports/ios-group.txt", { batchId: "b2", resolutions })).run();
    const names = repos.contacts.listByDataset(datasetId).map((c) => c.displayName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["Alice Example", "Bob Sample", "Carol Placeholder"]));
  });

  it("recovers from a crash: resumes from the checkpoint without duplicates", async () => {
    const { db, datasetId } = setup();
    const crashing = await importArchive(db, datasetId, "exports/android-group.txt", {
      batchId: "b1",
      failAfterChunks: 1,
    });
    await expect(crashing.run()).rejects.toThrow(/simulated crash/u);
    const partial = count(db, "messages");
    expect(partial).toBeGreaterThan(0);
    expect(createRepositories(db).importBatches.get("b1")?.status).toBe("failed");
    expect(
      (db.prepare("SELECT next_chunk_index AS n FROM import_checkpoints WHERE batch_id = 'b1'").get() as { n: number }).n,
    ).toBe(1);
    expect(count(db, "messages")).toBe(partial);

    const resumed = await importArchive(db, datasetId, "exports/android-group.txt", { batchId: "b1" });
    const result = await resumed.run();
    expect(result.status).toBe("committed");
    expect(result.resumedFromChunk).toBe(1);
    const clean = setup();
    await (await importArchive(clean.db, clean.datasetId, "exports/android-group.txt", { batchId: "b1" })).run();
    expect(count(db, "messages")).toBe(count(clean.db, "messages"));
    expect(count(db, "contacts")).toBe(count(clean.db, "contacts"));
  });

  it("hides uncommitted batches from analytics and rolls back on cancel", async () => {
    const { db, repos, datasetId } = setup();
    const crashing = await importArchive(db, datasetId, "exports/android-group.txt", {
      batchId: "b1",
      failAfterChunks: 1,
    });
    await expect(crashing.run()).rejects.toThrow();
    expect(count(db, "messages")).toBeGreaterThan(0);
    expect(count(db, "visible_messages")).toBe(0);
    expect(repos.rebuildAnalytics(datasetId)).toEqual({ daily: 0, hourly: 0 });
    await crashing.sink.rollbackBatch("b1");
    expect(count(db, "messages")).toBe(0);
    expect(count(db, "contacts")).toBe(0);
    expect(count(db, "conversations")).toBe(0);
    expect(repos.importBatches.get("b1")?.status).toBe("cancelled");
  });

  it("marks interrupted committing batches as failed so they can resume", async () => {
    const { db, datasetId } = setup();
    const job = await importArchive(db, datasetId, "exports/android-private.txt", {
      batchId: "b1",
      failAfterChunks: 1,
    });
    await expect(job.run()).rejects.toThrow();
    db.prepare("UPDATE import_batches SET status = 'committing' WHERE id = 'b1'").run();
    expect(markInterruptedImports(db, NOW)).toEqual(["b1"]);
    expect(createRepositories(db).importBatches.get("b1")?.status).toBe("failed");
  });
});
