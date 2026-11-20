/**
 * WX-086: deterministic, explainable chapter suggestions.
 *
 * Only factual, countable signals are used (date boundaries, activity volume, conversation
 * first/return appearances, media clusters). There is deliberately no text analysis at all:
 * no sentiment, no personality or relationship inference. Suggestions are proposals and are
 * never finalized without an explicit user action (see `draft.ts`).
 */

export const SUGGESTION_SIGNAL_TYPES = [
  "date-boundary",
  "activity-volume-shift",
  "conversation-new",
  "conversation-returning",
  "media-cluster",
] as const;

export type SuggestionSignalType = (typeof SUGGESTION_SIGNAL_TYPES)[number];

export interface ActivityEvent {
  readonly id: string;
  readonly conversationId: string;
  readonly timestampUtc: string;
  readonly kind: "message" | "media";
}

export interface SuggestionOptions {
  readonly range?: { readonly start?: string; readonly end?: string };
  readonly minGapDays?: number;
  readonly volumeWindowDays?: number;
  readonly volumeRatio?: number;
  readonly minVolume?: number;
  readonly newConversationMinMessages?: number;
  readonly returningGapDays?: number;
  readonly mediaClusterMinItems?: number;
  readonly mediaClusterWindowHours?: number;
  readonly minChapterDays?: number;
  readonly maxChapters?: number;
}

export type EvidenceValue = string | number;

export interface RationaleSignal {
  readonly signalType: SuggestionSignalType;
  readonly evidence: Readonly<Record<string, EvidenceValue>>;
  readonly explanation: string;
}

export interface ChapterRationale extends RationaleSignal {
  readonly supportingSignals: readonly RationaleSignal[];
  readonly metrics: ChapterMetrics;
}

export interface ChapterMetrics {
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly activeDays: number;
  readonly conversationCount: number;
}

