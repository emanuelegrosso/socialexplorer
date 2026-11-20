import { describe, expect, it } from "vitest";
import {
  CONTACT_PALETTE,
  GROUP_NEUTRAL_COLOR,
  colorForColorKey,
  contactColor,
  contactColorKey,
} from "./palette.js";

describe("contact palette", () => {
  it("is deterministic, valid hex and distinct per slot", () => {
    expect(new Set(CONTACT_PALETTE).size).toBe(CONTACT_PALETTE.length);
    for (const color of CONTACT_PALETTE) {
      expect(color).toMatch(/^#[0-9A-F]{6}$/u);
      expect(color).not.toBe(GROUP_NEUTRAL_COLOR);
    }
    expect(contactColor("contact_a")).toBe(contactColor("contact_a"));
    expect(colorForColorKey(contactColorKey("contact_a"), "x")).toBe(contactColor("contact_a"));
    expect(colorForColorKey("legacy", "contact_a")).toBe(contactColor("contact_a"));
  });
});
