import type {
  CrossChatActivityRelation,
  DirectMessageRelation,
  GroupPostRelation,
  RelationSet,
  SharedParticipantRelation,
  TemporalOverlapRelation,
} from "@social-explorer/contracts";
import type { EntityContext, MessageFact } from "./facts.js";

export const DEFAULT_CROSS_CHAT_WINDOW_MINUTES = 30;

const ordered = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * 1. shared_participant: the same identity appears in several conversations. Says nothing
 *    about anyone talking to anyone.
 */
export function sharedParticipantRelations(
  context: EntityContext,
  facts: readonly MessageFact[],
): SharedParticipantRelation[] {
  const memberships = new Map<string, Set<string>>();
  const add = (contactId: string, conversationId: string): void => {
    const set = memberships.get(contactId) ?? new Set<string>();
    set.add(conversationId);
    memberships.set(contactId, set);
  };
  for (const conversation of context.conversations.values()) {
    for (const participant of conversation.participantIds) {
      add(participant, conversation.id);
    }
  }
  for (const fact of facts) {
    if (fact.senderId !== null) {
      add(fact.senderId, fact.conversationId);
    }
  }
  const out: SharedParticipantRelation[] = [];
  for (const [contactId, set] of [...memberships].sort(([a], [b]) => a.localeCompare(b))) {
    const conversations = [...set].sort();
    for (const [index, left] of conversations.entries()) {
      for (const right of conversations.slice(index + 1)) {
        out.push({
          type: "shared_participant",
          contactId,
          leftConversationId: left,
          rightConversationId: right,
          documentedInteraction: false,
        });
      }
    }
  }
  return out;
}

/**
 * 2. temporal_overlap: two conversations were active during overlapping intervals of the same
 *    local day. Activity in parallel is not communication between their participants.
 */
export function temporalOverlapRelations(facts: readonly MessageFact[]): TemporalOverlapRelation[] {
  const spans = new Map<string, { conversationId: string; date: string; min: number; max: number }>();
  for (const fact of facts) {
    if (fact.timestampMs === null) {
      continue;
    }
    const key = `${fact.localDate}\u001f${fact.conversationId}`;
    const span = spans.get(key);
    if (span === undefined) {
      spans.set(key, {
        conversationId: fact.conversationId,
        date: fact.localDate,
        min: fact.timestampMs,
        max: fact.timestampMs,
      });
    } else {
      span.min = Math.min(span.min, fact.timestampMs);
      span.max = Math.max(span.max, fact.timestampMs);
    }
  }
  const byDate = new Map<string, { conversationId: string; min: number; max: number }[]>();
  for (const span of spans.values()) {
    const list = byDate.get(span.date) ?? [];
    list.push(span);
    byDate.set(span.date, list);
  }
  const out: TemporalOverlapRelation[] = [];
  for (const [date, list] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
    for (const [index, left] of list.entries()) {
      for (const right of list.slice(index + 1)) {
        const start = Math.max(left.min, right.min);
        const end = Math.min(left.max, right.max);
        if (start <= end) {
          out.push({
            type: "temporal_overlap",
            leftConversationId: left.conversationId,
            rightConversationId: right.conversationId,
            localDate: date,
            overlapSeconds: Math.round((end - start) / 1000),
            documentedInteraction: false,
          });
        }
      }
    }
  }
  return out;
}

/**
 * 3. cross_chat_activity: the same author posts in different chats within a configured window.
 */
export function crossChatActivityRelations(
  facts: readonly MessageFact[],
  windowMinutes = DEFAULT_CROSS_CHAT_WINDOW_MINUTES,
): CrossChatActivityRelation[] {
  const windowMs = windowMinutes * 60_000;
  const byAuthor = new Map<string, MessageFact[]>();
  for (const fact of facts) {
    if (fact.senderId === null || fact.timestampMs === null) {
      continue;
    }
    const list = byAuthor.get(fact.senderId) ?? [];
    list.push(fact);
    byAuthor.set(fact.senderId, list);
  }
  const counts = new Map<string, CrossChatActivityRelation>();
  for (const [author, list] of [...byAuthor].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.messageId.localeCompare(b.messageId));
    for (const [index, current] of list.entries()) {
      for (const next of list.slice(index + 1)) {
        if ((next.timestampMs ?? 0) - (current.timestampMs ?? 0) > windowMs) {
          break;
        }
        if (next.conversationId === current.conversationId) {
          continue;
        }
        const [left, right] = ordered(current.conversationId, next.conversationId);
        const key = `${author}\u001f${left}\u001f${right}`;
        const existing = counts.get(key);
        counts.set(key, {
          type: "cross_chat_activity",
          contactId: author,
          leftConversationId: left,
          rightConversationId: right,
          occurrences: (existing?.occurrences ?? 0) + 1,
          windowMinutes,
          documentedInteraction: false,
        });
      }
    }
  }
  return [...counts.values()];
}

