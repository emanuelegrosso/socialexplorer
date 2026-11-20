import { temporalFlowReadModelSchema } from "@social-explorer/contracts";
import { GROUP_NEUTRAL_COLOR, contactColor } from "@social-explorer/domain";
import { describe, expect, it } from "vitest";
import {
  buildTemporalFlowReadModel,
  resolveRange,
  type TemporalFlowInput,
  type TemporalMessageInput,
} from "./index.js";

const contacts = ["alice", "bob", "carol", "dave", "erin"].map((id) => ({
  id: `c_${id}`,
  displayName: `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`,
}));
const groups = [{ conversationId: "conv_group", title: "Hiking Club" }];
const conversations = [
  { id: "conv_ab", kind: "private" as const, participantIds: ["c_alice", "c_bob"] },
  { id: "conv_group", kind: "group" as const, participantIds: contacts.map((c) => c.id) },
  { id: "conv_lonely", kind: "private" as const, participantIds: ["c_alice"] },
];

function msg(id: string, conversationId: string, senderId: string | null, timestampUtc: string, partial = false): TemporalMessageInput {
  return { id, conversationId, senderId, timestampUtc, partial };
}

const messages: TemporalMessageInput[] = [
  msg("m1", "conv_ab", "c_alice", "2026-01-20T08:00:00Z"),
  msg("m2", "conv_ab", "c_alice", "2026-01-20T08:02:00Z"),
  msg("m3", "conv_ab", "c_bob", "2026-01-20T08:05:00Z"),
  msg("m4", "conv_group", "c_carol", "2026-01-20T09:00:00Z"),
  msg("m5", "conv_group", "c_alice", "2026-01-19T12:00:00Z", true),
  msg("m6", "conv_lonely", "c_alice", "2026-01-20T07:00:00Z"),
  msg("m7", "conv_group", null, "2026-01-20T09:30:00Z"),
  msg("m8", "conv_group", "c_bob", "2026-01-10T09:30:00Z"),
];

const base: TemporalFlowInput = {
  datasetId: "ds",
  timezone: "Europe/Rome",
  preset: "7d",
  now: "2026-01-20T10:00:00Z",
  contacts,
  groups,
  conversations,
  messages,
};

describe("range presets in dataset timezone", () => {
  const r = (preset: Parameters<typeof resolveRange>[0]["preset"], now = "2026-01-20T10:00:00Z") =>
    resolveRange({ preset, timezone: "Europe/Rome", now });
  it("evaluates day boundaries in the dataset timezone", () => {
    expect(r("today")).toMatchObject({ start: "2026-01-19T23:00:00.000Z", end: "2026-01-20T23:00:00.000Z" });
    expect(r("yesterday")).toMatchObject({ start: "2026-01-18T23:00:00.000Z", end: "2026-01-19T23:00:00.000Z" });
    expect(r("7d")).toMatchObject({ start: "2026-01-13T23:00:00.000Z", end: "2026-01-20T23:00:00.000Z" });
    expect(Date.parse(r("30d").end) - Date.parse(r("30d").start)).toBe(30 * 86_400_000);
    expect(Date.parse(r("90d").end) - Date.parse(r("90d").start)).toBe(90 * 86_400_000 + 3_600_000);
    expect(r("90d").start).toBe("2025-10-22T22:00:00.000Z");
  });
  it("uses the local date, not the UTC date, near midnight", () => {
    expect(r("today", "2026-01-20T23:30:00Z").start).toBe("2026-01-20T23:00:00.000Z");
    expect(resolveRange({ preset: "today", timezone: "UTC", now: "2026-01-20T23:30:00Z" }).start).toBe("2026-01-20T00:00:00.000Z");
  });
  it("handles DST days as 23h/25h and validates custom ranges", () => {
    const spring = r("today", "2026-03-29T12:00:00Z");
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 3_600_000);
    const autumn = r("today", "2026-10-25T12:00:00Z");
    expect(Date.parse(autumn.end) - Date.parse(autumn.start)).toBe(25 * 3_600_000);
    expect(() => resolveRange({ preset: "custom", timezone: "UTC", now: base.now })).toThrow(/start and end/u);
    expect(() => resolveRange({ preset: "custom", timezone: "UTC", now: base.now, customStart: "2026-01-02T00:00:00Z", customEnd: "2026-01-01T00:00:00Z" })).toThrow(/before/u);
    expect(resolveRange({ preset: "custom", timezone: "UTC", now: base.now, customStart: "2026-01-01T00:00:00Z", customEnd: "2026-01-02T00:00:00Z" }).preset).toBe("custom");
  });
});

