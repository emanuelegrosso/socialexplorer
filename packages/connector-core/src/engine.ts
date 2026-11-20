import {
  CONNECTION_REPLACED_STATUS_CODE,
  LOGGED_OUT_STATUS_CODE,
  RESTART_REQUIRED_STATUS_CODE,
  type BaileysSocketPort,
  type PortAuthState,
  type PortEvent,
} from "@social-explorer/baileys-adapter";
import { computeBackoffMs } from "./backoff.js";
import type { ConnectorConfig } from "./config.js";
import { HistorySyncProcessor } from "./history-sync.js";
import type { ConnectorIngestionSink } from "./ingestion-types.js";
import { LiveSyncProcessor } from "./live-sync.js";
import { CanonicalMapper } from "./mapper.js";
import {
  INITIAL_PAIRING_STATE,
  pairingReducer,
  pairingSnapshot,
  type PairingEvent,
  type PairingState,
} from "./pairing.js";
import type { ProtectedAuthState } from "./protected-auth-state.js";
import type { ConnectorErrorCode, ConnectorPhase, ConnectorState } from "./protocol.js";
import { SyncState } from "./sync-state.js";

export type EngineOutput =
  | { readonly type: "state"; readonly state: ConnectorState }
  | { readonly type: "qr"; readonly qr: string; readonly attempt: number }
  | { readonly type: "pairing-code"; readonly code: string }
  | { readonly type: "error"; readonly code: ConnectorErrorCode; readonly message: string };

export interface EngineTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EngineDeps {
  readonly config: ConnectorConfig;
  readonly datasetId: string;
  readonly sink: ConnectorIngestionSink;
  /** Opens (or re-opens) protected auth state; called per connection so a logout can start clean. */
  readonly openAuth: () => Promise<ProtectedAuthState>;
  readonly createPort: (auth: PortAuthState) => Promise<BaileysSocketPort> | BaileysSocketPort;
  readonly emit: (output: EngineOutput) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timers?: EngineTimers;
}

const defaultTimers: EngineTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * Read-only connector engine: owns one socket at a time, wires port events to the history/live
 * processors, and runs the reconnect state machine. It can only observe; the port has no write API.
 */
export class ConnectorEngine {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timers: EngineTimers;
  private readonly mapper: CanonicalMapper;
  private readonly syncState: SyncState;
  private readonly history: HistorySyncProcessor;
  private readonly live: LiveSyncProcessor;

