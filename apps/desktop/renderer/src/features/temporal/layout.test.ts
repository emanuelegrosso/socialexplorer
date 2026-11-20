import { GROUP_NEUTRAL_COLOR, contactColor } from "@social-explorer/domain";
import { describe, expect, it } from "vitest";
import { FALLBACK_CONTACT_COLOR, buildLaneRegistry, laneColor } from "./layout";
import { createSyntheticReadModel } from "./test-model";

describe("WX-041 lane stability and color rules", () => {
  it("assigns neutral color to groups and palette colors to contacts", () => {
    const model = createSyntheticReadModel();
    const registry = buildLaneRegistry(model);
    const group = [...registry.lanes.values()].find((lane) => lane.kind === "group");
    expect(group?.color).toBe(GROUP_NEUTRAL_COLOR);
    for (const lane of registry.lanes.values()) {
      if (lane.kind === "contact") {
        expect(lane.color).toBe(contactColor(lane.entityId));
        expect(lane.color).not.toBe(GROUP_NEUTRAL_COLOR);
      }
    }
    expect(laneColor({ kind: "group", color: "#ABCDEF" })).toBe(GROUP_NEUTRAL_COLOR);
    expect(laneColor({ kind: "contact", color: contactColor("c_alice") })).toBe(contactColor("c_alice"));
    expect(laneColor({ kind: "contact", color: "bad" })).toBe(FALLBACK_CONTACT_COLOR);
  });

  it("keeps lane positions when layoutVersion is unchanged", () => {
    const narrow = createSyntheticReadModel({ preset: "today" });
    const wide = createSyntheticReadModel({ preset: "90d" });
    const first = buildLaneRegistry(narrow);
    const second = buildLaneRegistry(wide, first);
    for (const lane of first.lanes.values()) {
      const next = second.lanes.get(lane.entityId);
      expect(next?.x).toBe(lane.x);
      expect(next?.z).toBe(lane.z);
      expect(next?.color).toBe(lane.color);
    }
  });
});