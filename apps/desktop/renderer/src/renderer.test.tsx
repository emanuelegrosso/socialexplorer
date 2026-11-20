import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IpcError, createBridge } from "../../shared/bridge";
import { Shell } from "./App";
import { MOCK_APP_VERSION, createIpcClient, parseResponse, resolveApi } from "./ipc-client";
import { createUiStore, snapshotUiState } from "./store";

describe("ui store", () => {
  it("holds only serializable state and updates immutably", () => {
    const store = createUiStore();
    expect(store.getState().activeView).toBe("discover");
    store.getState().setActiveView("memories");
    store.getState().toggleSidebar();
    store.getState().setActiveDataset("ds-1");
    const snapshot = snapshotUiState(store.getState());
    expect(snapshot).toEqual({
      activeView: "memories",
      sidebarCollapsed: true,
      activeDatasetId: "ds-1",
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("ipc client", () => {
  it("falls back to a headless mock without the preload bridge", async () => {
    const client = createIpcClient({});
    expect(client.isNative).toBe(false);
    expect(await client.getAppInfo()).toEqual({
      name: "SocialExplorer",
      version: MOCK_APP_VERSION,
    });
    expect(await client.listDatasets()).toEqual([]);
    expect((await client.getEntitlement()).tier).toBe("Free");
    await expect(
      client.api.getTemporalReadModel({ datasetId: "d", preset: "7d" }),
    ).rejects.toBeInstanceOf(IpcError);
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
  it("renders navigation and status without a DOM", () => {
    const html = renderToString(
      <Shell status={{ version: "1.0.0", datasetCount: 2, native: false }} />,
    );
    for (const label of [
      "Discover",
      "Memories",
      "Movie Studio",
      "Import",
      "Settings",
      "1.0.0",
      "Preview",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-current="page"');
    expect(renderToString(<Shell status={null} />)).toContain("Connecting");
  });
});
