import { describe, expect, it } from "vitest";
import {
  MergeResolutionError,
  applyConfirmation,
  buildMergeReviewPlan,
  parseArchive,
  resolveMergePlan,
  type NormalizedConversation,
  type NormalizedMessage,
} from "./index.js";
import { fixture } from "./fixtures.testutil.js";
import { MemoryIndex, toExistingRef } from "./memory-store.testutil.js";

async function normalized(path: string, self = ["Alice Example"]): Promise<NormalizedConversation> {
  const archive = await parseArchive(fixture(path));
  const conversation = applyConfirmation(archive, { timezone: "Europe/Rome", selfNames: self })[0];
  if (!conversation) {
    throw new Error("no conversation");
  }
  return conversation;
}

const existingFrom = (messages: readonly NormalizedMessage[], prefix = "ex") =>
  messages.map((m, i) => toExistingRef(m, `${prefix}-${String(i)}`));

describe("merge classification", () => {
  it("classifies everything as new against an empty dataset", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const plan = await buildMergeReviewPlan([conversation], new MemoryIndex());
    expect(plan.counts).toEqual({ new: 15, exact_duplicate: 0, ambiguous: 0 });
    expect(plan.reviews.filter((r) => r.kind === "message")).toHaveLength(0);
    expect(plan.contacts.map((c) => c.status)).toEqual(["new", "new"]);
  });

  it("re-importing the same archive yields only exact duplicates and is repeatable", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const index = new MemoryIndex(existingFrom(conversation.messages));
    const plan = await buildMergeReviewPlan([conversation], index);
    expect(plan.counts).toEqual({ new: 0, exact_duplicate: 15, ambiguous: 0 });
    const again = await buildMergeReviewPlan([conversation], index);
    expect(again.planId).toBe(plan.planId);
    expect(plan.items.every((i) => i.existingId !== null)).toBe(true);
  });

  it("mixes new and duplicate records for a partially overlapping import", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const index = new MemoryIndex(existingFrom(conversation.messages.slice(0, 8)));
    const plan = await buildMergeReviewPlan([conversation], index);
    expect(plan.counts).toEqual({ new: 7, exact_duplicate: 8, ambiguous: 0 });
  });

  it("treats minute-precision and second-precision timestamps of equal text as duplicates", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const hello = conversation.messages[1];
    if (!hello) {
      throw new Error("missing");
    }
    const existing = toExistingRef(
      { ...hello, timestampUtc: "2026-01-15T08:16:42.000Z", timestampPrecision: "second" },
      "ex-sec",
    );
    const plan = await buildMergeReviewPlan(
      [{ ...conversation, messages: [hello] }],
      new MemoryIndex([existing]),
    );
    expect(plan.items[0]).toMatchObject({
      classification: "exact_duplicate",
      existingId: "ex-sec",
    });
  });

  it("flags same-minute same-sender records with different text as ambiguous, never dropping them", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const target = conversation.messages[1];
    if (!target) {
      throw new Error("missing");
    }
    const edited = toExistingRef(
      { ...target, text: "Hello Bob (edited)", contentKey: "other-key" },
      "ex-edited",
    );
    const rest = existingFrom(conversation.messages.filter((m) => m !== target));
    const plan = await buildMergeReviewPlan([conversation], new MemoryIndex([...rest, edited]));
    expect(plan.counts).toEqual({ new: 0, exact_duplicate: 14, ambiguous: 1 });
    const item = plan.items.find((i) => i.classification === "ambiguous");
    expect(item).toMatchObject({ reason: "near_timestamp_same_sender", existingId: null });
    expect(item?.candidates.map((c) => c.id)).toEqual(["ex-edited"]);
    expect(plan.reviews.filter((r) => r.kind === "message")).toHaveLength(1);
  });

  it("flags same content at a nearby timestamp (timezone drift) as ambiguous", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const target = conversation.messages[2];
    if (!target) {
      throw new Error("missing");
    }
    const drifted = toExistingRef(
      { ...target, timestampUtc: "2026-01-15T08:18:10.000Z", timestampPrecision: "second" },
      "ex-drift",
    );
    const plan = await buildMergeReviewPlan(
      [{ ...conversation, messages: [target] }],
      new MemoryIndex([drifted]),
      { ambiguousWindowSeconds: 120 },
    );
    expect(plan.items[0]).toMatchObject({
      classification: "ambiguous",
      reason: "same_content_near_timestamp",
    });
  });

  it("does not flag the same sender when far outside the window", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const target = conversation.messages[1];
    if (!target) {
      throw new Error("missing");
    }
    const far = toExistingRef(
      { ...target, text: "x", contentKey: "k", timestampUtc: "2026-01-15T10:00:00.000Z" },
      "ex-far",
    );
    const plan = await buildMergeReviewPlan(
      [{ ...conversation, messages: [target] }],
      new MemoryIndex([far]),
    );
    expect(plan.items[0]?.classification).toBe("new");
  });

  it("handles repeated identical messages by multiplicity", async () => {
    const conversation = await normalized("exports/android-group.txt");
    const dupes = conversation.messages.filter((m) => m.text === "Same text, duplicate candidate");
    expect(dupes).toHaveLength(2);

    const empty = await buildMergeReviewPlan([conversation], new MemoryIndex());
    expect(empty.counts.ambiguous).toBe(0);

    const one = await buildMergeReviewPlan(
      [conversation],
      new MemoryIndex(existingFrom(dupes.slice(0, 1))),
    );
    const states = one.items
      .filter((i) => i.message.text === "Same text, duplicate candidate")
      .map((i) => i.classification);
    expect(states).toEqual(["exact_duplicate", "ambiguous"]);
    expect(one.items.find((i) => i.reason === "repeated_content_surplus")).toBeDefined();

    const both = await buildMergeReviewPlan([conversation], new MemoryIndex(existingFrom(dupes)));
    expect(both.counts.ambiguous).toBe(0);
    expect(both.counts.exact_duplicate).toBe(2);
  });

  it("keeps same text from different conversations separate", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const foreign = existingFrom(conversation.messages).map((ref) => ({
      ...ref,
      conversationKey: "conv_other",
    }));
    const plan = await buildMergeReviewPlan([conversation], new MemoryIndex(foreign));
    expect(plan.counts.exact_duplicate).toBe(0);
  });

  it("raises contact review items for ambiguous display names", async () => {
    const conversation = await normalized("exports/android-private.txt");
    const index = new MemoryIndex(
      [],
      [
        { id: "c-alice", displayName: "Alice Example" },
        { id: "c-bob-1", displayName: "Bob Sample" },
        { id: "c-bob-2", displayName: "bob sample" },
      ],
    );
    const plan = await buildMergeReviewPlan([conversation], index);
    expect(plan.contacts.map((c) => [c.displayName, c.status])).toEqual([
      ["Alice Example", "matched_by_display_name"],
      ["Bob Sample", "ambiguous"],
    ]);
    const review = plan.reviews.find((r) => r.kind === "contact");
    expect(review?.reviewId).toBe("contact:bob sample");
  });
});

