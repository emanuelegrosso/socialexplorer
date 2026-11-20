import {
  createRepositories,
  ingestCanonicalBatch,
  openMemoryDatabase,
  type CanonicalMessageInput,
  type SqliteDatabase,
} from "@social-explorer/database";
import { describe, expect, it } from "vitest";
import { createAnalyticsEngine } from "./engine.js";
import { loadEntityContext, loadMessageFacts } from "./facts.js";
import { analyticsVersion, isAnalyticsCurrent, rebuildAnalyticsTables, ANALYTICS_VERSION } from "./rebuild.js";
import { computeRelations } from "./relations.js";

const DS = "ds-1";

function at(local: string): { timestampLocal: string; timestampUtc: string } {
  const date = new Date(`${local}Z`);
  date.setUTCHours(date.getUTCHours() - 1);
  return { timestampLocal: local, timestampUtc: date.toISOString() };
}

let counter = 0;
function message(conversationKey: string, senderKey: string, local: string, overrides: Partial<CanonicalMessageInput> = {}): CanonicalMessageInput {
  counter += 1;
  return {
    recordKey: `r${String(counter)}`,
    sourceMessageId: `wa-${String(counter)}`,
    conversationKey,
    senderKey,
    ...at(local),
    timezone: "Europe/Rome",
    direction: "incoming",
    kind: "text",
    text: "hello",
    hasAttachment: false,
    parseStatus: "complete",
    locator: `wa-${String(counter)}`,
    ...overrides,
  };
}

function seed(): { db: SqliteDatabase; ids: Record<string, string> } {
  counter = 0;
  const db = openMemoryDatabase();
  db.prepare("INSERT INTO datasets (id, name, created_at, timezone) VALUES (?, 'Synthetic', '2026-01-01T00:00:00Z', 'Europe/Rome')").run(DS);
  db.prepare("INSERT INTO data_sources (id, dataset_id, platform, kind, label, created_at) VALUES ('src', ?, 'whatsapp', 'baileys-connector', 's', '2026-01-01T00:00:00Z')").run(DS);
  ingestCanonicalBatch(db, {
    datasetId: DS,
    sourceId: "src",
    sourceKind: "baileys-history",
    contacts: [
      { key: "A", displayName: "Alice Example", isSelf: true, identifiers: [{ type: "jid", value: "15551000001@s.whatsapp.net", confidence: "confirmed" }] },
      { key: "B", displayName: "Bob Sample", identifiers: [{ type: "jid", value: "15551000002@s.whatsapp.net", confidence: "confirmed" }] },
      { key: "C", displayName: "Carol Placeholder", identifiers: [{ type: "jid", value: "15551000003@s.whatsapp.net", confidence: "confirmed" }] },
    ],
    conversations: [
      { key: "P", title: "Alice & Bob", kind: "private", participantKeys: ["A", "B"] },
      { key: "G", title: "Synthetic Hiking Club", kind: "group", participantKeys: ["A", "B", "C"] },
      { key: "Q", title: "Alice & Carol", kind: "private", participantKeys: ["A", "C"] },
    ],
    messages: [
      message("P", "A", "2026-01-15T09:00:00"),
      message("P", "A", "2026-01-15T09:01:00"),
      message("P", "B", "2026-01-15T09:05:00"),
      message("P", "A", "2026-01-15T09:30:00"),
      message("P", "B", "2026-01-15T09:32:00"),
      message("G", "C", "2026-01-15T09:10:00"),
      message("G", "A", "2026-01-15T09:11:00"),
      message("G", "B", "2026-01-16T22:00:00"),
      message("Q", "C", "2026-01-16T22:10:00"),
      message("Q", "A", "2026-01-16T22:11:00", { hasAttachment: true, text: "photo" }),
      message("P", "A", "2026-01-15T09:15:00", { kind: "system", senderKey: null, text: "system notice" }),
    ],
  });
  const contacts = Object.fromEntries(
    (db.prepare("SELECT id, display_name FROM contacts").all() as { id: string; display_name: string }[]).map((row) => [row.display_name.slice(0, 1), row.id]),
  );
  const conversations = Object.fromEntries(
    (db.prepare("SELECT id, source_conversation_id AS k FROM conversations").all() as { id: string; k: string }[]).map((row) => [row.k, row.id]),
  );
  return { db, ids: { ...contacts, ...Object.fromEntries(Object.entries(conversations).map(([k, v]) => [`conv${k}`, v])) } };
}

