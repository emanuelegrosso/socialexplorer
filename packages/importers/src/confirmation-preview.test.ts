import { describe, expect, it } from "vitest";
import {
  ConfirmationError,
  applyConfirmation,
  localToUtcMs,
  parseArchive,
  previewArchiveImport,
  timeZoneOffsetMs,
} from "./index.js";
import { fixture, TXT_FIXTURES, ZIP_FIXTURES } from "./fixtures.testutil.js";

describe("timezone helpers", () => {
  it("computes offsets with DST", () => {
    expect(timeZoneOffsetMs("Europe/Rome", Date.UTC(2026, 0, 15, 12))).toBe(3_600_000);
    expect(timeZoneOffsetMs("Europe/Rome", Date.UTC(2026, 6, 15, 12))).toBe(7_200_000);
    expect(timeZoneOffsetMs("America/New_York", Date.UTC(2026, 0, 15, 12))).toBe(-5 * 3_600_000);
  });

  it("resolves DST gaps forward and overlaps to the earlier instant", () => {
    const gap = localToUtcMs(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(new Date(gap).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    const overlap = localToUtcMs(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(new Date(overlap).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("import preview", () => {
  it("summarizes android-private.txt before any persistence", async () => {
    const { preview } = await previewArchiveImport(fixture("exports/android-private.txt"), {
      systemTimeZone: "Europe/Rome",
    });
    expect(preview).toMatchObject({
      container: "txt",
      platform: "android",
      conversationCount: 1,
      totalRecords: 15,
      countsByParseStatus: { complete: 13, partial: 1, unparsed: 1 },
      mediaReferenceCount: 3,
      mediaAttachedCount: 2,
      mediaOmittedCount: 1,
      externalLinkCount: 3,
      externalLinksByProvider: { spotify: 1, youtube: 1, apple_music: 1, other: 0 },
      dateRange: { first: "2026-01-15", last: "2026-01-16" },
    });
    expect(preview.contactCandidates).toEqual([
      { displayName: "Alice Example", messageCount: 7 },
      { displayName: "Bob Sample", messageCount: 5 },
    ]);
    expect(preview.unparsedSamples).toHaveLength(1);
    expect(preview.unparsedSamples[0]).toMatchObject({ lineStart: 13, issues: ["invalid_date"] });
    expect(preview.warnings.map((w) => w.parseStatus)).toEqual(["partial", "unparsed"]);
    expect(preview.missingMedia).toEqual(["IMG-20260115-WA0001.png", "PTT-20260115-WA0002.wav"]);
  });

  it.each(ZIP_FIXTURES)("reports media presence for %s", async (path) => {
    const { preview } = await previewArchiveImport(fixture(path));
    expect(preview.container).toBe("zip");
    const group = path.includes("group");
    const ios = path.includes("ios");
    if (!group) {
      expect(preview.missingMedia).toEqual([]);
    } else if (!ios) {
      expect(preview.mediaAttachedCount).toBe(2);
    }
    expect(preview.bytesTotal).toBeGreaterThan(0);
  });

  it.each(TXT_FIXTURES)("preview totals are consistent for %s", async (path) => {
    const { preview } = await previewArchiveImport(fixture(path));
    const sum =
      preview.countsByParseStatus.complete +
      preview.countsByParseStatus.partial +
      preview.countsByParseStatus.unparsed;
    expect(sum).toBe(preview.totalRecords);
    expect(preview.confirmation.timezoneCandidates.length).toBeGreaterThanOrEqual(1);
  });
});

describe("timezone and self confirmation", () => {
  it("offers candidates with a recommended self name from self-only evidence", async () => {
    const { preview } = await previewArchiveImport(fixture("exports/android-private.txt"), {
      systemTimeZone: "Europe/Rome",
      hintTimeZones: ["America/New_York", "Europe/Rome"],
    });
    const { timezoneCandidates, selfCandidates, dateOrderReviews } = preview.confirmation;
    expect(timezoneCandidates.map((c) => c.timezone)).toEqual([
      "Europe/Rome",
      "America/New_York",
      "UTC",
    ]);
    expect(timezoneCandidates[0]?.recommended).toBe(true);
    expect(selfCandidates[0]).toMatchObject({
      name: "Alice Example",
      selfEvidence: 1,
      recommended: true,
    });
    expect(selfCandidates[1]?.recommended).toBe(false);
    expect(dateOrderReviews[0]?.requiresConfirmation).toBe(false);
  });

  it("does not recommend a self name in groups without evidence", async () => {
    const { preview } = await previewArchiveImport(fixture("exports/ios-group.txt"));
    expect(preview.confirmation.selfCandidates.every((c) => !c.recommended)).toBe(true);
  });

  it("marks the file-name counterpart as likely the other party", async () => {
    const { preview } = await previewArchiveImport(fixture("zips/android-private-with-media.zip"));
    expect(
      preview.confirmation.selfCandidates.find((c) => c.name === "Alice Example")?.likelyOther,
    ).toBe(true);
  });

  it("requires confirmation for ambiguous date orders", async () => {
    const data = new TextEncoder().encode(
      "01/02/2026, 09:15 - Alice: hi\n03/04/2026, 09:16 - Bob: yo\n",
    );
    const { preview } = await previewArchiveImport({ name: "x.txt", data });
    expect(preview.confirmation.dateOrderReviews[0]).toMatchObject({ requiresConfirmation: true });
    const reparsed = await parseArchive({ name: "x.txt", data }, { dateOrder: "MDY" });
    expect(reparsed.conversations[0]?.records[0]?.date).toEqual({ year: 2026, month: 1, day: 2 });
    const default_ = await parseArchive({ name: "x.txt", data });
    expect(default_.conversations[0]?.records[0]?.date).toEqual({ year: 2026, month: 2, day: 1 });
  });

  it("applies timezone and self names deterministically", async () => {
    const archive = await parseArchive(fixture("exports/android-private.txt"));
    const first = applyConfirmation(archive, {
      timezone: "Europe/Rome",
      selfNames: ["alice example"],
    });
    const second = applyConfirmation(archive, {
      timezone: "Europe/Rome",
      selfNames: ["Alice Example"],
    });
    expect(first).toEqual(second);
    const messages = first[0]?.messages ?? [];
    const hello = messages[1];
    expect(hello).toMatchObject({
      direction: "outgoing",
      senderName: "Alice Example",
      timestampLocal: "2026-01-15T09:16:00",
      timestampUtc: "2026-01-15T08:16:00.000Z",
      timestampPrecision: "minute",
    });
    expect(messages[2]?.direction).toBe("incoming");
    expect(messages[0]?.direction).toBe("system");
    const partial = messages.find((m) => m.parseStatus === "partial");
    expect(partial).toMatchObject({
      timestampLocal: null,
      timestampUtc: null,
      direction: "outgoing",
    });
    const unparsed = messages.find((m) => m.parseStatus === "unparsed");
    expect(unparsed?.direction).toBe("system");
    expect(unparsed?.rawLines).toHaveLength(1);
  });

  it("changes UTC but not local time when the timezone changes", async () => {
    const archive = await parseArchive(fixture("exports/ios-private.txt"));
    const rome = applyConfirmation(archive, { timezone: "Europe/Rome", selfNames: [] })[0]
      ?.messages[1];
    const ny = applyConfirmation(archive, { timezone: "America/New_York", selfNames: [] })[0]
      ?.messages[1];
    expect(rome?.timestampLocal).toBe(ny?.timestampLocal);
    expect(rome?.timestampLocal).toBe("2026-01-15T09:16:04");
    expect(rome?.timestampUtc).toBe("2026-01-15T08:16:04.000Z");
    expect(ny?.timestampUtc).toBe("2026-01-15T14:16:04.000Z");
    expect(rome?.timestampPrecision).toBe("second");
    expect(rome?.timestampText).toBe("15/01/26, 09:16:04");
  });

  it("keeps stable record ids and content keys across timezone choices", async () => {
    const archive = await parseArchive(fixture("exports/ios-group.txt"));
    const a = applyConfirmation(archive, { timezone: "UTC", selfNames: [] })[0]?.messages ?? [];
    const b =
      applyConfirmation(archive, { timezone: "Asia/Tokyo", selfNames: [] })[0]?.messages ?? [];
    expect(a.map((m) => [m.recordId, m.contentKey])).toEqual(
      b.map((m) => [m.recordId, m.contentKey]),
    );
  });

  it("rejects unknown time zones", async () => {
    const archive = await parseArchive(fixture("exports/ios-group.txt"));
    expect(() => applyConfirmation(archive, { timezone: "Mars/Olympus", selfNames: [] })).toThrow(
      ConfirmationError,
    );
  });
});
