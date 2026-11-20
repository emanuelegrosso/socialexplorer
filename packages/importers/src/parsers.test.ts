import { describe, expect, it } from "vitest";
import {
  ImportAbortedError,
  ImportFormatError,
  detectChatFormat,
  detectContainer,
  parseAndroidChat,
  parseArchive,
  parseIosChat,
  previewArchiveImport,
  readLines,
  sampleLinesFromText,
  stripInvisibleMarks,
  type ParsedMessage,
} from "./index.js";
import { fixture, TXT_FIXTURES, ZIP_FIXTURES } from "./fixtures.testutil.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

async function parseText(
  platform: "android" | "ios",
  text: string,
  dateOrder: "DMY" | "MDY" = "DMY",
) {
  const lines = readLines(text, { chunkSize: 7 });
  const options = { sourceFile: "t.txt", dateOrder };
  return collect(
    platform === "android" ? parseAndroidChat(lines, options) : parseIosChat(lines, options),
  );
}

describe("format detection", () => {
  it.each([
    ["exports/android-private.txt", "android", false],
    ["exports/android-group.txt", "android", false],
    ["exports/ios-private.txt", "ios", true],
    ["exports/ios-group.txt", "ios", true],
  ] as const)("classifies %s", (path, platform, bracketed) => {
    const { data } = fixture(path);
    expect(detectContainer(data)).toBe("txt");
    const format = detectChatFormat(sampleLinesFromText(new TextDecoder().decode(data)));
    expect(format.platform).toBe(platform);
    expect(format.bracketed).toBe(bracketed);
    expect(format.confidence).toBeGreaterThan(0.9);
    expect(format.dateOrder).toBe("DMY");
    expect(format.dateOrderConfidence).toBe("certain");
    expect(format.hourCycle).toBe("24h");
    expect(format.hasSeconds).toBe(bracketed);
  });

  it.each(ZIP_FIXTURES)("detects %s as a ZIP", (path) => {
    expect(detectContainer(fixture(path).data)).toBe("zip");
  });

  it("detects MM/DD order and 12h clocks", () => {
    const format = detectChatFormat([
      "1/15/26, 9:15 PM - Alice: hi",
      "1/16/26, 10:00 AM - Bob: yo",
    ]);
    expect(format.platform).toBe("android");
    expect(format.dateOrder).toBe("MDY");
    expect(format.hourCycle).toBe("12h");
  });

  it("flags fully ambiguous dates instead of guessing", () => {
    const format = detectChatFormat([
      "01/02/2026, 09:15 - Alice: hi",
      "03/04/2026, 09:16 - Bob: yo",
    ]);
    expect(format.dateOrderConfidence).toBe("ambiguous");
  });

  it("rejects unknown text", async () => {
    const data = new TextEncoder().encode("just some prose\nwithout any chat headers\n");
    await expect(parseArchive({ name: "x.txt", data })).rejects.toBeInstanceOf(ImportFormatError);
    await expect(parseArchive({ name: "x.txt", data: new Uint8Array() })).rejects.toMatchObject({
      code: "empty_input",
    });
  });
});

describe("line reader", () => {
  it("handles BOM, CRLF, split multibyte chars and a missing final newline", async () => {
    const text = "\uFEFFalpha\r\nbéta 🎉\r\ngamma";
    const bytes = new TextEncoder().encode(text);
    const lines = await collect(readLines(bytes, { chunkSize: 3 }));
    expect(lines.map((line) => line.text)).toEqual(["alpha", "béta 🎉", "gamma"]);
    expect(lines.map((line) => line.lineNumber)).toEqual([1, 2, 3]);
  });

  it("strips invisible marks", () => {
    expect(stripInvisibleMarks("\u200Ea\u200Fb\u202Ac\u202Ed\uFEFFe")).toBe("abcde");
  });
});

