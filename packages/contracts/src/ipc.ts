import { z } from "zod";
import { idSchema, isoUtcSchema } from "./common.js";
import { conversationSchema } from "./identity.js";
import { datasetSchema } from "./dataset.js";
import { entitlementSchema } from "./entitlement.js";
import { mediaReferenceSchema } from "./media.js";
import { messageSchema } from "./message.js";
import { connectorUiSnapshotSchema } from "./connector-ui.js";
import { dateRangePresetSchema, temporalFlowReadModelSchema } from "./temporal.js";

const phoneNumberSchema = z.string().regex(/^\+?[0-9 ()-]{6,20}$/u);

export const ipcChannels = {
  "app:get-info": {
    request: z.strictObject({}),
    response: z.strictObject({ name: z.literal("SocialExplorer"), version: z.string() }),
  },
  "dataset:list": {
    request: z.strictObject({}),
    response: z.array(datasetSchema),
  },
  "conversation:list": {
    request: z.strictObject({ datasetId: idSchema }),
    response: z.array(conversationSchema),
  },
  "message:list-range": {
    request: z.strictObject({
      datasetId: idSchema,
      conversationId: idSchema,
      start: isoUtcSchema,
      end: isoUtcSchema,
      limit: z.number().int().positive().max(1000),
    }),
    response: z.array(messageSchema),
  },
  "temporal:get-read-model": {
    request: z.strictObject({
      datasetId: idSchema,
      preset: dateRangePresetSchema,
      start: isoUtcSchema.optional(),
      end: isoUtcSchema.optional(),
    }),
    response: temporalFlowReadModelSchema,
  },
  "media:list-references": {
    request: z.strictObject({ datasetId: idSchema, conversationId: idSchema.optional() }),
    response: z.array(mediaReferenceSchema),
  },
  "entitlement:get": {
    request: z.strictObject({}),
    response: entitlementSchema,
  },
  "connector:get-snapshot": {
    request: z.strictObject({}),
    response: connectorUiSnapshotSchema,
  },
  "connector:start": {
    request: z.strictObject({ datasetId: idSchema.optional() }),
    response: connectorUiSnapshotSchema,
  },
  "connector:stop": {
    request: z.strictObject({}),
    response: connectorUiSnapshotSchema,
  },
  "connector:sign-out": {
    request: z.strictObject({}),
    response: connectorUiSnapshotSchema,
  },
  "connector:clear-auth": {
    request: z.strictObject({}),
    response: connectorUiSnapshotSchema,
  },
  "connector:request-pairing-code": {
    request: z.strictObject({ phoneNumber: phoneNumberSchema }),
    response: connectorUiSnapshotSchema,
  },
} as const;

export type IpcChannel = keyof typeof ipcChannels;
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcChannels)[C]["request"]>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcChannels)[C]["response"]>;

export const IPC_CHANNEL_NAMES = Object.keys(ipcChannels) as IpcChannel[];

export function isIpcChannel(value: string): value is IpcChannel {
  return (IPC_CHANNEL_NAMES as string[]).includes(value);
}
