import { createHash } from "node:crypto";
import {
  deriveConversationKey,
  type ParsedArchive,
  type ParsedConversation,
} from "./parse-archive.js";
import type {
  DateOrder,
  Direction,
  ExternalLink,
  MediaReference,
  ParseStatus,
  ParsedMessage,
  SystemEventKind,
  TimestampPrecision,
} from "./types.js";

export class ConfirmationError extends Error {
  override readonly name = "ConfirmationError";
}

export interface TimezoneCandidate {
  readonly timezone: string;
  readonly source: "system" | "hint" | "utc";
  readonly recommended: boolean;
}

export interface SelfCandidate {
  readonly name: string;
  readonly messageCount: number;
  /** Count of markers only the exporting user sees, e.g. "You deleted this message". */
  readonly selfEvidence: number;
  /** True when the file name ("WhatsApp Chat with X") says this is the other party. */
  readonly likelyOther: boolean;
  readonly recommended: boolean;
}

export interface DateOrderReview {
  readonly conversation: string;
  readonly dateOrder: DateOrder;
  readonly confidence: "certain" | "likely" | "ambiguous";
  /** Ambiguous orders are never silently reinterpreted; re-run parsing with an explicit `dateOrder`. */
  readonly requiresConfirmation: boolean;
}

export interface ImportConfirmationOptions {
  readonly timezoneCandidates: readonly TimezoneCandidate[];
  readonly selfCandidates: readonly SelfCandidate[];
  readonly dateOrderReviews: readonly DateOrderReview[];
}

export interface ImportConfirmation {
  readonly timezone: string;
  readonly selfNames: readonly string[];
}

export interface TimezoneOptions {
  readonly systemTimeZone?: string;
  readonly hintTimeZones?: readonly string[];
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function assertValidTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ConfirmationError(`Unknown IANA time zone "${timezone}"`);
  }
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

export function timeZoneOffsetMs(timezone: string, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }
  const asUtc = Date.UTC(
    parts["year"] ?? 1970,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts wall-clock fields to UTC deterministically. In a DST gap the time is shifted
 * forward by the gap; in an overlap the earlier (pre-transition) instant wins.
 */
export function localToUtcMs(
  fields: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timezone: string,
): number {
  const wall = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  const offsetBefore = timeZoneOffsetMs(timezone, wall - 24 * 3600 * 1000);
  const offsetAfter = timeZoneOffsetMs(timezone, wall + 24 * 3600 * 1000);
  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => wall - offset)
    .filter((utc) => timeZoneOffsetMs(timezone, utc) === wall - utc)
    .sort((a, b) => a - b);
  const valid = candidates[0];
  if (valid !== undefined) {
    return valid;
  }
  return wall - offsetBefore;
}

function normalizeName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function buildConfirmationOptions(
  archive: ParsedArchive,
  options: TimezoneOptions = {},
): ImportConfirmationOptions {
  const system = options.systemTimeZone ?? systemTimeZone();
  const timezones: TimezoneCandidate[] = [
    { timezone: system, source: "system", recommended: true },
  ];
  for (const hint of options.hintTimeZones ?? []) {
    assertValidTimeZone(hint);
    if (!timezones.some((candidate) => candidate.timezone === hint)) {
      timezones.push({ timezone: hint, source: "hint", recommended: false });
    }
  }
  if (!timezones.some((candidate) => candidate.timezone === "UTC")) {
    timezones.push({ timezone: "UTC", source: "utc", recommended: false });
  }

  const counts = new Map<string, { name: string; count: number; evidence: number }>();
  const others = new Set<string>();
  for (const conversation of archive.conversations) {
    const named = /^WhatsApp Chat (?:with|-)\s+(.+?)(?:\.txt)?$/i.exec(
      conversation.sourceFile.split("/").pop() ?? "",
    );
    if (named?.[1] !== undefined && !conversation.isGroup) {
      others.add(normalizeName(named[1]));
    }
    for (const record of conversation.records) {
      if (record.kind !== "message" || record.sender === null) {
        continue;
      }
      const key = normalizeName(record.sender);
      const entry = counts.get(key) ?? { name: record.sender, count: 0, evidence: 0 };
      entry.count++;
      if (record.deleted && /^you deleted/i.test(record.text.trim())) {
        entry.evidence++;
      }
      counts.set(key, entry);
    }
  }
  const ranked = [...counts.entries()]
    .map(([key, entry]) => ({
      name: entry.name,
      messageCount: entry.count,
      selfEvidence: entry.evidence,
      likelyOther: others.has(key),
    }))
    .sort(
      (a, b) =>
        b.selfEvidence - a.selfEvidence ||
        Number(a.likelyOther) - Number(b.likelyOther) ||
        b.messageCount - a.messageCount ||
        a.name.localeCompare(b.name),
    );
  const selfCandidates: SelfCandidate[] = ranked.map((candidate, index) => ({
    ...candidate,
    recommended: index === 0 && (candidate.selfEvidence > 0 || ranked.length === 1),
  }));

  const dateOrderReviews: DateOrderReview[] = archive.conversations.map((conversation) => ({
    conversation: conversation.sourceFile,
    dateOrder: conversation.dateOrder,
    confidence: conversation.format.dateOrderConfidence,
    requiresConfirmation: conversation.format.dateOrderConfidence === "ambiguous",
  }));

  return { timezoneCandidates: timezones, selfCandidates, dateOrderReviews };
}

