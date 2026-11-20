import type { MediaCatalogEntry, OnThisDayResult } from "@social-explorer/contracts";

export function monthDayFromLocalTimestamp(timestampLocal: string): string {
  return timestampLocal.slice(5, 10);
}

export function filterOnThisDayMedia(
  entries: readonly MediaCatalogEntry[],
  monthDay: string,
): MediaCatalogEntry[] {
  return entries.filter((entry) => monthDayFromLocalTimestamp(entry.reference.timestampLocal) === monthDay);
}

export function summarizeOnThisDay(result: OnThisDayResult): string {
  const parts: string[] = [];
  if (result.messages.length > 0) {
    parts.push(`${String(result.messages.length)} messages`);
  }
  if (result.media.length > 0) {
    parts.push(`${String(result.media.length)} media`);
  }
  if (parts.length === 0) {
    return result.coverageNote ?? "Nothing recorded on this day in your archive.";
  }
  return parts.join(" · ");
}