describe("analytics engine on a synthetic dataset", () => {
  it("computes exact global metrics and excludes system notices", () => {
    const { db } = seed();
    const global = createAnalyticsEngine(db).global(DS);
    expect(global).toMatchObject({
      timezone: "Europe/Rome",
      totalMessages: 10,
      activeDays: 2,
      contactCount: 3,
      groupCount: 1,
      conversationCount: 3,
      dailyAverage: 5,
      peakHour: 9,
      peakWeekday: 3,
      firstMessageAt: "2026-01-15T08:00:00.000Z",
      lastMessageAt: "2026-01-16T21:11:00.000Z",
      bursts: { burstCount: 1, longestBurst: 2, averageBurstLength: 2 },
    });
    expect(global.hourly[9]).toBe(7);
    expect(global.hourly[22]).toBe(3);
    expect(global.weekday).toEqual([0, 0, 0, 7, 3, 0, 0]);
    expect(global.busiestDays).toEqual([
      { date: "2026-01-15", count: 7 },
      { date: "2026-01-16", count: 3 },
    ]);
    expect(createAnalyticsEngine(db).global(DS, { startDate: "2026-01-16", endDate: "2026-01-16" })).toMatchObject({
      totalMessages: 3,
      dailyAverage: 3,
      activeDays: 1,
    });
  });

  it("computes per-contact metrics including counterparties, response and bursts", () => {
    const { db, ids } = seed();
    const engine = createAnalyticsEngine(db);
    const alice = engine.contact(DS, ids["A"] ?? "");
    expect(alice).toMatchObject({
      displayName: "Alice Example",
      totalMessages: 5,
      activeDays: 2,
      conversationCount: 3,
      groupCount: 1,
      peakHour: 9,
      bursts: { burstCount: 1, longestBurst: 2 },
      response: { samples: 2, medianSeconds: 780, meanSeconds: 780 },
    });
    expect(alice.hourly[9]).toBe(4);
    expect(alice.hourly[22]).toBe(1);
    expect(alice.topCounterparties).toEqual([
      { contactId: ids["B"], displayName: "Bob Sample", sent: 3, received: 2, total: 5 },
      { contactId: ids["C"], displayName: "Carol Placeholder", sent: 1, received: 1, total: 2 },
    ]);
    const bob = engine.contact(DS, ids["B"] ?? "");
    expect(bob.response).toEqual({ samples: 2, medianSeconds: 180, meanSeconds: 180 });
    expect(bob.topCounterparties.map((c) => c.contactId)).toEqual([ids["A"]]);
    expect(() => engine.contact(DS, "missing")).toThrow("contact_not_found");
  });

  it("computes per-group metrics without inventing member-to-member traffic", () => {
    const { db, ids } = seed();
    const group = createAnalyticsEngine(db).group(DS, ids["convG"] ?? "");
    expect(group).toMatchObject({ title: "Synthetic Hiking Club", totalMessages: 3, activeDays: 2, participantCount: 3 });
    expect(group.participants.map((p) => [p.displayName, p.messageCount])).toEqual([
      ["Alice Example", 1],
      ["Bob Sample", 1],
      ["Carol Placeholder", 1],
    ]);
    expect(() => createAnalyticsEngine(db).group(DS, ids["convP"] ?? "")).toThrow("group_not_found");
  });

  it("keeps the five relation types strictly separate", () => {
    const { db, ids } = seed();
    const relations = createAnalyticsEngine(db).relations(DS);
    expect(relations.direct_message).toHaveLength(4);
    expect(relations.direct_message.every((r) => r.conversationId !== ids["convG"])).toBe(true);
    expect(relations.direct_message.find((r) => r.sourceContactId === ids["A"] && r.targetContactId === ids["B"])).toMatchObject({
      messageCount: 3,
      firstAt: "2026-01-15T08:00:00.000Z",
      lastAt: "2026-01-15T08:30:00.000Z",
      documentedInteraction: true,
    });
    expect(relations.group_post.map((r) => [r.senderContactId, r.messageCount])).toHaveLength(3);
    expect(relations.group_post.every((r) => r.conversationId === ids["convG"] && r.documentedInteraction)).toBe(true);
    expect(relations.shared_participant).toHaveLength(5);
    expect(relations.temporal_overlap).toEqual([
      expect.objectContaining({ localDate: "2026-01-15", overlapSeconds: 60, documentedInteraction: false }),
    ]);
    expect(relations.cross_chat_activity).toEqual([
      expect.objectContaining({ contactId: ids["A"], occurrences: 3, windowMinutes: 30, documentedInteraction: false }),
    ]);
    for (const type of ["shared_participant", "temporal_overlap", "cross_chat_activity"] as const) {
      expect(relations[type].map((r) => r.documentedInteraction as boolean)).not.toContain(true);
    }
    expect(createAnalyticsEngine(db).relations(DS, 5).cross_chat_activity).toEqual([]);
  });

  it("treats group membership and overlap as non-direct: a group never yields direct messages", () => {
    const { db } = seed();
    const context = loadEntityContext(db, DS);
    const groupOnly = loadMessageFacts(db, DS).filter((fact) => fact.conversationKind === "group");
    const relations = computeRelations(context, groupOnly);
    expect(relations.direct_message).toEqual([]);
    expect(relations.group_post).toHaveLength(3);
  });

  it("rebuilds analytics_daily/hourly identically to the SQL rebuild and is idempotent", () => {
    const { db } = seed();
    const first = rebuildAnalyticsTables(db, DS, { now: "2026-02-01T00:00:00Z" });
    expect(first).toEqual({ datasetId: DS, daily: 7, hourly: 7, messages: 10, version: ANALYTICS_VERSION });
    const snapshot = (): unknown[] => [
      db.prepare("SELECT * FROM analytics_daily ORDER BY conversation_id, sender_key, date_local").all(),
      db.prepare("SELECT * FROM analytics_hourly ORDER BY conversation_id, sender_key, date_local, hour_local").all(),
    ];
    const js = snapshot();
    expect(rebuildAnalyticsTables(db, DS, { now: "2026-02-01T00:00:00Z" })).toEqual(first);
    expect(snapshot()).toEqual(js);
    createRepositories(db).rebuildAnalytics(DS);
    const sql = snapshot().map((rows) => (rows as Record<string, unknown>[]).map((row) => ({ ...row, computed_at: "x" })));
    expect(js.map((rows) => (rows as Record<string, unknown>[]).map((row) => ({ ...row, computed_at: "x" })))).toEqual(sql);
    expect(isAnalyticsCurrent(db, DS)).toBe(true);
    expect(analyticsVersion(db, "other")).toBeUndefined();
    const total = db.prepare("SELECT SUM(message_count) AS n, SUM(attachment_count) AS a FROM analytics_daily").get();
    expect(total).toEqual({ n: 10, a: 1 });
  });

  it("resolves manually merged contacts to their primary and un-merges cleanly", () => {
    const { db, ids } = seed();
    const repos = createRepositories(db);
    repos.identity.mergeContacts(DS, ids["A"] ?? "", ids["B"] ?? "");
    const engine = createAnalyticsEngine(db);
    expect(engine.global(DS).contactCount).toBe(2);
    expect(engine.contact(DS, ids["A"] ?? "").totalMessages).toBe(8);
    expect(() => engine.contact(DS, ids["B"] ?? "")).toThrow("contact_not_found");
    repos.identity.unmergeContact(DS, ids["B"] ?? "");
    expect(engine.contact(DS, ids["A"] ?? "").totalMessages).toBe(5);
    expect(engine.contact(DS, ids["B"] ?? "").totalMessages).toBe(3);
  });
});

describe("fact loading", () => {
  it("restricts facts to a UTC range and flags partial records", () => {
    const { db } = seed();
    db.prepare("UPDATE messages SET parse_status = 'partial' WHERE source_message_id = 'wa-1'").run();
    const all = loadMessageFacts(db, DS);
    expect(all).toHaveLength(10);
    expect(all.filter((fact) => fact.partial)).toHaveLength(1);
    const ranged = loadMessageFacts(db, DS, { startUtc: "2026-01-16T00:00:00.000Z", endUtc: "2026-01-17T00:00:00.000Z" });
    expect(ranged).toHaveLength(3);
    expect(ranged.every((fact) => fact.localDate === "2026-01-16")).toBe(true);
  });
});
