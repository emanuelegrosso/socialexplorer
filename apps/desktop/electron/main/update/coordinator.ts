import type { Logger } from "@social-explorer/security";
import type { EffectiveEntitlement } from "@social-explorer/licensing";
import {
  entitlementChannelToUpdaterChannel,
  feedUrlForChannel,
  resolveUpdateFeedConfig,
  type UpdaterChannel,
} from "./channels.js";
import { decideUpdateOffer } from "./policy.js";
import { validateUpdateMetadataTrust } from "./metadata-trust.js";

export interface UpdateCoordinatorOptions {
  readonly logger: Logger;
  readonly getEntitlement: () => EffectiveEntitlement;
  readonly isPackaged: boolean;
  readonly feedTrustVerified?: boolean;
  readonly connectorAbiLabel: string;
}

export interface UpdateCheckOutcome {
  readonly checked: boolean;
  readonly channel: UpdaterChannel | null;
  readonly skippedReason?: string;
}

/**
 * WX-064 stub orchestrator around electron-updater.
 * Preserves user data: autoInstallOnAppQuit only; no DB/auth paths touched.
 */
export class UpdateCoordinator {
  private readonly options: UpdateCoordinatorOptions;
  private rollbackVersion: string | null = null;
  private lastError: unknown;

  constructor(options: UpdateCoordinatorOptions) {
    this.options = options;
  }

  /** Records the currently running version before applying an update (rollback anchor). */
  markRollbackAnchor(version: string): void {
    this.rollbackVersion = version;
  }

  getRollbackAnchor(): string | null {
    return this.rollbackVersion;
  }

  getLastError(): unknown {
    return this.lastError;
  }

  /**
   * Configures channels and feed URL. Safe no-op when not packaged or feeds unset.
   * Full download/install is deferred until licensing entitlements are wired in the shell.
   */
  async prepareCheck(releasePublishedAt: number): Promise<UpdateCheckOutcome> {
    if (!this.options.isPackaged) {
      return { checked: false, channel: null, skippedReason: "dev_build" };
    }
    const feeds = resolveUpdateFeedConfig();
    const entitlement = this.options.getEntitlement();
    const feedChannel = entitlementChannelToUpdaterChannel(entitlement.updateChannel);
    const decision = decideUpdateOffer({
      entitlement,
      releasePublishedAt,
      feedChannel,
      requireSignedArtifacts: true,
      feedTrustVerified: this.options.feedTrustVerified ?? false,
    });
    if (decision.kind === "reject") {
      this.options.logger.warn("update skipped by policy", { reason: decision.reason });
      return { checked: false, channel: null, skippedReason: decision.reason };
    }
    const channel = entitlementChannelToUpdaterChannel(decision.channel);
    const feedUrl = feedUrlForChannel(feeds, channel);
    if (feedUrl.includes("updates.socialexplorer.app") && !process.env["SOCIAL_EXPLORER_UPDATE_FEED_STABLE"]) {
      return { checked: false, channel: null, skippedReason: "feed_not_configured" };
    }
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowDowngrade = false;
      autoUpdater.channel = channel;
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl, channel });
      autoUpdater.on("error", (error) => {
        this.lastError = error;
        this.options.logger.error("auto-update error", { error: String(error) });
      });
      autoUpdater.on("update-downloaded", (info) => {
        const trusted = validateUpdateMetadataTrust(info, {
          requireSha512: true,
          publisherAttestation: process.env["SOCIAL_EXPLORER_UPDATE_PUBLISHER_ATTESTATION"],
          expectedPublisherAttestation: process.env["SOCIAL_EXPLORER_EXPECTED_PUBLISHER_ATTESTATION"],
        });
        if (!trusted.ok) {
          this.lastError = trusted.reason;
          this.options.logger.error("rejected downloaded update", { reason: trusted.reason });
          return;
        }
        const notes =
          typeof trusted.metadata.releaseNotes === "string"
            ? trusted.metadata.releaseNotes
            : trusted.metadata.releaseNotes?.join("\n");
        this.options.logger.info("update ready", {
          version: trusted.metadata.version,
          releaseNotes: notes?.slice(0, 200),
          connectorAbi: this.options.connectorAbiLabel,
        });
      });
      return { checked: true, channel };
    } catch (error) {
      this.lastError = error;
      this.options.logger.error("auto-update configure failed", { error: String(error) });
      return { checked: false, channel: null, skippedReason: "configure_failed" };
    }
  }

  /** Rollback stub: records intent; full reinstall flow ships with signed delta packages. */
  planRollback(): { readonly action: "reinstall-previous"; readonly version: string | null } {
    this.options.logger.warn("update rollback requested", { version: this.rollbackVersion });
    return { action: "reinstall-previous", version: this.rollbackVersion };
  }
}

export function createUpdateCoordinator(options: UpdateCoordinatorOptions): UpdateCoordinator {
  return new UpdateCoordinator(options);
}