import { describe, expect, it } from "vitest";
import { buildAxisMarks, createTimeAxis } from "./axis";
import { createSyntheticReadModel } from "./test-model";

describe("WX-042 temporal axis", () => {
  it("maps past to the top and present to the bottom continuously", () => {
    const model = createSyntheticReadModel();
    const axis = createTimeAxis(model.range);
    const startMs = Date.parse(model.range.start);
    const endMs = Date.parse(model.range.end);
    expect(axis.yAt(startMs)).toBeGreaterThan(axis.yAt(endMs));
    expect(axis.yAt(startMs)).toBeCloseTo(axis.height, 5);
    expect(axis.yAt(endMs - 1)).toBeGreaterThanOrEqual(0);
    const mid = axis.yAt((startMs + endMs) / 2);
    expect(axis.msAt(mid)).toBeCloseTo((startMs + endMs) / 2, -2);
  });

  it("places daily separators and hour marks inside the range", () => {
    const model = createSyntheticReadModel();
    const axis = createTimeAxis(model.range);
    const marks = buildAxisMarks(model, axis);
    expect(marks.days.length).toBeGreaterThan(0);
    expect(marks.hours.length).toBeGreaterThan(0);
    for (const day of marks.days) {
      expect(day.y).toBeGreaterThanOrEqual(0);
      expect(day.y).toBeLessThanOrEqual(axis.height);
    }
  });
});