import type {
  DailyMarkerViewModel,
  DateRangePreset,
  HourMarkViewModel,
  TemporalArcViewModel,
  TemporalEventViewModel,
  TemporalFlowReadModel,
} from "@social-explorer/contracts";
import { localToUtc } from "@social-explorer/domain";
import {
  LAYOUT_VERSION,
  buildLanes,
  type TemporalContactInput,
  type TemporalGroupInput,
} from "./layout.js";
import {
  localDateOfInstant,
  resolveRange,
  shiftLocalDate,
  startOfLocalDay,
} from "./range.js";

export type LodLevel = "overview" | "mid" | "detail";

export const LOD_BUCKET_SECONDS: Readonly<Record<LodLevel, number>> = {
  overview: 6 * 3600,
  mid: 600,
  detail: 0,
};

export interface TemporalConversationInput {
  readonly id: string;
  readonly kind: "private" | "group" | "other";
  readonly participantIds: readonly string[];
}

export interface TemporalMessageInput {
  readonly id: string;
  readonly conversationId: string;
  /** Effective sender (merged contacts already resolved); null when unknown. */
  readonly senderId: string | null;
  readonly timestampUtc: string;
  readonly partial?: boolean;
}

export interface TemporalFlowInput {
  readonly datasetId: string;
  readonly timezone: string;
  readonly preset: DateRangePreset;
  readonly now: string;
  readonly customStart?: string | undefined;
  readonly customEnd?: string | undefined;
  readonly contacts: readonly TemporalContactInput[];
  readonly groups: readonly TemporalGroupInput[];
  readonly conversations: readonly TemporalConversationInput[];
  /** May contain messages outside the range; they are filtered here. */
  readonly messages: readonly TemporalMessageInput[];
  /** Imported-data coverage of the whole dataset, used for truthful range warnings. */
  readonly datasetCoverage?: { readonly start?: string | undefined; readonly end?: string | undefined };
  /** Defaults to a level derived from the range length. */
  readonly lod?: LodLevel;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function dayLabel(date: string): string {
  const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  return `${WEEKDAYS[day.getUTCDay()] ?? ""} ${String(day.getUTCDate())} ${MONTHS[day.getUTCMonth()] ?? ""} ${String(day.getUTCFullYear())}`;
}

export function defaultLod(startMs: number, endMs: number): LodLevel {
  const days = (endMs - startMs) / 86_400_000;
  return days <= 2 ? "detail" : days <= 14 ? "mid" : "overview";
}

const HOUR_STEP: Readonly<Record<LodLevel, number>> = { overview: 6, mid: 3, detail: 1 };
const iso = (ms: number): string => new Date(ms).toISOString();

function buildMarkers(
  startMs: number,
  endMs: number,
  timezone: string,
  lod: LodLevel,
): { dailyMarkers: DailyMarkerViewModel[]; hourMarks: HourMarkViewModel[] } {
  const dailyMarkers: DailyMarkerViewModel[] = [];
  const hourMarks: HourMarkViewModel[] = [];
  const first = localDateOfInstant(startMs, timezone);
  const last = localDateOfInstant(endMs - 1, timezone);
  for (let date = first; date <= last; date = shiftLocalDate(date, 1)) {
    const midnight = startOfLocalDay(date, timezone);
    if (midnight >= startMs && midnight < endMs) {
      dailyMarkers.push({ date, timestamp: iso(midnight), label: dayLabel(date) });
    }
    for (let hour = HOUR_STEP[lod]; hour < 24; hour += HOUR_STEP[lod]) {
      const instant = localToUtc(`${date}T${String(hour).padStart(2, "0")}:00:00`, timezone);
      const ms = instant === undefined ? undefined : Date.parse(instant);
      if (ms !== undefined && ms >= startMs && ms < endMs) {
        hourMarks.push({ timestamp: iso(ms), hour, date });
      }
    }
  }
  return { dailyMarkers, hourMarks };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pure read model for the Temporal Interaction Flow. The renderer receives lanes, events, arcs and
 * markers only. Impulses sit on the sender's lane; a private message adds one arc sender ->
 * counterpart and a group post adds one arc sender -> group. Arcs are never fanned out to members.
 */
export function buildTemporalFlowReadModel(input: TemporalFlowInput): TemporalFlowReadModel {
  const range = resolveRange(input);
  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  const lod = input.lod ?? defaultLod(startMs, endMs);
  const bucketMs = LOD_BUCKET_SECONDS[lod] * 1000;

  const lanes = buildLanes(input.contacts, input.groups);
  const laneColors = new Map(lanes.map((lane) => [lane.entityId, lane.color]));
  const contactIds = new Set(input.contacts.map((contact) => contact.id));
  const conversations = new Map(input.conversations.map((conversation) => [conversation.id, conversation]));
  const groupLanes = new Set(input.groups.map((group) => group.conversationId));

  const inRange = input.messages
    .map((message) => ({ message, ms: Date.parse(message.timestampUtc) }))
    .filter(({ ms }) => !Number.isNaN(ms) && ms >= startMs && ms < endMs)
    .sort((a, b) => a.ms - b.ms || cmp(a.message.id, b.message.id));

  const events = new Map<string, TemporalEventViewModel>();
  const arcs = new Map<string, TemporalArcViewModel>();
  let unknownSender = 0;
  let noRecipient = 0;
  let partial = 0;
  let firstMs: number | undefined;
  let lastMs: number | undefined;

  for (const { message, ms } of inRange) {
    firstMs = firstMs === undefined ? ms : Math.min(firstMs, ms);
    lastMs = lastMs === undefined ? ms : Math.max(lastMs, ms);
    if (message.partial === true) {
      partial += 1;
    }
    const sender = message.senderId;
    if (sender === null || !contactIds.has(sender)) {
      unknownSender += 1;
      continue;
    }
    const slot = bucketMs === 0 ? ms : Math.floor(ms / bucketMs) * bucketMs;
    const slotKey = bucketMs === 0 ? message.id : String(slot);

    const eventId = `ev:${sender}:${message.conversationId}:${slotKey}`;
    const event = events.get(eventId);
    events.set(eventId, {
      id: eventId,
      entityId: sender,
      conversationId: message.conversationId,
      timestamp: iso(slot),
      count: (event?.count ?? 0) + 1,
    });

    const conversation = conversations.get(message.conversationId);
    let target: string | undefined;
    let relationKind: TemporalArcViewModel["relationKind"] | undefined;
    if (conversation?.kind === "group" && groupLanes.has(conversation.id)) {
      target = conversation.id;
      relationKind = "group-post";
    } else if (conversation?.kind === "private") {
      const participants = new Set([...conversation.participantIds, sender]);
      if (participants.size === 2) {
        target = [...participants].find((id) => id !== sender);
        relationKind = "private-message";
      } else {
        noRecipient += 1;
      }
    }
    if (target !== undefined && relationKind !== undefined && laneColors.has(target)) {
      const arcId = `arc:${sender}:${target}:${relationKind}:${slotKey}`;
      const arc = arcs.get(arcId);
      arcs.set(arcId, {
        id: arcId,
        sourceEntityId: sender,
        targetEntityId: target,
        timestamp: iso(slot),
        direction: "source-to-target",
        count: (arc?.count ?? 0) + 1,
        relationKind,
        sourceColor: laneColors.get(sender) ?? "#FFFFFF",
      });
    }
  }

  const warnings: string[] = [];
  if (inRange.length === 0) {
    warnings.push("No messages in the selected range.");
  }
  const coverage = input.datasetCoverage;
  if (
    coverage?.start !== undefined &&
    coverage.end !== undefined &&
    (startMs < Date.parse(coverage.start) || endMs > Date.parse(coverage.end) + 1000)
  ) {
    warnings.push(
      `Selected range extends beyond imported data (${coverage.start} to ${coverage.end}); empty areas do not mean there was no activity.`,
    );
  }
  if (unknownSender > 0) {
    warnings.push(`${String(unknownSender)} message(s) have no known sender and show no impulse.`);
  }
  if (noRecipient > 0) {
    warnings.push(`${String(noRecipient)} private message(s) have no documented recipient and show no arc.`);
  }
  if (partial > 0) {
    warnings.push(`${String(partial)} message(s) were only partially parsed.`);
  }

  const { dailyMarkers, hourMarks } = buildMarkers(startMs, endMs, range.timezone, lod);
  const byTime = <T extends { timestamp: string; id: string }>(items: Iterable<T>): T[] =>
    [...items].sort((a, b) => cmp(a.timestamp, b.timestamp) || cmp(a.id, b.id));

  return {
    datasetId: input.datasetId,
    range,
    lanes,
    events: byTime(events.values()),
    arcs: byTime(arcs.values()),
    dailyMarkers,
    hourMarks,
    lod: { level: lod, bucketSeconds: LOD_BUCKET_SECONDS[lod] },
    layoutVersion: LAYOUT_VERSION,
    coverage: {
      ...(firstMs === undefined ? {} : { start: iso(firstMs) }),
      ...(lastMs === undefined ? {} : { end: iso(lastMs) }),
      messageCount: inRange.length,
      partialMessageCount: partial,
      warnings,
    },
  };
}
