import { z } from "zod";
import { idSchema, isoUtcSchema, localDateTimeSchema } from "./common.js";

export const mediaKindSchema = z.enum(["image", "video", "audio", "voice", "document", "unknown"]);

export const mediaAvailabilitySchema = z.enum([
  "available-local",
  "external-link",
  "missing",
  "unsupported",
  "not-imported",
]);

export const mediaAssetSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  kind: mediaKindSchema,
  originalName: z.string().optional(),
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  contentHash: z.string().optional(),
  storageRelativePath: z.string().optional(),
  availability: mediaAvailabilitySchema,
  importedAt: isoUtcSchema,
  provenanceId: idSchema,
});

export const mediaReferenceSchema = z.strictObject({
  id: idSchema,
  mediaAssetId: idSchema.optional(),
  messageId: idSchema.optional(),
  conversationId: idSchema,
  timestampUtc: isoUtcSchema.optional(),
  timestampLocal: localDateTimeSchema,
  caption: z.string().optional(),
  availability: mediaAvailabilitySchema,
});

export const externalMediaProviderSchema = z.enum(["spotify", "youtube", "apple-music", "other"]);

export const externalMediaLinkSchema = z.strictObject({
  id: idSchema,
  messageId: idSchema,
  url: z.url(),
  provider: externalMediaProviderSchema.optional(),
  title: z.string().optional(),
  creator: z.string().optional(),
  linkKind: z.enum(["music", "video", "other"]),
  resolvedMetadataAt: isoUtcSchema.optional(),
});

export const storyProjectSchema = z.strictObject({
  id: idSchema,
  datasetId: idSchema,
  title: z.string().min(1),
  dateRangeStart: isoUtcSchema.optional(),
  dateRangeEnd: isoUtcSchema.optional(),
  status: z.enum(["draft", "rendering", "ready", "failed"]),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  createdAt: isoUtcSchema,
  updatedAt: isoUtcSchema,
});

export const storyChapterSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  title: z.string().min(1),
  narrativeText: z.string().optional(),
  startAt: isoUtcSchema.optional(),
  endAt: isoUtcSchema.optional(),
  sortOrder: z.number().int().nonnegative(),
  transition: z.enum(["cut", "fade", "crossfade"]),
  durationSeconds: z.number().positive(),
});

export const storyChapterItemSchema = z.strictObject({
  id: idSchema,
  chapterId: idSchema,
  itemKind: z.enum(["photo", "video", "audio", "message-card", "stat-card", "title-card"]),
  mediaAssetId: idSchema.optional(),
  messageId: idSchema.optional(),
  sortOrder: z.number().int().nonnegative(),
  startOffsetMs: z.number().int().nonnegative().optional(),
  endOffsetMs: z.number().int().nonnegative().optional(),
});

export const soundtrackRightsStatusSchema = z.enum([
  "unknown",
  "user-confirmed",
  "licensed",
  "not-for-export",
]);

export const soundtrackTrackSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  sourceKind: z.enum(["shared-link", "user-file", "licensed-library"]),
  externalUrl: z.url().optional(),
  localAssetId: idSchema.optional(),
  title: z.string().optional(),
  artist: z.string().optional(),
  startOffsetMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  rightsStatus: soundtrackRightsStatusSchema,
});

export const movieExportSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  preset: z.enum(["16:9"]),
  status: z.enum(["queued", "rendering", "completed", "failed", "cancelled"]),
  includeMessageText: z.boolean(),
  includeContactNames: z.boolean(),
  includedSoundtrackTrackIds: z.array(idSchema),
  linkReferenceTrackIds: z.array(idSchema),
  createdAt: isoUtcSchema,
  completedAt: isoUtcSchema.optional(),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaReference = z.infer<typeof mediaReferenceSchema>;
export type ExternalMediaLink = z.infer<typeof externalMediaLinkSchema>;
export type StoryProject = z.infer<typeof storyProjectSchema>;
export type StoryChapter = z.infer<typeof storyChapterSchema>;
export type StoryChapterItem = z.infer<typeof storyChapterItemSchema>;
export type SoundtrackTrack = z.infer<typeof soundtrackTrackSchema>;
export type SoundtrackRightsStatus = z.infer<typeof soundtrackRightsStatusSchema>;
export type MovieExport = z.infer<typeof movieExportSchema>;

export function isEmbeddableInExport(track: Pick<SoundtrackTrack, "rightsStatus">): boolean {
  return track.rightsStatus === "licensed" || track.rightsStatus === "user-confirmed";
}
