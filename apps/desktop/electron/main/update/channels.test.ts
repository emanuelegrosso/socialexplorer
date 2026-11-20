import { describe, expect, it } from "vitest";
import {
  entitlementChannelToUpdaterChannel,
  feedUrlForChannel,
  resolveUpdateFeedConfig,
} from "./channels.js";

describe("update channels", () => {
  it("maps entitlement channels directly", () => {
    expect(entitlementChannelToUpdaterChannel("stable")).toBe("stable");
    expect(entitlementChannelToUpdaterChannel("beta")).toBe("beta");
  });

  it("resolves feed URLs from environment", () => {
    const config = resolveUpdateFeedConfig({
      SOCIAL_EXPLORER_UPDATE_FEED_STABLE: "https://cdn.example/stable",
      SOCIAL_EXPLORER_UPDATE_FEED_BETA: "https://cdn.example/beta",
    });
    expect(feedUrlForChannel(config, "stable")).toBe("https://cdn.example/stable");
    expect(feedUrlForChannel(config, "beta")).toBe("https://cdn.example/beta");
  });
});