import { MockSocketPort } from "@social-explorer/baileys-adapter";
import { describe, expect, it } from "vitest";
import { parseConnectorConfig } from "./config.js";
import { ProtectedAuthState } from "./protected-auth-state.js";
import { newAuthStore } from "./test-helpers.js";
import { runConnectorWorker, type WorkerChannel } from "./worker.js";
import type { ConnectorEvent } from "./protocol.js";

function setup(enabled = true) {
  const sent: ConnectorEvent[] = [];
  let handler: ((raw: unknown) => void) | undefined;
  let exitCode: number | undefined;
  const ports: MockSocketPort[] = [];
  const { store } = newAuthStore();
  const channel: WorkerChannel = {
    send: (event) => sent.push(event),
    onMessage: (h) => {
      handler = h;
    },
    exit: (code) => {
      exitCode = code;
    },
  };
  const worker = runConnectorWorker({
    channel,
    config: parseConnectorConfig({ connectorEnabled: enabled }),
    pid: 4242,
    openAuth: () => ProtectedAuthState.open(store, () => ({})),
    createPort: () => {
      const port = new MockSocketPort();
      ports.push(port);
      return port;
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
  });
  return { sent, ports, worker, send: (raw: unknown) => handler?.(raw), exit: () => exitCode };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("connector worker", () => {
  it("announces readiness with a heartbeat and answers pings", async () => {
    const { sent, send } = setup();
    expect(sent.map((event) => event.type)).toEqual(["heartbeat", "ready"]);
    send({ type: "ping", nonce: "n1" });
    await tick();
    expect(sent.at(-1)).toEqual({ type: "pong", nonce: "n1" });
  });

  it("rejects invalid or generic commands without executing anything", async () => {
    const { sent, send, ports } = setup();
    send({ type: "exec", command: "whoami" });
    send({ type: "logout" });
    await tick();
    const errors = sent.filter((event) => event.type === "error");
    expect(errors).toHaveLength(2);
    expect(ports).toHaveLength(0);
  });

  it("refuses to start when the connector is disabled", async () => {
    const { sent, send, ports } = setup(false);
    send({ type: "start", datasetId: "ds_synthetic", timezone: "UTC" });
    await tick();
    expect(sent.find((event) => event.type === "error")).toMatchObject({ code: "disabled" });
    expect(ports).toHaveLength(0);
  });

  it("starts the engine, forwards live batches over IPC and waits for the host ack", async () => {
    const { sent, send, ports } = setup();
    send({ type: "start", datasetId: "ds_synthetic", timezone: "UTC" });
    await tick();
    ports[0]!.emit({ name: "connection.update", data: { connection: "open" } });
    ports[0]!.emit({
      name: "messages.upsert",
      data: {
        type: "notify",
        messages: [
          {
            key: { remoteJid: "15551000001@s.whatsapp.net", id: "SYNTH-W-1", fromMe: false },
            timestampMs: 1768468800000,
            kind: "text",
            text: "worker message",
            hasAttachment: false,
          },
        ],
      },
    });
    await tick();
    const ingest = sent.find((event) => event.type === "ingest");
    expect(ingest).toBeDefined();
    if (ingest?.type === "ingest") {
      expect(ingest.batch.messages).toHaveLength(1);
      send({ type: "ingest-ack", seq: ingest.seq, ok: true });
    }
    await tick();
    expect(sent.filter((event) => event.type === "state").length).toBeGreaterThan(1);
  });

  it("shuts down gracefully", async () => {
    const { send, exit, ports } = setup();
    send({ type: "start", datasetId: "ds_synthetic", timezone: "UTC" });
    await tick();
    send({ type: "shutdown" });
    await tick();
    expect(exit()).toBe(0);
    expect(ports[0]!.closed).toBe(true);
  });
});