/**
 * 4. direct_message: a documented private sender -> recipient pair. Only private conversations
 *    with exactly two known participants qualify; anything else is left out rather than guessed.
 */
export function directMessageRelations(
  context: EntityContext,
  facts: readonly MessageFact[],
): DirectMessageRelation[] {
  const groups = new Map<string, DirectMessageRelation>();
  for (const fact of facts) {
    const conversation = context.conversations.get(fact.conversationId);
    if (conversation?.kind !== "private" || fact.senderId === null || fact.timestampUtc === null) {
      continue;
    }
    const participants = new Set([...conversation.participantIds, fact.senderId]);
    if (participants.size !== 2) {
      continue;
    }
    const target = [...participants].find((id) => id !== fact.senderId);
    if (target === undefined) {
      continue;
    }
    const key = `${fact.conversationId}\u001f${fact.senderId}\u001f${target}`;
    const existing = groups.get(key);
    groups.set(key, {
      type: "direct_message",
      sourceContactId: fact.senderId,
      targetContactId: target,
      conversationId: fact.conversationId,
      messageCount: (existing?.messageCount ?? 0) + 1,
      firstAt: existing === undefined || fact.timestampUtc < existing.firstAt ? fact.timestampUtc : existing.firstAt,
      lastAt: existing === undefined || fact.timestampUtc > existing.lastAt ? fact.timestampUtc : existing.lastAt,
      documentedInteraction: true,
    });
  }
  return [...groups.values()];
}

/**
 * 5. group_post: sender -> group. Never expanded to the group's other members.
 */
export function groupPostRelations(
  context: EntityContext,
  facts: readonly MessageFact[],
): GroupPostRelation[] {
  const groups = new Map<string, GroupPostRelation>();
  for (const fact of facts) {
    if (
      context.conversations.get(fact.conversationId)?.kind !== "group" ||
      fact.senderId === null ||
      fact.timestampUtc === null
    ) {
      continue;
    }
    const key = `${fact.conversationId}\u001f${fact.senderId}`;
    const existing = groups.get(key);
    groups.set(key, {
      type: "group_post",
      senderContactId: fact.senderId,
      conversationId: fact.conversationId,
      messageCount: (existing?.messageCount ?? 0) + 1,
      firstAt: existing === undefined || fact.timestampUtc < existing.firstAt ? fact.timestampUtc : existing.firstAt,
      lastAt: existing === undefined || fact.timestampUtc > existing.lastAt ? fact.timestampUtc : existing.lastAt,
      documentedInteraction: true,
    });
  }
  return [...groups.values()];
}

/** Returns the five relation types as separate, never-merged lists. */
export function computeRelations(
  context: EntityContext,
  facts: readonly MessageFact[],
  windowMinutes = DEFAULT_CROSS_CHAT_WINDOW_MINUTES,
): RelationSet {
  const byKey = <T extends object>(items: T[], keys: (item: T) => string): T[] =>
    items.sort((a, b) => keys(a).localeCompare(keys(b)));
  return {
    datasetId: context.datasetId,
    windowMinutes,
    shared_participant: sharedParticipantRelations(context, facts),
    temporal_overlap: temporalOverlapRelations(facts),
    cross_chat_activity: byKey(crossChatActivityRelations(facts, windowMinutes), (r) =>
      [r.contactId, r.leftConversationId, r.rightConversationId].join("\u001f"),
    ),
    direct_message: byKey(directMessageRelations(context, facts), (r) =>
      [r.conversationId, r.sourceContactId].join("\u001f"),
    ),
    group_post: byKey(groupPostRelations(context, facts), (r) =>
      [r.conversationId, r.senderContactId].join("\u001f"),
    ),
  };
}