describe("explicit resolution", () => {
  async function ambiguousPlan() {
    const conversation = await normalized("exports/android-group.txt");
    const dupes = conversation.messages.filter((m) => m.text === "Same text, duplicate candidate");
    const index = new MemoryIndex(existingFrom(dupes.slice(0, 1)), [
      { id: "c1", displayName: "Carol Placeholder" },
      { id: "c2", displayName: "Carol  Placeholder".replace("  ", " ") },
    ]);
    return { plan: await buildMergeReviewPlan([conversation], index), conversation };
  }

  it("blocks completion until every ambiguous item is resolved", async () => {
    const { plan } = await ambiguousPlan();
    const resolved = resolveMergePlan(plan);
    expect(resolved.complete).toBe(false);
    expect(resolved.unresolved.map((r) => r.kind).sort()).toEqual(["contact", "message"]);
    expect(
      resolved.commitItems.some(
        (c) => c.message.text === "Same text, duplicate candidate" && c.kind === "insert",
      ),
    ).toBe(false);
    expect(resolved.skipped).toHaveLength(0);
  });

  it.each([
    ["keep_both", { action: "keep_both" as const }, "insert"],
    ["link_existing", { action: "link_existing" as const, existingId: "ex-0" }, "link"],
  ])("applies %s", async (_name, resolution, kind) => {
    const { plan } = await ambiguousPlan();
    const message = plan.reviews.find((r) => r.kind === "message");
    const contact = plan.reviews.find((r) => r.kind === "contact");
    if (!message || !contact) {
      throw new Error("expected reviews");
    }
    const resolved = resolveMergePlan(plan, {
      [message.reviewId]: resolution,
      [contact.reviewId]: { action: "link_existing", existingId: "c2" },
    });
    expect(resolved.complete).toBe(true);
    const item = resolved.commitItems.find((c) => c.message.recordId === message.reviewId);
    expect(item?.kind).toBe(kind);
    expect(resolved.contacts.find((c) => c.displayName === "Carol Placeholder")).toEqual({
      displayName: "Carol Placeholder",
      action: "link",
      existingId: "c2",
    });
    expect(resolved.commitItems).toHaveLength(plan.items.length);
  });

  it("skip_incoming keeps the record in the skipped audit list", async () => {
    const { plan } = await ambiguousPlan();
    const message = plan.reviews.find((r) => r.kind === "message");
    const contact = plan.reviews.find((r) => r.kind === "contact");
    if (!message || !contact) {
      throw new Error("expected reviews");
    }
    const resolved = resolveMergePlan(plan, {
      [message.reviewId]: { action: "skip_incoming" },
      [contact.reviewId]: { action: "keep_both" },
    });
    expect(resolved.complete).toBe(true);
    expect(resolved.skipped.map((s) => s.message.recordId)).toEqual([message.reviewId]);
    expect(resolved.commitItems).toHaveLength(plan.items.length - 1);
    expect(resolved.contacts.find((c) => c.displayName === "Carol Placeholder")?.action).toBe(
      "create",
    );
  });

  it("validates resolutions", async () => {
    const { plan } = await ambiguousPlan();
    const message = plan.reviews.find((r) => r.kind === "message");
    const contact = plan.reviews.find((r) => r.kind === "contact");
    if (!message || !contact) {
      throw new Error("expected reviews");
    }
    expect(() => resolveMergePlan(plan, { nope: { action: "keep_both" } })).toThrow(
      MergeResolutionError,
    );
    expect(() =>
      resolveMergePlan(plan, {
        [message.reviewId]: { action: "link_existing", existingId: "zzz" },
      }),
    ).toThrow(MergeResolutionError);
    expect(() =>
      resolveMergePlan(plan, { [contact.reviewId]: { action: "skip_incoming" } }),
    ).toThrow(MergeResolutionError);
  });

  it("auto-links exact duplicates for provenance without review", async () => {
    const conversation = await normalized("exports/ios-group.txt");
    const plan = await buildMergeReviewPlan(
      [conversation],
      new MemoryIndex(existingFrom(conversation.messages)),
    );
    const resolved = resolveMergePlan(plan);
    expect(resolved.complete).toBe(true);
    expect(
      resolved.commitItems.every((c) => c.kind === "link" && c.reason === "exact_duplicate"),
    ).toBe(true);
  });
});
