import { z } from "zod";
import { idSchema, isoUtcSchema, parseStatusSchema, timezoneSchema } from "./common.js";

export const datasetSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1),
  createdAt: isoUtcSchema,
  timezone: timezoneSchema,
  sourceIds: z.array(idSchema),
  coverageStart: isoUtcSchema.optional(),
  coverageEnd: isoUtcSchema.optional(),
});

export const dataSourceKindSchema = z.enum([
  "whatsapp-android-txt",
  "whatsapp-ios-txt",
  "whatsapp-zip",
  "baileys-connector",
]);

export const dataSourceSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  platform: z.literal("whatsapp"),
  kind: dataSourceKindSchema,
  label: z.string().min(1),
  createdAt: isoUtcSchema,
});

export const provenanceRecordSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  sourceId: idSchema,
  importBatchId: idSchema.optional(),
  sourceKind: z.enum(["archive-import", "baileys-history", "baileys-live"]),
  originalTimestampText: z.string().optional(),
  sourceLocator: z.string().optional(),
  parseStatus: parseStatusSchema,
  recordedAt: isoUtcSchema,
});

export const importBatchSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  sourceId: idSchema,
  status: z.enum(["previewed", "committing", "committed", "cancelled", "failed"]),
  startedAt: isoUtcSchema,
  completedAt: isoUtcSchema.optional(),
  counts: z.strictObject({
    parsed: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    unparsed: z.number().int().nonnegative(),
    newRecords: z.number().int().nonnegative(),
    exactDuplicates: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
  }),
});

export type Dataset = z.infer<typeof datasetSchema>;
export type DataSource = z.infer<typeof dataSourceSchema>;
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;
export type ImportBatch = z.infer<typeof importBatchSchema>;
