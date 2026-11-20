import type { ConnectorUiSnapshot, HistoryWarningCode } from "@social-explorer/contracts";
import { redactValue } from "@social-explorer/shared";

export interface ConnectorSection {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly emphasis?: "ok" | "warn" | "error" | "muted";
}

const PHASE_LABELS: Record<NonNullable<ConnectorUiSnapshot["connector"]>["phase"], string> = {
  idle: "Idle",
  connecting: "Connecting",
  "awaiting-pairing": "Awaiting pairing",
  open: "Connected",
  reconnecting: "Reconnecting",
  "logged-out": "Logged out",
  replaced: "Session replaced",
  failed: "Failed",
  stopped: "Stopped",
};

const SUPERVISOR_LABELS: Record<ConnectorUiSnapshot["supervisor"]["status"], string> = {
  disabled: "Disabled (feature flag off)",
  stopped: "Stopped",
  starting: "Starting worker",
  running: "Running",
  unresponsive: "Unresponsive — restarting",
  crashed: "Crashed",
  restarting: "Restarting worker",
  failed: "Restart budget exhausted",
  stopping: "Stopping",
};

const HISTORY_WARNING_LABELS: Record<HistoryWarningCode, string> = {
  "history-paused": "History sync paused",
  "history-completion-inferred": "History completion inferred (coverage may be incomplete)",
  "history-interrupted": "History sync was interrupted",
  "history-empty": "No messages returned in history sync",
  "history-coverage-limited": "Partial history coverage — not all chats may be included",
};

export interface ConnectorViewModel {
  readonly enabled: boolean;
  readonly headline: string;
  readonly subhead: string;
  readonly sections: readonly ConnectorSection[];
  readonly showPairingQr: boolean;
  readonly qrPayload?: string;
  readonly pairingCode?: string;
  readonly actionsEnabled: boolean;
  readonly debugJson: string;
}

function formatTimestamp(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
  return new Date(ms).toISOString();
}

function redactSnapshotForDebug(snapshot: ConnectorUiSnapshot): unknown {
  return redactValue({
    ...snapshot,
    pairing: {
      ...snapshot.pairing,
      ...(snapshot.pairing.qrPayload === undefined ? {} : { qrPayload: "[redacted-qr]" }),
      ...(snapshot.pairing.pairingCode === undefined ? {} : { pairingCode: "[redacted-pairing-code]" }),
    },
  });
}

export function mapConnectorSnapshotToView(snapshot: ConnectorUiSnapshot): ConnectorViewModel {
  if (!snapshot.connectorEnabled) {
    return {
      enabled: false,
      headline: "Connector unavailable",
      subhead: "The optional Baileys connector is disabled by default (ENABLE_BAILEYS_CONNECTOR). Archive Import remains the primary path.",
      sections: [
        {
          id: "flag",
          title: "Feature flag",
          lines: ["connectorEnabled is false in the desktop host configuration."],
          emphasis: "muted",
        },
      ],
      showPairingQr: false,
      actionsEnabled: false,
      debugJson: JSON.stringify(redactSnapshotForDebug(snapshot), null, 2),
    };
  }

  const connector = snapshot.connector;
  const phaseLabel = connector === undefined ? "Not started" : PHASE_LABELS[connector.phase];
  const supervisorLabel = SUPERVISOR_LABELS[snapshot.supervisor.status];
  const history = connector?.history;
  const historyLines: string[] =
    history === undefined
      ? ["History sync has not started yet."]
      : [
          `Status: ${history.status}`,
          history.progress === undefined ? "Progress: —" : `Progress: ${history.progress.toFixed(0)}%`,
          `Batches applied: ${String(history.batchesApplied)}`,
          `Messages ingested: ${String(history.messagesIngested)}`,
          `Duplicates skipped: ${String(history.duplicatesSkipped)}`,
          `Oldest message: ${formatTimestamp(history.oldestMessageTimestampMs)}`,
          `Newest message: ${formatTimestamp(history.newestMessageTimestampMs)}`,
          ...history.warnings.map((code) => HISTORY_WARNING_LABELS[code]),
        ];

  const supervisorEmphasis: ConnectorSection["emphasis"] | undefined =
    snapshot.supervisor.status === "running"
      ? "ok"
      : snapshot.supervisor.status === "failed" || snapshot.supervisor.status === "unresponsive"
        ? "error"
        : undefined;

  const historyEmphasis: ConnectorSection["emphasis"] | undefined = history?.warnings.length
    ? "warn"
    : history?.status === "complete"
      ? "ok"
      : undefined;

  const sections: ConnectorSection[] = [
    {
      id: "supervisor",
      title: "Supervisor",
      lines: [
        supervisorLabel,
        `Restart count: ${String(snapshot.supervisor.restartCount)}`,
        snapshot.supervisor.lastFailure === undefined
          ? "Last failure: —"
          : `Last failure: ${snapshot.supervisor.lastFailure}`,
        `Last heartbeat: ${formatTimestamp(snapshot.supervisor.lastHeartbeatAtMs)}`,
      ],
      ...(supervisorEmphasis === undefined ? {} : { emphasis: supervisorEmphasis }),
    },
    {
      id: "connection",
      title: "Connection",
      lines: [
        `Phase: ${phaseLabel}`,
        connector === undefined ? "Pairing: —" : `Pairing phase: ${connector.pairing.phase}`,
        connector === undefined ? "Reconnect attempt: —" : `Reconnect attempt: ${String(connector.reconnectAttempt)}`,
        connector?.nextRetryInMs === undefined
          ? "Next retry: —"
          : `Next retry in ${String(connector.nextRetryInMs)} ms`,
      ],
    },
    {
      id: "history",
      title: "History sync",
      lines: historyLines,
      ...(historyEmphasis === undefined ? {} : { emphasis: historyEmphasis }),
    },
    {
      id: "live",
      title: "Last sync activity",
      lines: [
        `Last live event: ${formatTimestamp(connector?.lastLiveEventAtMs)}`,
        `Last sync event (UI): ${formatTimestamp(snapshot.lastSyncEventAtMs)}`,
        snapshot.lastErrorCode === undefined ? "Last error: —" : `Last error: ${snapshot.lastErrorCode}`,
      ],
    },
  ];

  const showPairingQr = Boolean(snapshot.pairing.qrPayload);
  const showCode = Boolean(snapshot.pairing.pairingCode);

  return {
    enabled: true,
    headline: "WhatsApp connector (read-only)",
    subhead: "Pair a linked device to ingest history and live updates. This build never exposes send-message controls.",
    sections,
    showPairingQr,
    ...(snapshot.pairing.qrPayload === undefined ? {} : { qrPayload: snapshot.pairing.qrPayload }),
    ...(showCode && snapshot.pairing.pairingCode !== undefined
      ? { pairingCode: snapshot.pairing.pairingCode }
      : {}),
    actionsEnabled: true,
    debugJson: JSON.stringify(redactSnapshotForDebug(snapshot), null, 2),
  };
}

export function connectorActionsVisible(snapshot: ConnectorUiSnapshot): boolean {
  return snapshot.connectorEnabled;
}