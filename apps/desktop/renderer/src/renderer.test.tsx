import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IpcError, createBridge } from "../../shared/bridge";
import { Shell } from "./App";
import { MOCK_APP_VERSION, createIpcClient, parseResponse, resolveApi } from "./ipc-client";
import { createUiStore, snapshotUiState } from "./store";

describe("ui store", () => {
  it("holds only serializable state and updates immutably", () => {
    const store = createUiStore();
    expect(store.getState().activeView).toBe("home");
    store.getState().setActiveView("analytics");
    store.getState().toggleSidebar();
    store.getState().setActiveDataset("ds-1");
    const snapshot = snapshotUiState(store.getState());
    expect(snapshot).toEqual({
      activeView: "analytics",
      sidebarCollapsed: true,
      activeDatasetId: "ds-1",
      pendingFocusMessageId: null,
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("ipc client", () => {
  it("exposes first-run demo status in preview mode", async () => {
    const client = createIpcClient({});
    await expect(client.api.getFirstRunStatus()).resolves.toMatchObject({
      state: "seeded",
      datasetName: "Synthetic demo",
    });
  });

  it("falls back to a headless mock without the preload bridge", async () => {
    const client = createIpcClient({});
    expect(client.isNative).toBe(false);
    expect(await client.getAppInfo()).toEqual({
      name: "SocialExplorer",
      version: MOCK_APP_VERSION,
    });
    const datasets = await client.listDatasets();
    expect(datasets).toHaveLength(1);
    expect((await client.getEntitlement()).tier).toBe("Free");
    await expect(
      client.api.getTemporalReadModel({ datasetId: datasets[0]?.id ?? "x", preset: "7d" }),
    ).resolves.toMatchObject({ datasetId: datasets[0]?.id });
    await expect(client.api.getTemporalReadModel({ datasetId: "missing", preset: "7d" })).rejects.toBeInstanceOf(
      IpcError,
    );
  });

  it("uses the native bridge when present and re-validates its responses", async () => {
    const bridge = createBridge((channel) =>
      Promise.resolve({
        ok: true,
        value:
          channel === "app:get-info"
            ? { name: "SocialExplorer", version: "9.9.9" }
            : { bogus: true },
      }),
    );
    expect(resolveApi({ socialExplorer: bridge }).isNative).toBe(true);
    const client = createIpcClient({ socialExplorer: bridge });
    expect(await client.getAppInfo()).toEqual({ name: "SocialExplorer", version: "9.9.9" });
    await expect(client.listDatasets()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(() => parseResponse("dataset:list", "x")).toThrow(IpcError);
  });
});

describe("shell", () => {
  it("renders navigation and dataset chrome without a DOM", () => {
    const client = createIpcClient({});
    const html = renderToString(
      <Shell
        status={{ version: "1.0.0", datasetCount: 1, native: false }}
        client={client}
        datasets={[]}
        onDatasetsChange={() => undefined}
      />,
    );
    for (const label of ["Home", "Memories", "Timeline", "Archive Import"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-current="page"');
    expect(
      renderToString(
        <Shell status={null} client={client} datasets={[]} onDatasetsChange={() => undefined} />,
      ),
    ).toContain("Home");
  });
});