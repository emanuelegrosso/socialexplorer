import { z } from "zod";
import { idSchema, isoUtcSchema, localDateTimeSchema } from "./common.js";
import { mediaAssetSchema, mediaReferenceSchema } from "./media.js";
import { messageSchema } from "./message.js";

export const catalogMediaTypeSchema = z.enum(["photo", "video", "audio", "voice-note", "document"]);

export const mediaCatalogMessageSchema = z.strictObject({
  id: idSchema,
  conversationId: idSchema,
  senderContactId: idSchema.optional(),
  timestampLocal: localDateTimeSchema,
  kind: z.string(),
  text: z.string().optional(),
});

export const mediaCatalogEntrySchema = z.strictObject({
  reference: mediaReferenceSchema.extend({ datasetId: idSchema }),
  asset: mediaAssetSchema.optional(),
  message: mediaCatalogMessageSchema.optional(),
  mediaType: catalogMediaTypeSchema.optional(),
});

export const memoryCardItemSchema = z.strictObject({
  kind: z.enum(["message", "media", "time-interval"]),
  targetId: idSchema,
  caption: z.string().max(500).optional(),
});

export const memoryCardSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  title: z.string().min(1).max(200),
  items: z.array(memoryCardItemSchema),
  createdAt: isoUtcSchema,
  updatedAt: isoUtcSchema,
});

export const onThisDayResultSchema = z.strictObject({
  monthDay: z.string().regex(/^\d{2}-\d{2}$/u),
  timezone: z.string(),
  referenceDate: z.string(),
  media: z.array(mediaCatalogEntrySchema),
  messages: z.array(messageSchema),
  coverageNote: z.string().optional(),
});

export const firstRunStateSchema = z.enum(["pending", "skipped", "seeded"]);

export const firstRunStatusSchema = z.strictObject({
  state: firstRunStateSchema,
  datasetId: idSchema.optional(),
  datasetName: z.string().optional(),
});

export const demoSeedResultSchema = z.strictObject({
  datasetId: idSchema,
  status: z.enum(["seeded", "already-seeded"]),
  messageCount: z.number().int().nonnegative(),
  mediaReferenceCount: z.number().int().nonnegative(),
});

export type CatalogMediaType = z.infer<typeof catalogMediaTypeSchema>;
export type MediaCatalogEntry = z.infer<typeof mediaCatalogEntrySchema>;
export type MemoryCard = z.infer<typeof memoryCardSchema>;
export type MemoryCardItem = z.infer<typeof memoryCardItemSchema>;
export type OnThisDayResult = z.infer<typeof onThisDayResultSchema>;
export type FirstRunStatus = z.infer<typeof firstRunStatusSchema>;
export type DemoSeedResult = z.infer<typeof demoSeedResultSchema>;