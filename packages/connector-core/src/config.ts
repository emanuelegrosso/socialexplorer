import { z } from "zod";

export const reconnectConfigSchema = z.strictObject({
  baseMs: z.number().int().positive().default(1_000),
  maxMs: z.number().int().positive().default(60_000),
  /** Fraction of the delay randomized in both directions, 0..1. */
  jitterRatio: z.number().min(0).max(1).default(0.25),
  /** Consecutive transient failures tolerated before the engine gives up and reports `failed`. */
  maxAttempts: z.number().int().positive().default(12),
});

export const supervisorConfigSchema = z.strictObject({
  heartbeatIntervalMs: z.number().int().positive().default(5_000),
  heartbeatTimeoutMs: z.number().int().positive().default(15_000),
  readyTimeoutMs: z.number().int().positive().default(20_000),
  maxRestarts: z.number().int().nonnegative().default(5),
  restartWindowMs: z.number().int().positive().default(300_000),
  restartBaseMs: z.number().int().positive().default(1_000),
  restartMaxMs: z.number().int().positive().default(30_000),
  shutdownGraceMs: z.number().int().positive().default(5_000),
});

/** Disabled by default: the connector is optional and never starts unless explicitly enabled. */
export const connectorConfigSchema = z.strictObject({
  connectorEnabled: z.boolean().default(false),
  datasetId: z.string().min(1).optional(),
  timezone: z.string().min(1).default("UTC"),
  pairingMaxQrAttempts: z.number().int().positive().default(6),
  reconnect: reconnectConfigSchema.default(() => reconnectConfigSchema.parse({})),
  supervisor: supervisorConfigSchema.default(() => supervisorConfigSchema.parse({})),
});

export type ReconnectConfig = z.infer<typeof reconnectConfigSchema>;
export type SupervisorConfig = z.infer<typeof supervisorConfigSchema>;
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export function parseConnectorConfig(input: unknown = {}): ConnectorConfig {
  return connectorConfigSchema.parse(input);
}

export const DEFAULT_CONNECTOR_CONFIG: ConnectorConfig = parseConnectorConfig({});

export function isConnectorEnabled(config: Pick<ConnectorConfig, "connectorEnabled">): boolean {
  return config.connectorEnabled;
}
