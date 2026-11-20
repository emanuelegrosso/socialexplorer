import { z } from "zod";
import { idSchema, isoUtcSchema, localDateSchema } from "./common.js";

const count = z.number().int().nonnegative();

export const hourlyDistributionSchema = z.array(count).length(24);
export const weekdayDistributionSchema = z.array(count).length(7);

export const dayCountSchema = z.strictObject({ date: localDateSchema, count });

export const analyticsRangeSchema = z.strictObject({
  startDate: localDateSchema.optional(),
  endDate: localDateSchema.optional(),
});

export const burstStatsSchema = z.strictObject({
  burstCount: count,
  longestBurst: count,
  averageBurstLength: z.number().nonnegative(),
});

export const responseStatsSchema = z.strictObject({
  samples: count,
  medianSeconds: z.number().nonnegative().nullable(),
  meanSeconds: z.number().nonnegative().nullable(),
});

const activityShape = {
  totalMessages: count,
  activeDays: count,
  hourly: hourlyDistributionSchema,
  weekday: weekdayDistributionSchema,
  peakHour: z.number().int().min(0).max(23).nullable(),
  peakWeekday: z.number().int().min(0).max(6).nullable(),
  busiestDays: z.array(dayCountSchema),
  daily: z.array(dayCountSchema),
  firstMessageAt: isoUtcSchema.nullable(),
  lastMessageAt: isoUtcSchema.nullable(),
  bursts: burstStatsSchema,
};

export const globalMetricsSchema = z.strictObject({
  datasetId: idSchema,
  timezone: z.string().min(1),
  range: analyticsRangeSchema,
  contactCount: count,
  groupCount: count,
  conversationCount: count,
  dailyAverage: z.number().nonnegative(),
  ...activityShape,
});

export const counterpartySchema = z.strictObject({
  contactId: idSchema,
  displayName: z.string(),
  sent: count,
  received: count,
  total: count,
});

export const contactMetricsSchema = z.strictObject({
  datasetId: idSchema,
  contactId: idSchema,
  displayName: z.string(),
  range: analyticsRangeSchema,
  conversationCount: count,
  groupCount: count,
  topCounterparties: z.array(counterpartySchema),
  response: responseStatsSchema,
  ...activityShape,
});

export const groupParticipantMetricsSchema = z.strictObject({
  contactId: idSchema.nullable(),
  displayName: z.string(),
  messageCount: count,
});

export const groupMetricsSchema = z.strictObject({
  datasetId: idSchema,
  conversationId: idSchema,
  title: z.string(),
  range: analyticsRangeSchema,
  participantCount: count,
  participants: z.array(groupParticipantMetricsSchema),
  ...activityShape,
});

export const sharedParticipantRelationSchema = z.strictObject({
  type: z.literal("shared_participant"),
  contactId: idSchema,
  leftConversationId: idSchema,
  rightConversationId: idSchema,
  documentedInteraction: z.literal(false),
});

export const temporalOverlapRelationSchema = z.strictObject({
  type: z.literal("temporal_overlap"),
  leftConversationId: idSchema,
  rightConversationId: idSchema,
  localDate: localDateSchema,
  overlapSeconds: count,
  documentedInteraction: z.literal(false),
});

export const crossChatActivityRelationSchema = z.strictObject({
  type: z.literal("cross_chat_activity"),
  contactId: idSchema,
  leftConversationId: idSchema,
  rightConversationId: idSchema,
  occurrences: count,
  windowMinutes: z.number().int().positive(),
  documentedInteraction: z.literal(false),
});

export const directMessageRelationSchema = z.strictObject({
  type: z.literal("direct_message"),
  sourceContactId: idSchema,
  targetContactId: idSchema,
  conversationId: idSchema,
  messageCount: count,
  firstAt: isoUtcSchema,
  lastAt: isoUtcSchema,
  documentedInteraction: z.literal(true),
});

export const groupPostRelationSchema = z.strictObject({
  type: z.literal("group_post"),
  senderContactId: idSchema,
  conversationId: idSchema,
  messageCount: count,
  firstAt: isoUtcSchema,
  lastAt: isoUtcSchema,
  documentedInteraction: z.literal(true),
});

export const relationSetSchema = z.strictObject({
  datasetId: idSchema,
  windowMinutes: z.number().int().positive(),
  shared_participant: z.array(sharedParticipantRelationSchema),
  temporal_overlap: z.array(temporalOverlapRelationSchema),
  cross_chat_activity: z.array(crossChatActivityRelationSchema),
  direct_message: z.array(directMessageRelationSchema),
  group_post: z.array(groupPostRelationSchema),
});

export const analyticsRebuildResultSchema = z.strictObject({
  datasetId: idSchema,
  daily: count,
  hourly: count,
  messages: count,
  version: z.number().int().positive(),
});

export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;
export type BurstStats = z.infer<typeof burstStatsSchema>;
export type ResponseStats = z.infer<typeof responseStatsSchema>;
export type DayCount = z.infer<typeof dayCountSchema>;
export type GlobalMetrics = z.infer<typeof globalMetricsSchema>;
export type ContactMetrics = z.infer<typeof contactMetricsSchema>;
export type GroupMetrics = z.infer<typeof groupMetricsSchema>;
export type RelationSet = z.infer<typeof relationSetSchema>;
export type SharedParticipantRelation = z.infer<typeof sharedParticipantRelationSchema>;
export type TemporalOverlapRelation = z.infer<typeof temporalOverlapRelationSchema>;
export type CrossChatActivityRelation = z.infer<typeof crossChatActivityRelationSchema>;
export type DirectMessageRelation = z.infer<typeof directMessageRelationSchema>;
export type GroupPostRelation = z.infer<typeof groupPostRelationSchema>;
export type AnalyticsRebuildResult = z.infer<typeof analyticsRebuildResultSchema>;
