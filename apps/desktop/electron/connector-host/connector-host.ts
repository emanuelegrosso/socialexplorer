import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorUiSnapshot } from "@social-explorer/contracts";
import {
  ConnectorSupervisor,
  InMemoryIngestionSink,
  parseConnectorConfig,
  type SupervisorEvent,
} from "@social-explorer/connector-core";
import type { Logger } from "@social-explorer/security";
import { buildConnectorUiSnapshot, type EphemeralPairing } from "./snapshot.js";

const defaultWorkerEntry = join(
  dirname(fileURLToPath(import.meta.resolve("@social-explorer/connector-core"))),
  "worker-entry.js",
);

export function resolveConnectorFeatureFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw =
    env["ENABLE_BAILEYS_CONNECTOR"] ??
    env["SOCIAL_EXPLORER_ENABLE_BAILEYS_CONNECTOR"] ??
    env["SOCIALEXPLORER_ENABLE_BAILEYS_CONNECTOR"];
  if (raw === undefined || raw.length === 0) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export interface ConnectorHostOptions {
  readonly authDirectory: string;
  readonly logger: Logger;
  readonly onPush: (snapshot: ConnectorUiSnapshot) => void;
  readonly now?: () => number;
  readonly workerEntry?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ConnectorHost {
  snapshot(): ConnectorUiSnapshot;
  start(datasetId?: string): ConnectorUiSnapshot;
  stop(): Promise<ConnectorUiSnapshot>;
  signOut(): ConnectorUiSnapshot;
  clearAuth(): ConnectorUiSnapshot;
  requestPairingCode(phoneNumber: string): ConnectorUiSnapshot;
  shutdown(): Promise<void>;
}

export function createConnectorHost(options: ConnectorHostOptions): ConnectorHost {
  const now = options.now ?? Date.now;
  const connectorEnabled = resolveConnectorFeatureFlag(options.env);
  const config = parseConnectorConfig({ connectorEnabled });
  const sink = new InMemoryIngestionSink();
  let datasetId = config.datasetId ?? "ds_connector_default";
  let lastErrorCode: string | undefined;
  let pairing: EphemeralPairing = {};

  const supervisor = new ConnectorSupervisor({
    config,
    entry: options.workerEntry ?? defaultWorkerEntry,
    datasetId,
    authDirectory: options.authDirectory,
    sink,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const snapshotInput = (): Parameters<typeof buildConnectorUiSnapshot>[0] => ({
    connectorEnabled,
    datasetId,
    supervisor: supervisor.state,
    pairing,
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
    nowMs: now(),
  });

  const emitSnapshot = (): ConnectorUiSnapshot => {
    const snapshot = buildConnectorUiSnapshot(snapshotInput());
    options.onPush(snapshot);
    return snapshot;
  };

  supervisor.onEvent((event: SupervisorEvent) => {
    if (event.type === "qr") {
      pairing = { qrPayload: event.qr, qrAttempt: event.attempt };
    } else if (event.type === "pairing-code") {
      pairing = { ...pairing, pairingCode: event.code };
    } else if (event.type === "error") {
      lastErrorCode = event.code;
    } else {
      const phase = event.state.connector?.phase;
      if (phase === "open" || phase === "logged-out" || phase === "stopped") {
        pairing = {};
      }
    }
    emitSnapshot();
  });

  return {
    snapshot() {
      return buildConnectorUiSnapshot(snapshotInput());
    },
    start(nextDatasetId) {
      if (!connectorEnabled) {
        return this.snapshot();
      }
      if (nextDatasetId !== undefined) {
        datasetId = nextDatasetId;
      }
      supervisor.start();
      return emitSnapshot();
    },
    async stop() {
      if (!connectorEnabled) {
        return this.snapshot();
      }
      await supervisor.stop();
      pairing = {};
      return emitSnapshot();
    },
    signOut() {
      if (!connectorEnabled) {
        return this.snapshot();
      }
      supervisor.logout();
      return emitSnapshot();
    },
    clearAuth() {
      if (!connectorEnabled) {
        return this.snapshot();
      }
      supervisor.deleteAuth();
      pairing = {};
      return emitSnapshot();
    },
    requestPairingCode(phoneNumber: string) {
      if (!connectorEnabled) {
        return this.snapshot();
      }
      supervisor.requestPairingCode(phoneNumber);
      return emitSnapshot();
    },
    async shutdown() {
      pairing = {};
      await supervisor.stop();
    },
  };
}