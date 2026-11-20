import { describe, expect, it } from "vitest";
import { buildImpulses, effectiveBucketSeconds, lodForZoom } from "./lod";
import { createSyntheticReadModel } from "./test-model";

describe("WX-043 impulse LOD counts", () => {
  it("selects LOD levels from zoom and preserves total message counts", () => {
    expect(lodForZoom(0.5)).toBe("overview");
    expect(lodForZoom(3)).toBe("mid");
    expect(lodForZoom(8)).toBe("detail");
    const model = createSyntheticReadModel();
    const events = model.events;
    const detailCount = events.reduce((sum, event) => sum + event.count, 0);
    const overview = buildImpulses(events, effectiveBucketSeconds("overview", model.lod.bucketSeconds));
    const detail = buildImpulses(events, 0);
    expect(overview.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(detailCount);
    expect(detail.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(detailCount);
    expect(overview.length).toBeLessThanOrEqual(detail.length);
  });
});