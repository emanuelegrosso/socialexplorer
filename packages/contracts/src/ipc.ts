import { z } from "zod";
import {
  analyticsRangeSchema,
  analyticsRebuildResultSchema,
  contactMetricsSchema,
  globalMetricsSchema,
  groupMetricsSchema,
  relationSetSchema,
} from "./analytics.js";
import {
  archiveCancelResultSchema,
  archiveCommitRequestSchema,
  archiveCommitResultSchema,
  archiveConfirmRequestSchema,
  archiveConfirmResultSchema,
  archivePickFileResultSchema,
  archivePreviewSchema,
} from "./archive-import.js";
import { idSchema, isoUtcSchema } from "./common.js";
import {
  contactMergeSchema,
  contactSummarySchema,
  conversationSchema,
  groupSummarySchema,
} from "./identity.js";
import { datasetSchema } from "./dataset.js";
import { entitlementSchema } from "./entitlement.js";
import { mediaReferenceSchema } from "./media.js";
import { messageSchema } from "./message.js";
import { dateRangePresetSchema, temporalFlowReadModelSchema } from "./temporal.js";

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
  "archive-import:pick-file": {
    request: z.strictObject({}),
    response: archivePickFileResultSchema,
  },
  "archive-import:preview": {
    request: z.strictObject({ stagedId: idSchema }),
    response: archivePreviewSchema,
  },
  "archive-import:confirm": {
    request: archiveConfirmRequestSchema,
    response: archiveConfirmResultSchema,
  },
  "archive-import:commit": {
    request: archiveCommitRequestSchema,
    response: archiveCommitResultSchema,
  },
  "archive-import:cancel": {
    request: z.strictObject({ stagedId: idSchema }),
    response: archiveCancelResultSchema,
  },
  "contact:list": {
    request: z.strictObject({ datasetId: idSchema }),
    response: z.array(contactSummarySchema),
  },
  "group:list": {
    request: z.strictObject({ datasetId: idSchema }),
    response: z.array(groupSummarySchema),
  },
  "contact:merge": {
    request: z.strictObject({
      datasetId: idSchema,
      primaryContactId: idSchema,
      secondaryContactId: idSchema,
      reason: z.string().max(500).optional(),
    }),
    response: contactMergeSchema,
  },
  "contact:unmerge": {
    request: z.strictObject({ datasetId: idSchema, secondaryContactId: idSchema }),
    response: contactMergeSchema,
  },
  "contact:list-merges": {
    request: z.strictObject({ datasetId: idSchema }),
    response: z.array(contactMergeSchema),
  },
  "analytics:get-global": {
    request: z.strictObject({ datasetId: idSchema, range: analyticsRangeSchema.optional() }),
    response: globalMetricsSchema,
  },
  "analytics:get-contact": {
    request: z.strictObject({
      datasetId: idSchema,
      contactId: idSchema,
      range: analyticsRangeSchema.optional(),
    }),
    response: contactMetricsSchema,
  },
  "analytics:get-group": {
    request: z.strictObject({
      datasetId: idSchema,
      conversationId: idSchema,
      range: analyticsRangeSchema.optional(),
    }),
    response: groupMetricsSchema,
  },
  "analytics:get-relations": {
    request: z.strictObject({
      datasetId: idSchema,
      windowMinutes: z.number().int().positive().max(1440).optional(),
    }),
    response: relationSetSchema,
  },
  "analytics:rebuild": {
    request: z.strictObject({ datasetId: idSchema }),
    response: analyticsRebuildResultSchema,
  },
  "entitlement:get": {
    request: z.strictObject({}),
    response: entitlementSchema,
  },
} as const;

export type IpcChannel = keyof typeof ipcChannels;
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcChannels)[C]["request"]>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcChannels)[C]["response"]>;

export const IPC_CHANNEL_NAMES = Object.keys(ipcChannels) as IpcChannel[];

export function isIpcChannel(value: string): value is IpcChannel {
  return (IPC_CHANNEL_NAMES as string[]).includes(value);
}
