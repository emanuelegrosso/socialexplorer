import { describe, expect, it } from "vitest";
import type { ConnectorUiSnapshot } from "@social-explorer/contracts";
import { connectorActionsVisible, mapConnectorSnapshotToView } from "./view-model.js";

const baseEnabledSnapshot = (): ConnectorUiSnapshot => ({
  connectorEnabled: true,
  datasetId: "ds_test",
  supervisor: { status: "running", restartCount: 0, lastHeartbeatAtMs: 1 },
  connector: {
    phase: "awaiting-pairing",
    pairing: { phase: "awaiting-qr", qrAttempts: 1, hasQr: true },
    reconnectAttempt: 0,
    history: {
      status: "syncing",
      progress: 42,
      batchesApplied: 2,
      messagesIngested: 120,
      duplicatesSkipped: 3,
      warnings: ["history-coverage-limited"],
    },
  },
  pairing: { qrPayload: "qr-payload", qrAttempt: 1 },
  lastSyncEventAtMs: 2,
  updatedAtMs: 3,
});

describe("mapConnectorSnapshotToView", () => {
  it("hides actionable UI when the feature flag is off", () => {
    const view = mapConnectorSnapshotToView({
      connectorEnabled: false,
      supervisor: { status: "disabled", restartCount: 0 },
      pairing: {},
      updatedAtMs: 0,
    });
    expect(view.enabled).toBe(false);
    expect(view.actionsEnabled).toBe(false);
    expect(view.showPairingQr).toBe(false);
    expect(view.headline).toContain("unavailable");
    expect(view.debugJson).not.toContain("qr-payload");
    expect(connectorActionsVisible({ connectorEnabled: false, supervisor: { status: "disabled", restartCount: 0 }, pairing: {}, updatedAtMs: 0 })).toBe(false);
  });

  it("maps supervisor, history warnings and pairing material for enabled builds", () => {
    const view = mapConnectorSnapshotToView(baseEnabledSnapshot());
    expect(view.enabled).toBe(true);
    expect(view.actionsEnabled).toBe(true);
    expect(view.showPairingQr).toBe(true);
    expect(view.qrPayload).toBe("qr-payload");
    const history = view.sections.find((section) => section.id === "history");
    expect(history?.lines.join("\n")).toContain("Partial history coverage");
    expect(history?.emphasis).toBe("warn");
    expect(view.debugJson).not.toContain("qr-payload");
    expect(connectorActionsVisible(baseEnabledSnapshot())).toBe(true);
  });
});