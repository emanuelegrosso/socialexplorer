import { describe, expect, it } from "vitest";
import { freeEntitlement, type EffectiveEntitlement } from "@social-explorer/licensing";
import { decideUpdateOffer } from "./policy.js";

const NOW = Date.UTC(2026, 0, 1);

function entitled(channel: "stable" | "beta", updatesUntil: number | null): EffectiveEntitlement {
  const base = freeEntitlement("active");
  return {
    ...base,
    plan: channel === "beta" ? "professional" : "personal",
    updateChannel: channel,
    updatesUntil,
  };
}

describe("decideUpdateOffer", () => {
  it("rejects when updates window expired", () => {
    const result = decideUpdateOffer({
      entitlement: entitled("stable", NOW - 1),
      releasePublishedAt: NOW,
      feedChannel: "stable",
      requireSignedArtifacts: true,
      feedTrustVerified: true,
    });
    expect(result).toEqual({ kind: "reject", reason: "updates_window_expired" });
  });

  it("rejects unsigned feeds when policy requires signatures", () => {
    const result = decideUpdateOffer({
      entitlement: entitled("stable", NOW + 86_400_000),
      releasePublishedAt: NOW,
      feedChannel: "stable",
      requireSignedArtifacts: true,
      feedTrustVerified: false,
    });
    expect(result).toEqual({ kind: "reject", reason: "unsigned_build_policy" });
  });

  it("rejects beta feed for stable-only entitlement", () => {
    const result = decideUpdateOffer({
      entitlement: entitled("stable", NOW + 86_400_000),
      releasePublishedAt: NOW,
      feedChannel: "beta",
      requireSignedArtifacts: true,
      feedTrustVerified: true,
    });
    expect(result).toEqual({ kind: "reject", reason: "channel_mismatch" });
  });

  it("offers beta channel for professional entitlement", () => {
    const result = decideUpdateOffer({
      entitlement: entitled("beta", NOW + 86_400_000),
      releasePublishedAt: NOW,
      feedChannel: "beta",
      requireSignedArtifacts: true,
      feedTrustVerified: true,
    });
    expect(result).toEqual({ kind: "offer", channel: "beta" });
  });
});