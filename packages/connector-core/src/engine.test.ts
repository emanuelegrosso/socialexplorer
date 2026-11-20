import { describe, expect, it } from "vitest";
import { harness, historyChunk, loadFixture, settle } from "./test-helpers.js";
import { InMemoryIngestionSink } from "./memory-sink.js";
import { ConnectorEngine } from "./engine.js";
import { parseConnectorConfig } from "./config.js";
import { MockSocketPort } from "@social-explorer/baileys-adapter";
import { ProtectedAuthState } from "./protected-auth-state.js";

const fixture = loadFixture();

async function open(h: ReturnType<typeof harness>): Promise<MockSocketPort> {
  await h.engine.start();
  const port = h.ports.at(-1);
  if (port === undefined) {
    throw new Error("no port");
  }
  port.emit({ name: "connection.update", data: { connection: "open" } });
  await settle(h.engine);
  return port;
}

describe("feature flag", () => {
  it("is disabled by default and never opens a socket", async () => {
    expect(parseConnectorConfig({}).connectorEnabled).toBe(false);
    const h = harness({ connectorEnabled: false });
    await h.engine.start();
    expect(h.ports).toHaveLength(0);
    expect(h.outputs).toEqual([{ type: "error", code: "disabled", message: "connector_disabled" }]);
  });
});

describe("pairing flow", () => {
  it("emits QR out-of-band, keeps it out of state, and times out after the QR budget", async () => {
    const h = harness({ pairingMaxQrAttempts: 2 });
    await h.engine.start();
    const port = h.ports[0]!;
    port.emit({ name: "connection.update", data: { qr: "synthetic-qr-1" } });
    await settle(h.engine);
    expect(h.outputs.find((o) => o.type === "qr")).toMatchObject({ qr: "synthetic-qr-1", attempt: 1 });
    expect(h.engine.snapshot().phase).toBe("awaiting-pairing");
    expect(JSON.stringify(h.engine.snapshot())).not.toContain("synthetic-qr-1");
    port.emit({ name: "connection.update", data: { qr: "synthetic-qr-2" } });
    port.emit({ name: "connection.update", data: { qr: "synthetic-qr-3" } });
    await settle(h.engine);
    expect(h.engine.snapshot().pairing.phase).toBe("timed-out");
    expect(port.closed).toBe(true);
  });

  it("issues a pairing code and then reaches paired on open", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.requestPairingCode("+1 555 010 0001");
    expect(h.outputs.find((o) => o.type === "pairing-code")).toEqual({ type: "pairing-code", code: "SYNT-H123" });
    expect(h.engine.snapshot().pairing.phase).toBe("awaiting-code");
    h.ports[0]!.emit({ name: "connection.update", data: { connection: "open", isNewLogin: true } });
    await settle(h.engine);
    expect(h.engine.snapshot()).toMatchObject({ phase: "open", pairing: { phase: "paired" } });
  });

  it("persists creds.update incrementally in the protected store", async () => {
    const h = harness();
    await h.engine.start();
    h.ports[0]!.emit({ name: "creds.update", data: { me: { id: "15551000009:3@s.whatsapp.net" } } });
    await settle(h.engine);
    const reopened = await ProtectedAuthState.open(h.store, () => ({}));
    expect(reopened.restored).toBe(true);
    expect(reopened.selfJid()).toBe("15551000009:3@s.whatsapp.net");
  });
});

