const PART_TYPES = ["year", "month", "day", "hour", "minute", "second"] as const;

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function readParts(timestampMs: number, timeZone: string): Record<(typeof PART_TYPES)[number], number> {
  const parts = formatter(timeZone).formatToParts(new Date(timestampMs));
  const result = {} as Record<(typeof PART_TYPES)[number], number>;
  for (const type of PART_TYPES) {
    const match = parts.find((part) => part.type === type);
    if (match === undefined) {
      throw new Error(`Missing date part ${type}`);
    }
    result[type] = Number(match.value);
  }
  return result;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function utcToLocal(timestampUtc: string, timeZone: string): string {
  const ms = Date.parse(timestampUtc);
  if (Number.isNaN(ms)) {
    throw new Error("Invalid UTC timestamp");
  }
  const p = readParts(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

function offsetMs(timestampMs: number, timeZone: string): number {
  const p = readParts(timestampMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(timestampMs / 1000) * 1000;
}

/**
 * Interprets a local wall-clock time in the given zone. Returns undefined when the local time does
 * not exist in that zone (DST gap) so callers can ask the user instead of guessing.
 */
export function localToUtc(timestampLocal: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u.exec(timestampLocal);
  if (match === null) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = guess - offsetMs(guess, timeZone);
  candidate = guess - offsetMs(candidate, timeZone);
  if (utcToLocal(new Date(candidate).toISOString(), timeZone) !== timestampLocal) {
    return undefined;
  }
  return new Date(candidate).toISOString().replace(".000Z", "Z");
}

export function localDateOf(timestampLocal: string): string {
  return timestampLocal.slice(0, 10);
}
