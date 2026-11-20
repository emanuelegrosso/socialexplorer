import { describe, expect, it } from "vitest";
import {
  canAutoMerge,
  classifyDuplicate,
  classifyField,
  classifyIdentifier,
  classifyJidChat,
  compareIdentities,
  contactId,
  exportFingerprint,
  isValidTimezone,
  localToUtc,
  messageDedupKey,
  normalizeExportName,
  normalizeJid,
  normalizePhone,
  parseJid,
  utcToLocal,
} from "./index.js";

describe("jid / lid / phone", () => {
  it("parses and classifies identifiers", () => {
    expect(parseJid("15551000001:7@s.whatsapp.net")).toEqual({
      user: "15551000001",
      server: "s.whatsapp.net",
      device: 7,
    });
    expect(parseJid("not a jid")).toBeUndefined();
    expect(normalizeJid("15551000001:7@s.whatsapp.net")).toBe("15551000001@s.whatsapp.net");
    expect(classifyJidChat("120363000000000001@g.us")).toBe("group");
    expect(classifyJidChat("15551000001@s.whatsapp.net")).toBe("private");
    expect(classifyIdentifier("00000002@lid").type).toBe("lid");
    expect(classifyIdentifier("15551000001@s.whatsapp.net").type).toBe("jid");
    expect(classifyIdentifier("+1 (555) 010-1234").type).toBe("phone");
    expect(classifyIdentifier("Alice Example").type).toBe("other");
  });

  it("normalizes phones and export names", () => {
    expect(normalizePhone("+1 555-010-1234")).toBe("+15550101234");
    expect(normalizePhone("12")).toBeUndefined();
    expect(normalizeExportName("\u200EAlice   Example ")).toBe("Alice Example");
  });
});

describe("identity resolution", () => {
  it("never merges on display name alone", () => {
    const left = [{ type: "export-name", value: "Bob Sample", confidence: "unknown" }] as const;
    const right = [
      { type: "export-name", value: "Bob Sample", confidence: "unknown" },
      { type: "lid", value: "00000002@lid", confidence: "probable" },
    ] as const;
    const match = compareIdentities(left, right);
    expect(match.decision).toBe("needs-manual-review");
    expect(canAutoMerge(match)).toBe(false);
  });

  it("matches a shared strong identifier and keeps jid/lid distinct", () => {
    const jid = { type: "jid", value: "15551000002@s.whatsapp.net", confidence: "confirmed" } as const;
    const lid = { type: "lid", value: "00000002@lid", confidence: "confirmed" } as const;
    expect(canAutoMerge(compareIdentities([jid], [jid]))).toBe(true);
    expect(compareIdentities([jid], [lid]).decision).toBe("distinct");
    expect(contactId("d", "jid", jid.value)).not.toBe(contactId("d", "lid", lid.value));
  });
});

describe("time", () => {
  it("round-trips local and UTC for a zone", () => {
    expect(isValidTimezone("Europe/Rome")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(utcToLocal("2026-01-15T23:30:00Z", "Europe/Rome")).toBe("2026-01-16T00:30:00");
    expect(localToUtc("2026-01-16T00:30:00", "Europe/Rome")).toBe("2026-01-15T23:30:00Z");
    expect(localToUtc("2026-07-01T12:00:00", "Europe/Rome")).toBe("2026-07-01T10:00:00Z");
  });

  it("returns undefined for nonexistent DST local times", () => {
    expect(localToUtc("2026-03-29T02:30:00", "Europe/Rome")).toBeUndefined();
    expect(localToUtc("garbage", "UTC")).toBeUndefined();
  });
});

describe("dedup", () => {
  it("builds exact keys and conservative fingerprints", () => {
    expect(messageDedupKey({ conversationKey: "c", sourceMessageId: "m" })).toBe("c\u001fm\u001f");
    const base = {
      conversationKey: "c",
      timestampLocal: "2026-01-20T18:21:00",
      senderName: "Alice Example",
      text: "Same text",
    };
    expect(exportFingerprint(base)).toBe(exportFingerprint({ ...base }));
    expect(exportFingerprint(base)).not.toBe(exportFingerprint({ ...base, text: "Other" }));
  });

  it("never silently drops ambiguous repeats", () => {
    const fp = "fp";
    expect(classifyDuplicate(fp, new Map(), 1)).toBe("new");
    expect(classifyDuplicate(fp, new Map(), 2)).toBe("ambiguous");
    expect(classifyDuplicate(fp, new Map([[fp, 1]]), 1)).toBe("exact-duplicate");
    expect(classifyDuplicate(fp, new Map([[fp, 1]]), 2)).toBe("ambiguous");
  });
});

describe("sensitive fields", () => {
  it("classifies fields", () => {
    expect(classifyField("text")).toBe("content");
    expect(classifyField("remoteId")).toBe("identifier");
    expect(classifyField("token")).toBe("secret");
    expect(classifyField("count")).toBe("public");
  });
});
