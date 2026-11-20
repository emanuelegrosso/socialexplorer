import type { ConnectorUiSnapshot } from "@social-explorer/contracts";
import type { SupervisorState } from "@social-explorer/connector-core";

export interface EphemeralPairing {
  readonly qrPayload?: string;
  readonly pairingCode?: string;
  readonly qrAttempt?: number;
}

export function buildConnectorUiSnapshot(options: {
  readonly connectorEnabled: boolean;
  readonly datasetId?: string;
  readonly supervisor: SupervisorState;
  readonly pairing: EphemeralPairing;
  readonly lastErrorCode?: string;
  readonly nowMs: number;
}): ConnectorUiSnapshot {
  const { supervisor, connectorEnabled, pairing, nowMs } = options;
  const connector = supervisor.connector;
  const lastSyncEventAtMs =
    connector?.lastLiveEventAtMs ?? connector?.history.newestMessageTimestampMs;

  return {
    connectorEnabled,
    ...(options.datasetId === undefined ? {} : { datasetId: options.datasetId }),
    supervisor: {
      status: supervisor.status,
      restartCount: supervisor.restartCount,
      ...(supervisor.lastFailure === undefined ? {} : { lastFailure: supervisor.lastFailure }),
      ...(supervisor.lastHeartbeatAtMs === undefined
        ? {}
        : { lastHeartbeatAtMs: supervisor.lastHeartbeatAtMs }),
      ...(supervisor.lastExit === undefined
        ? {}
        : { lastExitCode: supervisor.lastExit.code }),
    },
    ...(connector === undefined ? {} : { connector }),
    pairing: {
      ...(pairing.qrPayload === undefined ? {} : { qrPayload: pairing.qrPayload }),
      ...(pairing.pairingCode === undefined ? {} : { pairingCode: pairing.pairingCode }),
      ...(pairing.qrAttempt === undefined ? {} : { qrAttempt: pairing.qrAttempt }),
    },
    ...(lastSyncEventAtMs === undefined ? {} : { lastSyncEventAtMs }),
    ...(options.lastErrorCode === undefined ? {} : { lastErrorCode: options.lastErrorCode }),
    updatedAtMs: nowMs,
  };
}