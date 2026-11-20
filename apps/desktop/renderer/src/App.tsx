import { useEffect, useState, type ReactNode } from "react";
import { ConnectorPanel } from "./features/connector/ConnectorPanel";
import type { RendererIpcClient } from "./ipc-client";
import { VIEW_IDS, useUiStore, type ViewId } from "./store";

export const VIEW_LABELS: Record<ViewId, { title: string; blurb: string }> = {
  discover: { title: "Discover", blurb: "Temporal Interaction Flow arrives in Wave 4." },
  memories: { title: "Memories", blurb: "Search, bookmarks and media timeline arrive in Wave 5." },
  "movie-studio": { title: "Movie Studio", blurb: "Guided movie composer arrives in Wave 6." },
  import: { title: "Import", blurb: "WhatsApp archive import arrives in Wave 3 integration." },
  settings: { title: "Settings", blurb: "Privacy, storage and connector controls." },
};

export interface ShellStatus {
  readonly version: string;
  readonly datasetCount: number;
  readonly native: boolean;
}

export function Shell({
  status,
  children,
}: {
  readonly status: ShellStatus | null;
  readonly children?: ReactNode;
}) {
  const activeView = useUiStore((state) => state.activeView);
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const view = VIEW_LABELS[activeView];

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
        <header>
          <h1>{view.title}</h1>
          <p>{view.blurb}</p>
        </header>
        {children ?? (
          <section className="card" aria-label="Status">
            {status === null ? (
              <p>Connecting to local services...</p>
            ) : (
              <dl>
                <dt>Version</dt>
                <dd>{status.version}</dd>
                <dt>Datasets</dt>
                <dd>{status.datasetCount}</dd>
                <dt>Runtime</dt>
                <dd>{status.native ? "Desktop" : "Preview (no desktop bridge)"}</dd>
              </dl>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export function App({ client }: { readonly client: RendererIpcClient }) {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const activeView = useUiStore((state) => state.activeView);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.getAppInfo(), client.listDatasets()]).then(([info, datasets]) => {
      if (!cancelled) {
        setStatus({
          version: info.version,
          datasetCount: datasets.length,
          native: client.isNative,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client]);
  return (
    <Shell status={status}>
      {activeView === "settings" ? (
        <ConnectorPanel
          api={client.api}
          subscribeConnector={(listener) => client.api.subscribeConnector(listener)}
        />
      ) : null}
    </Shell>
  );
}
