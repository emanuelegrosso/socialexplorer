import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConnectorConfig } from "./config.js";
import { InMemoryIngestionSink } from "./memory-sink.js";
import { ConnectorSupervisor, type SupervisorEvent, type SupervisorStatus } from "./supervisor.js";

const entry = join(import.meta.dirname, "..", "test-fixtures", "fake-child.mjs");
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
});

function make(mode: string, overrides: Record<string, unknown> = {}, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "se-supervisor-"));
  cleanup.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const sink = new InMemoryIngestionSink();
  const config = parseConnectorConfig({
    connectorEnabled: enabled,
    supervisor: {
      heartbeatIntervalMs: 40,
      heartbeatTimeoutMs: 250,
      readyTimeoutMs: 3_000,
      restartBaseMs: 20,
      restartMaxMs: 60,
      maxRestarts: 3,
      shutdownGraceMs: 400,
      ...overrides,
    },
  });
  const supervisor = new ConnectorSupervisor({
    config,
    entry,
    datasetId: "ds_synthetic",
    authDirectory: join(dir, "auth"),
    sink,
    env: { ...process.env, FAKE_MODE: mode, FAKE_MARKER: join(dir, "marker") },
  });
  cleanup.push(() => supervisor.stop());
  const events: SupervisorEvent[] = [];
  const statuses: SupervisorStatus[] = [];
  supervisor.onEvent((event) => {
    events.push(event);
    if (event.type === "state" && statuses.at(-1) !== event.state.status) {
      statuses.push(event.state.status);
    }
  });
  return { supervisor, sink, events, statuses };
}

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timeout waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ConnectorSupervisor", () => {
  it("never forks when the connector is disabled (default)", () => {
    const { supervisor, statuses } = make("healthy", {}, false);
    expect(supervisor.state.status).toBe("disabled");
    supervisor.start();
    expect(supervisor.state.status).toBe("disabled");
    expect(statuses).toEqual(["disabled"]);
  });

  it("starts, reports connector state, and shuts down gracefully", async () => {
    const { supervisor, events } = make("healthy");
    supervisor.start();
    await until(() => supervisor.state.connector?.phase === "open");
    expect(supervisor.state.status).toBe("running");
    expect(events.some((event) => event.type === "state")).toBe(true);
    await supervisor.stop();
    expect(supervisor.state.status).toBe("stopped");
    expect(supervisor.state.lastExit?.code).toBe(0);
  });

  it("applies valid ingest batches to the sink and acks them", async () => {
    const { supervisor, sink } = make("ingest");
    supervisor.start();
    await until(() => supervisor.state.connector?.lastLiveEventAtMs === 1);
    expect(sink.batches).toBe(1);
    expect(sink.checkpoints.get("ds_synthetic")?.recentMessageIds).toEqual(["msg_a"]);
  });

  it("detects a crash, emits typed failure + recovery state, and recovers without touching data", async () => {
    const { supervisor, statuses, sink } = make("crash-once");
    supervisor.start();
    await until(() => statuses.includes("crashed") && supervisor.state.status === "running" && supervisor.state.restartCount === 1);
    expect(statuses).toContain("crashed");
    expect(statuses).toContain("restarting");
    expect(supervisor.state.lastFailure).toBe("crash");
    expect(supervisor.state.lastExit?.code).toBe(1);
    expect(sink.batches).toBe(0);
    expect(sink.messages.size).toBe(0);
  });

  it("bounds restarts and ends in failed instead of looping forever", async () => {
    const { supervisor, statuses } = make("crash-always");
    supervisor.start();
    await until(() => supervisor.state.status === "failed");
    expect(statuses.filter((status) => status === "crashed").length).toBeGreaterThanOrEqual(3);
    expect(supervisor.state.restartCount).toBe(3);
  });

  it("kills a child that stops sending heartbeats and recovers state as heartbeat-timeout", async () => {
    const { supervisor, statuses } = make("hang", { maxRestarts: 1 });
    supervisor.start();
    await until(() => statuses.includes("unresponsive"));
    await until(() => supervisor.state.status === "failed" || supervisor.state.status === "restarting");
    expect(supervisor.state.lastFailure).toBe("heartbeat-timeout");
  });

  it("treats unknown/generic messages from the child as a protocol violation", async () => {
    const { supervisor } = make("garbage", { maxRestarts: 1 });
    supervisor.start();
    await until(() => supervisor.state.lastFailure === "protocol-violation");
    expect(["unresponsive", "crashed", "restarting", "failed"]).toContain(supervisor.state.status);
  });

  it("a crash with an invalid half-written batch leaves the sink untouched", async () => {
    const { supervisor, sink } = make("invalid-batch-crash", { maxRestarts: 1 });
    supervisor.start();
    await until(() => supervisor.state.lastFailure !== undefined);
    expect(supervisor.state.lastFailure === "protocol-violation" || supervisor.state.lastFailure === "crash").toBe(true);
    expect(sink.batches).toBe(0);
  });

  it("does not forward QR payloads into supervisor state", async () => {
    const { supervisor, events } = make("crash-after-qr");
    supervisor.start();
    await until(() => events.some((event) => event.type === "qr"));
    expect(JSON.stringify(supervisor.state)).not.toContain("synthetic-qr-payload");
  });

  it("force-kills a child that ignores shutdown after the grace period", async () => {
    const { supervisor } = make("ignore-shutdown");
    supervisor.start();
    await until(() => supervisor.state.status === "running");
    await supervisor.stop();
    expect(supervisor.state.status).toBe("stopped");
    expect(supervisor.state.lastExit?.signal).toBe("SIGKILL");
  });

  it("rejects commands outside the typed union before sending", async () => {
    const { supervisor } = make("healthy");
    supervisor.start();
    await until(() => supervisor.state.status === "running");
    expect(supervisor.sendCommand({ type: "exec", cmd: "ls" } as never)).toBe(false);
    expect(supervisor.sendCommand({ type: "ping", nonce: "ok" })).toBe(true);
  });
});
