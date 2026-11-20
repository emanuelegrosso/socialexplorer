import { z } from "zod";
import {
  ENTITLEMENT_SCHEMA_VERSION,
  FeatureFlagsSchema,
  LimitsSchema,
  PLAN_DEFINITIONS,
  PlanSchema,
  UpdateChannelSchema,
  FREE_PLAN,
  type FeatureFlags,
  type FeatureName,
  type Limits,
  type Plan,
  type UpdateChannel,
} from "./plans.js";

const Timestamp = z.number().int().nonnegative();
const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u);

/** Versioned, signed entitlement payload. Contains no personal or chat data. */
export const EntitlementPayloadSchema = z.strictObject({
  v: z.literal(ENTITLEMENT_SCHEMA_VERSION),
  licenseId: Id,
  deviceId: z.string().regex(/^[a-f0-9]{64}$/u),
  plan: PlanSchema,
  features: FeatureFlagsSchema,
  limits: LimitsSchema,
  updateChannel: UpdateChannelSchema,
  /** Updates released after this instant are not offered (perpetual use of older builds remains). */
  updatesUntil: Timestamp,
  issuedAt: Timestamp,
  /** Subscription/licence end. After this the app degrades to Free. */
  licenseExpiresAt: Timestamp,
  /** Token must be refreshed after this instant; offline use continues through the grace window. */
  tokenExpiresAt: Timestamp,
  offlineGraceMs: z
    .number()
    .int()
    .min(0)
    .max(90 * 86_400_000),
});
export type EntitlementPayload = z.infer<typeof EntitlementPayloadSchema>;

export type EntitlementState = "active" | "offline-grace" | "expired" | "free";

/**
 * Local data guarantees. These are constants by design: no licence state, expiry, outage or
 * tamper result may change them. Gate only paid *features*, never access to the user's data.
 */
export interface DataAccess {
  readonly readLocalData: true;
  readonly exportData: true;
  readonly deleteLocalData: true;
}
export const DATA_ACCESS: DataAccess = Object.freeze({
  readLocalData: true,
  exportData: true,
  deleteLocalData: true,
});

export interface EffectiveEntitlement {
  readonly state: EntitlementState;
  readonly plan: Plan;
  readonly features: FeatureFlags;
  readonly limits: Limits;
  readonly updateChannel: UpdateChannel;
  readonly updatesUntil: number | null;
  readonly graceEndsAt: number | null;
  readonly dataAccess: DataAccess;
}

export function freeEntitlement(state: EntitlementState = "free"): EffectiveEntitlement {
  return {
    state,
    plan: "free",
    features: { ...FREE_PLAN.features },
    limits: { ...FREE_PLAN.limits },
    updateChannel: FREE_PLAN.updateChannel,
    updatesUntil: null,
    graceEndsAt: null,
    dataAccess: DATA_ACCESS,
  };
}

/** Pure evaluation of a (already signature-verified) payload at a point in time. */
export function evaluateEntitlement(
  payload: EntitlementPayload,
  now: number,
): EffectiveEntitlement {
  if (now > payload.licenseExpiresAt) {
    return { ...freeEntitlement("expired"), updatesUntil: payload.updatesUntil };
  }
  const graceEndsAt = payload.tokenExpiresAt + payload.offlineGraceMs;
  let state: EntitlementState;
  if (now <= payload.tokenExpiresAt) {
    state = "active";
  } else if (now <= graceEndsAt) {
    state = "offline-grace";
  } else {
    return { ...freeEntitlement("expired"), updatesUntil: payload.updatesUntil };
  }
  return {
    state,
    plan: payload.plan,
    features: { ...payload.features },
    limits: { ...payload.limits },
    updateChannel: payload.updateChannel,
    updatesUntil: payload.updatesUntil,
    graceEndsAt,
    dataAccess: DATA_ACCESS,
  };
}

export function isFeatureEnabled(entitlement: EffectiveEntitlement, feature: FeatureName): boolean {
  return entitlement.features[feature];
}

export function isUpdateEligible(entitlement: EffectiveEntitlement, releasedAt: number): boolean {
  return entitlement.updatesUntil !== null && releasedAt <= entitlement.updatesUntil;
}

export interface BuildPayloadInput {
  readonly licenseId: string;
  readonly deviceId: string;
  readonly plan: Plan;
  readonly now: number;
  readonly licenseExpiresAt: number;
  readonly tokenTtlMs: number;
  readonly offlineGraceMs: number;
  readonly updatesUntil: number;
}

export function buildEntitlementPayload(input: BuildPayloadInput): EntitlementPayload {
  const def = PLAN_DEFINITIONS[input.plan];
  return EntitlementPayloadSchema.parse({
    v: ENTITLEMENT_SCHEMA_VERSION,
    licenseId: input.licenseId,
    deviceId: input.deviceId,
    plan: input.plan,
    features: def.features,
    limits: def.limits,
    updateChannel: def.updateChannel,
    updatesUntil: input.updatesUntil,
    issuedAt: input.now,
    licenseExpiresAt: input.licenseExpiresAt,
    tokenExpiresAt: Math.min(input.now + input.tokenTtlMs, input.licenseExpiresAt),
    offlineGraceMs: input.offlineGraceMs,
  });
}
