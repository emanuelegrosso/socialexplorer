import { z } from "zod";
import { chatKindSchema, confidenceSchema, idSchema, isoUtcSchema } from "./common.js";

export const contactIdentifierSchema = z.strictObject({
  type: z.enum(["phone", "jid", "lid", "export-name", "other"]),
  value: z.string().min(1),
  sourceId: idSchema.optional(),
  confidence: confidenceSchema,
});

export const contactSchema = z.strictObject({
  id: idSchema,
  displayName: z.string(),
  aliases: z.array(z.string()),
  identifiers: z.array(contactIdentifierSchema),
  isSelf: z.boolean(),
  colorKey: z.string().min(1),
});

export const conversationSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  sourceConversationId: z.string().min(1).optional(),
  title: z.string(),
  kind: chatKindSchema,
  groupEntityId: idSchema.optional(),
});

export const conversationParticipantSchema = z.strictObject({
  conversationId: idSchema,
  contactId: idSchema,
  firstSeenAt: isoUtcSchema.optional(),
  lastSeenAt: isoUtcSchema.optional(),
  confidence: confidenceSchema,
});

export type ContactIdentifier = z.infer<typeof contactIdentifierSchema>;
export type Contact = z.infer<typeof contactSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationParticipant = z.infer<typeof conversationParticipantSchema>;
