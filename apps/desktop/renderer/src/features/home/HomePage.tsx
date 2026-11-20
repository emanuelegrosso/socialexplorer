import type { FirstRunStatus } from "@social-explorer/contracts";
import { useCallback, useEffect, useState } from "react";
import type { RendererIpcClient } from "../../ipc-client";
import type { ViewId } from "../../store";

export function HomePage(props: {
  readonly client: RendererIpcClient;
  readonly onNavigate: (view: ViewId) => void;
  readonly onDatasetReady: (datasetId: string) => void;
  readonly datasetCount: number;
}) {
  const [status, setStatus] = useState<FirstRunStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    if (!props.client.isNative) {
      setStatus({ state: "seeded", datasetId: "ds_synthetic", datasetName: "Synthetic demo" });
      return;
    }
    void props.client.api
      .getFirstRunStatus()
      .then(setStatus)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not read first-run status.");
      });
  }, [props.client.api, props.client.isNative]);

  useEffect(() => {
    refresh();
  }, [refresh, props.datasetCount]);

  const seed = (): void => {
    setBusy(true);
    setError(null);
    void props.client.api
      .seedSyntheticDemo({})
      .then((result) => {
        props.onDatasetReady(result.datasetId);
        refresh();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Demo seed failed.");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const skip = (): void => {
    setBusy(true);
    void props.client.api
      .skipFirstRun()
      .then(setStatus)
      .finally(() => {
        setBusy(false);
      });
  };

  const reset = (): void => {
    setBusy(true);
    void props.client.api
      .resetSyntheticDemo()
      .then(() => {
        refresh();
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="home-page">
      <section className="card home-hero">
        <h2>Your Story</h2>
        <p>
          Explore conversations through Temporal Interaction Flow, rediscover media in Memories, or import
          your own WhatsApp archive — all locally on this device.
        </p>
        <div className="home-actions">
          <button
            type="button"
            onClick={() => {
              props.onNavigate("discover");
            }}
          >
            Discovery
          </button>
          <button
            type="button"
            onClick={() => {
              props.onNavigate("memories");
            }}
          >
            Memories
          </button>
          <button
            type="button"
            onClick={() => {
              props.onNavigate("timeline");
            }}
          >
            Timeline
          </button>
        </div>
      </section>

      {status?.state === "pending" && props.datasetCount === 0 ? (
        <section className="card first-run" aria-label="First run">
          <h3>Try the synthetic demo</h3>
          <p>
            Load a local-only demo dataset from{" "}
            <code>fixtures/synthetic</code> (messages + media placeholders). You can reset or skip at any
            time.
          </p>
          {error !== null ? <p className="error">{error}</p> : null}
          <div className="button-row">
            <button type="button" disabled={busy} onClick={seed}>
              {busy ? "Seeding…" : "Load demo"}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={skip}>
              Skip for now
            </button>
          </div>
        </section>
      ) : null}

      {status?.state === "seeded" || props.datasetCount > 0 ? (
        <section className="card">
          <h3>Demo dataset</h3>
          <p>
            {status?.datasetName ?? "Dataset"} is ready. Synthetic media references reflect availability from
            the import — missing files stay visible with navigation to their source messages.
          </p>
          {props.client.isNative ? (
            <button type="button" className="ghost" disabled={busy} onClick={reset}>
              Reset synthetic demo
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}