describe("fixture matrix", () => {
  const expected: Record<
    string,
    { total: number; complete: number; partial: number; unparsed: number; system: number }
  > = {
    "android-private.txt": { total: 15, complete: 13, partial: 1, unparsed: 1, system: 2 },
    "android-group.txt": { total: 15, complete: 15, partial: 0, unparsed: 0, system: 5 },
    "ios-private.txt": { total: 13, complete: 11, partial: 1, unparsed: 1, system: 3 },
    "ios-group.txt": { total: 11, complete: 11, partial: 0, unparsed: 0, system: 4 },
  };

  it.each(TXT_FIXTURES)("parses %s", async (path) => {
    const input = fixture(path);
    const archive = await parseArchive(input);
    const conversation = archive.conversations[0];
    expect(conversation).toBeDefined();
    const records = conversation?.records ?? [];
    const want = expected[input.name];
    expect(want).toBeDefined();
    expect(records).toHaveLength(want?.total ?? -1);
    expect(records.filter((r) => r.parseStatus === "complete")).toHaveLength(want?.complete ?? -1);
    expect(records.filter((r) => r.parseStatus === "partial")).toHaveLength(want?.partial ?? -1);
    expect(records.filter((r) => r.parseStatus === "unparsed")).toHaveLength(want?.unparsed ?? -1);
    expect(records.filter((r) => r.kind === "system")).toHaveLength(want?.system ?? -1);
  });

  it.each(TXT_FIXTURES)(
    "never drops lines from %s (provenance covers every input line)",
    async (path) => {
      const input = fixture(path);
      const totalLines = new TextDecoder()
        .decode(input.data)
        .replace(/\r?\n$/, "")
        .split("\n").length;
      const archive = await parseArchive(input);
      const covered = (archive.conversations[0]?.records ?? []).reduce(
        (sum, r) => sum + r.rawLines.length,
        0,
      );
      expect(covered).toBe(totalLines);
      let previous = 0;
      for (const record of archive.conversations[0]?.records ?? []) {
        expect(record.lineStart).toBeGreaterThan(previous);
        expect(record.lineEnd).toBeGreaterThanOrEqual(record.lineStart);
        previous = record.lineEnd;
      }
    },
  );

  it.each(TXT_FIXTURES)("TXT and ZIP variants of %s agree on record content", async (path) => {
    const txt = await parseArchive(fixture(path));
    const zipPath = path.replace("exports/", "zips/").replace(".txt", "-with-media.zip");
    const zip = await parseArchive(fixture(zipPath));
    const project = (records: readonly ParsedMessage[] | undefined) =>
      (records ?? []).map((r) => [r.parseStatus, r.sender, r.text, r.lineStart]);
    expect(project(zip.conversations[0]?.records)).toEqual(project(txt.conversations[0]?.records));
  });
});

describe("Android parser", () => {
  async function android() {
    const archive = await parseArchive(fixture("exports/android-private.txt"));
    return archive.conversations[0]?.records ?? [];
  }

  it("keeps multiline messages together with line ranges", async () => {
    const records = await android();
    const multi = records.find((r) => r.sender === "Bob Sample" && r.text.startsWith("Hi Alice"));
    expect(multi?.text.split("\n")).toHaveLength(3);
    expect(multi?.lineStart).toBe(3);
    expect(multi?.lineEnd).toBe(5);
    expect(multi?.text).toContain("café, naïve, 日本語 🎉");
  });

  it("extracts media markers and attachments", async () => {
    const records = await android();
    const omitted = records.find((r) => r.mediaOmitted);
    expect(omitted?.media[0]).toMatchObject({ kind: "omitted", marker: "<Media omitted>" });
    const attached = records.find((r) => r.text.startsWith("IMG-20260115"));
    expect(attached?.media[0]).toMatchObject({
      kind: "attached",
      fileName: "IMG-20260115-WA0001.png",
      mediaType: "image",
    });
    expect(records.find((r) => r.text.startsWith("PTT-"))?.media[0]?.mediaType).toBe("audio");
  });

  it("extracts external provider links", async () => {
    const records = await android();
    const links = records.flatMap((r) => r.links);
    expect(links.map((l) => l.provider)).toEqual(["spotify", "youtube", "apple_music"]);
    expect(links[0]?.url).toBe("https://open.spotify.com/track/EXAMPLE0001");
  });

  it("classifies system events and deleted markers", async () => {
    const records = await android();
    expect(records[0]?.systemEvent).toBe("encryption_notice");
    expect(records.find((r) => r.text.includes("changed the subject"))?.systemEvent).toBe(
      "subject_changed",
    );
    expect(records.filter((r) => r.deleted)).toHaveLength(2);
  });

  it("marks impossible time as partial and impossible date as unparsed, with provenance", async () => {
    const records = await android();
    const partial = records.find((r) => r.parseStatus === "partial");
    expect(partial).toMatchObject({ lineStart: 12, sender: "Alice Example", time: null });
    expect(partial?.date).toEqual({ year: 2026, month: 1, day: 15 });
    expect(partial?.issues[0]?.code).toBe("invalid_time");
    const unparsed = records.find((r) => r.parseStatus === "unparsed");
    expect(unparsed).toMatchObject({ lineStart: 13, kind: "unparsed" });
    expect(unparsed?.rawLines[0]).toContain("32/13/2026");
  });

  it("derives group metadata", async () => {
    const archive = await parseArchive(fixture("exports/android-group.txt"));
    const conversation = archive.conversations[0];
    expect(conversation?.isGroup).toBe(true);
    expect(conversation?.title).toBe("Synthetic Hiking Club");
    const records = conversation?.records ?? [];
    expect(records.map((r) => r.systemEvent).filter(Boolean)).toEqual([
      "encryption_notice",
      "group_created",
      "member_added",
      "member_added",
      "member_left",
    ]);
    const dupes = records.filter((r) => r.text === "Same text, duplicate candidate");
    expect(dupes).toHaveLength(2);
    expect(records.at(-1)?.text).toContain("Привет, مرحبا, שלום");
  });

  it("handles 12-hour clocks and MM/DD order", async () => {
    const records = await parseText(
      "android",
      "1/15/26, 9:05 PM - Alice: evening\n1/16/26, 12:30 AM - Bob: midnight\n",
      "MDY",
    );
    expect(records[0]?.time).toEqual({ hour: 21, minute: 5, second: null });
    expect(records[0]?.date).toEqual({ year: 2026, month: 1, day: 15 });
    expect(records[1]?.time?.hour).toBe(0);
  });

  it("records orphan lines before the first header instead of dropping them", async () => {
    const records = await parseText("android", "stray preface\n\n15/01/2026, 09:16 - Alice: hi\n");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ parseStatus: "unparsed", lineStart: 1 });
    expect(records[0]?.issues[0]?.code).toBe("orphan_line");
  });

  it("keeps blank lines inside a message but trims trailing blanks", async () => {
    const records = await parseText(
      "android",
      "15/01/2026, 09:16 - Alice: a\n\nb\n\n\n15/01/2026, 09:17 - Bob: c\n",
    );
    expect(records[0]?.text).toBe("a\n\nb");
    expect(records[0]?.lineEnd).toBe(3);
  });
});

