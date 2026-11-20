import type { DateRangePreset } from "@social-explorer/contracts";
import { localToUtc, utcToLocal } from "@social-explorer/domain";

export interface ResolvedRange {
  readonly preset: DateRangePreset;
  /** Inclusive start instant (ISO UTC). */
  readonly start: string;
  /** Exclusive end instant (ISO UTC). */
  readonly end: string;
  readonly timezone: string;
}

export class TemporalRangeError extends Error {
  override readonly name = "TemporalRangeError";
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function shiftLocalDate(date: string, days: number): string {
  const shifted = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days),
  );
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** First instant of a local calendar day; skips hours that do not exist (DST gaps at midnight). */
export function startOfLocalDay(date: string, timezone: string): number {
  for (let hour = 0; hour < 6; hour++) {
    const instant = localToUtc(`${date}T${pad(hour)}:00:00`, timezone);
    if (instant !== undefined) {
      return Date.parse(instant);
    }
  }
  throw new TemporalRangeError(`cannot resolve start of local day ${date}`);
}

export function localDateOfInstant(instantMs: number, timezone: string): string {
  return utcToLocal(new Date(instantMs).toISOString(), timezone).slice(0, 10);
}

const PRESET_DAYS: Readonly<Partial<Record<DateRangePreset, number>>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/**
 * Resolves a preset to concrete bounds using the dataset timezone for every day boundary.
 * `7d`/`30d`/`90d` are the last N local days including today.
 */
export function resolveRange(input: {
  readonly preset: DateRangePreset;
  readonly timezone: string;
  readonly now: string;
  readonly customStart?: string | undefined;
  readonly customEnd?: string | undefined;
}): ResolvedRange {
  const { preset, timezone } = input;
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new TemporalRangeError("invalid now");
  }
  const today = localDateOfInstant(nowMs, timezone);
  const iso = (ms: number): string => new Date(ms).toISOString();
  let startMs: number;
  let endMs: number;
  if (preset === "custom") {
    if (input.customStart === undefined || input.customEnd === undefined) {
      throw new TemporalRangeError("custom range requires start and end");
    }
    startMs = Date.parse(input.customStart);
    endMs = Date.parse(input.customEnd);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      throw new TemporalRangeError("custom range must have start before end");
    }
  } else if (preset === "today") {
    startMs = startOfLocalDay(today, timezone);
    endMs = startOfLocalDay(shiftLocalDate(today, 1), timezone);
  } else if (preset === "yesterday") {
    startMs = startOfLocalDay(shiftLocalDate(today, -1), timezone);
    endMs = startOfLocalDay(today, timezone);
  } else {
    const days = PRESET_DAYS[preset] ?? 7;
    startMs = startOfLocalDay(shiftLocalDate(today, -(days - 1)), timezone);
    endMs = startOfLocalDay(shiftLocalDate(today, 1), timezone);
  }
  return { preset, start: iso(startMs), end: iso(endMs), timezone };
}
