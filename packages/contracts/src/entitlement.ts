import { z } from "zod";
import { isoUtcSchema } from "./common.js";

export const entitlementTierSchema = z.enum(["Free", "Personal", "Professional"]);

export const entitlementFeaturesSchema = z.strictObject({
  maxDatasets: z.number().int().positive(),
  maxImportedMessages: z.number().int().positive().nullable(),
  advancedAnalytics: z.boolean(),
  reportExport: z.boolean(),
  annotations: z.boolean(),
  movieStudio: z.boolean(),
});

export const entitlementSchema = z.strictObject({
  version: z.literal(1),
  tier: entitlementTierSchema,
  features: entitlementFeaturesSchema,
  issuedAt: isoUtcSchema,
  expiresAt: isoUtcSchema.nullable(),
  lastVerifiedAt: isoUtcSchema.optional(),
  offlineGraceDays: z.number().int().nonnegative(),
  dataAccessOnExpiry: z.literal("always-readable"),
  deletesDataOnExpiry: z.literal(false),
});

export type EntitlementTier = z.infer<typeof entitlementTierSchema>;
export type EntitlementFeatures = z.infer<typeof entitlementFeaturesSchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;

export const FREE_FEATURES: EntitlementFeatures = {
  maxDatasets: 1,
  maxImportedMessages: 50_000,
  advancedAnalytics: false,
  reportExport: false,
  annotations: false,
  movieStudio: false,
};

export const DEFAULT_FREE_ENTITLEMENT: Entitlement = {
  version: 1,
  tier: "Free",
  features: FREE_FEATURES,
  issuedAt: "2026-01-01T00:00:00Z",
  expiresAt: null,
  offlineGraceDays: 0,
  dataAccessOnExpiry: "always-readable",
  deletesDataOnExpiry: false,
};

export interface EntitlementEvaluation {
  readonly status: "active" | "offline-grace" | "expired";
  readonly effectiveTier: EntitlementTier;
  readonly features: EntitlementFeatures;
  readonly dataAccessible: true;
  readonly dataDeleted: false;
}

const DAY_MS = 86_400_000;

export function evaluateEntitlement(entitlement: Entitlement, now: Date): EvaluatedState {
  const nowMs = now.getTime();
  const expiresMs = entitlement.expiresAt === null ? null : Date.parse(entitlement.expiresAt);
  if (expiresMs === null || nowMs <= expiresMs) {
    return build("active", entitlement.tier, entitlement.features);
  }
  const graceEnd = expiresMs + entitlement.offlineGraceDays * DAY_MS;
  if (entitlement.tier === "Professional" && nowMs <= graceEnd) {
    return build("offline-grace", entitlement.tier, entitlement.features);
  }
  return build("expired", "Free", FREE_FEATURES);
}

type EvaluatedState = EntitlementEvaluation;

function build(
  status: EntitlementEvaluation["status"],
  effectiveTier: EntitlementTier,
  features: EntitlementFeatures,
): EntitlementEvaluation {
  return { status, effectiveTier, features, dataAccessible: true, dataDeleted: false };
}