export interface ChapterSuggestion {
  readonly id: string;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly rationale: ChapterRationale;
  /** Always false: suggestions become chapters only through an explicit user action. */
  readonly finalized: false;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const DEFAULTS = {
  minGapDays: 7,
  volumeWindowDays: 7,
  volumeRatio: 2,
  minVolume: 10,
  newConversationMinMessages: 5,
  returningGapDays: 14,
  mediaClusterMinItems: 5,
  mediaClusterWindowHours: 24,
  minChapterDays: 3,
  maxChapters: 24,
} as const;

interface Boundary {
  readonly atMs: number;
  readonly signal: RationaleSignal;
}

interface TimedEvent extends ActivityEvent {
  readonly ms: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function byTimeThenId(a: TimedEvent, b: TimedEvent): number {
  return a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function dateBoundaries(events: readonly TimedEvent[], minGapDays: number): Boundary[] {
  const out: Boundary[] = [];
  let prev: TimedEvent | undefined;
  for (const event of events) {
    if (prev !== undefined) {
      const gapDays = Math.floor((event.ms - prev.ms) / DAY_MS);
      if (gapDays >= minGapDays) {
        out.push({
          atMs: event.ms,
          signal: {
            signalType: "date-boundary",
            evidence: { gapDays, previousActivity: day(prev.ms), nextActivity: day(event.ms) },
            explanation: `No activity for ${String(gapDays)} days (${day(prev.ms)} to ${day(event.ms)}); this chapter starts at the first activity after the pause.`,
          },
        });
      } else if (new Date(event.ms).getUTCFullYear() !== new Date(prev.ms).getUTCFullYear()) {
        const year = new Date(event.ms).getUTCFullYear();
        out.push({
          atMs: event.ms,
          signal: {
            signalType: "date-boundary",
            evidence: { year, firstActivity: day(event.ms) },
            explanation: `Calendar year changes to ${String(year)}; this chapter starts at the first activity of the year.`,
          },
        });
      }
    }
    prev = event;
  }
  return out;
}

function volumeBoundaries(
  events: readonly TimedEvent[],
  windowDays: number,
  ratio: number,
  minVolume: number,
): Boundary[] {
  const first = events[0];
  if (first === undefined) return [];
  const origin = Math.floor(first.ms / DAY_MS) * DAY_MS;
  const binMs = windowDays * DAY_MS;
  const last = events[events.length - 1] ?? first;
  const binCount = Math.floor((last.ms - origin) / binMs) + 1;
  const counts = new Array<number>(binCount).fill(0);
  const firstInBin = new Array<number | undefined>(binCount).fill(undefined);
  for (const event of events) {
    const bin = Math.floor((event.ms - origin) / binMs);
    counts[bin] = (counts[bin] ?? 0) + 1;
    firstInBin[bin] ??= event.ms;
  }
  const out: Boundary[] = [];
  for (let bin = 1; bin < binCount; bin += 1) {
    const current = counts[bin] ?? 0;
    const window = counts.slice(Math.max(0, bin - 4), bin);
    const average = window.reduce((sum, value) => sum + value, 0) / window.length;
    const atMs = firstInBin[bin];
    if (atMs === undefined) continue;
    const binStart = day(origin + bin * binMs);
    if (current >= minVolume && current >= ratio * average) {
      out.push({
        atMs,
        signal: {
          signalType: "activity-volume-shift",
          evidence: {
            direction: "increase",
            windowDays,
            windowStart: binStart,
            currentCount: current,
            previousAverage: round1(average),
          },
          explanation: `Activity rose to ${String(current)} events in the ${String(windowDays)}-day window starting ${binStart}, versus an average of ${String(round1(average))} in the preceding windows.`,
        },
      });
    } else if (average >= minVolume && current * ratio <= average) {
      out.push({
        atMs,
        signal: {
          signalType: "activity-volume-shift",
          evidence: {
            direction: "decrease",
            windowDays,
            windowStart: binStart,
            currentCount: current,
            previousAverage: round1(average),
          },
          explanation: `Activity fell to ${String(current)} events in the ${String(windowDays)}-day window starting ${binStart}, versus an average of ${String(round1(average))} in the preceding windows.`,
        },
      });
    }
  }
  return out;
}

function conversationBoundaries(
  events: readonly TimedEvent[],
  minMessages: number,
  returningGapDays: number,
): Boundary[] {
  const first = events[0];
  if (first === undefined) return [];
  const messages = events.filter((event) => event.kind === "message");
  const byConversation = new Map<string, TimedEvent[]>();
  for (const event of messages) {
    const list = byConversation.get(event.conversationId) ?? [];
    list.push(event);
    byConversation.set(event.conversationId, list);
  }
  const out: Boundary[] = [];
  const firstWeekEnd = first.ms + 7 * DAY_MS;
  for (const [conversationId, list] of [...byConversation.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const countFrom = (startMs: number): number =>
      list.filter((event) => event.ms >= startMs && event.ms < startMs + 14 * DAY_MS).length;
    const firstEvent = list[0];
    if (firstEvent !== undefined && firstEvent.ms >= firstWeekEnd) {
      const inFirst = countFrom(firstEvent.ms);
      if (inFirst >= minMessages) {
        out.push({
          atMs: firstEvent.ms,
          signal: {
            signalType: "conversation-new",
            evidence: { conversationId, messagesInFirst14Days: inFirst, firstActivity: day(firstEvent.ms) },
            explanation: `Conversation ${conversationId} first appears on ${day(firstEvent.ms)} with ${String(inFirst)} messages in its first 14 days.`,
          },
        });
      }
    }
    for (let index = 1; index < list.length; index += 1) {
      const prev = list[index - 1];
      const cur = list[index];
      if (prev === undefined || cur === undefined) continue;
      const gapDays = Math.floor((cur.ms - prev.ms) / DAY_MS);
      if (gapDays >= returningGapDays) {
        const after = countFrom(cur.ms);
        if (after >= minMessages) {
          out.push({
            atMs: cur.ms,
            signal: {
              signalType: "conversation-returning",
              evidence: { conversationId, gapDays, messagesInNext14Days: after },
              explanation: `Conversation ${conversationId} resumes on ${day(cur.ms)} after ${String(gapDays)} days without messages, with ${String(after)} messages in the next 14 days.`,
            },
          });
        }
      }
    }
  }
  return out;
}

function mediaBoundaries(
  events: readonly TimedEvent[],
  minItems: number,
  windowHours: number,
): Boundary[] {
  const media = events.filter((event) => event.kind === "media");
  const out: Boundary[] = [];
  let group: TimedEvent[] = [];
  const flush = (): void => {
    const start = group[0];
    const end = group[group.length - 1];
    if (start !== undefined && end !== undefined && group.length >= minItems) {
      const spanHours = round1((end.ms - start.ms) / HOUR_MS);
      out.push({
        atMs: start.ms,
        signal: {
          signalType: "media-cluster",
          evidence: { mediaCount: group.length, spanHours, clusterStart: iso(start.ms) },
          explanation: `${String(group.length)} photos/videos were shared within ${String(spanHours)} hours starting ${day(start.ms)}.`,
        },
      });
      const next = events.find((event) => event.ms > end.ms);
      if (next !== undefined) {
        out.push({
          atMs: next.ms,
          signal: {
            signalType: "media-cluster",
            evidence: { mediaCount: group.length, clusterEnd: iso(end.ms) },
            explanation: `The cluster of ${String(group.length)} media items ends ${day(end.ms)}; this chapter starts at the next activity.`,
          },
        });
      }
    }
    group = [];
  };
  for (const event of media) {
    const prev = group[group.length - 1];
    if (prev !== undefined && event.ms - prev.ms > windowHours * HOUR_MS) flush();
    group.push(event);
  }
  flush();
  return out;
}

function metricsFor(events: readonly TimedEvent[]): ChapterMetrics {
  return {
    messageCount: events.filter((event) => event.kind === "message").length,
    mediaCount: events.filter((event) => event.kind === "media").length,
    activeDays: new Set(events.map((event) => day(event.ms))).size,
    conversationCount: new Set(events.map((event) => event.conversationId)).size,
  };
}

function mergeBoundaries(
  boundaries: readonly Boundary[],
  firstMs: number,
  minChapterDays: number,
): { starts: Boundary[]; startSupport: RationaleSignal[] } {
  const sorted = [...boundaries]
    .filter((boundary) => boundary.atMs > firstMs)
    .sort(
      (a, b) =>
        a.atMs - b.atMs ||
        SUGGESTION_SIGNAL_TYPES.indexOf(a.signal.signalType) -
          SUGGESTION_SIGNAL_TYPES.indexOf(b.signal.signalType),
    );
  const kept: { atMs: number; signals: RationaleSignal[] }[] = [];
  const firstSupport: RationaleSignal[] = [];
  let lastMs = firstMs;
  for (const boundary of sorted) {
    if (boundary.atMs - lastMs >= minChapterDays * DAY_MS) {
      kept.push({ atMs: boundary.atMs, signals: [boundary.signal] });
      lastMs = boundary.atMs;
    } else {
      const target = kept[kept.length - 1];
      if (target === undefined) firstSupport.push(boundary.signal);
      else target.signals.push(boundary.signal);
    }
  }
  return {
    starts: kept.map((entry) => ({ atMs: entry.atMs, signal: entry.signals[0] as RationaleSignal })),
    startSupport: [
      ...firstSupport,
      ...kept.flatMap((entry) => entry.signals.slice(1)),
    ],
  };
}

export function suggestChapters(
  rawEvents: readonly ActivityEvent[],
  options: SuggestionOptions = {},
): ChapterSuggestion[] {
  const opt = { ...DEFAULTS, ...stripUndefinedOptions(options) };
  const rangeStart = options.range?.start === undefined ? -Infinity : Date.parse(options.range.start);
  const rangeEnd = options.range?.end === undefined ? Infinity : Date.parse(options.range.end);
  const events: TimedEvent[] = rawEvents
    .map((event) => ({ ...event, ms: Date.parse(event.timestampUtc) }))
    .filter((event) => Number.isFinite(event.ms) && event.ms >= rangeStart && event.ms <= rangeEnd)
    .sort(byTimeThenId);
  const first = events[0];
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) return [];

  const boundaries: Boundary[] = [
    ...dateBoundaries(events, opt.minGapDays),
    ...volumeBoundaries(events, opt.volumeWindowDays, opt.volumeRatio, opt.minVolume),
    ...conversationBoundaries(events, opt.newConversationMinMessages, opt.returningGapDays),
    ...mediaBoundaries(events, opt.mediaClusterMinItems, opt.mediaClusterWindowHours),
  ];

  let minDays = opt.minChapterDays;
  let merged = mergeBoundaries(boundaries, first.ms, minDays);
  while (merged.starts.length + 1 > opt.maxChapters) {
    minDays *= 2;
    merged = mergeBoundaries(boundaries, first.ms, minDays);
  }

  const starts: { atMs: number; primary: RationaleSignal }[] = [
    {
      atMs: first.ms,
      primary: {
        signalType: "date-boundary",
        evidence: { firstActivity: day(first.ms) },
        explanation: `Start of the selected activity on ${day(first.ms)}.`,
      },
    },
    ...merged.starts.map((entry) => ({ atMs: entry.atMs, primary: entry.signal })),
  ];

  return starts.map((start, index) => {
    const nextMs = starts[index + 1]?.atMs ?? Infinity;
    const inside = events.filter((event) => event.ms >= start.atMs && event.ms < nextMs);
    const lastInside = inside[inside.length - 1] ?? first;
    const supporting = merged.startSupport.filter((signal) => {
      const at = boundaries.find((boundary) => boundary.signal === signal)?.atMs ?? start.atMs;
      return at >= start.atMs && at < nextMs;
    });
    const startAt = iso(start.atMs);
    const endAt = iso(lastInside.ms);
    return {
      id: `suggestion-${startAt}`,
      title: `${day(start.atMs)} to ${day(lastInside.ms)}`,
      startAt,
      endAt,
      rationale: {
        ...start.primary,
        supportingSignals: supporting,
        metrics: metricsFor(inside),
      },
      finalized: false as const,
    };
  });
}

function stripUndefinedOptions(options: SuggestionOptions): Partial<Record<keyof typeof DEFAULTS, number>> {
  const out: Partial<Record<keyof typeof DEFAULTS, number>> = {};
  for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    const value = options[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
