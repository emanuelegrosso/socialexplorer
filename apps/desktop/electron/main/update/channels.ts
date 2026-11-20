import type { UpdateChannel } from "@social-explorer/licensing";

export type UpdaterChannel = "stable" | "beta";

export interface UpdateFeedConfig {
  readonly stableUrl: string;
  readonly betaUrl: string;
}

const DEFAULT_STABLE = "https://updates.socialexplorer.app/stable";
const DEFAULT_BETA = "https://updates.socialexplorer.app/beta";

/** Resolves generic-provider feed URLs from environment with safe defaults for dev. */
export function resolveUpdateFeedConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpdateFeedConfig {
  return {
    stableUrl: env["SOCIAL_EXPLORER_UPDATE_FEED_STABLE"]?.trim() || DEFAULT_STABLE,
    betaUrl: env["SOCIAL_EXPLORER_UPDATE_FEED_BETA"]?.trim() || DEFAULT_BETA,
  };
}

export function feedUrlForChannel(config: UpdateFeedConfig, channel: UpdaterChannel): string {
  return channel === "beta" ? config.betaUrl : config.stableUrl;
}

/** Maps licensing entitlement channel to electron-updater channel (no network). */
export function entitlementChannelToUpdaterChannel(
  channel: UpdateChannel,
): UpdaterChannel {
  return channel;
}