import { z } from "zod";
import { idSchema, localDateSchema, timezoneSchema } from "./common.js";

const count = z.number().int().nonnegative();

export const archivePickFileResultSchema = z.strictObject({
  canceled: z.boolean(),
  stagedId: idSchema.optional(),
  name: z.string().optional(),
  sizeBytes: count.optional(),
});

export const archivePreviewSchema = z.strictObject({
  stagedId: idSchema,
  name: z.string(),
  container: z.enum(["txt", "zip"]),
  platform: z.enum(["android", "ios"]),
  conversationCount: count,
  totalRecords: count,
  countsByParseStatus: z.strictObject({ complete: count, partial: count, unparsed: count }),
  dateRange: z.strictObject({ first: localDateSchema, last: localDateSchema }).nullable(),
  conversations: z.array(
    z.strictObject({
      sourceFile: z.string(),
      title: z.string(),
      isGroup: z.boolean(),
      messageCount: count,
      systemMessageCount: count,
    }),
  ),
  contactCandidates: z.array(z.strictObject({ displayName: z.string(), messageCount: count })),
  mediaReferenceCount: count,
  externalLinkCount: count,
  confirmation: z.strictObject({
    timezoneCandidates: z.array(
      z.strictObject({
        timezone: timezoneSchema,
        source: z.enum(["system", "hint", "utc"]),
        recommended: z.boolean(),
      }),
    ),
    selfCandidates: z.array(
      z.strictObject({
        name: z.string(),
        messageCount: count,
        selfEvidence: count,
        likelyOther: z.boolean(),
        recommended: z.boolean(),
      }),
    ),
    dateOrderReviews: z.array(
      z.strictObject({
        conversation: z.string(),
        dateOrder: z.enum(["DMY", "MDY", "YMD"]),
        confidence: z.enum(["certain", "likely", "ambiguous"]),
        requiresConfirmation: z.boolean(),
      }),
    ),
  }),
});

export const archiveConfirmRequestSchema = z.strictObject({
  stagedId: idSchema,
  datasetId: idSchema.optional(),
  datasetName: z.string().min(1).optional(),
  timezone: timezoneSchema,
  selfNames: z.array(z.string()),
});

export const archiveReviewItemSchema = z.strictObject({
  reviewId: z.string().min(1),
  kind: z.enum(["message", "contact"]),
  reason: z.string().optional(),
  summary: z.string(),
  candidates: z.array(z.strictObject({ id: idSchema, label: z.string() })),
});

export const archiveConfirmResultSchema = z.strictObject({
  stagedId: idSchema,
  datasetId: idSchema,
  planId: z.string(),
  counts: z.strictObject({ new: count, exactDuplicate: count, ambiguous: count }),
  contacts: z.array(
    z.strictObject({
      displayName: z.string(),
      status: z.enum(["new", "matched_by_display_name", "ambiguous"]),
    }),
  ),
  reviews: z.array(archiveReviewItemSchema),
});

export const mergeResolutionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep_both") }),
  z.strictObject({ action: z.literal("skip_incoming") }),
  z.strictObject({ action: z.literal("link_existing"), existingId: idSchema }),
]);

export const archiveCommitRequestSchema = z.strictObject({
  stagedId: idSchema,
  resolutions: z.record(z.string(), mergeResolutionSchema),
  chunkSize: z.number().int().positive().max(5000).optional(),
});

export const archiveCommitResultSchema = z.strictObject({
  stagedId: idSchema,
  datasetId: idSchema,
  batchId: idSchema,
  status: z.enum(["committed", "canceled", "failed"]),
  totalChunks: count,
  committedItems: count,
  resumedFromChunk: count,
  persisted: z.strictObject({
    messagesInserted: count,
    messagesLinked: count,
    contactsCreated: count,
    conversationsCreated: count,
    unplacedRecords: count,
  }),
});

export const archiveCancelResultSchema = z.strictObject({ canceled: z.boolean() });

export type ArchivePickFileResult = z.infer<typeof archivePickFileResultSchema>;
export type ArchivePreview = z.infer<typeof archivePreviewSchema>;
export type ArchiveConfirmResult = z.infer<typeof archiveConfirmResultSchema>;
export type ArchiveCommitResult = z.infer<typeof archiveCommitResultSchema>;