  private phase: ConnectorPhase = "idle";
  private pairing: PairingState = INITIAL_PAIRING_STATE;
  private auth: ProtectedAuthState | undefined;
  private port: BaileysSocketPort | undefined;
  private detach: (() => void) | undefined;
  private retryHandle: unknown;
  private reconnectAttempt = 0;
  private nextRetryInMs: number | undefined;
  private lastDisconnectCode: number | undefined;
  private generation = 0;
  private restored = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.timers = deps.timers ?? defaultTimers;
    this.mapper = new CanonicalMapper({ datasetId: deps.datasetId, timezone: deps.config.timezone });
    this.syncState = new SyncState(deps.datasetId, deps.sink, this.now);
    this.history = new HistorySyncProcessor(this.mapper, this.syncState);
    this.live = new LiveSyncProcessor(this.mapper, this.syncState);
  }

  snapshot(): ConnectorState {
    const coverage = this.syncState.coverage;
    return {
      phase: this.phase,
      pairing: pairingSnapshot(this.pairing),
      reconnectAttempt: this.reconnectAttempt,
      ...(this.nextRetryInMs === undefined ? {} : { nextRetryInMs: this.nextRetryInMs }),
      ...(this.lastDisconnectCode === undefined ? {} : { lastDisconnectCode: this.lastDisconnectCode }),
      history: {
        status: coverage.status,
        ...(coverage.progress === undefined ? {} : { progress: coverage.progress }),
        batchesApplied: coverage.batchesApplied,
        messagesIngested: coverage.messagesIngested,
        duplicatesSkipped: coverage.duplicatesSkipped,
        ...(coverage.oldestMessageTimestampMs === undefined
          ? {}
          : { oldestMessageTimestampMs: coverage.oldestMessageTimestampMs }),
        ...(coverage.newestMessageTimestampMs === undefined
          ? {}
          : { newestMessageTimestampMs: coverage.newestMessageTimestampMs }),
        warnings: [...coverage.warnings],
      },
      ...(this.syncState.lastLiveEventAtMs === undefined
        ? {}
        : { lastLiveEventAtMs: this.syncState.lastLiveEventAtMs }),
    };
  }

  /** Resolves once every event received so far has been fully processed. */
  async whenIdle(): Promise<void> {
    let current: Promise<unknown>;
    do {
      current = this.pending;
      await current.catch(() => undefined);
    } while (current !== this.pending);
  }

  async start(): Promise<void> {
    if (!this.deps.config.connectorEnabled) {
      this.deps.emit({ type: "error", code: "disabled", message: "connector_disabled" });
      return;
    }
    if (this.phase !== "idle" && this.phase !== "stopped" && this.phase !== "logged-out" && this.phase !== "failed" && this.phase !== "replaced") {
      return;
    }
    if (!this.restored) {
      this.syncState.restore(await this.deps.sink.loadCheckpoint(this.deps.datasetId));
      this.restored = true;
    }
    this.reconnectAttempt = 0;
    this.pairing = INITIAL_PAIRING_STATE;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.clearRetry();
    this.history.markInterrupted();
    this.teardownPort();
    await this.pending.catch(() => undefined);
    this.phase = "stopped";
    this.publish();
  }

  async requestPairingCode(phoneNumber: string): Promise<void> {
    const port = this.port;
    if (port === undefined || this.auth?.isRegistered() === true) {
      this.deps.emit({ type: "error", code: "pairing-failed", message: "pairing_unavailable" });
      return;
    }
    try {
      const code = await port.requestPairingCode(phoneNumber);
      this.applyPairing({ type: "code-requested" });
      this.deps.emit({ type: "pairing-code", code });
      this.publish();
    } catch {
      this.deps.emit({ type: "error", code: "pairing-failed", message: "pairing_code_request_failed" });
    }
  }

  /** Explicit user logout: unlink the device, wipe protected auth, keep every archived dataset. */
  async logout(): Promise<void> {
    const port = this.port;
    this.generation += 1;
    this.clearRetry();
    if (port !== undefined) {
      await port.logout().catch(() => undefined);
    }
    this.teardownPort();
    await this.pending.catch(() => undefined);
    await this.wipeAuth();
    this.applyPairing({ type: "logged-out" });
    this.phase = "logged-out";
    this.publish();
  }

  /** Local-only deletion of auth state (device stays linked on the phone until removed there). */
  async deleteAuth(): Promise<void> {
    this.generation += 1;
    this.clearRetry();
    this.teardownPort();
    await this.pending.catch(() => undefined);
    await this.wipeAuth();
    this.applyPairing({ type: "reset" });
    this.phase = "stopped";
    this.publish();
  }

  private async wipeAuth(): Promise<void> {
    const auth = this.auth ?? (await this.deps.openAuth().catch(() => undefined));
    await auth?.clear();
    this.auth = undefined;
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.phase = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.nextRetryInMs = undefined;
    this.publish();
    try {
      const auth = await this.deps.openAuth();
      if (generation !== this.generation) {
        return;
      }
      this.auth = auth;
      this.mapper.setSelfJid(auth.selfJid());
      const port = await this.deps.createPort(auth.state);
      if (generation !== this.generation) {
        port.close();
        return;
      }
      this.port = port;
      this.detach = port.onEvent((event) => {
        this.pending = this.pending.then(() => this.onEvent(event, generation)).catch(() => {
          this.deps.emit({ type: "error", code: "sink-failed", message: "event_processing_failed" });
        });
      });
    } catch {
      this.deps.emit({ type: "error", code: "auth-failed", message: "connect_failed" });
      this.scheduleReconnect(generation);
    }
  }

  private async onEvent(event: PortEvent, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    switch (event.name) {
      case "connection.update":
        this.onConnectionUpdate(event.data, generation);
        return;
      case "creds.update":
        await this.auth?.saveCreds(event.data);
        this.mapper.setSelfJid(this.auth?.selfJid());
        return;
      case "history.set":
        await this.history.handleChunk(event.data);
        this.publish();
        return;
      case "history.status":
        this.history.handleStatus(event.data);
        await this.syncState.commit({
          source: "baileys-history",
          conversations: [],
          contacts: [],
          participants: [],
          messages: [],
          reactions: [],
          removedReactionIds: [],
          edits: [],
          deletedMessageIds: [],
          deletedConversationIds: [],
          forceCheckpoint: true,
        });
        this.publish();
        return;
      default:
        if (await this.live.handle(event)) {
          this.publish();
        }
    }
  }

  private onConnectionUpdate(
    update: Extract<PortEvent, { name: "connection.update" }>["data"],
    generation: number,
  ): void {
    if (update.qr !== undefined) {
      this.applyPairing({ type: "qr", qr: update.qr });
      if (this.pairing.phase === "awaiting-qr") {
        this.phase = "awaiting-pairing";
        this.deps.emit({ type: "qr", qr: update.qr, attempt: this.pairing.qrAttempts });
      } else if (this.pairing.phase === "timed-out") {
        this.teardownPort();
        this.phase = "stopped";
      }
    }
    if (update.connection === "open") {
      this.phase = "open";
      this.reconnectAttempt = 0;
      this.nextRetryInMs = undefined;
      this.lastDisconnectCode = undefined;
      this.applyPairing({ type: "paired" });
      this.mapper.setSelfJid(this.auth?.selfJid());
    } else if (update.connection === "connecting" && this.phase === "idle") {
      this.phase = "connecting";
    } else if (update.connection === "close") {
      this.onClose(update.disconnect?.statusCode, generation);
      return;
    }
    this.publish();
  }

  private onClose(statusCode: number | undefined, generation: number): void {
    this.lastDisconnectCode = statusCode;
    this.history.markInterrupted();
    this.teardownPort();
    if (statusCode === LOGGED_OUT_STATUS_CODE) {
      this.generation += 1;
      this.pending = this.pending.then(async () => {
        await this.wipeAuth().catch(() => undefined);
        this.applyPairing({ type: "logged-out" });
        this.phase = "logged-out";
        this.publish();
      });
      return;
    }
    if (statusCode === CONNECTION_REPLACED_STATUS_CODE) {
      this.generation += 1;
      this.phase = "replaced";
      this.publish();
      return;
    }
    this.scheduleReconnect(generation, statusCode === RESTART_REQUIRED_STATUS_CODE);
  }

  private scheduleReconnect(generation: number, immediate = false): void {
    if (generation !== this.generation) {
      return;
    }
    if (immediate) {
      this.phase = "reconnecting";
      this.publish();
      this.retryHandle = this.timers.setTimeout(() => {
        this.retryHandle = undefined;
        this.runReconnect(generation);
      }, 0);
      return;
    }
    const policy = this.deps.config.reconnect;
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > policy.maxAttempts) {
      this.phase = "failed";
      this.nextRetryInMs = undefined;
      this.publish();
      return;
    }
    const delay = computeBackoffMs(this.reconnectAttempt, policy, this.random);
    this.phase = "reconnecting";
    this.nextRetryInMs = delay;
    this.publish();
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = undefined;
      this.runReconnect(generation);
    }, delay);
  }

  private runReconnect(generation: number): void {
    if (generation === this.generation) {
      this.pending = this.pending.then(() => this.connect());
    }
  }

  private applyPairing(event: PairingEvent): void {
    this.pairing = pairingReducer(this.pairing, event, this.deps.config.pairingMaxQrAttempts);
  }

  private clearRetry(): void {
    if (this.retryHandle !== undefined) {
      this.timers.clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
    this.nextRetryInMs = undefined;
  }

  private teardownPort(): void {
    this.detach?.();
    this.detach = undefined;
    this.port?.close();
    this.port = undefined;
  }

  private publish(): void {
    this.deps.emit({ type: "state", state: this.snapshot() });
  }
}