export interface NormalizedMessage {
  readonly recordId: string;
  readonly conversationKey: string;
  readonly sourceFile: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly rawLines: readonly string[];
  readonly parseStatus: ParseStatus;
  readonly direction: Direction;
  readonly senderName: string | null;
  readonly text: string;
  /** `YYYY-MM-DDTHH:MM:SS` wall-clock time exactly as exported; null when unparseable. */
  readonly timestampLocal: string | null;
  readonly timestampUtc: string | null;
  readonly timestampPrecision: TimestampPrecision | null;
  readonly media: readonly MediaReference[];
  readonly links: readonly ExternalLink[];
  readonly mediaOmitted: boolean;
  readonly deleted: boolean;
  readonly systemEvent: SystemEventKind | null;
  readonly timestampText: string | null;
  /** Hash of conversation + sender + normalized text; independent of time precision. */
  readonly contentKey: string;
}

export interface NormalizedConversation {
  readonly conversationKey: string;
  readonly title: string;
  readonly isGroup: boolean;
  readonly sourceFile: string;
  readonly timezone: string;
  readonly messages: readonly NormalizedMessage[];
}

export interface NormalizeOptions {
  readonly conversationKey?: (conversation: ParsedConversation) => string;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

export function normalizeText(text: string): string {
  return text.normalize("NFC").trim();
}

export function normalizeSenderKey(name: string | null): string {
  return name === null ? "" : normalizeName(name);
}

export function computeContentKey(
  conversationKey: string,
  sender: string | null,
  text: string,
): string {
  return createHash("sha256")
    .update(`${conversationKey}\0${normalizeSenderKey(sender)}\0${normalizeText(text)}`)
    .digest("hex");
}

function normalizeRecord(
  record: ParsedMessage,
  conversationKey: string,
  timezone: string,
  selfKeys: ReadonlySet<string>,
): NormalizedMessage {
  let timestampLocal: string | null = null;
  let timestampUtc: string | null = null;
  let precision: TimestampPrecision | null = null;
  if (record.date !== null && record.time !== null) {
    const second = record.time.second ?? 0;
    timestampLocal =
      `${pad(record.date.year, 4)}-${pad(record.date.month)}-${pad(record.date.day)}` +
      `T${pad(record.time.hour)}:${pad(record.time.minute)}:${pad(second)}`;
    timestampUtc = new Date(
      localToUtcMs(
        { ...record.date, hour: record.time.hour, minute: record.time.minute, second },
        timezone,
      ),
    ).toISOString();
    precision = record.time.second === null ? "minute" : "second";
  }
  let direction: Direction = "system";
  if (record.kind === "message") {
    direction =
      record.sender !== null && selfKeys.has(normalizeName(record.sender))
        ? "outgoing"
        : "incoming";
  }
  const identityText = record.kind === "unparsed" ? record.rawLines.join("\n") : record.text;
  const recordId = createHash("sha256")
    .update(`${conversationKey}\0${record.sourceFile}\0${String(record.lineStart)}`)
    .digest("hex")
    .slice(0, 32);
  return {
    recordId,
    conversationKey,
    sourceFile: record.sourceFile,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    rawLines: record.rawLines,
    parseStatus: record.parseStatus,
    direction,
    senderName: record.sender,
    text: record.text,
    timestampLocal,
    timestampUtc,
    timestampPrecision: precision,
    media: record.media,
    links: record.links,
    mediaOmitted: record.mediaOmitted,
    deleted: record.deleted,
    systemEvent: record.systemEvent,
    timestampText: record.timestampText,
    contentKey: computeContentKey(
      conversationKey,
      record.kind === "system" ? null : record.sender,
      identityText,
    ),
  };
}

/** Applies the user's confirmed timezone and self identity. Pure and deterministic. */
export function applyConfirmation(
  archive: ParsedArchive,
  confirmation: ImportConfirmation,
  options: NormalizeOptions = {},
): NormalizedConversation[] {
  assertValidTimeZone(confirmation.timezone);
  const selfKeys = new Set(confirmation.selfNames.map(normalizeName));
  return archive.conversations.map((conversation) => {
    const conversationKey =
      options.conversationKey?.(conversation) ?? deriveConversationKey(conversation.title);
    return {
      conversationKey,
      title: conversation.title,
      isGroup: conversation.isGroup,
      sourceFile: conversation.sourceFile,
      timezone: confirmation.timezone,
      messages: conversation.records.map((record) =>
        normalizeRecord(record, conversationKey, confirmation.timezone, selfKeys),
      ),
    };
  });
}
