import { describe, expect, it } from "vitest";
import {
  arcVisual,
  clearSelection,
  connectedEntityIds,
  highlightParticipant,
  laneVisual,
  panelTarget,
  selectEntity,
  toggleIsolation,
} from "./selection";
import { buildLaneRegistry } from "./layout";
import { createSyntheticReadModel } from "./test-model";

describe("WX-046 selection and panels", () => {
  const model = createSyntheticReadModel();
  const registry = buildLaneRegistry(model);
  const arcs = model.arcs.map((arc) => ({ sourceId: arc.sourceEntityId, targetId: arc.targetEntityId }));

  it("syncs lane and arc emphasis with panel target", () => {
    let selection = selectEntity(clearSelection(), "c_alice");
    expect(selection.mode).toBe("selected");
    const connected = connectedEntityIds(arcs, "c_alice");
    expect(laneVisual("c_bob", selection, connected)).toBe("connected");
    selection = toggleIsolation(selection);
    expect(selection.mode).toBe("isolated");
    expect(laneVisual("c_carol", selection, connected)).toBe("hidden");
    const arc = model.arcs[0];
    expect(arc).toBeDefined();
    if (arc !== undefined) {
      expect(
        arcVisual(
          { sourceId: arc.sourceEntityId, targetId: arc.targetEntityId },
          selection,
        ),
      ).toBe("highlighted");
    }
    selection = highlightParticipant(selection, "c_bob");
    expect(panelTarget(selection, registry.lanes)).toMatchObject({ kind: "contact", entityId: "c_alice" });
    const groupArc = model.arcs.find((item) => item.targetEntityId === "conv_group");
    if (groupArc !== undefined) {
      expect(panelTarget(selectEntity(clearSelection(), "conv_group"), registry.lanes)).toMatchObject({
        kind: "group",
        entityId: "conv_group",
      });
    }
  });
});