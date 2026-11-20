import { fork, type ChildProcess } from "node:child_process";
import { computeBackoffMs } from "./backoff.js";
import type { ConnectorConfig } from "./config.js";
import type { ConnectorIngestionSink } from "./ingestion-types.js";
import {
  parseConnectorEvent,
  parseHostCommand,
  type ConnectorEvent,
  type ConnectorState,
  type HostCommand,
} from "./protocol.js";

export type SupervisorStatus =
  | "disabled"
  | "stopped"
  | "starting"
  | "running"
  | "unresponsive"
  | "crashed"
  | "restarting"
  | "failed"
  | "stopping";

export type FailureReason = "crash" | "heartbeat-timeout" | "ready-timeout" | "protocol-violation";

export interface SupervisorState {
  readonly status: SupervisorStatus;
  readonly restartCount: number;
  readonly lastFailure?: FailureReason;
  readonly lastExit?: { readonly code: number | null; readonly signal: string | null };
  readonly connector?: ConnectorState;
  readonly lastHeartbeatAtMs?: number;
}

export interface SupervisorOptions {
  readonly config: ConnectorConfig;
  /** Absolute path of the child entry module (`dist/worker-entry.js`). */
  readonly entry: string;
  readonly datasetId: string;
  readonly authDirectory: string;
  readonly sink: ConnectorIngestionSink;
  readonly execArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly random?: () => number;
}

export type SupervisorEvent =
  | { readonly type: "state"; readonly state: SupervisorState }
  | { readonly type: "qr"; readonly qr: string; readonly attempt: number }
  | { readonly type: "pairing-code"; readonly code: string }
  | { readonly type: "error"; readonly code: string };

/**
 * Host-side supervisor. The connector runs in a forked child so a Baileys crash, hang or memory
 * blow-up can never take down the host or touch the archive: the child only emits validated,
 * canonical batches over IPC, and the host applies them to the sink atomically with checkpoints.
 */
