import { z } from "zod";
import {
  entityKindSchema,
  idSchema,
  isoUtcSchema,
  localDateSchema,
  timezoneSchema,
} from "./common.js";

export const relationTypeSchema = z.enum([
  "shared_participant",
  "temporal_overlap",
  "cross_chat_activity",
  "direct_message",
  "group_post",
]);

export const dateRangePresetSchema = z.enum(["today", "yesterday", "7d", "30d", "90d", "custom"]);

export const temporalEntitySchema = z.strictObject({
  entityId: idSchema,
  kind: entityKindSchema,
  label: z.string(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
  stableX: z.number(),
  stableZ: z.number(),
});

export const temporalEventSchema = z.strictObject({
  id: idSchema,
  entityId: idSchema,
  conversationId: idSchema,
  timestamp: isoUtcSchema,
  count: z.number().int().positive(),
});

export const temporalArcSchema = z.strictObject({
  id: idSchema,
  sourceEntityId: idSchema,
  targetEntityId: idSchema,
  timestamp: isoUtcSchema,
  direction: z.literal("source-to-target"),
  count: z.number().int().positive(),
  relationKind: z.enum(["private-message", "group-post"]),
  sourceColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
});

export const dailyMarkerSchema = z.strictObject({
  date: localDateSchema,
  timestamp: isoUtcSchema,
  label: z.string(),
});

export const hourMarkSchema = z.strictObject({
  timestamp: isoUtcSchema,
  hour: z.number().int().min(0).max(23),
  date: localDateSchema,
});

export const coverageSchema = z.strictObject({
  start: isoUtcSchema.optional(),
  end: isoUtcSchema.optional(),
  messageCount: z.number().int().nonnegative(),
  partialMessageCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export const temporalFlowReadModelSchema = z.strictObject({
  datasetId: idSchema,
  range: z.strictObject({
    preset: dateRangePresetSchema,
    start: isoUtcSchema,
    end: isoUtcSchema,
    timezone: timezoneSchema,
  }),
  lanes: z.array(temporalEntitySchema),
  events: z.array(temporalEventSchema),
  arcs: z.array(temporalArcSchema),
  dailyMarkers: z.array(dailyMarkerSchema),
  hourMarks: z.array(hourMarkSchema),
  lod: z.strictObject({
    level: z.enum(["overview", "mid", "detail"]),
    bucketSeconds: z.number().int().nonnegative(),
  }),
  layoutVersion: z.number().int().positive(),
  coverage: coverageSchema,
});

export type RelationType = z.infer<typeof relationTypeSchema>;
export type DateRangePreset = z.infer<typeof dateRangePresetSchema>;
export type TemporalEntityViewModel = z.infer<typeof temporalEntitySchema>;
export type TemporalEventViewModel = z.infer<typeof temporalEventSchema>;
export type TemporalArcViewModel = z.infer<typeof temporalArcSchema>;
export type DailyMarkerViewModel = z.infer<typeof dailyMarkerSchema>;
export type HourMarkViewModel = z.infer<typeof hourMarkSchema>;
export type CoverageViewModel = z.infer<typeof coverageSchema>;
export type TemporalFlowReadModel = z.infer<typeof temporalFlowReadModelSchema>;
