import { z } from "zod";

export const isoUtcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u, "expected ISO-8601 UTC");

export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u, "expected local wall-clock YYYY-MM-DDTHH:mm:ss");

export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const timezoneSchema = z.string().min(1);

export const idSchema = z.string().min(1);

export const confidenceSchema = z.enum(["confirmed", "probable", "unknown"]);

export const sourceKindSchema = z.enum(["archive-import", "baileys-history", "baileys-live"]);

export const parseStatusSchema = z.enum(["complete", "partial", "unparsed"]);

export const chatKindSchema = z.enum(["private", "group", "other"]);

export const entityKindSchema = z.enum(["contact", "group"]);

export type Confidence = z.infer<typeof confidenceSchema>;
export type SourceKind = z.infer<typeof sourceKindSchema>;
export type ParseStatus = z.infer<typeof parseStatusSchema>;
export type ChatKind = z.infer<typeof chatKindSchema>;
export type EntityKind = z.infer<typeof entityKindSchema>;
