import type { Confidence, ContactIdentifier } from "@social-explorer/contracts";
import { identifierKey } from "./identity.js";

export interface IdentityMatch {
  readonly decision: "same-identifier" | "needs-manual-review" | "distinct";
  readonly confidence: Confidence;
  readonly reason: string;
}

const STRONG_TYPES = new Set(["phone", "jid"]);

/**
 * Never merges on display name alone. Only an identical strong identifier (phone/jid) is an
 * automatic match; shared names, or jid vs lid for the same name, require manual review.
 * Merges stay reversible at the persistence layer.
 */
export function compareIdentities(
  left: readonly ContactIdentifier[],
  right: readonly ContactIdentifier[],
): IdentityMatch {
  const rightKeys = new Set(right.map(identifierKey));
  for (const identifier of left) {
    if (STRONG_TYPES.has(identifier.type) && rightKeys.has(identifierKey(identifier))) {
      return {
        decision: "same-identifier",
        confidence: "confirmed",
        reason: `shared ${identifier.type}`,
      };
    }
  }
  const leftNames = new Set(left.filter((i) => i.type === "export-name").map((i) => i.value));
  const sharesName = right.some((i) => i.type === "export-name" && leftNames.has(i.value));
  if (sharesName) {
    return {
      decision: "needs-manual-review",
      confidence: "unknown",
      reason: "only the display name matches",
    };
  }
  return { decision: "distinct", confidence: "unknown", reason: "no shared identifier" };
}

export function canAutoMerge(match: IdentityMatch): boolean {
  return match.decision === "same-identifier" && match.confidence === "confirmed";
}
