import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FREE_ENTITLEMENT,
  IPC_CHANNEL_NAMES,
  connectorEventSchema,
  contactIdentifierSchema,
  dateRangePresetSchema,
  entitlementSchema,
  evaluateEntitlement,
  externalMediaLinkSchema,
  ipcChannels,
  isEmbeddableInExport,
  messageSchema,
  relationTypeSchema,
  soundtrackTrackSchema,
  temporalFlowReadModelSchema,
} from "./index.js";

const message = {
  id: "msg_1",
  datasetId: "d1",
  conversationId: "c1",
  timestampLocal: "2026-01-15T09:16:00",
  timezone: "Europe/Rome",
  direction: "incoming",
  kind: "text",
  hasAttachment: false,
  sourceKind: "archive-import",
  parseStatus: "complete",
  provenanceId: "prov_1",
} as const;

describe("canonical contracts", () => {
  it("accepts a valid message without UTC and rejects unknown keys or enums", () => {
    expect(messageSchema.safeParse(message).success).toBe(true);
    expect(messageSchema.safeParse({ ...message, extra: 1 }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, parseStatus: "weird" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, timestampLocal: "15/01/2026" }).success).toBe(false);
    expect(messageSchema.safeParse({ ...message, timestampUtc: "2026-01-15T08:16:00Z" }).success).toBe(true);
  });

  it("covers identifier types, relation types and presets", () => {
    for (const type of ["phone", "jid", "lid", "export-name", "other"]) {
      expect(contactIdentifierSchema.safeParse({ type, value: "x", confidence: "unknown" }).success).toBe(true);
    }
    expect(relationTypeSchema.options).toEqual([
      "shared_participant",
      "temporal_overlap",
      "cross_chat_activity",
      "direct_message",
      "group_post",
    ]);
    expect(dateRangePresetSchema.options).toEqual(["today", "yesterday", "7d", "30d", "90d", "custom"]);
  });

  it("validates a temporal flow read model", () => {
    const model = {
      datasetId: "d1",
      range: {
        preset: "7d",
        start: "2026-01-09T00:00:00Z",
        end: "2026-01-15T23:59:59Z",
        timezone: "UTC",
      },
      lanes: [{ entityId: "e1", kind: "contact", label: "A", color: "#35D0FF", stableX: 0, stableZ: 0 }],
      events: [
        { id: "ev1", entityId: "e1", conversationId: "c1", timestamp: "2026-01-15T09:00:00Z", count: 1 },
      ],
      arcs: [
        {
          id: "a1",
          sourceEntityId: "e1",
          targetEntityId: "g1",
          timestamp: "2026-01-15T09:00:00Z",
          direction: "source-to-target",
          count: 1,
          relationKind: "group-post",
          sourceColor: "#35D0FF",
        },
      ],
      dailyMarkers: [{ date: "2026-01-15", timestamp: "2026-01-15T00:00:00Z", label: "15 Jan" }],
      coverage: { messageCount: 1, partialMessageCount: 0, warnings: [] },
    };
    expect(temporalFlowReadModelSchema.safeParse(model).success).toBe(true);
    const bad = { ...model, arcs: [{ ...model.arcs[0], direction: "target-to-source" }] };
    expect(temporalFlowReadModelSchema.safeParse(bad).success).toBe(false);
  });
});

describe("media and soundtrack rights", () => {
  it("validates providers and gates export embedding by rights", () => {
    expect(
      externalMediaLinkSchema.safeParse({
        id: "l1",
        messageId: "m1",
        url: "https://open.spotify.com/track/EXAMPLE0001",
        provider: "spotify",
        linkKind: "music",
      }).success,
    ).toBe(true);
    const track = {
      id: "t1",
      projectId: "p1",
      sourceKind: "shared-link",
      startOffsetMs: 0,
      rightsStatus: "unknown",
    } as const;
    expect(soundtrackTrackSchema.safeParse(track).success).toBe(true);
    expect(isEmbeddableInExport(track)).toBe(false);
    expect(isEmbeddableInExport({ rightsStatus: "not-for-export" })).toBe(false);
    expect(isEmbeddableInExport({ rightsStatus: "licensed" })).toBe(true);
  });
});

describe("entitlement", () => {
  it("never locks or deletes data on expiry", () => {
    const pro = entitlementSchema.parse({
      ...DEFAULT_FREE_ENTITLEMENT,
      tier: "Professional",
      features: { ...DEFAULT_FREE_ENTITLEMENT.features, advancedAnalytics: true },
      expiresAt: "2026-02-01T00:00:00Z",
      offlineGraceDays: 14,
    });
    const active = evaluateEntitlement(pro, new Date("2026-01-15T00:00:00Z"));
    const grace = evaluateEntitlement(pro, new Date("2026-02-10T00:00:00Z"));
    const expired = evaluateEntitlement(pro, new Date("2026-03-01T00:00:00Z"));
    expect([active.status, grace.status, expired.status]).toEqual(["active", "offline-grace", "expired"]);
    expect(expired.effectiveTier).toBe("Free");
    for (const state of [active, grace, expired]) {
      expect(state.dataAccessible).toBe(true);
      expect(state.dataDeleted).toBe(false);
    }
    expect(entitlementSchema.safeParse({ ...pro, deletesDataOnExpiry: true }).success).toBe(false);
  });
});

describe("IPC contract", () => {
  it("exposes only narrow read-only channels", () => {
    expect(IPC_CHANNEL_NAMES.length).toBeGreaterThan(0);
    for (const name of IPC_CHANNEL_NAMES) {
      if (name.startsWith("connector:")) {
        continue;
      }
      expect(name).not.toMatch(/send|write|delete|mutate|exec|shell|open-path|logout/u);
    }
    expect(
      ipcChannels["message:list-range"].request.safeParse({
        datasetId: "d",
        conversationId: "c",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
        limit: 50,
      }).success,
    ).toBe(true);
    expect(ipcChannels["dataset:list"].request.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("synthetic connector fixture", () => {
  it("validates every event", () => {
    const path = resolve(import.meta.dirname, "../../../fixtures/synthetic/connector-events.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { events: unknown[] };
    expect(parsed.events.length).toBeGreaterThanOrEqual(5);
    for (const event of parsed.events) {
      expect(connectorEventSchema.safeParse(event).success).toBe(true);
    }
    const types = parsed.events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(
      expect.arrayContaining(["history.batch", "message.upsert", "message.reaction", "group.metadata", "identity.link"]),
    );
  });
});
