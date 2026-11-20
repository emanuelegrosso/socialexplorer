import { z } from "zod";

export const ENTITLEMENT_SCHEMA_VERSION = 1;

export const PlanSchema = z.enum(["free", "personal", "professional"]);
export type Plan = z.infer<typeof PlanSchema>;

export const UpdateChannelSchema = z.enum(["stable", "beta"]);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export const FeatureFlagsSchema = z.strictObject({
  archiveImport: z.boolean(),
  temporalFlow: z.boolean(),
  mediaExport: z.boolean(),
  movieExport: z.boolean(),
  optionalConnector: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
export type FeatureName = keyof FeatureFlags;

export const LimitsSchema = z.strictObject({
  maxArchives: z.number().int().min(1).max(10_000),
  maxMessagesPerArchive: z.number().int().min(1).max(1_000_000_000),
});
export type Limits = z.infer<typeof LimitsSchema>;

export interface PlanDefinition {
  readonly features: FeatureFlags;
  readonly limits: Limits;
  readonly updateChannel: UpdateChannel;
  readonly maxDevices: number;
}

export const PLAN_DEFINITIONS: Readonly<Record<Plan, PlanDefinition>> = {
  free: {
    features: {
      archiveImport: true,
      temporalFlow: false,
      mediaExport: false,
      movieExport: false,
      optionalConnector: false,
    },
    limits: { maxArchives: 1, maxMessagesPerArchive: 50_000 },
    updateChannel: "stable",
    maxDevices: 1,
  },
  personal: {
    features: {
      archiveImport: true,
      temporalFlow: true,
      mediaExport: true,
      movieExport: false,
      optionalConnector: false,
    },
    limits: { maxArchives: 5, maxMessagesPerArchive: 1_000_000 },
    updateChannel: "stable",
    maxDevices: 2,
  },
  professional: {
    features: {
      archiveImport: true,
      temporalFlow: true,
      mediaExport: true,
      movieExport: true,
      optionalConnector: true,
    },
    limits: { maxArchives: 100, maxMessagesPerArchive: 10_000_000 },
    updateChannel: "beta",
    maxDevices: 3,
  },
};

export const FREE_PLAN = PLAN_DEFINITIONS.free;
