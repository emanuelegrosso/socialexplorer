import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepositories, openMemoryDatabase } from "@social-explorer/database";
import type { IpcChannel, IpcRequest, IpcResponse } from "@social-explorer/contracts";
import { createIpcHandlers } from "./ipc-handlers.js";
import { createIpcRouter } from "./ipc-router.js";

const TRUSTED = "file:///app/renderer/index.html";
const FIXTURES = resolve(import.meta.dirname, "../../../../fixtures/synthetic");

function setup() {
  const db = openMemoryDatabase();
  const repositories = createRepositories(db);
  const queue: { name: string; data: Uint8Array }[] = [];
  const router = createIpcRouter({
    isTrustedSender: (url) => url === TRUSTED,
    handlers: createIpcHandlers({
      repositories,
      db,
      appVersion: "test",
      now: () => "2026-02-01T12:00:00.000Z",
      pickArchiveFile: () => Promise.resolve(queue.shift()),
    }),
  });
  async function call<C extends IpcChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    const result = (await router.handle(channel, request, TRUSTED)) as
      | { ok: true; value: IpcResponse<C> }
      | { ok: false; error: { code: string; message: string } };
    if (!result.ok) {
      throw new Error(`${channel}: ${result.error.code} ${result.error.message}`);
    }
    return result.value;
  }
  const enqueue = (file: string): void => {
    queue.push({ name: file, data: readFileSync(resolve(FIXTURES, file)) });
  };
  return { call, enqueue, router };
}

async function importFile(
  ctx: ReturnType<typeof setup>,
  file: string,
  selfName: string,
  datasetId?: string,
) {
  ctx.enqueue(file);
  const picked = await ctx.call("archive-import:pick-file", {});
  expect(picked.canceled).toBe(false);
  const stagedId = picked.stagedId as string;
  const preview = await ctx.call("archive-import:preview", { stagedId });
  expect(preview.conversationCount).toBeGreaterThan(0);
  const confirmed = await ctx.call("archive-import:confirm", {
    stagedId,
    timezone: "Europe/Rome",
    selfNames: [selfName],
    ...(datasetId === undefined ? { datasetName: "Synthetic" } : { datasetId }),
  });
  const committed = await ctx.call("archive-import:commit", { stagedId, resolutions: {} });
  return { confirmed, committed };
}

describe("Wave 4 IPC flow over synthetic fixtures", () => {
  it("imports, dedups, analyses and projects a temporal read model", async () => {
    const ctx = setup();
    const first = await importFile(ctx, "exports/android-private.txt", "Alice Example");
    expect(first.committed.status).toBe("committed");
    const datasetId = first.confirmed.datasetId;
    expect(first.committed.persisted.messagesInserted).toBeGreaterThan(0);

    const again = await importFile(ctx, "zips/android-private-with-media.zip", "Alice Example", datasetId);
    expect(again.committed.status).toBe("committed");

    const datasets = await ctx.call("dataset:list", {});
    expect(datasets).toHaveLength(1);

    const global = await ctx.call("analytics:get-global", { datasetId });
    expect(global.totalMessages).toBeGreaterThan(0);

    const contacts = await ctx.call("contact:list", { datasetId });
    expect(contacts.length).toBeGreaterThanOrEqual(2);

    const model = await ctx.call("temporal:get-read-model", {
      datasetId,
      preset: "custom",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-03-01T00:00:00.000Z",
    });
    expect(model.datasetId).toBe(datasetId);
    expect(model.lanes.length).toBeGreaterThan(0);
    expect(model.events.length).toBeGreaterThan(0);
    expect(model.range.timezone).toBe("Europe/Rome");
  });

  it("merges and unmerges contacts reversibly through IPC", async () => {
    const ctx = setup();
    const first = await importFile(ctx, "exports/android-private.txt", "Alice Example");
    const datasetId = first.confirmed.datasetId;
    await importFile(ctx, "exports/android-group.txt", "Alice Example", datasetId);
    const before = await ctx.call("analytics:get-global", { datasetId });
    const contacts = await ctx.call("contact:list", { datasetId });
    const others = contacts.filter((c) => !c.isSelf);
    expect(others.length).toBeGreaterThanOrEqual(2);
    const primary = others[0]?.id as string;
    const secondary = others[1]?.id as string;
    expect(primary).not.toBe(secondary);

    await ctx.call("contact:merge", {
      datasetId,
      primaryContactId: primary,
      secondaryContactId: secondary,
    });
    expect(await ctx.call("contact:list-merges", { datasetId })).toHaveLength(1);
    const merged = await ctx.call("contact:list", { datasetId });
    expect(merged).toHaveLength(contacts.length - 1);

    await ctx.call("contact:unmerge", { datasetId, secondaryContactId: secondary });
    expect(await ctx.call("contact:list", { datasetId })).toHaveLength(contacts.length);
    const after = await ctx.call("analytics:get-global", { datasetId });
    expect(after.totalMessages).toBe(before.totalMessages);
  });

  it("rejects bad merges, unknown datasets and invalid ranges without internals", async () => {
    const ctx = setup();
    const first = await importFile(ctx, "exports/android-group.txt", "Alice Example");
    const datasetId = first.confirmed.datasetId;
    const same = await ctx.router.handle(
      "contact:merge",
      { datasetId, primaryContactId: "x", secondaryContactId: "x" },
      TRUSTED,
    );
    expect(same).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const missing = await ctx.router.handle(
      "temporal:get-read-model",
      { datasetId: "nope", preset: "7d" },
      TRUSTED,
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const groups = await ctx.call("group:list", { datasetId });
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]?.messageCount).toBeGreaterThan(0);
  });

  it("reports a canceled pick without a staged id", async () => {
    const ctx = setup();
    expect(await ctx.call("archive-import:pick-file", {})).toEqual({ canceled: true });
  });
});
