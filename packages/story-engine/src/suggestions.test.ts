import { describe, expect, it } from "vitest";
import {
  deleteDraft,
  draftFromSuggestion,
  editDraft,
  renameDraft,
  reorderDrafts,
  suggestChapters,
  type ActivityEvent,
} from "./index.js";

function ev(id: string, ts: string, conv = "conv-a", kind: ActivityEvent["kind"] = "message"): ActivityEvent {
  return { id, conversationId: conv, timestampUtc: ts, kind };
}

function synthetic(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let n = 0;
  const push = (ts: string, conv = "conv-a", kind: ActivityEvent["kind"] = "message"): void => {
    n += 1;
    events.push(ev(`e${String(n)}`, ts, conv, kind));
  };
  // Quiet baseline in December, 1 message/day.
  for (let d = 1; d <= 20; d += 1) push(`2025-12-${String(d).padStart(2, "0")}T10:00:00Z`);
  // 30-day pause, then January resumes with a new year.
  for (let d = 1; d <= 6; d += 1) push(`2026-01-${String(d + 19).padStart(2, "0")}T10:00:00Z`);
  // Busy week with a media cluster and a new conversation.
  for (let h = 0; h < 6; h += 1) push(`2026-02-10T${String(8 + h).padStart(2, "0")}:00:00Z`, "conv-a", "media");
  for (let i = 0; i < 30; i += 1) push(`2026-02-${String(10 + (i % 5)).padStart(2, "0")}T12:${String(i).padStart(2, "0")}:00Z`, "conv-b");
  return events;
}

describe("suggestChapters", () => {
  it("is deterministic and independent of input order", () => {
    const events = synthetic();
    const a = suggestChapters(events);
    const b = suggestChapters([...events].reverse());
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(2);
  });

  it("never finalizes and exposes a factual rationale for every suggestion", () => {
    for (const suggestion of suggestChapters(synthetic())) {
      expect(suggestion.finalized).toBe(false);
      expect(suggestion.rationale.signalType).toBeTruthy();
      expect(Object.keys(suggestion.rationale.evidence).length).toBeGreaterThan(0);
      expect(suggestion.rationale.explanation.length).toBeGreaterThan(10);
      expect(suggestion.rationale.metrics.activeDays).toBeGreaterThan(0);
    }
  });

  it("detects a date gap, volume shift, new conversation and media cluster", () => {
    const types = new Set<string>();
    for (const s of suggestChapters(synthetic())) {
      types.add(s.rationale.signalType);
      for (const support of s.rationale.supportingSignals) types.add(support.signalType);
    }
    expect(types).toContain("date-boundary");
    expect(types).toContain("media-cluster");
    expect(types).toContain("activity-volume-shift");
    expect(types).toContain("conversation-new");
  });

  it("reports the pause length as evidence", () => {
    const gap = suggestChapters(synthetic()).find(
      (s) => s.rationale.signalType === "date-boundary" && "gapDays" in s.rationale.evidence,
    );
    expect(gap?.rationale.evidence["gapDays"]).toBe(31);
    expect(gap?.startAt).toBe("2026-01-20T10:00:00Z");
  });

  it("detects returning conversations", () => {
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 6; i += 1) events.push(ev(`a${String(i)}`, `2026-01-0${String(i + 1)}T10:00:00Z`, "conv-x"));
    for (let i = 0; i < 6; i += 1) events.push(ev(`b${String(i)}`, `2026-01-${String(i + 21)}T10:00:00Z`, "conv-x"));
    const all = suggestChapters(events, { minGapDays: 60 });
    const returning = all.flatMap((s) => [s.rationale, ...s.rationale.supportingSignals]);
    expect(returning.some((r) => r.signalType === "conversation-returning")).toBe(true);
  });

  it("honours the date range and returns nothing for empty input", () => {
    expect(suggestChapters([])).toEqual([]);
    const ranged = suggestChapters(synthetic(), { range: { start: "2026-02-01T00:00:00Z" } });
    expect(ranged.every((s) => s.startAt >= "2026-02-01T00:00:00Z")).toBe(true);
  });

  it("respects maxChapters", () => {
    expect(suggestChapters(synthetic(), { maxChapters: 2 }).length).toBeLessThanOrEqual(2);
  });

  it("uses no sentiment or personality vocabulary in its explanations", () => {
    const text = suggestChapters(synthetic())
      .flatMap((s) => [s.rationale, ...s.rationale.supportingSignals])
      .map((r) => r.explanation.toLowerCase())
      .join(" ");
    for (const word of ["sentiment", "happy", "sad", "angry", "love", "toxic", "personality", "relationship", "close friend"]) {
      expect(text).not.toContain(word);
    }
  });
});

describe("chapter drafts", () => {
  it("supports rename, edit, reorder and delete without mutating inputs", () => {
    const drafts = suggestChapters(synthetic()).slice(0, 3).map((s) => draftFromSuggestion(s));
    const [first, second, third] = drafts;
    if (first === undefined || second === undefined || third === undefined) throw new Error("need 3");
    const renamed = renameDraft(drafts, first.id, "Our winter");
    expect(renamed[0]?.title).toBe("Our winter");
    expect(drafts[0]?.title).not.toBe("Our winter");
    expect(editDraft(drafts, second.id, { durationSeconds: 12 })[1]?.durationSeconds).toBe(12);
    expect(reorderDrafts(drafts, [third.id, first.id, second.id]).map((d) => d.id)).toEqual([third.id, first.id, second.id]);
    expect(deleteDraft(drafts, second.id)).toHaveLength(2);
    expect(() => reorderDrafts(drafts, [first.id])).toThrow();
    expect(() => renameDraft(drafts, first.id, "  ")).toThrow();
  });
});
