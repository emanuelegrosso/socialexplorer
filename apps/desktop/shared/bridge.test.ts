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
      "cancelArchive",
      "commitArchive",
      "confirmArchive",
      "getAppInfo",
      "getContactAnalytics",
      "getEntitlement",
      "getGlobalAnalytics",
      "getGroupAnalytics",
      "getRelations",
      "getTemporalReadModel",
      "listContactMerges",
      "listContacts",
      "listConversations",
      "listDatasets",
      "listGroups",
      "listMediaReferences",
      "listMessagesInRange",
      "mergeContacts",
      "pickArchiveFile",
      "previewArchive",
      "rebuildAnalytics",
      "unmergeContact",
    ]);
    expect(Object.values(bridge).every((v) => typeof v === "function")).toBe(true);
  });

  it("maps the Wave 4 methods onto their contract channels", async () => {
    const calls: string[] = [];
    const bridge = createBridge((channel) => {
      calls.push(channel);
      return Promise.resolve({ ok: true, value: null });
    });
    await bridge.pickArchiveFile();
    await bridge.previewArchive({ stagedId: "s" });
    await bridge.confirmArchive({ stagedId: "s", timezone: "UTC", selfNames: [] });
    await bridge.commitArchive({ stagedId: "s", resolutions: {} });
    await bridge.cancelArchive({ stagedId: "s" });
    await bridge.listContacts({ datasetId: "d" });
    await bridge.listGroups({ datasetId: "d" });
    await bridge.mergeContacts({ datasetId: "d", primaryContactId: "a", secondaryContactId: "b" });
    await bridge.unmergeContact({ datasetId: "d", secondaryContactId: "b" });
    await bridge.listContactMerges({ datasetId: "d" });
    await bridge.getGlobalAnalytics({ datasetId: "d" });
    await bridge.getContactAnalytics({ datasetId: "d", contactId: "a" });
    await bridge.getGroupAnalytics({ datasetId: "d", conversationId: "g" });
    await bridge.getRelations({ datasetId: "d" });
    await bridge.rebuildAnalytics({ datasetId: "d" });
    expect(calls).toEqual([
      "archive-import:pick-file",
      "archive-import:preview",
      "archive-import:confirm",
      "archive-import:commit",
      "archive-import:cancel",
      "contact:list",
      "group:list",
      "contact:merge",
      "contact:unmerge",
      "contact:list-merges",
      "analytics:get-global",
      "analytics:get-contact",
      "analytics:get-group",
      "analytics:get-relations",
      "analytics:rebuild",
    ]);
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
