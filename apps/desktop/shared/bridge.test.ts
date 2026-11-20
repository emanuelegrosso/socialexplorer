import { describe, expect, it } from "vitest";
import { createBridge, IpcError } from "./bridge.js";

describe("bridge", () => {
  it("maps each method to exactly one contract channel and unwraps envelopes", async () => {
    const calls: [string, unknown][] = [];
    const bridge = createBridge((channel, request) => {
      calls.push([channel, request]);
      return Promise.resolve({ ok: true, value: [] });
    });
    await bridge.listDatasets();
    await bridge.listConversations({ datasetId: "d" });
    await bridge.getEntitlement();
    await bridge.listMediaReferences({ datasetId: "d" });
    expect(calls.map(([c]) => c)).toEqual([
      "dataset:list",
      "conversation:list",
      "entitlement:get",
      "media:list-references",
    ]);
    expect(calls[1]?.[1]).toEqual({ datasetId: "d" });
  });

  it("exposes only function members (no raw invoke, no node handles)", () => {
    const bridge = createBridge(() => Promise.resolve({ ok: true, value: null }));
    expect(Object.keys(bridge).sort()).toEqual([
      "clearConnectorAuth",
      "getAppInfo",
      "getConnectorSnapshot",
      "getEntitlement",
      "getTemporalReadModel",
      "listConversations",
      "listDatasets",
      "listMediaReferences",
      "listMessagesInRange",
      "requestConnectorPairingCode",
      "signOutConnector",
      "startConnector",
      "stopConnector",
      "subscribeConnector",
    ]);
    expect(Object.values(bridge).every((v) => typeof v === "function")).toBe(true);
  });

  it("throws typed errors for failures and malformed envelopes", async () => {
    const failing = createBridge(() =>
      Promise.resolve({ ok: false, error: { code: "UNSUPPORTED", message: "later" } }),
    );
    await expect(failing.getAppInfo()).rejects.toMatchObject({
      name: "IpcError",
      code: "UNSUPPORTED",
    });
    const malformed = createBridge(() => Promise.resolve("oops"));
    await expect(malformed.getAppInfo()).rejects.toBeInstanceOf(IpcError);
  });
});
