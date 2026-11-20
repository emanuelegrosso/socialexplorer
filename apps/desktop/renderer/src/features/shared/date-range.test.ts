import { describe, expect, it } from "vitest";
import { resolveSelection } from "./date-range";

describe("WX-047 shared date range resolution", () => {
  const context = {
    timezone: "Europe/Rome",
    now: "2026-01-20T10:00:00Z",
    coverageStart: "2026-01-01T00:00:00Z",
    coverageEnd: "2026-01-20T20:00:00Z",
  };

  it("resolves presets and custom local ranges for temporal and analytics", () => {
    const seven = resolveSelection({ choice: "7d" }, context);
    expect(seven.ok).toBe(true);
    if (seven.ok) {
      expect(seven.range.temporal.preset).toBe("7d");
      expect(seven.range.analytics.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
    const all = resolveSelection({ choice: "all" }, context);
    expect(all.ok).toBe(true);
    const custom = resolveSelection(
      { choice: "custom", customStartDate: "2026-01-10", customEndDate: "2026-01-15" },
      context,
    );
    expect(custom.ok).toBe(true);
    expect(resolveSelection({ choice: "custom" }, context).ok).toBe(false);
  });
});