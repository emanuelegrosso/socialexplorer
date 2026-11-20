import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockSocketPort, type PortChat, type PortContact, type PortHistorySet, type PortMessage } from "@social-explorer/baileys-adapter";
import { MemoryKeyStore, ProtectedStore } from "@social-explorer/security";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseConnectorConfig, type ConnectorConfig } from "./config.js";
import { ConnectorEngine, type EngineOutput, type EngineTimers } from "./engine.js";
import { InMemoryIngestionSink } from "./memory-sink.js";
import { ProtectedAuthState } from "./protected-auth-state.js";

export interface SyntheticFixture {
  self: string;
  history: {
    chats: PortChat[];
    contacts: PortContact[];
    messages: PortMessage[];
    progress: number;
    isLatest: boolean;
  }[];
  live: PortMessage[];
}

export function loadFixture(): SyntheticFixture {
  const path = join(import.meta.dirname, "..", "..", "..", "fixtures", "synthetic", "connector-port-events.json");
  return JSON.parse(readFileSync(path, "utf8")) as SyntheticFixture;
}

export function historyChunk(fixture: SyntheticFixture, index: number): PortHistorySet {
  const chunk = fixture.history[index];
  if (chunk === undefined) {
    throw new Error("missing fixture chunk");
  }
  return chunk;
}

export class FakeTimers implements EngineTimers {
  readonly scheduled: { id: number; callback: () => void; ms: number; cleared: boolean }[] = [];

  setTimeout(callback: () => void, ms: number): unknown {
    const entry = { id: this.scheduled.length, callback, ms, cleared: false };
    this.scheduled.push(entry);
    return entry;
  }

  clearTimeout(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }

  get pending(): { id: number; ms: number; callback: () => void; cleared: boolean }[] {
    return this.scheduled.filter((entry) => !entry.cleared);
  }

  fireLast(): void {
    const entry = this.scheduled.filter((e) => !e.cleared).at(-1);
    if (entry === undefined) {
      throw new Error("no pending timer");
    }
    entry.cleared = true;
    entry.callback();
  }
}

export function newAuthStore(): { store: ProtectedStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "se-auth-"));
  return { directory, store: new ProtectedStore({ directory, keyStore: new MemoryKeyStore() }) };
}

export interface Harness {
  engine: ConnectorEngine;
  sink: InMemoryIngestionSink;
  timers: FakeTimers;
  ports: MockSocketPort[];
  outputs: EngineOutput[];
  store: ProtectedStore;
  directory: string;
  config: ConnectorConfig;
}

export function harness(configInput: Record<string, unknown> = {}, sinkArg?: InMemoryIngestionSink): Harness {
  const config = parseConnectorConfig({ connectorEnabled: true, ...configInput });
  const sink = sinkArg ?? new InMemoryIngestionSink();
  const timers = new FakeTimers();
  const ports: MockSocketPort[] = [];
  const outputs: EngineOutput[] = [];
  const { store, directory } = newAuthStore();
  const engine = new ConnectorEngine({
    config,
    datasetId: "ds_synthetic",
    sink,
    timers,
    random: () => 0.5,
    now: () => 1_768_500_000_000,
    openAuth: () => ProtectedAuthState.open(store, () => ({ noiseKey: Buffer.from("synthetic-noise") })),
    createPort: () => {
      const port = new MockSocketPort();
      ports.push(port);
      return port;
    },
    emit: (output) => outputs.push(output),
  });
  return { engine, sink, timers, ports, outputs, store, directory, config };
}

export async function settle(engine: ConnectorEngine): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await engine.whenIdle();
}