describe("temporal flow read model", () => {
  it("matches the contract and puts contacts and groups in the same lane set", () => {
    const model = buildTemporalFlowReadModel(base);
    expect(temporalFlowReadModelSchema.safeParse(model).success).toBe(true);
    expect(model.lanes).toHaveLength(6);
    const group = model.lanes.find((lane) => lane.entityId === "conv_group");
    expect(group).toMatchObject({ kind: "group", color: GROUP_NEUTRAL_COLOR, label: "Hiking Club" });
    for (const lane of model.lanes.filter((l) => l.kind === "contact")) {
      expect(lane.color).toBe(contactColor(lane.entityId));
      expect(lane.color).not.toBe(GROUP_NEUTRAL_COLOR);
    }
    expect(new Set(model.lanes.map((lane) => lane.stableX)).size).toBe(6);
  });

  it("keeps lane positions stable across presets, ranges and input order", () => {
    const lanes = (input: Partial<TemporalFlowInput>) => buildTemporalFlowReadModel({ ...base, ...input }).lanes;
    const reference = lanes({});
    expect(lanes({ preset: "today" })).toEqual(reference);
    expect(lanes({ preset: "yesterday" })).toEqual(reference);
    expect(lanes({ preset: "90d" })).toEqual(reference);
    expect(lanes({ preset: "custom", customStart: "2026-01-01T00:00:00Z", customEnd: "2026-01-05T00:00:00Z" })).toEqual(reference);
    expect(lanes({ messages: [] })).toEqual(reference);
    expect(lanes({ contacts: [...contacts].reverse(), groups })).toEqual(reference);
  });

  it("is deterministic regardless of message order", () => {
    const forward = buildTemporalFlowReadModel(base);
    const reversed = buildTemporalFlowReadModel({ ...base, messages: [...messages].reverse() });
    expect(reversed).toEqual(forward);
  });

  it("creates sender-lane impulses and only documented arcs", () => {
    const model = buildTemporalFlowReadModel({ ...base, lod: "detail" });
    const inRange = messages.filter((m) => Date.parse(m.timestampUtc) >= Date.parse(model.range.start) && m.id !== "m8");
    expect(model.coverage.messageCount).toBe(inRange.length);
    const events = model.events.filter((e) => e.id.includes("m4"));
    expect(events).toEqual([expect.objectContaining({ entityId: "c_carol", conversationId: "conv_group", count: 1 })]);
    const groupArcs = model.arcs.filter((arc) => arc.relationKind === "group-post");
    expect(groupArcs.every((arc) => arc.targetEntityId === "conv_group")).toBe(true);
    expect(groupArcs.map((arc) => arc.sourceEntityId).sort()).toEqual(["c_alice", "c_carol"]);
    const carolArc = groupArcs.find((arc) => arc.sourceEntityId === "c_carol");
    expect(carolArc?.sourceColor).toBe(contactColor("c_carol"));
    const privateArcs = model.arcs.filter((arc) => arc.relationKind === "private-message");
    expect(privateArcs.map((arc) => [arc.sourceEntityId, arc.targetEntityId])).toEqual([
      ["c_alice", "c_bob"],
      ["c_alice", "c_bob"],
      ["c_bob", "c_alice"],
    ]);
    expect(new Set(model.arcs.map((arc) => arc.direction))).toEqual(new Set(["source-to-target"]));
    expect(model.coverage.warnings.join(" ")).toMatch(/no known sender/u);
    expect(model.coverage.warnings.join(" ")).toMatch(/no documented recipient/u);
  });

  it("never synthesizes arcs from a sender to every group member", () => {
    const model = buildTemporalFlowReadModel({
      ...base,
      messages: [msg("g1", "conv_group", "c_alice", "2026-01-20T09:00:00Z")],
    });
    expect(model.arcs).toHaveLength(1);
    expect(model.arcs[0]).toMatchObject({ sourceEntityId: "c_alice", targetEntityId: "conv_group", relationKind: "group-post", count: 1 });
    expect(model.events).toHaveLength(1);
  });

  it("applies LOD bucketing while preserving counts and time", () => {
    const burst = Array.from({ length: 12 }, (_, i) =>
      msg(`b${String(i)}`, "conv_ab", "c_alice", `2026-01-20T08:${String(i * 4).padStart(2, "0")}:00Z`),
    );
    const total = (lod: "overview" | "mid" | "detail") => {
      const model = buildTemporalFlowReadModel({ ...base, messages: burst, lod });
      return {
        model,
        events: model.events.reduce((sum, e) => sum + e.count, 0),
        arcs: model.arcs.reduce((sum, a) => sum + a.count, 0),
      };
    };
    const detail = total("detail");
    const mid = total("mid");
    const overview = total("overview");
    expect([detail.events, mid.events, overview.events]).toEqual([12, 12, 12]);
    expect([detail.arcs, mid.arcs, overview.arcs]).toEqual([12, 12, 12]);
    expect(detail.model.events).toHaveLength(12);
    expect(mid.model.events.length).toBeLessThan(12);
    expect(overview.model.events).toHaveLength(1);
    expect(overview.model.lod).toEqual({ level: "overview", bucketSeconds: 21600 });
    for (const event of overview.model.events) {
      expect(Date.parse(event.timestamp) % 21_600_000).toBe(0);
    }
  });

  it("derives LOD from the range length by default", () => {
    expect(buildTemporalFlowReadModel({ ...base, preset: "today" }).lod.level).toBe("detail");
    expect(buildTemporalFlowReadModel({ ...base, preset: "7d" }).lod.level).toBe("mid");
    expect(buildTemporalFlowReadModel({ ...base, preset: "90d" }).lod.level).toBe("overview");
  });

  it("emits daily separators and secondary hour marks in the dataset timezone", () => {
    const model = buildTemporalFlowReadModel({ ...base, preset: "today", lod: "detail" });
    expect(model.dailyMarkers).toEqual([
      { date: "2026-01-20", timestamp: "2026-01-19T23:00:00.000Z", label: "Tue 20 Jan 2026" },
    ]);
    expect(model.hourMarks).toHaveLength(23);
    expect(model.hourMarks[0]).toEqual({ timestamp: "2026-01-20T00:00:00.000Z", hour: 1, date: "2026-01-20" });
    expect(model.hourMarks.every((mark) => mark.hour > 0)).toBe(true);
    const week = buildTemporalFlowReadModel({ ...base, preset: "7d" });
    expect(week.dailyMarkers.map((m) => m.date)).toEqual([
      "2026-01-14", "2026-01-15", "2026-01-16", "2026-01-17", "2026-01-18", "2026-01-19", "2026-01-20",
    ]);
    const spring = buildTemporalFlowReadModel({ ...base, now: "2026-03-29T12:00:00Z", preset: "today", lod: "detail" });
    expect(spring.hourMarks).toHaveLength(22);
  });

  it("reports truthful coverage and range warnings", () => {
    const empty = buildTemporalFlowReadModel({ ...base, preset: "yesterday", messages: [] });
    expect(empty.coverage).toEqual({ messageCount: 0, partialMessageCount: 0, warnings: ["No messages in the selected range."] });
    const model = buildTemporalFlowReadModel({
      ...base,
      preset: "30d",
      datasetCoverage: { start: "2026-01-10T09:30:00Z", end: "2026-01-20T09:30:00Z" },
    });
    expect(model.coverage).toMatchObject({
      messageCount: 8,
      partialMessageCount: 1,
      start: "2026-01-10T09:30:00.000Z",
      end: "2026-01-20T09:30:00.000Z",
    });
    expect(model.coverage.warnings.join(" ")).toMatch(/beyond imported data/u);
    expect(model.coverage.warnings.join(" ")).toMatch(/partially parsed/u);
  });
});