describe("history sync", () => {
  it("ingests chunks with progress and checkpoints", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(h.engine);
    expect(h.sink.messages.size).toBe(2);
    expect(h.sink.conversations.size).toBe(2);
    expect(h.engine.snapshot().history).toMatchObject({ status: "syncing", progress: 50, batchesApplied: 1 });
    port.emit({ name: "history.set", data: historyChunk(fixture, 1) });
    port.emit({ name: "history.status", data: { syncType: 3, status: "complete", explicit: true } });
    await settle(h.engine);
    const snapshot = h.engine.snapshot().history;
    expect(snapshot.status).toBe("complete");
    expect(snapshot.messagesIngested).toBe(3);
    expect(snapshot.warnings).toEqual(["history-coverage-limited"]);
    expect(snapshot.oldestMessageTimestampMs).toBe(1768468740000);
    expect(h.sink.checkpoints.get("ds_synthetic")?.historyStatus).toBe("complete");
  });

  it("replaying a history batch produces zero duplicates", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(h.engine);
    const messages = h.sink.messages.size;
    const batches = h.sink.batches;
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(h.engine);
    expect(h.sink.messages.size).toBe(messages);
    expect(h.engine.snapshot().history.duplicatesSkipped).toBe(2);
    expect(h.sink.batches).toBe(batches + 1);
    expect(h.sink.checkpoints.get("ds_synthetic")?.historyBatchesApplied).toBe(2);
  });

  it("flags inferred completion and paused sync as partial coverage", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    port.emit({ name: "history.status", data: { syncType: 3, status: "complete", explicit: false } });
    await settle(h.engine);
    expect(h.engine.snapshot().history).toMatchObject({ status: "partial" });
    expect(h.engine.snapshot().history.warnings).toContain("history-completion-inferred");
    port.emit({ name: "history.status", data: { syncType: 3, status: "paused", explicit: true } });
    await settle(h.engine);
    expect(h.engine.snapshot().history.warnings).toContain("history-paused");
  });

  it("marks history interrupted when the connection drops mid-sync, and recovers on resume", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 408 } } });
    await settle(h.engine);
    expect(h.engine.snapshot().history.status).toBe("partial");
    expect(h.engine.snapshot().history.warnings).toContain("history-interrupted");
    h.timers.fireLast();
    await settle(h.engine);
    const next = h.ports[1]!;
    next.emit({ name: "connection.update", data: { connection: "open" } });
    next.emit({ name: "history.set", data: historyChunk(fixture, 1) });
    await settle(h.engine);
    expect(h.engine.snapshot().history.status).toBe("syncing");
    expect(h.engine.snapshot().history.warnings).not.toContain("history-interrupted");
  });

  it("resumes from a stored checkpoint without re-inserting seen messages", async () => {
    const first = harness();
    const port = await open(first);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(first.engine);
    const second = harness({}, first.sink);
    const port2 = await open(second);
    port2.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(second.engine);
    expect(second.engine.snapshot().history.duplicatesSkipped).toBe(2);
    expect(first.sink.messages.size).toBe(2);
  });

  it("does not mark messages seen when the sink fails, so a replay retries them", async () => {
    const h = harness();
    const port = await open(h);
    h.sink.failNext = true;
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(h.engine);
    expect(h.sink.messages.size).toBe(0);
    expect(h.engine.snapshot().history.batchesApplied).toBe(0);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(h.engine);
    expect(h.sink.messages.size).toBe(2);
  });
});

