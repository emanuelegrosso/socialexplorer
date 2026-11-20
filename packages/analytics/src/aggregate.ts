import type { BurstStats, DayCount } from "@social-explorer/contracts";
import type { MessageFact } from "./facts.js";

export interface HourlyBucket {
  readonly conversationId: string;
  readonly senderKey: string;
  readonly dateLocal: string;
  readonly hour: number;
  readonly messageCount: number;
}

export interface DailyBucket {
  readonly conversationId: string;
  readonly senderKey: string;
  readonly dateLocal: string;
  readonly messageCount: number;
  readonly attachmentCount: number;
  readonly characterCount: number;
}

const SEP = "\u001f";

export function aggregateHourly(facts: readonly MessageFact[]): HourlyBucket[] {
  const buckets = new Map<string, HourlyBucket>();
  for (const fact of facts) {
    const senderKey = fact.senderId ?? "";
    const key = [fact.conversationId, senderKey, fact.localDate, String(fact.hour)].join(SEP);
    const current = buckets.get(key);
    buckets.set(key, {
      conversationId: fact.conversationId,
      senderKey,
      dateLocal: fact.localDate,
      hour: fact.hour,
      messageCount: (current?.messageCount ?? 0) + 1,
    });
  }
  return [...buckets.values()].sort(
    (a, b) =>
      a.dateLocal.localeCompare(b.dateLocal) ||
      a.hour - b.hour ||
      a.conversationId.localeCompare(b.conversationId) ||
      a.senderKey.localeCompare(b.senderKey),
  );
}

export function aggregateDaily(facts: readonly MessageFact[]): DailyBucket[] {
  const buckets = new Map<string, DailyBucket>();
  for (const fact of facts) {
    const senderKey = fact.senderId ?? "";
    const key = [fact.conversationId, senderKey, fact.localDate].join(SEP);
    const current = buckets.get(key);
    buckets.set(key, {
      conversationId: fact.conversationId,
      senderKey,
      dateLocal: fact.localDate,
      messageCount: (current?.messageCount ?? 0) + 1,
      attachmentCount: (current?.attachmentCount ?? 0) + (fact.hasAttachment ? 1 : 0),
      characterCount: (current?.characterCount ?? 0) + fact.characters,
    });
  }
  return [...buckets.values()].sort(
    (a, b) =>
      a.dateLocal.localeCompare(b.dateLocal) ||
      a.conversationId.localeCompare(b.conversationId) ||
      a.senderKey.localeCompare(b.senderKey),
  );
}

export interface ActivityMetrics {
  readonly totalMessages: number;
  readonly activeDays: number;
  readonly hourly: number[];
  readonly weekday: number[];
  readonly peakHour: number | null;
  readonly peakWeekday: number | null;
  readonly busiestDays: DayCount[];
  readonly daily: DayCount[];
  readonly firstMessageAt: string | null;
  readonly lastMessageAt: string | null;
  readonly bursts: BurstStats;
}

function peakIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const [index, value] of values.entries()) {
    if (value > bestCount) {
      best = index;
      bestCount = value;
    }
  }
  return best;
}

export const BURST_GAP_SECONDS = 120;
export const BUSIEST_DAY_LIMIT = 5;

/**
 * A burst is two or more consecutive messages by the same sender, each within
 * `BURST_GAP_SECONDS` of the previous one, with nobody else posting in between.
 * `only` restricts the count to bursts by one sender while other senders still break bursts.
 */
export function computeBursts(facts: readonly MessageFact[], only?: string): BurstStats {
  const byConversation = new Map<string, MessageFact[]>();
  for (const fact of facts) {
    if (fact.timestampMs === null) {
      continue;
    }
    const list = byConversation.get(fact.conversationId) ?? [];
    list.push(fact);
    byConversation.set(fact.conversationId, list);
  }
  const lengths: number[] = [];
  for (const list of byConversation.values()) {
    list.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.messageId.localeCompare(b.messageId));
    let sender: string | null = null;
    let last = 0;
    let length = 0;
    const flush = (): void => {
      if (length >= 2 && sender !== null && (only === undefined || sender === only)) {
        lengths.push(length);
      }
    };
    for (const fact of list) {
      const ts = fact.timestampMs ?? 0;
      if (fact.senderId !== null && fact.senderId === sender && ts - last <= BURST_GAP_SECONDS * 1000) {
        length += 1;
      } else {
        flush();
        sender = fact.senderId;
        length = 1;
      }
      last = ts;
    }
    flush();
  }
  const total = lengths.reduce((sum, value) => sum + value, 0);
  return {
    burstCount: lengths.length,
    longestBurst: lengths.reduce((max, value) => Math.max(max, value), 0),
    averageBurstLength: lengths.length === 0 ? 0 : Math.round((total / lengths.length) * 100) / 100,
  };
}

export function computeActivity(
  facts: readonly MessageFact[],
  burstScope: readonly MessageFact[] = facts,
  burstSender?: string,
): ActivityMetrics {
  const hourly = Array.from({ length: 24 }, () => 0);
  const weekday = Array.from({ length: 7 }, () => 0);
  const perDay = new Map<string, number>();
  let first = null as string | null;
  let last = null as string | null;
  for (const fact of facts) {
    hourly[fact.hour] = (hourly[fact.hour] ?? 0) + 1;
    weekday[fact.weekday] = (weekday[fact.weekday] ?? 0) + 1;
    perDay.set(fact.localDate, (perDay.get(fact.localDate) ?? 0) + 1);
    if (fact.timestampUtc !== null) {
      first = first === null || fact.timestampUtc < first ? fact.timestampUtc : first;
      last = last === null || fact.timestampUtc > last ? fact.timestampUtc : last;
    }
  }
  const daily = [...perDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const busiestDays = [...daily]
    .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))
    .slice(0, BUSIEST_DAY_LIMIT);
  return {
    totalMessages: facts.length,
    activeDays: perDay.size,
    hourly,
    weekday,
    peakHour: peakIndex(hourly),
    peakWeekday: peakIndex(weekday),
    busiestDays,
    daily,
    firstMessageAt: first,
    lastMessageAt: last,
    bursts: computeBursts(burstScope, burstSender),
  };
}
