import { performance } from "node:perf_hooks";
import { rebuildAnalyticsTables } from "@social-explorer/analytics";
import { ingestCanonicalBatch, openMemoryDatabase, type CanonicalMessageInput } from "@social-explorer/database";
import {
  buildTemporalFlowReadModel,
  type TemporalFlowInput,
  type TemporalMessageInput,
} from "./model.js";
import { describe, expect, it } from "vitest";

const DS = "ds_bench";
const NOW = "2026-01-20T12:00:00.000Z";

const CONTACTS = [
  { id: "c_alice", displayName: "Alice" },
  { id: "c_bob", displayName: "Bob" },
  { id: "c_carol", displayName: "Carol" },
];
const GROUPS = [{ conversationId: "conv_group", title: "Synthetic Group" }];
const CONVERSATIONS = [
  { id: "conv_private", kind: "private" as const, participantIds: ["c_alice", "c_bob"] },
  { id: "conv_group", kind: "group" as const, participantIds: ["c_alice", "c_bob", "c_carol"] },
];

function canonicalMessages(count: number): CanonicalMessageInput[] {
  const rows: CanonicalMessageInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = 10 + (index % 10);
    const hour = index % 24;
    const local = `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00`;
    const utc = new Date(`${local}Z`);
    utc.setUTCHours(utc.getUTCHours() - 1);
    rows.push({
      recordKey: `rk_${String(index)}`,
      sourceMessageId: `wa_${String(index)}`,
      conversationKey: index % 5 === 0 ? "G" : "P",
      senderKey: index % 2 === 0 ? "A" : "B",
      timestampLocal: local,
      timestampUtc: utc.toISOString(),
      timezone: "Europe/Rome",
      direction: "incoming",
      kind: "text",
      text: `synthetic ${String(index)}`,
      hasAttachment: false,
      parseStatus: "complete",
      locator: `loc_${String(index)}`,
    });
  }
  return rows;
}

function temporalMessages(count: number): TemporalMessageInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m_${String(index)}`,
    conversationId: index % 5 === 0 ? "conv_group" : "conv_private",
    senderId: index % 2 === 0 ? "c_alice" : "c_bob",
    timestampUtc: new Date(Date.UTC(2026, 0, 15, index % 24, index % 60)).toISOString(),
  }));
}

const temporalBase = (): TemporalFlowInput => ({
  datasetId: DS,
  timezone: "Europe/Rome",
  preset: "7d",
  now: NOW,
  contacts: CONTACTS,
  groups: GROUPS,
  conversations: CONVERSATIONS,
  messages: [],
});

function seedAnalyticsDb(messageCount: number) {
  const db = openMemoryDatabase();
  db.prepare("INSERT INTO datasets (id, name, created_at, timezone) VALUES (?, 'Bench', ?, 'Europe/Rome')").run(
    DS,
    NOW,
  );
  db.prepare(
    "INSERT INTO data_sources (id, dataset_id, platform, kind, label, created_at) VALUES ('src', ?, 'whatsapp', 'whatsapp-android-txt', 'bench', ?)",
  ).run(DS, NOW);
  ingestCanonicalBatch(db, {
    datasetId: DS,
    sourceId: "src",
    sourceKind: "archive-import",
    contacts: [
      { key: "A", displayName: "Alice", isSelf: true, identifiers: [] },
      { key: "B", displayName: "Bob", identifiers: [] },
      { key: "C", displayName: "Carol", identifiers: [] },
    ],
    conversations: [
      { key: "P", title: "Alice & Bob", kind: "private", participantKeys: ["A", "B"] },
      { key: "G", title: "Group", kind: "group", participantKeys: ["A", "B", "C"] },
    ],
    messages: canonicalMessages(messageCount),
  });
  return db;
}

const SCALES = [
  { messages: 1_000, temporalLimitMs: 8_000, analyticsLimitMs: 20_000 },
  { messages: 10_000, temporalLimitMs: 30_000, analyticsLimitMs: 90_000 },
] as const;

const optional100k =
  process.env["BENCH_100K"] === "1"
    ? ([{ messages: 100_000, temporalLimitMs: 120_000, analyticsLimitMs: 300_000 }] as const)
    : ([] as const);

describe("WX-072 performance benchmarks (synthetic)", () => {
  for (const scale of [...SCALES, ...optional100k]) {
    it(`buildTemporalFlowReadModel @ ${scale.messages.toLocaleString()} messages`, () => {
      const started = performance.now();
      const model = buildTemporalFlowReadModel({
        ...temporalBase(),
        messages: temporalMessages(scale.messages),
      });
      const elapsed = performance.now() - started;
      expect(model.coverage.messageCount).toBe(scale.messages);
      if (elapsed > scale.temporalLimitMs * 0.5) {
        console.warn(
          `[bench] temporal ${String(scale.messages)}: ${elapsed.toFixed(0)}ms (soft target ${String(scale.temporalLimitMs)}ms)`,
        );
      }
      expect(elapsed).toBeLessThan(scale.temporalLimitMs);
    });

    it(`rebuildAnalyticsTables @ ${scale.messages.toLocaleString()} messages`, () => {
      const db = seedAnalyticsDb(scale.messages);
      const started = performance.now();
      const result = rebuildAnalyticsTables(db, DS, { now: NOW });
      const elapsed = performance.now() - started;
      expect(result.messages).toBe(scale.messages);
      if (elapsed > scale.analyticsLimitMs * 0.5) {
        console.warn(
          `[bench] analytics ${String(scale.messages)}: ${elapsed.toFixed(0)}ms (soft target ${String(scale.analyticsLimitMs)}ms)`,
        );
      }
      expect(elapsed).toBeLessThan(scale.analyticsLimitMs);
    });
  }
});