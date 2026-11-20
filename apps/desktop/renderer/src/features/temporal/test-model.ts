import type { TemporalFlowReadModel } from "@social-explorer/contracts";
import { buildTemporalFlowReadModel } from "@social-explorer/visualization-model";

const contacts = ["alice", "bob", "carol", "dave", "erin"].map((id) => ({
  id: `c_${id}`,
  displayName: `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`,
}));

const groups = [{ conversationId: "conv_group", title: "Hiking Club" }];

const conversations = [
  { id: "conv_ab", kind: "private" as const, participantIds: ["c_alice", "c_bob"] },
  { id: "conv_group", kind: "group" as const, participantIds: contacts.map((c) => c.id) },
];

const messages = [
  { id: "m1", conversationId: "conv_ab", senderId: "c_alice", timestampUtc: "2026-01-20T08:00:00Z" },
  { id: "m2", conversationId: "conv_ab", senderId: "c_bob", timestampUtc: "2026-01-20T08:05:00Z" },
  { id: "m3", conversationId: "conv_group", senderId: "c_carol", timestampUtc: "2026-01-20T09:00:00Z" },
  { id: "m4", conversationId: "conv_group", senderId: "c_alice", timestampUtc: "2026-01-20T09:10:00Z" },
  { id: "m5", conversationId: "conv_ab", senderId: "c_alice", timestampUtc: "2026-01-19T12:00:00Z" },
];

/** Deterministic read model used by renderer unit tests and preview mode. */
export function createSyntheticReadModel(
  overrides: Partial<Parameters<typeof buildTemporalFlowReadModel>[0]> = {},
): TemporalFlowReadModel {
  return buildTemporalFlowReadModel({
    datasetId: "ds_synthetic",
    timezone: "Europe/Rome",
    preset: "7d",
    now: "2026-01-20T10:00:00Z",
    contacts,
    groups,
    conversations,
    messages,
    lod: "detail",
    datasetCoverage: { start: "2026-01-19T00:00:00Z", end: "2026-01-20T23:00:00Z" },
    ...overrides,
  });
}
