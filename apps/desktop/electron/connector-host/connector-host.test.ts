import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorHost, resolveConnectorFeatureFlag } from "./connector-host.js";

const fakeChild = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "connector-core", "test-fixtures", "fake-child.mjs");
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    fn();
  }
});

describe("resolveConnectorFeatureFlag", () => {
  it("defaults to disabled", () => {
    expect(resolveConnectorFeatureFlag({})).toBe(false);
    expect(resolveConnectorFeatureFlag({ ENABLE_BAILEYS_CONNECTOR: "false" })).toBe(false);
    expect(resolveConnectorFeatureFlag({ ENABLE_BAILEYS_CONNECTOR: "true" })).toBe(true);
  });
});

describe("createConnectorHost", () => {
  it("reports disabled without forking", () => {
    const dir = mkdtempSync(join(tmpdir(), "se-connector-host-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const pushed: unknown[] = [];
    const host = createConnectorHost({
      authDirectory: join(dir, "auth"),
      logger: { debug() {}, info() {}, warn() {}, error() {}, close: async () => {} },
      onPush: (snapshot) => {
        pushed.push(snapshot);
      },
      workerEntry: fakeChild,
      env: { FAKE_MODE: "healthy" },
    });
    const snapshot = host.snapshot();
    expect(snapshot.connectorEnabled).toBe(false);
    expect(snapshot.supervisor.status).toBe("disabled");
    host.start();
    expect(host.snapshot().supervisor.status).toBe("disabled");
    expect(pushed).toHaveLength(0);
  });

  it("starts when the feature flag is on and emits push snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "se-connector-host-"));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const pushed: unknown[] = [];
    const host = createConnectorHost({
      authDirectory: join(dir, "auth"),
      logger: { debug() {}, info() {}, warn() {}, error() {}, close: async () => {} },
      onPush: (snapshot) => {
        pushed.push(snapshot);
      },
      workerEntry: fakeChild,
      env: { ENABLE_BAILEYS_CONNECTOR: "true", FAKE_MODE: "healthy" },
    });
    expect(host.snapshot().connectorEnabled).toBe(true);
    host.start("ds_test");
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const phase = host.snapshot().connector?.phase;
      if (phase === "open") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(host.snapshot().connector?.phase).toBe("open");
    expect(pushed.length).toBeGreaterThan(0);
    await host.shutdown();
  });
});