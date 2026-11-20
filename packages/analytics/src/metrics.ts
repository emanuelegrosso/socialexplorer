import type {
  AnalyticsRange,
  ContactMetrics,
  GlobalMetrics,
  GroupMetrics,
  ResponseStats,
} from "@social-explorer/contracts";
import { computeActivity } from "./aggregate.js";
import type { EntityContext, MessageFact } from "./facts.js";
import { directMessageRelations } from "./relations.js";

export const RESPONSE_MAX_GAP_SECONDS = 24 * 3600;
export const TOP_COUNTERPARTY_LIMIT = 10;

export function filterByRange(facts: readonly MessageFact[], range: AnalyticsRange = {}): MessageFact[] {
  return facts.filter(
    (fact) =>
      (range.startDate === undefined || fact.localDate >= range.startDate) &&
      (range.endDate === undefined || fact.localDate <= range.endDate),
  );
}

function daySpan(first: string, last: string): number {
  const ms = Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * `dailyAverage` is messages per calendar day over the observed span (first to last active day,
 * or the requested range when both bounds are given), so quiet days lower the average.
 */
export function computeGlobalMetrics(
  context: EntityContext,
  allFacts: readonly MessageFact[],
  range: AnalyticsRange = {},
): GlobalMetrics {
  const facts = filterByRange(allFacts, range);
  const activity = computeActivity(facts);
  const first = activity.daily[0]?.date;
  const last = activity.daily.at(-1)?.date;
  const span =
    range.startDate !== undefined && range.endDate !== undefined
      ? daySpan(range.startDate, range.endDate)
      : first === undefined || last === undefined
        ? 0
        : daySpan(first, last);
  const conversations = [...context.conversations.values()];
  return {
    datasetId: context.datasetId,
    timezone: context.timezone,
    range,
    contactCount: context.contacts.size,
    groupCount: conversations.filter((conversation) => conversation.kind === "group").length,
    conversationCount: conversations.length,
    dailyAverage: span <= 0 ? 0 : round2(facts.length / span),
    ...activity,
  };
}

export function computeResponseStats(
  context: EntityContext,
  facts: readonly MessageFact[],
  contactId: string,
): ResponseStats {
  const byConversation = new Map<string, MessageFact[]>();
  for (const fact of facts) {
    const conversation = context.conversations.get(fact.conversationId);
    if (conversation?.kind !== "private" || fact.timestampMs === null || fact.senderId === null) {
      continue;
    }
    const list = byConversation.get(fact.conversationId) ?? [];
    list.push(fact);
    byConversation.set(fact.conversationId, list);
  }
  const gaps: number[] = [];
  for (const list of byConversation.values()) {
    list.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.messageId.localeCompare(b.messageId));
    let previous: MessageFact | undefined;
    for (const fact of list) {
      if (previous !== undefined && previous.senderId !== fact.senderId && fact.senderId === contactId) {
        const gap = ((fact.timestampMs ?? 0) - (previous.timestampMs ?? 0)) / 1000;
        if (gap <= RESPONSE_MAX_GAP_SECONDS) {
          gaps.push(gap);
        }
      }
      previous = fact;
    }
  }
  if (gaps.length === 0) {
    return { samples: 0, medianSeconds: null, meanSeconds: null };
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 1 ? (gaps[mid] ?? 0) : ((gaps[mid - 1] ?? 0) + (gaps[mid] ?? 0)) / 2;
  const mean = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  return { samples: gaps.length, medianSeconds: round2(median), meanSeconds: round2(mean) };
}

export function computeContactMetrics(
  context: EntityContext,
  allFacts: readonly MessageFact[],
  contactId: string,
  range: AnalyticsRange = {},
): ContactMetrics {
  const contact = context.contacts.get(contactId);
  if (contact === undefined) {
    throw new Error("contact_not_found");
  }
  const scoped = filterByRange(allFacts, range);
  const own = scoped.filter((fact) => fact.senderId === contactId);
  const conversationIds = new Set(own.map((fact) => fact.conversationId));
  for (const conversation of context.conversations.values()) {
    if (conversation.participantIds.has(contactId)) {
      conversationIds.add(conversation.id);
    }
  }
  const groupCount = [...conversationIds].filter(
    (id) => context.conversations.get(id)?.kind === "group",
  ).length;

  const partners = new Map<string, { sent: number; received: number }>();
  for (const relation of directMessageRelations(context, scoped)) {
    const other =
      relation.sourceContactId === contactId
        ? relation.targetContactId
        : relation.targetContactId === contactId
          ? relation.sourceContactId
          : undefined;
    if (other === undefined) {
      continue;
    }
    const entry = partners.get(other) ?? { sent: 0, received: 0 };
    if (relation.sourceContactId === contactId) {
      entry.sent += relation.messageCount;
    } else {
      entry.received += relation.messageCount;
    }
    partners.set(other, entry);
  }
  const topCounterparties = [...partners]
    .map(([id, counts]) => ({
      contactId: id,
      displayName: context.contacts.get(id)?.displayName ?? id,
      sent: counts.sent,
      received: counts.received,
      total: counts.sent + counts.received,
    }))
    .sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName) || a.contactId.localeCompare(b.contactId))
    .slice(0, TOP_COUNTERPARTY_LIMIT);

  return {
    datasetId: context.datasetId,
    contactId,
    displayName: contact.displayName,
    range,
    conversationCount: conversationIds.size,
    groupCount,
    topCounterparties,
    response: computeResponseStats(context, scoped, contactId),
    ...computeActivity(own, scoped, contactId),
  };
}

export function computeGroupMetrics(
  context: EntityContext,
  allFacts: readonly MessageFact[],
  conversationId: string,
  range: AnalyticsRange = {},
): GroupMetrics {
  const conversation = context.conversations.get(conversationId);
  if (conversation?.kind !== "group") {
    throw new Error("group_not_found");
  }
  const facts = filterByRange(allFacts, range).filter((fact) => fact.conversationId === conversationId);
  const counts = new Map<string | null, number>();
  for (const fact of facts) {
    counts.set(fact.senderId, (counts.get(fact.senderId) ?? 0) + 1);
  }
  for (const id of conversation.participantIds) {
    counts.set(id, counts.get(id) ?? 0);
  }
  const participants = [...counts]
    .map(([id, messageCount]) => ({
      contactId: id,
      displayName: id === null ? "Unknown sender" : (context.contacts.get(id)?.displayName ?? id),
      messageCount,
    }))
    .sort((a, b) => b.messageCount - a.messageCount || a.displayName.localeCompare(b.displayName));
  return {
    datasetId: context.datasetId,
    conversationId,
    title: conversation.title,
    range,
    participantCount: participants.filter((participant) => participant.contactId !== null).length,
    participants,
    ...computeActivity(facts),
  };
}
