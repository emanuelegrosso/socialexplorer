import { useCallback, useEffect, useState } from "react";
import { AnalyticsPage } from "./features/analytics/AnalyticsPage";
import { DiscoveryPage } from "./features/discovery/DiscoveryPage";
import { HomePage } from "./features/home/HomePage";
import { ImportPage } from "./features/import/ImportPage";
import { MemoriesPage } from "./features/memories/MemoriesPage";
import { MovieStudioPage } from "./features/movie-studio/MovieStudioPage";
import { readResumableImport } from "./features/import/resumable";
import { TemporalPage } from "./features/temporal/TemporalPage";
import type { RendererIpcClient } from "./ipc-client";
import { VIEW_IDS, useUiStore, type ViewId } from "./store";
import type { Dataset } from "@social-explorer/contracts";

export const VIEW_LABELS: Record<ViewId, { title: string; blurb: string }> = {
  home: {
    title: "Home",
    blurb: "Your Story — Discovery and Memories on one dataset.",
  },
  discover: {
    title: "Discovery",
    blurb: "Activity, peaks, and top conversations before diving into Timeline.",
  },
  memories: {
    title: "Memories",
    blurb: "Gallery, On This Day, bookmarks, and memory cards.",
  },
  timeline: {
    title: "Timeline",
    blurb: "Temporal Interaction Flow — past at the top, present at the bottom.",
  },
  analytics: { title: "Analytics", blurb: "Dataset metrics aligned with the analytics read model." },
  "movie-studio": { title: "Movie Studio", blurb: "Guided movie composer arrives in Wave 9." },
  import: { title: "Archive Import", blurb: "WhatsApp archive import with preview, merge review and commit." },
};

export interface ShellStatus {
  readonly version: string;
  readonly datasetCount: number;
  readonly native: boolean;
}

export function Shell({
  status,
  client,
  datasets,
  onDatasetsChange,
}: {
  readonly status: ShellStatus | null;
  readonly client: RendererIpcClient;
  readonly datasets: readonly Dataset[];
  readonly onDatasetsChange: () => void;
}) {
  const activeView = useUiStore((state) => state.activeView);
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const activeDatasetId = useUiStore((state) => state.activeDatasetId);
  const pendingFocusMessageId = useUiStore((state) => state.pendingFocusMessageId);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const setActiveDataset = useUiStore((state) => state.setActiveDataset);
  const setPendingFocusMessageId = useUiStore((state) => state.setPendingFocusMessageId);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const view = VIEW_LABELS[activeView];
  const resumable = readResumableImport();
  const activeDataset =
    datasets.find((dataset) => dataset.id === activeDatasetId) ?? datasets[0] ?? undefined;

  const navigate = (id: ViewId, messageId?: string): void => {
    if (messageId !== undefined) {
      setPendingFocusMessageId(messageId);
    }
    setActiveView(id);
  };


  useEffect(() => {
    if (activeDatasetId === null && datasets[0] !== undefined) {
      setActiveDataset(datasets[0].id);
    }
  }, [activeDatasetId, datasets, setActiveDataset]);

  return (
    <div className="shell" data-collapsed={collapsed}>
      <nav className="sidebar" aria-label="Primary">
        <div className="brand">{collapsed ? "SE" : "SocialExplorer"}</div>
        <ul>
          {VIEW_IDS.map((id) => (
            <li key={id}>
              <button
                type="button"
                aria-current={id === activeView ? "page" : undefined}
                onClick={() => {
                  setActiveView(id);
                }}
              >
                {VIEW_LABELS[id].title}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="ghost" onClick={toggleSidebar}>
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </nav>
      <main className="content">
        {resumable !== undefined ? (
          <div className="banner resumable-banner" role="status">
            Interrupted import for <strong>{resumable.datasetName}</strong> — resume from Import (chunk{" "}
            {resumable.resumedFromChunk}/{resumable.totalChunks}).
          </div>
        ) : null}
        <header className="content-head">
          <div>
            <h1>{view.title}</h1>
            <p>{view.blurb}</p>
          </div>
          {datasets.length > 0 ? (
            <label className="dataset-picker">
              Dataset
              <select
                value={activeDataset?.id ?? ""}
                onChange={(event) => {
                  setActiveDataset(event.target.value === "" ? null : event.target.value);
                }}
              >
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </header>
        {activeView === "home" ? (
          <HomePage
            client={client}
            datasetCount={datasets.length}
            onNavigate={navigate}
            onDatasetReady={(datasetId) => {
              setActiveDataset(datasetId);
              onDatasetsChange();
            }}
          />
        ) : activeDataset === undefined ? (
          <section className="card">
            <p>Import a synthetic or real WhatsApp archive, or load the demo from Home.</p>
            <button
              type="button"
              onClick={() => {
                setActiveView("home");
              }}
            >
              Go to Home
            </button>
            {status !== null ? (
              <dl>
                <dt>Version</dt>
                <dd>{status.version}</dd>
                <dt>Runtime</dt>
                <dd>{status.native ? "Desktop" : "Preview (demo read model)"}</dd>
              </dl>
            ) : null}
          </section>
        ) : activeView === "discover" ? (
          <DiscoveryPage
            client={client}
            datasetId={activeDataset.id}
            timezone={activeDataset.timezone}
            onNavigate={navigate}
            {...(activeDataset.coverageStart === undefined
              ? {}
              : { coverageStart: activeDataset.coverageStart })}
            {...(activeDataset.coverageEnd === undefined ? {} : { coverageEnd: activeDataset.coverageEnd })}
          />
        ) : activeView === "memories" ? (
          <MemoriesPage client={client} datasetId={activeDataset.id} onNavigate={navigate} />
        ) : activeView === "timeline" ? (
          <TemporalPage
            client={client}
            datasetId={activeDataset.id}
            timezone={activeDataset.timezone}
            {...(pendingFocusMessageId === null ? {} : { focusMessageId: pendingFocusMessageId })}
            {...(activeDataset.coverageStart === undefined
              ? {}
              : { coverageStart: activeDataset.coverageStart })}
            {...(activeDataset.coverageEnd === undefined ? {} : { coverageEnd: activeDataset.coverageEnd })}
          />
        ) : activeView === "analytics" ? (
          <AnalyticsPage
            client={client}
            datasetId={activeDataset.id}
            timezone={activeDataset.timezone}
            {...(activeDataset.coverageStart === undefined
              ? {}
              : { coverageStart: activeDataset.coverageStart })}
            {...(activeDataset.coverageEnd === undefined ? {} : { coverageEnd: activeDataset.coverageEnd })}
          />
        ) : activeView === "import" ? (
          <ImportPage client={client} />
        ) : (
          <MovieStudioPage />
        )}
      </main>
    </div>
  );
}

export function App({ client }: { readonly client: RendererIpcClient }) {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const refreshDatasets = useCallback((): void => {
    void client.listDatasets().then(setDatasets);
  }, [client]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.getAppInfo(), client.listDatasets()]).then(([info, listed]) => {
      if (!cancelled) {
        setStatus({
          version: info.version,
          datasetCount: listed.length,
          native: client.isNative,
        });
        setDatasets(listed);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client]);
  return (
    <Shell status={status} client={client} datasets={datasets} onDatasetsChange={refreshDatasets} />
  );
}