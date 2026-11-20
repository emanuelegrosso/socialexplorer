import type { BaileysSocketPort, PortAuthState } from "@social-explorer/baileys-adapter";
import { ConnectorEngine, type EngineOutput } from "./engine.js";
import type { ConnectorConfig } from "./config.js";
import type {
  ConnectorCheckpoint,
  ConnectorIngestBatch,
  ConnectorIngestionSink,
  IngestOutcome,
} from "./ingestion-types.js";
import type { ProtectedAuthState } from "./protected-auth-state.js";
import {
  PROTOCOL_VERSION,
  parseHostCommand,
  type ConnectorErrorCode,
  type ConnectorEvent,
  type HostCommand,
} from "./protocol.js";

export interface WorkerChannel {
  send(event: ConnectorEvent): void;
  onMessage(handler: (raw: unknown) => void): void;
  exit(code: number): void;
}

export interface WorkerDeps {
  readonly channel: WorkerChannel;
  readonly config: ConnectorConfig;
  readonly openAuth: () => Promise<ProtectedAuthState>;
  readonly createPort: (auth: PortAuthState) => Promise<BaileysSocketPort> | BaileysSocketPort;
  readonly pid?: number;
  readonly now?: () => number;
  readonly ackTimeoutMs?: number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/** Forwards canonical batches to the host over IPC; the child never opens the archive database. */
class IpcIngestionSink implements ConnectorIngestionSink {
  private seq = 0;
  private readonly waiting = new Map<number, (ok: boolean) => void>();
  checkpoint: ConnectorCheckpoint | undefined;

  constructor(
    private readonly channel: WorkerChannel,
    private readonly ackTimeoutMs: number,
  ) {}

  loadCheckpoint(): Promise<ConnectorCheckpoint | undefined> {
    return Promise.resolve(this.checkpoint);
  }

  ingest(batch: ConnectorIngestBatch): Promise<IngestOutcome> {
    const seq = this.seq++;
    return new Promise<IngestOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(seq);
        reject(new Error("ingest_ack_timeout"));
      }, this.ackTimeoutMs);
      this.waiting.set(seq, (ok) => {
        clearTimeout(timer);
        if (ok) {
          resolve({ insertedMessages: batch.messages.length, duplicateMessages: 0 });
        } else {
          reject(new Error("ingest_rejected"));
        }
      });
      this.channel.send({ type: "ingest", seq, batch });
    });
  }

  ack(seq: number, ok: boolean): void {
    this.waiting.get(seq)?.(ok);
    this.waiting.delete(seq);
  }
}

export interface RunningWorker {
  handle(raw: unknown): Promise<void>;
  dispose(): void;
}

/** Child-process main loop: validates every message, dispatches only typed commands. */
export function runConnectorWorker(deps: WorkerDeps): RunningWorker {
  const { channel, config } = deps;
  const now = deps.now ?? Date.now;
  const sink = new IpcIngestionSink(channel, deps.ackTimeoutMs ?? 30_000);
  let engine: ConnectorEngine | undefined;
  let heartbeatSeq = 0;

  const fail = (code: ConnectorErrorCode, message: string): void => {
    channel.send({ type: "error", code, message });
  };
  const emit = (output: EngineOutput): void => {
    channel.send(output);
  };

  const heartbeat = (): void => {
    channel.send({ type: "heartbeat", seq: heartbeatSeq++, atMs: now() });
  };
  const timer = (deps.setInterval ?? ((cb, ms) => setInterval(cb, ms)))(
    heartbeat,
    config.supervisor.heartbeatIntervalMs,
  );
  const dispose = (): void => {
    (deps.clearInterval ?? ((handle) => { clearInterval(handle as NodeJS.Timeout); }))(timer);
  };

  const dispatch = async (command: HostCommand): Promise<void> => {
    switch (command.type) {
      case "ping":
        channel.send({ type: "pong", nonce: command.nonce });
        return;
      case "ingest-ack":
        sink.ack(command.seq, command.ok);
        return;
      case "shutdown":
        await engine?.stop();
        dispose();
        channel.exit(0);
        return;
      case "start":
        if (!config.connectorEnabled) {
          fail("disabled", "connector_disabled");
          return;
        }
        if (engine !== undefined) {
          await engine.start();
          return;
        }
        sink.checkpoint = command.checkpoint;
        engine = new ConnectorEngine({
          config: { ...config, timezone: command.timezone, datasetId: command.datasetId },
          datasetId: command.datasetId,
          sink,
          openAuth: deps.openAuth,
          createPort: deps.createPort,
          emit,
          now,
        });
        await engine.start();
        return;
      default:
        break;
    }
    if (engine === undefined) {
      fail("invalid-command", "connector_not_started");
      return;
    }
    switch (command.type) {
      case "stop":
        await engine.stop();
        return;
      case "request-pairing-code":
        await engine.requestPairingCode(command.phoneNumber);
        return;
      case "logout":
        await engine.logout();
        return;
      case "delete-auth":
        await engine.deleteAuth();
        return;
    }
  };

  heartbeat();
  channel.send({ type: "ready", protocolVersion: PROTOCOL_VERSION, pid: deps.pid ?? process.pid });

  const handle = async (raw: unknown): Promise<void> => {
    const parsed = parseHostCommand(raw);
    if (!parsed.ok) {
      fail("invalid-command", "invalid_command");
      return;
    }
    try {
      await dispatch(parsed.value);
    } catch {
      fail("internal", "command_failed");
    }
  };
  channel.onMessage((raw) => {
    void handle(raw);
  });
  return { handle, dispose };
}
