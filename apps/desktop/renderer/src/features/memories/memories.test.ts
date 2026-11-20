import { describe, expect, it } from "vitest";
import { applyMemoriesFilters, DEFAULT_MEMORIES_FILTERS } from "./filters";
import { filterOnThisDayMedia, monthDayFromLocalTimestamp, summarizeOnThisDay } from "./on-this-day";
import type { MediaCatalogEntry } from "@social-explorer/contracts";
import { VIEW_IDS } from "../../store";

const sampleEntry = (overrides: Partial<MediaCatalogEntry["reference"]>): MediaCatalogEntry => ({
  reference: {
    id: overrides.id ?? "ref1",
    datasetId: "ds1",
    conversationId: overrides.conversationId ?? "c1",
    timestampLocal: overrides.timestampLocal ?? "2026-01-15T09:20:00",
    availability: "missing",
    ...(overrides.messageId === undefined ? {} : { messageId: overrides.messageId }),
  },
  mediaType: "photo",
  message: {
    id: "m1",
    conversationId: "c1",
    senderContactId: "contact_a",
    timestampLocal: "2026-01-15T09:20:00",
    kind: "image",
  },
});

describe("memories filters", () => {
  it("filters by media type, contact, and bookmarks", () => {
    const entries = [
      sampleEntry({ id: "a", timestampLocal: "2026-01-15T09:20:00" }),
      {
        ...sampleEntry({ id: "b", timestampLocal: "2026-01-16T09:20:00" }),
        mediaType: "video" as const,
        message: {
          id: "m2",
          conversationId: "c1",
          senderContactId: "contact_b",
          timestampLocal: "2026-01-16T09:20:00",
          kind: "video",
        },
      },
    ];
    const byType = applyMemoriesFilters(entries, { ...DEFAULT_MEMORIES_FILTERS, mediaType: "video" }, new Set());
    expect(byType).toHaveLength(1);
    expect(byType[0]?.reference.id).toBe("b");

    const byContact = applyMemoriesFilters(
      entries,
      { ...DEFAULT_MEMORIES_FILTERS, contactId: "contact_a" },
      new Set(),
    );
    expect(byContact).toHaveLength(1);

    const bookmarked = applyMemoriesFilters(
      entries,
      { ...DEFAULT_MEMORIES_FILTERS, bookmarksOnly: true },
      new Set(["a"]),
    );
    expect(bookmarked.map((row) => row.reference.id)).toEqual(["a"]);
  });
});

describe("on this day", () => {
  it("matches month-day from local timestamps", () => {
    expect(monthDayFromLocalTimestamp("2026-01-15T09:20:00")).toBe("01-15");
    const entries = [
      sampleEntry({ timestampLocal: "2025-01-15T08:00:00" }),
      sampleEntry({ id: "other", timestampLocal: "2026-02-01T08:00:00" }),
    ];
    expect(filterOnThisDayMedia(entries, "01-15")).toHaveLength(1);
  });

  it("summarizes coverage gaps without emotional inference", () => {
    expect(
      summarizeOnThisDay({
        monthDay: "03-01",
        timezone: "UTC",
        referenceDate: "2026-03-01T00:00:00.000Z",
        media: [],
        messages: [],
        coverageNote: "No history for this day.",
      }),
    ).toBe("No history for this day.");
  });
});

describe("shell navigation", () => {
  it("includes unified consumer journey views", () => {
    expect(VIEW_IDS).toEqual([
      "home",
      "discover",
      "memories",
      "timeline",
      "analytics",
      "import",
      "movie-studio",
    ]);
  });
});