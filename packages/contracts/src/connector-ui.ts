import { z } from "zod";

/** One-way channel from main to renderer; not part of the invoke allow-list. */
export const CONNECTOR_PUSH_CHANNEL = "connector:push" as const;

export const historyWarningCodeSchema = z.enum([
  "history-paused",
  "history-completion-inferred",
  "history-interrupted",
  "history-empty",
  "history-coverage-limited",
]);
export type HistoryWarningCode = z.infer<typeof historyWarningCodeSchema>;

export const historyStatusSchema = z.enum(["not-started", "syncing", "complete", "partial"]);
export type HistoryStatus = z.infer<typeof historyStatusSchema>;

export const connectorPhaseSchema = z.enum([
  "idle",
  "connecting",
  "awaiting-pairing",
  "open",
  "reconnecting",
  "logged-out",
  "replaced",
  "failed",
  "stopped",
]);
export type ConnectorPhase = z.infer<typeof connectorPhaseSchema>;

export const supervisorStatusSchema = z.enum([
  "disabled",
  "stopped",
  "starting",
  "running",
  "unresponsive",
  "crashed",
  "restarting",
  "failed",
  "stopping",
]);
export type SupervisorStatus = z.infer<typeof supervisorStatusSchema>;

export const pairingPhaseSchema = z.enum([
  "idle",
  "awaiting-qr",
  "awaiting-code",
  "paired",
  "logged-out",
  "timed-out",
]);
export type PairingPhase = z.infer<typeof pairingPhaseSchema>;

const connectorRuntimeStateSchema = z.strictObject({
  phase: connectorPhaseSchema,
  pairing: z.strictObject({
    phase: pairingPhaseSchema,
    qrAttempts: z.number().int().nonnegative(),
    hasQr: z.boolean(),
  }),
  reconnectAttempt: z.number().int().nonnegative(),
  nextRetryInMs: z.number().int().nonnegative().optional(),
  lastDisconnectCode: z.number().int().optional(),
  history: z.strictObject({
    status: historyStatusSchema,
    progress: z.number().min(0).max(100).optional(),
    batchesApplied: z.number().int().nonnegative(),
    messagesIngested: z.number().int().nonnegative(),
    duplicatesSkipped: z.number().int().nonnegative(),
    oldestMessageTimestampMs: z.number().int().nonnegative().optional(),
    newestMessageTimestampMs: z.number().int().nonnegative().optional(),
    warnings: z.array(historyWarningCodeSchema),
  }),
  lastLiveEventAtMs: z.number().int().nonnegative().optional(),
});

export const connectorUiSnapshotSchema = z.strictObject({
  connectorEnabled: z.boolean(),
  datasetId: z.string().min(1).optional(),
  supervisor: z.strictObject({
    status: supervisorStatusSchema,
    restartCount: z.number().int().nonnegative(),
    lastFailure: z.enum(["crash", "heartbeat-timeout", "ready-timeout", "protocol-violation"]).optional(),
    lastHeartbeatAtMs: z.number().int().nonnegative().optional(),
    lastExitCode: z.number().int().nullable().optional(),
  }),
  connector: connectorRuntimeStateSchema.optional(),
  pairing: z.strictObject({
    qrPayload: z.string().min(1).optional(),
    pairingCode: z.string().min(1).optional(),
    qrAttempt: z.number().int().positive().optional(),
  }),
  lastSyncEventAtMs: z.number().int().nonnegative().optional(),
  lastErrorCode: z.string().optional(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type ConnectorUiSnapshot = z.infer<typeof connectorUiSnapshotSchema>;

export const connectorPushEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot"), snapshot: connectorUiSnapshotSchema }),
]);
export type ConnectorPushEvent = z.infer<typeof connectorPushEventSchema>;