export class ConnectorSupervisor {
  private child: ChildProcess | undefined;
  private current: SupervisorState;
  private readonly listeners = new Set<(event: SupervisorEvent) => void>();
  private readonly restartTimes: number[] = [];
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private lastHeartbeatAt = 0;
  private wantRunning = false;
  private intentionalStop = false;
  private exitWaiters: (() => void)[] = [];
  private ingestQueue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.current = {
      status: options.config.connectorEnabled ? "stopped" : "disabled",
      restartCount: 0,
    };
  }

  get state(): SupervisorState {
    return this.current;
  }

  onEvent(listener: (event: SupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (!this.options.config.connectorEnabled) {
      this.setState({ status: "disabled" });
      return;
    }
    if (this.wantRunning) {
      return;
    }
    this.wantRunning = true;
    this.intentionalStop = false;
    this.restartTimes.length = 0;
    this.setState({ status: "starting", restartCount: 0 });
    this.forkChild();
  }

  /** Graceful shutdown: ask the child to stop, then force-kill after the grace period. */
  async stop(): Promise<void> {
    this.wantRunning = false;
    this.intentionalStop = true;
    this.clearTimers();
    const child = this.child;
    if (child === undefined) {
      this.setState({ status: "stopped" });
      return;
    }
    this.setState({ status: "stopping" });
    await new Promise<void>((resolve) => {
      const forced = setTimeout(() => {
        child.kill("SIGKILL");
      }, this.options.config.supervisor.shutdownGraceMs);
      this.exitWaiters.push(() => {
        clearTimeout(forced);
        resolve();
      });
      this.sendCommand({ type: "shutdown" });
    });
    this.setState({ status: "stopped" });
  }

  requestPairingCode(phoneNumber: string): boolean {
    return this.sendCommand({ type: "request-pairing-code", phoneNumber });
  }

  logout(): boolean {
    return this.sendCommand({ type: "logout" });
  }

  deleteAuth(): boolean {
    return this.sendCommand({ type: "delete-auth" });
  }

  /** Validates against the closed command union before anything is written to the child. */
  sendCommand(command: HostCommand): boolean {
    const parsed = parseHostCommand(command);
    const child = this.child;
    if (!parsed.ok || child === undefined || !child.connected) {
      return false;
    }
    try {
      child.send(parsed.value);
      return true;
    } catch {
      return false;
    }
  }

  private forkChild(): void {
    const { config } = this.options;
    const child = fork(this.options.entry, [], {
      execArgv: [...(this.options.execArgv ?? [])],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...(this.options.env ?? process.env),
        SE_CONNECTOR_AUTH_DIR: this.options.authDirectory,
        SE_CONNECTOR_CONFIG: JSON.stringify(config),
      },
    });
    this.child = child;
    this.lastHeartbeatAt = this.now();
    child.on("message", (raw: unknown) => {
      if (this.child === child) {
        this.onMessage(child, raw);
      }
    });
    child.on("error", () => {
      if (this.child === child && child.pid === undefined) {
        this.onExit(child, null, null);
      }
    });
    child.on("exit", (code, signal) => {
      this.onExit(child, code, signal);
    });
    this.readyTimer = setTimeout(() => {
      if (this.child === child && this.current.status === "starting") {
        this.failure(child, "ready-timeout");
      }
    }, config.supervisor.readyTimeoutMs);
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeat(child);
    }, config.supervisor.heartbeatIntervalMs);
  }

  private checkHeartbeat(child: ChildProcess): void {
    if (this.child !== child || this.current.status === "starting") {
      return;
    }
    if (this.now() - this.lastHeartbeatAt > this.options.config.supervisor.heartbeatTimeoutMs) {
      this.failure(child, "heartbeat-timeout");
    }
  }

  private failure(child: ChildProcess, reason: FailureReason): void {
    if (this.child !== child) {
      return;
    }
    this.pendingFailure = reason;
    this.setState({ status: "unresponsive", lastFailure: reason });
    child.kill("SIGKILL");
  }

  private pendingFailure: FailureReason | undefined;

  private onMessage(child: ChildProcess, raw: unknown): void {
    const parsed = parseConnectorEvent(raw);
    if (!parsed.ok) {
      this.failure(child, "protocol-violation");
      return;
    }
    const event = parsed.value;
    switch (event.type) {
      case "ready":
        clearTimeout(this.readyTimer);
        this.lastHeartbeatAt = this.now();
        this.setState({ status: "running", lastHeartbeatAtMs: this.lastHeartbeatAt });
        void this.sendStart(child);
        return;
      case "heartbeat":
        this.lastHeartbeatAt = this.now();
        return;
      case "pong":
        this.lastHeartbeatAt = this.now();
        return;
      case "state":
        this.setState({ connector: event.state });
        return;
      case "qr":
        this.emit({ type: "qr", qr: event.qr, attempt: event.attempt });
        return;
      case "pairing-code":
        this.emit({ type: "pairing-code", code: event.code });
        return;
      case "error":
        this.emit({ type: "error", code: event.code });
        return;
      case "ingest":
        this.ingestQueue = this.ingestQueue.then(() => this.applyIngest(child, event));
        return;
    }
  }

  private async sendStart(child: ChildProcess): Promise<void> {
    const { datasetId, config, sink } = this.options;
    const checkpoint = await sink.loadCheckpoint(datasetId).catch(() => undefined);
    if (this.child !== child) {
      return;
    }
    this.sendCommand({
      type: "start",
      datasetId,
      timezone: config.timezone,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
  }

  private async applyIngest(
    child: ChildProcess,
    event: Extract<ConnectorEvent, { type: "ingest" }>,
  ): Promise<void> {
    let ok = true;
    try {
      await this.options.sink.ingest(event.batch);
    } catch {
      ok = false;
    }
    if (this.child === child) {
      this.sendCommand({ type: "ingest-ack", seq: event.seq, ok });
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.clearTimers();
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
    if (this.intentionalStop || !this.wantRunning) {
      this.setState({ lastExit: { code, signal } });
      return;
    }
    const reason = this.pendingFailure ?? "crash";
    this.pendingFailure = undefined;
    this.setState({ status: "crashed", lastFailure: reason, lastExit: { code, signal } });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const { supervisor } = this.options.config;
    const now = this.now();
    while (this.restartTimes.length > 0 && now - (this.restartTimes[0] ?? now) > supervisor.restartWindowMs) {
      this.restartTimes.shift();
    }
    if (this.restartTimes.length >= supervisor.maxRestarts) {
      this.wantRunning = false;
      this.setState({ status: "failed" });
      return;
    }
    this.restartTimes.push(now);
    const delay = computeBackoffMs(
      this.restartTimes.length,
      { baseMs: supervisor.restartBaseMs, maxMs: supervisor.restartMaxMs, jitterRatio: 0.25 },
      this.random,
    );
    this.setState({ status: "restarting", restartCount: this.current.restartCount + 1 });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.wantRunning) {
        this.setState({ status: "starting" });
        this.forkChild();
      }
    }, delay);
  }

  private clearTimers(): void {
    clearTimeout(this.readyTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private setState(patch: Partial<SupervisorState>): void {
    this.current = { ...this.current, ...patch };
    this.emit({ type: "state", state: this.current });
  }

  private emit(event: SupervisorEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
