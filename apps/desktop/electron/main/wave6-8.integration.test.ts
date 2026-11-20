import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createRepositories, openMemoryDatabase } from "@social-explorer/database";
import type { IpcChannel, IpcRequest, IpcResponse } from "@social-explorer/contracts";
import { ArchiveImportService } from "./import-service.js";
import { createIpcHandlers } from "./ipc-handlers.js";
import { createIpcRouter } from "./ipc-router.js";

const TRUSTED = "file:///app/renderer/index.html";
const NOW = "2026-01-15T12:00:00.000Z";

describe("Wave 6/8 memories and demo IPC", () => {
  let userData = "";

  afterEach(() => {
    if (userData !== "") {
      rmSync(userData, { recursive: true, force: true });
      userData = "";
    }
  });

  function setup() {
    userData = mkdtempSync(join(tmpdir(), "se-demo-"));
    const db = openMemoryDatabase();
    const repositories = createRepositories(db);
    const imports = new ArchiveImportService({ db, repositories, now: () => NOW });
    const router = createIpcRouter({
      isTrustedSender: (url) => url === TRUSTED,
      handlers: createIpcHandlers({
        repositories,
        db,
        appVersion: "test",
        userDataDir: userData,
        now: () => NOW,
        importService: imports,
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
    return { call, repositories };
  }

  it("seeds synthetic demo, queries catalog, bookmarks and On This Day", async () => {
    const { call } = setup();
    expect(await call("demo:get-first-run", {})).toEqual({ state: "pending" });
    const seeded = await call("demo:seed-synthetic", {});
    expect(seeded.status).toBe("seeded");
    expect(seeded.messageCount).toBeGreaterThan(0);

    const catalog = await call("media:query-catalog", { datasetId: seeded.datasetId, limit: 100 });
    expect(Array.isArray(catalog)).toBe(true);

    const day = await call("memories:on-this-day", { datasetId: seeded.datasetId, referenceAt: NOW });
    expect(day.monthDay).toBe("01-15");
    expect(day.messages.length + day.media.length).toBeGreaterThan(0);

    const target =
      catalog[0] ??
      (day.media[0] !== undefined
        ? day.media[0]
        : undefined);
    const messageTarget = day.messages[0];
    expect(messageTarget ?? target).toBeDefined();

    const bookmark = await call("annotation:toggle-bookmark", {
      datasetId: seeded.datasetId,
      targetKind: target !== undefined ? "media" : "message",
      targetId: target?.reference.id ?? messageTarget?.id ?? "missing",
      bookmarked: true,
    });
    expect(bookmark.bookmarked).toBe(true);
    const bookmarks = await call("annotation:list-bookmarks", { datasetId: seeded.datasetId });
    expect(bookmarks.length).toBeGreaterThan(0);

    const cardItem =
      target !== undefined
        ? ({ kind: "media" as const, targetId: target.reference.id })
        : ({ kind: "message" as const, targetId: messageTarget?.id ?? bookmark.targetId });
    const card = await call("memory-card:save", {
      id: "mc_test",
      datasetId: seeded.datasetId,
      title: "Trip",
      items: [cardItem],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect((await call("memory-card:list", { datasetId: seeded.datasetId }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: card.id })]),
    );
  });

  it("supports skip and reset of the first-run demo", async () => {
    const { call } = setup();
    expect(await call("demo:skip-first-run", {})).toEqual({ state: "skipped" });
    const seeded = await call("demo:seed-synthetic", {});
    expect(await call("demo:reset-synthetic", {})).toEqual({ state: "pending" });
    expect((await call("dataset:list", {})).some((dataset) => dataset.id === seeded.datasetId)).toBe(
      false,
    );
  });
});