import {
  type EffectiveEntitlement,
  type UpdateChannel,
  isUpdateEligible,
} from "@social-explorer/licensing";

export type UpdateOfferDecision =
  | { readonly kind: "offer"; readonly channel: UpdateChannel }
  | { readonly kind: "reject"; readonly reason: UpdateRejectionReason };

export type UpdateRejectionReason =
  | "updates_window_expired"
  | "channel_mismatch"
  | "unsigned_build_policy";

export interface UpdateOfferInput {
  readonly entitlement: EffectiveEntitlement;
  readonly releasePublishedAt: number;
  readonly feedChannel: UpdateChannel;
  readonly requireSignedArtifacts: boolean;
  readonly feedTrustVerified: boolean;
}

/**
 * Pure policy: whether an update may be offered for the running install.
 * Chat/licensing invariants: no payload leaves the device; only channel + eligibility.
 */
export function decideUpdateOffer(input: UpdateOfferInput): UpdateOfferDecision {
  if (input.requireSignedArtifacts && !input.feedTrustVerified) {
    return { kind: "reject", reason: "unsigned_build_policy" };
  }
  if (!isUpdateEligible(input.entitlement, input.releasePublishedAt)) {
    return { kind: "reject", reason: "updates_window_expired" };
  }
  const entitled = input.entitlement.updateChannel;
  if (entitled === "stable" && input.feedChannel === "beta") {
    return { kind: "reject", reason: "channel_mismatch" };
  }
  if (entitled === "beta") {
    return { kind: "offer", channel: input.feedChannel };
  }
  return { kind: "offer", channel: "stable" };
}