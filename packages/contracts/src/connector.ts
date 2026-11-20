import { z } from "zod";

const connectorMessageSchema = z.strictObject({
  remoteId: z.string().min(1),
  messageId: z.string().min(1),
  participantId: z.string().min(1).optional(),
  fromMe: z.boolean(),
  timestampMs: z.number().int().nonnegative(),
  kind: z.string().min(1),
  text: z.string().optional(),
  hasAttachment: z.boolean(),
});

export const connectorEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("history.batch"),
    chats: z.array(z.strictObject({ remoteId: z.string().min(1), title: z.string() })),
    contacts: z.array(
      z.strictObject({ displayName: z.string(), jid: z.string().optional(), lid: z.string().optional() }),
    ),
    messages: z.array(connectorMessageSchema),
  }),
  z.strictObject({ type: z.literal("message.upsert"), message: connectorMessageSchema }),
  z.strictObject({
    type: z.literal("message.reaction"),
    remoteId: z.string().min(1),
    messageId: z.string().min(1),
    reactorId: z.string().min(1),
    emoji: z.string().min(1),
    timestampMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("group.metadata"),
    remoteId: z.string().min(1),
    title: z.string(),
    participantIds: z.array(z.string().min(1)),
  }),
  z.strictObject({
    type: z.literal("identity.link"),
    jid: z.string().min(1),
    lid: z.string().min(1),
  }),
]);

export type ConnectorEvent = z.infer<typeof connectorEventSchema>;
