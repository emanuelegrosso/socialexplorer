import { z } from "zod";
import { checkpointSchema, historyStatusSchema, historyWarningSchema, ingestBatchSchema } from "./ingestion-types.js";

export const PROTOCOL_VERSION = 1 as const;

/**
 * Typed IPC protocol between the host (Electron main) and the connector child process.
 * Both directions are closed discriminated unions over strict objects: there is no generic
 * "run this" / "eval" / "exec" command, and unknown fields or types are rejected.
 */

export const hostCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    datasetId: z.string().min(1),
    timezone: z.string().min(1),
    checkpoint: checkpointSchema.optional(),
  }),
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({ type: z.literal("request-pairing-code"), phoneNumber: z.string().regex(/^\+?[0-9 ()-]{6,20}$/u) }),
  z.strictObject({ type: z.literal("logout") }),
  z.strictObject({ type: z.literal("delete-auth") }),
  z.strictObject({ type: z.literal("ping"), nonce: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("ingest-ack"), seq: z.number().int().nonnegative(), ok: z.boolean() }),
  z.strictObject({ type: z.literal("shutdown") }),
]);
export type HostCommand = z.infer<typeof hostCommandSchema>;
export type HostCommandType = HostCommand["type"];

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

export const connectorStateSchema = z.strictObject({
  phase: connectorPhaseSchema,
  pairing: z.strictObject({
    phase: z.enum(["idle", "awaiting-qr", "awaiting-code", "paired", "logged-out", "timed-out"]),
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
    warnings: z.array(historyWarningSchema),
  }),
  lastLiveEventAtMs: z.number().int().nonnegative().optional(),
});
export type ConnectorState = z.infer<typeof connectorStateSchema>;

export const connectorErrorCodeSchema = z.enum([
  "disabled",
  "invalid-command",
  "pairing-failed",
  "sink-failed",
  "auth-failed",
  "internal",
]);
export type ConnectorErrorCode = z.infer<typeof connectorErrorCodeSchema>;

export const connectorEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), protocolVersion: z.literal(PROTOCOL_VERSION), pid: z.number().int() }),
  z.strictObject({ type: z.literal("heartbeat"), seq: z.number().int().nonnegative(), atMs: z.number().int() }),
  z.strictObject({ type: z.literal("pong"), nonce: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("state"), state: connectorStateSchema }),
  z.strictObject({ type: z.literal("qr"), qr: z.string().min(1), attempt: z.number().int().positive() }),
  z.strictObject({ type: z.literal("pairing-code"), code: z.string().min(1) }),
  z.strictObject({ type: z.literal("ingest"), seq: z.number().int().nonnegative(), batch: ingestBatchSchema }),
  z.strictObject({ type: z.literal("error"), code: connectorErrorCodeSchema, message: z.string().max(200) }),
]);
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;
export type ConnectorEventType = ConnectorEvent["type"];

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: "protocol_validation_failed" };
}

export function parseHostCommand(raw: unknown): ParseResult<HostCommand> {
  return parseWith(hostCommandSchema, raw);
}

export function parseConnectorEvent(raw: unknown): ParseResult<ConnectorEvent> {
  return parseWith(connectorEventSchema, raw);
}

/** Closed list used by tests to assert the protocol contains no generic execution verbs. */
export const HOST_COMMAND_TYPES: readonly HostCommandType[] = hostCommandSchema.options.map(
  (option) => option.shape.type.value,
);
