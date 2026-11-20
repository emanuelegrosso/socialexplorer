import { describe, expect, it } from "vitest";
import { createMemoryLogSink, createLogger } from "@social-explorer/security";
import { createRepositories, openMemoryDatabase } from "@social-explorer/database";
import { createIpcHandlers } from "./ipc-handlers.js";
import { createIpcRouter } from "./ipc-router.js";

const TRUSTED = "file:///app/renderer/index.html";
const isTrustedSender = (url: string | undefined): boolean => url === TRUSTED;

function setup() {
  const repositories = createRepositories(openMemoryDatabase());
  const sink = createMemoryLogSink();
  const router = createIpcRouter({
    handlers: createIpcHandlers({ repositories, appVersion: "1.2.3" }),
    isTrustedSender,
    logger: createLogger({ sink }),
  });
  return { repositories, router, sink };
}

describe("ipc router", () => {
  it("serves validated read-only requests", async () => {
    const { router, repositories } = setup();
    repositories.datasets.upsert({
      id: "d1",
      name: "D",
      createdAt: "2026-01-01T00:00:00Z",
      timezone: "UTC",
      sourceIds: [],
    });
    expect(await router.handle("app:get-info", {}, TRUSTED)).toEqual({
      ok: true,
      value: { name: "SocialExplorer", version: "1.2.3" },
    });
    const datasets = await router.handle("dataset:list", {}, TRUSTED);
    expect(datasets).toMatchObject({ ok: true, value: [{ id: "d1" }] });
    expect(await router.handle("conversation:list", { datasetId: "d1" }, TRUSTED)).toEqual({
      ok: true,
      value: [],
    });
    expect(
      await router.handle(
        "message:list-range",
        {
          datasetId: "d1",
          conversationId: "c1",
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-02T00:00:00Z",
          limit: 10,
        },
        TRUSTED,
      ),
    ).toEqual({ ok: true, value: [] });
    expect(await router.handle("media:list-references", { datasetId: "d1" }, TRUSTED)).toEqual({
      ok: true,
      value: [],
    });
    expect(await router.handle("entitlement:get", {}, TRUSTED)).toMatchObject({
      ok: true,
      value: { tier: "Free" },
    });
  });

  it("rejects unknown channels, untrusted senders and invalid payloads", async () => {
    const { router, sink } = setup();
    expect(await router.handle("fs:read", {}, TRUSTED)).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_CHANNEL" },
    });
    expect(await router.handle(42, {}, TRUSTED)).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_CHANNEL" },
    });
    expect(await router.handle("dataset:list", {}, "https://evil.example")).toMatchObject({
      ok: false,
      error: { code: "UNTRUSTED_SENDER" },
    });
    expect(await router.handle("dataset:list", undefined, undefined)).toMatchObject({ ok: false });
    expect(await router.handle("dataset:list", { extra: 1 }, TRUSTED)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(
      await router.handle(
        "message:list-range",
        { datasetId: "d", conversationId: "c", start: "x", end: "y", limit: 5000 },
        TRUSTED,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(sink.lines.length).toBeGreaterThan(0);
  });

  it("reports unsupported channels without leaking internals", async () => {
    const { router } = setup();
    expect(
      await router.handle("temporal:get-read-model", { datasetId: "d1", preset: "7d" }, TRUSTED),
    ).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED" },
    });
    const bare = createIpcRouter({ handlers: {}, isTrustedSender });
    expect(await bare.handle("dataset:list", {}, TRUSTED)).toMatchObject({
      error: { code: "UNSUPPORTED" },
    });
  });

  it("converts handler errors and invalid responses into generic failures", async () => {
    const router = createIpcRouter({
      isTrustedSender,
      handlers: {
        "dataset:list": () => {
          throw new Error("SQLITE_CORRUPT at C:\\Users\\someone\\explorer.sqlite");
        },
        "entitlement:get": () => ({ nope: true }) as never,
      },
    });
    const failed = await router.handle("dataset:list", {}, TRUSTED);
    expect(failed).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "internal error" },
    });
    expect(await router.handle("entitlement:get", {}, TRUSTED)).toMatchObject({
      error: { code: "INVALID_RESPONSE" },
    });
  });
});