describe("iOS parser", () => {
  async function ios() {
    const archive = await parseArchive(fixture("exports/ios-private.txt"));
    return archive.conversations[0]?.records ?? [];
  }

  it("strips LTR/RTL marks from content but keeps raw provenance", async () => {
    const records = await ios();
    const sticker = records.find((r) => r.text === "sticker omitted");
    expect(sticker?.mediaOmitted).toBe(true);
    expect(sticker?.media[0]?.mediaType).toBe("sticker");
    expect(sticker?.rawLines[0]).toContain("\u200E");
    expect(records.some((r) => /[\u200E\u200F]/.test(r.text))).toBe(false);
  });

  it("treats a sender-less RTL line as a system record", async () => {
    const records = await ios();
    const rtl = records.find((r) => r.text.startsWith("שלום"));
    expect(rtl).toMatchObject({ kind: "system", sender: null, parseStatus: "complete" });
  });

  it("parses <attached: ...> references", async () => {
    const records = await ios();
    const attached = records.filter((r) => r.media.some((m) => m.kind === "attached"));
    expect(attached.map((r) => r.media[0]?.fileName)).toEqual([
      "00000001-PHOTO-2026-01-15-09-21-00.png",
      "00000002-AUDIO-2026-01-15-09-22-45.wav",
    ]);
    expect(attached[0]?.media[0]?.mediaType).toBe("image");
  });

  it("flags malformed brackets as unparsed and impossible time as partial", async () => {
    const records = await ios();
    expect(records.find((r) => r.lineStart === 12)).toMatchObject({ parseStatus: "partial" });
    expect(records.find((r) => r.lineStart === 13)).toMatchObject({
      parseStatus: "unparsed",
      issues: [{ code: "malformed_header" }],
    });
  });

  it("keeps seconds precision and original timestamp text", async () => {
    const records = await ios();
    expect(records[1]?.time).toEqual({ hour: 9, minute: 16, second: 4 });
    expect(records[1]?.timestampText).toBe("15/01/26, 09:16:04");
  });

  it("detects group system events", async () => {
    const archive = await parseArchive(fixture("exports/ios-group.txt"));
    const events = archive.conversations[0]?.records.map((r) => r.systemEvent).filter(Boolean);
    expect(events).toEqual(["encryption_notice", "group_created", "member_added", "member_left"]);
  });

  it("recognizes localized media-omitted markers", async () => {
    const records = await parseText(
      "ios",
      "[15/01/26, 09:20:00] Alice: <Medien ausgeschlossen>\n[15/01/26, 09:21:00] Alice: <Multimedia omitido>\n",
    );
    expect(records.every((r) => r.mediaOmitted)).toBe(true);
  });
});

describe("streaming and cancellation", () => {
  it("emits progress with monotonically increasing byte/line counts", async () => {
    const events: { bytes: number; lines: number }[] = [];
    await previewArchiveImport(fixture("exports/android-private.txt"), {
      chunkSize: 64,
      onProgress: (p) => {
        if (p.phase === "parse") {
          events.push({ bytes: p.bytesProcessed, lines: p.linesProcessed });
        }
      },
    });
    expect(events.length).toBeGreaterThan(5);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.bytes).toBeGreaterThanOrEqual(events[i - 1]?.bytes ?? 0);
      expect(events[i]?.lines).toBeGreaterThanOrEqual(events[i - 1]?.lines ?? 0);
    }
    expect(events.at(-1)?.bytes).toBe(1271);
    expect(events.at(-1)?.lines).toBe(17);
  });

  it("cancels cooperatively mid-stream", async () => {
    const controller = new AbortController();
    let seenLines = 0;
    const promise = previewArchiveImport(fixture("exports/android-private.txt"), {
      chunkSize: 64,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "parse" && p.linesProcessed >= 3) {
          seenLines = p.linesProcessed;
          controller.abort();
        }
      },
    });
    await expect(promise).rejects.toBeInstanceOf(ImportAbortedError);
    expect(seenLines).toBeGreaterThanOrEqual(3);
    expect(seenLines).toBeLessThan(17);
  });

  it("cancels while streaming a ZIP entry", async () => {
    const controller = new AbortController();
    const promise = parseArchive(fixture("zips/ios-private-with-media.zip"), {
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      previewArchiveImport(fixture("exports/ios-group.txt"), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ImportAbortedError);
  });
});
