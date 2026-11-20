import { useCallback, useEffect, useState } from "react";
import type { ConnectorUiSnapshot } from "@social-explorer/contracts";
import type { ConnectorPushEvent } from "@social-explorer/contracts";
import type { SocialExplorerApi } from "../../../../shared/bridge";
import { mapConnectorSnapshotToView } from "./view-model.js";

export interface ConnectorPanelProps {
  readonly api: SocialExplorerApi;
  readonly subscribeConnector?: SocialExplorerApi["subscribeConnector"];
}

const DISABLED_SNAPSHOT: ConnectorUiSnapshot = {
  connectorEnabled: false,
  supervisor: { status: "disabled", restartCount: 0 },
  pairing: {},
  updatedAtMs: 0,
};

export function ConnectorPanel({ api, subscribeConnector }: ConnectorPanelProps) {
  const [snapshot, setSnapshot] = useState<ConnectorUiSnapshot>(DISABLED_SNAPSHOT);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const next = await api.getConnectorSnapshot();
      setSnapshot(next);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "connector_snapshot_failed");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (subscribeConnector === undefined) {
      return;
    }
    return subscribeConnector((event: ConnectorPushEvent) => {
      setSnapshot(event.snapshot);
    });
  }, [refresh, subscribeConnector]);

  const view = mapConnectorSnapshotToView(snapshot);

  const run = async (action: () => Promise<ConnectorUiSnapshot>) => {
    setBusy(true);
    try {
      const next = await action();
      setSnapshot(next);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "connector_action_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connector-panel">
      <header className="connector-header">
        <h2>{view.headline}</h2>
        <p>{view.subhead}</p>
      </header>

      {error !== undefined ? <p className="connector-error">{error}</p> : null}

      {!view.enabled ? (
        <section className="card connector-card" aria-label="Connector disabled">
          {view.sections.map((section) => (
            <ConnectorSectionBlock key={section.id} section={section} />
          ))}
        </section>
      ) : (
        <>
          {view.showPairingQr && view.qrPayload !== undefined ? (
            <section className="card connector-card" aria-label="Pairing QR">
              <h3>Scan to pair</h3>
              <p className="connector-qr" data-testid="connector-qr">
                {view.qrPayload}
              </p>
              <p className="connector-muted">QR payload is shown only here — debug output below is redacted.</p>
            </section>
          ) : null}

          {view.pairingCode !== undefined ? (
            <section className="card connector-card" aria-label="Pairing code">
              <h3>Pairing code</h3>
              <p className="connector-code">{view.pairingCode}</p>
            </section>
          ) : null}

          <div className="connector-grid">
            {view.sections.map((section) => (
              <section key={section.id} className="card connector-card" aria-label={section.title}>
                <ConnectorSectionBlock section={section} />
              </section>
            ))}
          </div>

          <section className="card connector-card" aria-label="Connector actions">
            <h3>Session controls</h3>
            <p className="connector-muted">Disconnect stops the worker. Sign out ends the WhatsApp session. Clear auth removes protected credentials.</p>
            <div className="connector-actions">
              <button
                type="button"
                disabled={!view.actionsEnabled || busy}
                onClick={() => {
                  void run(() => api.startConnector({}));
                }}
              >
                Start
              </button>
              <button
                type="button"
                disabled={!view.actionsEnabled || busy}
                onClick={() => {
                  void run(() => api.stopConnector());
                }}
              >
                Disconnect
              </button>
              <button
                type="button"
                disabled={!view.actionsEnabled || busy}
                onClick={() => {
                  void run(() => api.signOutConnector());
                }}
              >
                Sign out
              </button>
              <button
                type="button"
                disabled={!view.actionsEnabled || busy}
                onClick={() => {
                  void run(() => api.clearConnectorAuth());
                }}
              >
                Clear auth
              </button>
            </div>
            <label className="connector-field">
              Phone number for pairing code
              <input
                value={phoneNumber}
                onChange={(event) => {
                  setPhoneNumber(event.target.value);
                }}
                placeholder="+1 555 010 0100"
                disabled={!view.actionsEnabled || busy}
              />
            </label>
            <button
              type="button"
              disabled={!view.actionsEnabled || busy || phoneNumber.trim().length === 0}
              onClick={() => {
                void run(() => api.requestConnectorPairingCode({ phoneNumber: phoneNumber.trim() }));
              }}
            >
              Request pairing code
            </button>
          </section>

          <details className="card connector-card">
            <summary>Debug snapshot (redacted)</summary>
            <pre className="connector-debug">{view.debugJson}</pre>
          </details>
        </>
      )}
    </div>
  );
}

function ConnectorSectionBlock({
  section,
}: {
  readonly section: ReturnType<typeof mapConnectorSnapshotToView>["sections"][number];
}) {
  return (
    <div data-emphasis={section.emphasis}>
      <h3>{section.title}</h3>
      <ul className="connector-lines">
        {section.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}