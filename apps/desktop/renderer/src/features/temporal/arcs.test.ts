import { describe, expect, it } from "vitest";
import { aggregateArcs, pulseProgress, validateArcs } from "./arcs";
import { buildLaneRegistry } from "./layout";
import { createSyntheticReadModel } from "./test-model";

describe("WX-044 directional arcs", () => {
  it("accepts only sender→recipient or sender→group arcs and rejects member fan-out", () => {
    const model = createSyntheticReadModel();
    const registry = buildLaneRegistry(model);
    const { valid, rejected } = validateArcs(model.arcs, registry.lanes);
    expect(valid.length).toBeGreaterThan(0);
    expect(
      valid.every(
        (arc) =>
          (arc.relationKind === "private-message" &&
            registry.lanes.get(arc.targetEntityId)?.kind === "contact") ||
          (arc.relationKind === "group-post" &&
            registry.lanes.get(arc.targetEntityId)?.kind === "group"),
      ),
    ).toBe(true);
    const bad = {
      id: "bad",
      sourceEntityId: "c_alice",
      targetEntityId: "c_bob",
      timestamp: model.range.start,
      direction: "source-to-target" as const,
      count: 1,
      relationKind: "group-post" as const,
      sourceColor: "#AABBCC",
    };
    expect(validateArcs([...model.arcs, bad], registry.lanes).rejected).toContainEqual(
      expect.objectContaining({ arc: bad, reason: "group_target_not_group" }),
    );
    const syntheticMemberArc = {
      ...bad,
      relationKind: "private-message" as const,
      targetEntityId: "conv_group",
    };
    expect(validateArcs([syntheticMemberArc], registry.lanes).rejected[0]?.reason).toBe(
      "private_target_not_contact",
    );
    expect(rejected).toHaveLength(0);
    const aggregated = aggregateArcs(valid, 0);
    expect(aggregated.reduce((sum, arc) => sum + arc.count, 0)).toBe(
      valid.reduce((sum, arc) => sum + arc.count, 0),
    );
    const p0 = pulseProgress("arc:test", 0);
    const p1 = pulseProgress("arc:test", 1200);
    expect(p0).toBeGreaterThanOrEqual(0);
    expect(p0).toBeLessThan(1);
    expect(p1).not.toBe(p0);
  });
});