import { z } from "zod";
import {
  idSchema,
  isoUtcSchema,
  localDateTimeSchema,
  parseStatusSchema,
  sourceKindSchema,
  timezoneSchema,
} from "./common.js";

export const messageDirectionSchema = z.enum(["incoming", "outgoing", "unknown"]);

export const messageKindSchema = z.enum([
  "text",
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "link",
  "system",
  "call",
  "unknown",
]);

export const messageSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  conversationId: idSchema,
  sourceMessageId: z.string().min(1).optional(),
  senderContactId: idSchema.optional(),
  timestampUtc: isoUtcSchema.optional(),
  timestampLocal: localDateTimeSchema,
  timezone: timezoneSchema,
  direction: messageDirectionSchema,
  kind: messageKindSchema,
  text: z.string().optional(),
  hasAttachment: z.boolean(),
  isEdited: z.boolean().optional(),
  isDeleted: z.boolean().optional(),
  sourceKind: sourceKindSchema,
  parseStatus: parseStatusSchema,
  provenanceId: idSchema,
});

export const messageReactionSchema = z.strictObject({
  id: idSchema,
  messageId: idSchema,
  reactorContactId: idSchema.optional(),
  emoji: z.string().min(1),
  reactedAtUtc: isoUtcSchema.optional(),
  provenanceId: idSchema,
});

export const annotationSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  targetKind: z.enum(["message", "media", "conversation", "contact", "time-interval"]),
  targetId: idSchema,
  note: z.string().optional(),
  bookmarked: z.boolean(),
  createdAt: isoUtcSchema,
  updatedAt: isoUtcSchema,
});

export type Message = z.infer<typeof messageSchema>;
export type MessageReaction = z.infer<typeof messageReactionSchema>;
export type Annotation = z.infer<typeof annotationSchema>;