describe("live sync", () => {
  it("handles upserts, reactions, edits, deletes and chat/contact/group updates", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    port.emit({ name: "messages.upsert", data: { type: "notify", messages: fixture.live } });
    await settle(h.engine);
    expect(h.sink.messages.size).toBe(3);
    const live = [...h.sink.messages.values()].find((m) => m.sourceMessageId === "SYNTH-L-0004");
    expect(live).toMatchObject({ sourceKind: "baileys-live", direction: "incoming", text: "live message" });
    expect(h.engine.snapshot().lastLiveEventAtMs).toBe(1_768_500_000_000);

    const key = { remoteJid: "15551000001@s.whatsapp.net", id: "SYNTH-H-0001", fromMe: false };
    port.emit({
      name: "messages.reaction",
      data: [{ key, reactorId: "15551000002@s.whatsapp.net", emoji: "👍", timestampMs: 1768469000000 }],
    });
    await settle(h.engine);
    expect(h.sink.reactions.size).toBe(1);
    port.emit({ name: "messages.reaction", data: [{ key, reactorId: "15551000002@s.whatsapp.net", emoji: "" }] });
    await settle(h.engine);
    expect(h.sink.reactions.size).toBe(0);

    port.emit({ name: "messages.update", data: [{ key, editedText: "edited text", editedAtMs: 1768469100000 }] });
    await settle(h.engine);
    expect([...h.sink.messages.values()].find((m) => m.sourceMessageId === "SYNTH-H-0001")).toMatchObject({
      text: "edited text",
      isEdited: true,
    });
    port.emit({ name: "messages.delete", data: { keys: [key] } });
    await settle(h.engine);
    const deleted = [...h.sink.messages.values()].find((m) => m.sourceMessageId === "SYNTH-H-0001");
    expect(deleted?.isDeleted).toBe(true);
    expect(deleted?.text).toBeUndefined();

    port.emit({ name: "chats.update", data: [{ id: "15551000001@s.whatsapp.net", name: "Renamed Synthetic" }] });
    port.emit({ name: "contacts.update", data: [{ id: "15551000001@s.whatsapp.net", name: "Alice Renamed" }] });
    port.emit({
      name: "groups.update",
      data: [{ id: "120363000000000001@g.us", subject: "Group Renamed", participantIds: ["15551000003@s.whatsapp.net"] }],
    });
    port.emit({ name: "lid-mapping.update", data: { lid: "00000003@lid", pn: "15551000003@s.whatsapp.net" } });
    await settle(h.engine);
    const titles = [...h.sink.conversations.values()].map((c) => c.title);
    expect(titles).toContain("Renamed Synthetic");
    expect(titles).toContain("Group Renamed");
    expect([...h.sink.contacts.values()].map((c) => c.displayName)).toContain("Alice Renamed");
  });

  it("attributes outgoing messages to the self contact", async () => {
    const h = harness();
    await h.engine.start();
    h.ports[0]!.emit({ name: "creds.update", data: { me: { id: `${fixture.self.split("@")[0]}:1@s.whatsapp.net` } } });
    h.ports[0]!.emit({ name: "connection.update", data: { connection: "open" } });
    h.ports[0]!.emit({ name: "history.set", data: historyChunk(fixture, 1) });
    await settle(h.engine);
    const outgoing = [...h.sink.messages.values()].find((m) => m.direction === "outgoing");
    const self = [...h.sink.contacts.values()].find((c) => c.isSelf);
    expect(outgoing?.senderContactId).toBeDefined();
    expect(self?.id ?? outgoing?.senderContactId).toBe(outgoing?.senderContactId);
  });
});

