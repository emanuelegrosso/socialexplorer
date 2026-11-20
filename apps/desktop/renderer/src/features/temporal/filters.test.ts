import { describe, expect, it } from "vitest";
import { searchEntities } from "./filters";
import { buildLaneRegistry } from "./layout";
import { createSyntheticReadModel } from "./test-model";

describe("WX-047 search and filters", () => {
  const model = createSyntheticReadModel();
  const registry = buildLaneRegistry(model);
  const aliases = new Map<string, readonly string[]>([["c_bob", ["Bobby"]]]);

  it("finds contacts by alias and respects entity filters", () => {
    const hits = searchEntities(registry.lanes.values(), aliases, "bobby", "all");
    expect(hits[0]?.entityId).toBe("c_bob");
    expect(searchEntities(registry.lanes.values(), aliases, "hiking", "contact")).toHaveLength(0);
    expect(searchEntities(registry.lanes.values(), aliases, "hiking", "group")[0]?.entityId).toBe(
      "conv_group",
    );
  });
});