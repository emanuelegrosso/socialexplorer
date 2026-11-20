import { describe, expect, it } from "vitest";
import {
  ImportCommitError,
  IncompletePlanError,
  applyConfirmation,
  buildMergeReviewPlan,
  canTransition,
  commitArchiveImport,
  parseArchive,
  resolveMergePlan,
  type ImportBatchStatus,
  type ResolvedMergePlan,
} from "./index.js";
import { fixture } from "./fixtures.testutil.js";
import { MemoryIndex, MemorySink, toExistingRef } from "./memory-store.testutil.js";

async function plan(path = "exports/android-group.txt"): Promise<ResolvedMergePlan> {
  const archive = await parseArchive(fixture(path));
  const conversations = applyConfirmation(archive, {
    timezone: "UTC",
    selfNames: ["Alice Example"],
  });
  return resolveMergePlan(await buildMergeReviewPlan(conversations, new MemoryIndex()));
}

describe("chunked commit", () => {
  it("commits in chunks and checkpoints each one", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    const progress: number[] = [];
    const result = await commitArchiveImport({
      batchId: "b1",
      plan: resolved,
      sink,
      chunkSize: 4,
      onProgress: (p) => progress.push(p.committedItems),
    });
    expect(result).toMatchObject({
      status: "committed",
      totalChunks: 4,
      committedChunks: 4,
      committedItems: 15,
      resumedFromChunk: 0,
    });
    expect(progress).toEqual([4, 8, 12, 15]);
    expect(sink.rows.get("b1")).toHaveLength(15);
    expect(sink.checkpoints.get("b1")).toMatchObject({ status: "committed", nextChunkIndex: 4 });
  });

  it("is idempotent when re-run for a committed batch", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    await commitArchiveImport({ batchId: "b1", plan: resolved, sink, chunkSize: 5 });
    const calls = sink.commitCalls;
    const again = await commitArchiveImport({ batchId: "b1", plan: resolved, sink, chunkSize: 5 });
    expect(again.status).toBe("committed");
    expect(sink.commitCalls).toBe(calls);
    expect(sink.rows.get("b1")).toHaveLength(15);
  });

  it("re-importing into the resulting dataset commits only provenance links", async () => {
    const archive = await parseArchive(fixture("exports/android-private.txt"));
    const conversations = applyConfirmation(archive, { timezone: "UTC", selfNames: [] });
    const first = resolveMergePlan(await buildMergeReviewPlan(conversations, new MemoryIndex()));
    const sink = new MemorySink();
    await commitArchiveImport({ batchId: "first", plan: first, sink, chunkSize: 6 });
    const inserted = (sink.rows.get("first") ?? []).filter((r) => r.startsWith("insert:")).length;
    expect(inserted).toBe(15);

    const index = new MemoryIndex(
      conversations.flatMap((c) => c.messages).map((m, i) => toExistingRef(m, `row-${String(i)}`)),
    );
    const second = resolveMergePlan(await buildMergeReviewPlan(conversations, index));
    await commitArchiveImport({ batchId: "second", plan: second, sink, chunkSize: 6 });
    const rows = sink.rows.get("second") ?? [];
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.startsWith("link:"))).toBe(true);
  });

  it("recovers from a simulated mid-chunk crash and resumes without duplicates", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    sink.crashOnChunk = 2;
    const error = await commitArchiveImport({
      batchId: "crash",
      plan: resolved,
      sink,
      chunkSize: 4,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportCommitError);
    expect(error).toMatchObject({ committedChunks: 2, rolledBack: false });
    expect(sink.rows.get("crash")).toHaveLength(8);
    expect(sink.checkpoints.get("crash")).toMatchObject({
      status: "failed",
      nextChunkIndex: 2,
      committedItems: 8,
    });
    expect(sink.checkpoints.get("crash")?.error).toContain("mid-chunk crash");

    sink.crashOnChunk = null;
    const resumed = await commitArchiveImport({
      batchId: "crash",
      plan: resolved,
      sink,
      chunkSize: 4,
    });
    expect(resumed).toMatchObject({ status: "committed", resumedFromChunk: 2, committedItems: 15 });
    const rows = sink.rows.get("crash") ?? [];
    expect(rows).toHaveLength(15);
    expect(new Set(rows).size).toBe(15);
  });

  it("recovers after a hard crash where even the failure checkpoint could not be written", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    sink.crashOnChunk = 1;
    sink.failSaveStatus = "failed";
    await expect(
      commitArchiveImport({ batchId: "hard", plan: resolved, sink, chunkSize: 4 }),
    ).rejects.toBeInstanceOf(ImportCommitError);
    expect(sink.checkpoints.get("hard")).toMatchObject({ status: "committing", nextChunkIndex: 1 });
    sink.crashOnChunk = null;
    sink.failSaveStatus = null;
    const resumed = await commitArchiveImport({
      batchId: "hard",
      plan: resolved,
      sink,
      chunkSize: 4,
    });
    expect(resumed).toMatchObject({ status: "committed", resumedFromChunk: 1 });
    expect(sink.rows.get("hard")).toHaveLength(15);
  });

  it("can roll back a failed batch entirely", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    sink.crashOnChunk = 2;
    const error = await commitArchiveImport({
      batchId: "rb",
      plan: resolved,
      sink,
      chunkSize: 4,
      onFailure: "rollback",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ rolledBack: true, committedChunks: 0 });
    expect(sink.rows.has("rb")).toBe(false);
    expect(sink.checkpoints.has("rb")).toBe(false);
  });

  it("cancels mid-commit and rolls back by default (no half-committed dataset)", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    const controller = new AbortController();
    const result = await commitArchiveImport({
      batchId: "c1",
      plan: resolved,
      sink,
      chunkSize: 4,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.chunkIndex === 1) {
          controller.abort();
        }
      },
    });
    expect(result).toMatchObject({
      status: "canceled",
      rolledBack: true,
      committedChunks: 0,
      committedItems: 0,
    });
    expect(sink.rows.has("c1")).toBe(false);
    expect(sink.checkpoints.has("c1")).toBe(false);
  });

  it("can keep a canceled batch resumable", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    const controller = new AbortController();
    const canceled = await commitArchiveImport({
      batchId: "c2",
      plan: resolved,
      sink,
      chunkSize: 4,
      signal: controller.signal,
      onCancel: "keep",
      onProgress: (p) => {
        if (p.chunkIndex === 0) {
          controller.abort();
        }
      },
    });
    expect(canceled).toMatchObject({ status: "canceled", committedChunks: 1, rolledBack: false });
    expect(sink.checkpoints.get("c2")?.status).toBe("canceled");
    const resumed = await commitArchiveImport({
      batchId: "c2",
      plan: resolved,
      sink,
      chunkSize: 4,
    });
    expect(resumed).toMatchObject({ status: "committed", resumedFromChunk: 1 });
    expect(sink.rows.get("c2")).toHaveLength(15);
  });

  it("does not start when already aborted", async () => {
    const resolved = await plan();
    const sink = new MemorySink();
    const controller = new AbortController();
    controller.abort();
    const result = await commitArchiveImport({
      batchId: "c3",
      plan: resolved,
      sink,
      signal: controller.signal,
    });
    expect(result.status).toBe("canceled");
    expect(sink.commitCalls).toBe(0);
    expect(sink.rows.has("c3")).toBe(false);
  });

  it("refuses incomplete plans and mismatched resumes", async () => {
    const archive = await parseArchive(fixture("exports/android-group.txt"));
    const conversations = applyConfirmation(archive, { timezone: "UTC", selfNames: [] });
    const dupes = conversations
      .flatMap((c) => c.messages)
      .filter((m) => m.text === "Same text, duplicate candidate");
    const review = await buildMergeReviewPlan(
      conversations,
      new MemoryIndex(dupes.slice(0, 1).map((m) => toExistingRef(m, "e"))),
    );
    const incomplete = resolveMergePlan(review);
    const sink = new MemorySink();
    await expect(
      commitArchiveImport({ batchId: "x", plan: incomplete, sink }),
    ).rejects.toBeInstanceOf(IncompletePlanError);
    expect(sink.checkpoints.size).toBe(0);

    const complete = await plan();
    sink.crashOnChunk = 0;
    await commitArchiveImport({ batchId: "y", plan: complete, sink, chunkSize: 4 }).catch(
      () => undefined,
    );
    sink.crashOnChunk = null;
    const other = await plan("exports/ios-group.txt");
    await expect(
      commitArchiveImport({ batchId: "y", plan: other, sink, chunkSize: 4 }),
    ).rejects.toBeInstanceOf(IncompletePlanError);
    await expect(
      commitArchiveImport({ batchId: "y", plan: complete, sink, chunkSize: 5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      commitArchiveImport({ batchId: "z", plan: complete, sink, chunkSize: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("commits contacts with chunk 0 only, and handles empty plans", async () => {
    const resolved = await plan("exports/ios-private.txt");
    const seen: number[] = [];
    const sink = new MemorySink();
    const original = sink.commitChunk.bind(sink);
    sink.commitChunk = (chunk, checkpoint) => {
      seen.push(chunk.contacts.length);
      return original(chunk, checkpoint);
    };
    await commitArchiveImport({ batchId: "ct", plan: resolved, sink, chunkSize: 5 });
    expect(seen).toEqual([2, 0, 0]);

    const empty: ResolvedMergePlan = {
      planId: "empty",
      commitItems: [],
      skipped: [],
      contacts: [],
      unresolved: [],
      complete: true,
    };
    const result = await commitArchiveImport({ batchId: "e", plan: empty, sink });
    expect(result).toMatchObject({ status: "committed", totalChunks: 0, committedItems: 0 });
  });
});

describe("batch state machine", () => {
  const allowed: [ImportBatchStatus, ImportBatchStatus][] = [
    ["pending", "parsing"],
    ["parsing", "previewing"],
    ["previewing", "committing"],
    ["committing", "committed"],
    ["committing", "failed"],
    ["committing", "canceled"],
    ["failed", "committing"],
    ["canceled", "committing"],
  ];
  it.each(allowed)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });
  it.each<[ImportBatchStatus, ImportBatchStatus]>([
    ["committed", "committing"],
    ["committed", "failed"],
    ["pending", "committed"],
    ["parsing", "committing"],
    ["canceled", "committed"],
  ])("forbids %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});
