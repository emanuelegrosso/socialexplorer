import { createAnalyticsEngine } from "@social-explorer/analytics";
import { describe, expect, it } from "vitest";
import { ingestCanonicalBatch, openMemoryDatabase, type CanonicalMessageInput } from "@social-explorer/database";
import { resolveSelection } from "../shared/date-range";

const DS = "ds-analytics-ui";

function at(local: string): { timestampLocal: string; timestampUtc: string } {
  const date = new Date(`${local}Z`);
  date.setUTCHours(date.getUTCHours() - 1);
  return { timestampLocal: local, timestampUtc: date.toISOString() };
}

function message(conversationKey: string, senderKey: string, local: string): CanonicalMessageInput {
  return {
    recordKey: `${conversationKey}-${local}`,
    sourceMessageId: `${conversationKey}-${local}`,
    conversationKey,
    senderKey,
    ...at(local),
    timezone: "Europe/Rome",
    direction: "incoming",
    kind: "text",
    text: "hello",
    hasAttachment: false,
    parseStatus: "complete",
    locator: `${conversationKey}-${local}`,
  };
}

describe("WX-048 analytics read-model agreement", () => {
  it("matches engine global metrics for the shared date range", () => {
    const db = openMemoryDatabase();
    db.prepare(
      "INSERT INTO datasets (id, name, created_at, timezone) VALUES (?, 'Synthetic', '2026-01-01T00:00:00Z', 'Europe/Rome')",
    ).run(DS);
    db.prepare(
      "INSERT INTO data_sources (id, dataset_id, platform, kind, label, created_at) VALUES ('src', ?, 'whatsapp', 'baileys-connector', 's', '2026-01-01T00:00:00Z')",
    ).run(DS);
    ingestCanonicalBatch(db, {
      datasetId: DS,
      sourceId: "src",
      sourceKind: "baileys-history",
      contacts: [
        { key: "A", displayName: "Alice", isSelf: true, identifiers: [] },
        { key: "B", displayName: "Bob", identifiers: [] },
      ],
      conversations: [{ key: "P", title: "Alice & Bob", kind: "private", participantKeys: ["A", "B"] }],
      messages: [
        message("P", "A", "2026-01-19T10:00:00"),
        message("P", "B", "2026-01-20T09:00:00"),
      ],
    });
    const engine = createAnalyticsEngine(db);
    engine.rebuild(DS);
    const range = resolveSelection({ choice: "7d" }, {
      timezone: "Europe/Rome",
      now: "2026-01-20T12:00:00.000Z",
    });
    expect(range.ok).toBe(true);
    if (!range.ok) {
      return;
    }
    const global = engine.global(DS, range.range.analytics);
    expect(global.totalMessages).toBe(2);
    expect(global.contactCount).toBe(2);
    expect(global.dailyAverage).toBeGreaterThan(0);
    expect(global.hourly.reduce((sum, count) => sum + count, 0)).toBe(2);
  });
});