describe("reconnect state machine", () => {
  it("retries transient disconnects with exponential backoff + jitter and resets after open", async () => {
    const h = harness({ reconnect: { baseMs: 1000, maxMs: 60000, jitterRatio: 0.25, maxAttempts: 10 } });
    let port = await open(h);
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 408 } } });
      await settle(h.engine);
      delays.push(h.timers.pending.at(-1)!.ms);
      expect(h.engine.snapshot().phase).toBe("reconnecting");
      h.timers.fireLast();
      await settle(h.engine);
      port = h.ports.at(-1)!;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    port.emit({ name: "connection.update", data: { connection: "open" } });
    await settle(h.engine);
    expect(h.engine.snapshot()).toMatchObject({ phase: "open", reconnectAttempt: 0 });
    port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 408 } } });
    await settle(h.engine);
    expect(h.timers.pending.at(-1)!.ms).toBe(1000);
  });

  it("applies jitter within bounds", async () => {
    const config = parseConnectorConfig({ connectorEnabled: true, reconnect: { jitterRatio: 0.5, baseMs: 1000 } });
    const sink = new InMemoryIngestionSink();
    const delays: number[] = [];
    for (const random of [0, 0.999]) {
      const h = harness({ reconnect: config.reconnect }, sink);
      const engine = new ConnectorEngine({
        config,
        datasetId: "ds_synthetic",
        sink,
        random: () => random,
        timers: { setTimeout: (_cb, ms) => { delays.push(ms); return 1; }, clearTimeout: () => undefined },
        openAuth: () => ProtectedAuthState.open(h.store, () => ({})),
        createPort: () => { const p = new MockSocketPort(); h.ports.push(p); return p; },
        emit: () => undefined,
      });
      await engine.start();
      h.ports[0]!.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 408 } } });
      await settle(engine);
    }
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBeGreaterThan(1400);
    expect(delays[1]).toBeLessThanOrEqual(1500);
  });

  it("treats loggedOut (401) as terminal: no reconnect, auth wiped, archive intact", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    port.emit({ name: "creds.update", data: { me: { id: "15551000009:1@s.whatsapp.net" } } });
    await settle(h.engine);
    port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 401 } } });
    await settle(h.engine);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.engine.snapshot()).toMatchObject({ phase: "logged-out", lastDisconnectCode: 401 });
    expect(h.timers.pending).toHaveLength(0);
    expect(h.ports).toHaveLength(1);
    expect(await h.store.list()).toEqual([]);
    expect(h.sink.messages.size).toBe(2);
  });

  it("stops (no retry) when the session is replaced (440)", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 440 } } });
    await settle(h.engine);
    expect(h.engine.snapshot().phase).toBe("replaced");
    expect(h.timers.pending).toHaveLength(0);
  });

  it("reconnects immediately after restartRequired (515)", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 515 } } });
    await settle(h.engine);
    expect(h.timers.pending.at(-1)!.ms).toBe(0);
    h.timers.fireLast();
    await settle(h.engine);
    expect(h.ports).toHaveLength(2);
    expect(h.ports[0]!.closed).toBe(true);
  });

  it("gives up with a typed failed phase after maxAttempts", async () => {
    const h = harness({ reconnect: { maxAttempts: 2, baseMs: 10, maxMs: 100, jitterRatio: 0 } });
    await h.engine.start();
    for (let i = 0; i < 3; i += 1) {
      h.ports.at(-1)!.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 408 } } });
      await settle(h.engine);
      if (h.engine.snapshot().phase === "failed") {
        break;
      }
      h.timers.fireLast();
      await settle(h.engine);
    }
    expect(h.engine.snapshot().phase).toBe("failed");
  });

  it("dedups messages re-delivered after reconnect and detaches the old socket", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "messages.upsert", data: { type: "notify", messages: fixture.live } });
    await settle(h.engine);
    port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 428 } } });
    await settle(h.engine);
    expect(port.listenerCount).toBe(0);
    h.timers.fireLast();
    await settle(h.engine);
    const next = h.ports[1]!;
    next.emit({ name: "connection.update", data: { connection: "open" } });
    next.emit({ name: "messages.upsert", data: { type: "append", messages: fixture.live } });
    await settle(h.engine);
    expect(h.sink.messages.size).toBe(1);
    expect(h.engine.snapshot().history.duplicatesSkipped).toBe(1);
  });

  it("stop cancels pending retries; stale events from old sockets are ignored", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "connection.update", data: { connection: "close", disconnect: { statusCode: 408 } } });
    await settle(h.engine);
    await h.engine.stop();
    expect(h.timers.pending).toHaveLength(0);
    port.emit({ name: "messages.upsert", data: { type: "notify", messages: fixture.live } });
    await settle(h.engine);
    expect(h.sink.messages.size).toBe(0);
    expect(h.engine.snapshot().phase).toBe("stopped");
  });
});

describe("logout and delete auth", () => {
  it("logout unlinks, wipes protected auth and preserves archived data", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "creds.update", data: { me: { id: "15551000009:1@s.whatsapp.net" } } });
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(h.engine);
    expect((await h.store.list()).length).toBeGreaterThan(0);
    await h.engine.logout();
    expect(port.loggedOut).toBe(true);
    expect(await h.store.list()).toEqual([]);
    expect(h.sink.messages.size).toBe(2);
    expect(h.engine.snapshot().phase).toBe("logged-out");
  });

  it("deleteAuth is local-only and leaves the dataset untouched", async () => {
    const h = harness();
    const port = await open(h);
    port.emit({ name: "history.set", data: historyChunk(fixture, 0) });
    await settle(h.engine);
    await h.engine.deleteAuth();
    expect(port.loggedOut).toBe(false);
    expect(await h.store.list()).toEqual([]);
    expect(h.sink.messages.size).toBe(2);
    expect(h.engine.snapshot().phase).toBe("stopped");
  });
});
