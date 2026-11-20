import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RenderSecurityError } from "./safe-paths.js";

export interface RenderProgress {
  readonly fraction: number;
  readonly outTimeMs: number;
  readonly frame?: number;
  readonly totalSize?: number;
  readonly speed?: string;
  readonly done: boolean;
}

export type RunnerEvent =
  | { readonly type: "started"; readonly pid: number | undefined }
  | { readonly type: "progress"; readonly progress: RenderProgress }
  | { readonly type: "finished"; readonly status: RunOutcome["status"] };

export interface RunOptions {
  /** Bare program name (resolved via PATH) or an absolute path. Never a shell string. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly expectedDurationMs?: number;
  /** Kill the process when the reported output size exceeds this many bytes. */
  readonly maxOutputBytes?: number;
  readonly maxStderrBytes?: number;
  readonly onEvent?: (event: RunnerEvent) => void;
}

export interface RunOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "timeout" | "limit-exceeded" | "spawn-error";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
  readonly lastProgress?: RenderProgress;
  readonly error?: string;
}

export type FfmpegRunnerFn = (options: RunOptions) => Promise<RunOutcome>;

const EXECUTABLE_NAME = /^[A-Za-z0-9._+-]+$/u;
const MAX_ARGS = 2000;
const MAX_ARG_LENGTH = 16_384;

export function validateExecutable(executable: string): void {
  if (typeof executable !== "string" || executable.length === 0 || executable.includes("\0")) {
    throw new RenderSecurityError("Invalid executable");
  }
  if (isAbsolute(executable)) {
    if (!existsSync(executable)) throw new RenderSecurityError("Executable does not exist");
    try {
      accessSync(executable, constants.X_OK);
    } catch {
      throw new RenderSecurityError("Executable is not executable");
    }
    return;
  }
  if (!EXECUTABLE_NAME.test(executable)) {
    throw new RenderSecurityError("Executable must be a plain program name or an absolute path");
  }
}

/** Arguments are an array of plain strings; this guards shape, not meaning. */
export function validateArgs(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new RenderSecurityError("Too many arguments");
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0") || arg.length > MAX_ARG_LENGTH) {
      throw new RenderSecurityError("Invalid argument");
    }
  }
}

class ProgressParser {
  #buffer = "";
  #fields = new Map<string, string>();
  constructor(
    private readonly expectedMs: number | undefined,
    private readonly emit: (progress: RenderProgress) => void,
  ) {}

  push(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf("\n");
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      this.#fields.set(key, value);
      if (key === "progress") this.#flush(value === "end");
    }
  }

  #flush(done: boolean): void {
    const micro = Number(this.#fields.get("out_time_us") ?? this.#fields.get("out_time_ms") ?? "0");
    const outTimeMs = Number.isFinite(micro) && micro > 0 ? Math.round(micro / 1000) : 0;
    const frame = Number(this.#fields.get("frame"));
    const size = Number(this.#fields.get("total_size"));
    const speed = this.#fields.get("speed");
    const fraction = done
      ? 1
      : this.expectedMs === undefined || this.expectedMs <= 0
        ? 0
        : Math.min(0.999, outTimeMs / this.expectedMs);
    this.emit({
      fraction,
      outTimeMs,
      ...(Number.isFinite(frame) ? { frame } : {}),
      ...(Number.isFinite(size) ? { totalSize: size } : {}),
      ...(speed === undefined ? {} : { speed }),
      done,
    });
    this.#fields = new Map();
  }
}

/**
 * Supervised child-process runner: `spawn` with an argument array and `shell: false`, no
 * stdin, minimal environment, progress parsing from `-progress pipe:1`, cancellation by
 * AbortSignal, timeout and output-size limits, SIGTERM then SIGKILL, bounded stderr capture.
 */
export function runSupervised(options: RunOptions): Promise<RunOutcome> {
  try {
    validateExecutable(options.executable);
    validateArgs(options.args);
  } catch (error) {
    return Promise.resolve({
      status: "spawn-error",
      exitCode: null,
      signal: null,
      stderrTail: "",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const emit = options.onEvent ?? ((): void => undefined);
  if (options.signal?.aborted === true) {
    emit({ type: "finished", status: "cancelled" });
    return Promise.resolve({ status: "cancelled", exitCode: null, signal: null, stderrTail: "" });
  }

  return new Promise<RunOutcome>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable, [...options.args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { PATH: process.env["PATH"] ?? "", LANG: "C", ...(process.env["TMPDIR"] === undefined ? {} : { TMPDIR: process.env["TMPDIR"] }) },
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (error) {
      resolvePromise({ status: "spawn-error", exitCode: null, signal: null, stderrTail: "", error: String(error) });
      return;
    }

    let stderrTail = "";
    const maxStderr = options.maxStderrBytes ?? 16_384;
    let lastProgress: RenderProgress | undefined;
    let forced: "cancelled" | "timeout" | "limit-exceeded" | undefined;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: NonNullable<typeof forced>): void => {
      if (forced !== undefined) return;
      forced = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.killGraceMs ?? 2000);
    };

    const parser = new ProgressParser(options.expectedDurationMs, (progress) => {
      lastProgress = progress;
      emit({ type: "progress", progress });
      if (options.maxOutputBytes !== undefined && (progress.totalSize ?? 0) > options.maxOutputBytes) {
        terminate("limit-exceeded");
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      parser.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-maxStderr);
    });

    const onAbort = (): void => {
      terminate("cancelled");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        terminate("timeout");
      }, options.timeoutMs);
    }

    let settled = false;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const status: RunOutcome["status"] =
        spawnError !== undefined
          ? "spawn-error"
          : (forced ?? (exitCode === 0 ? "completed" : "failed"));
      emit({ type: "finished", status });
      resolvePromise({
        status,
        exitCode,
        signal,
        stderrTail,
        ...(lastProgress === undefined ? {} : { lastProgress }),
        ...(spawnError === undefined ? {} : { error: spawnError }),
      });
    };

    child.once("error", (error) => {
      spawnError = error.message;
      if (child.pid === undefined) settle(null, null);
    });
    child.once("close", (code, signal) => {
      settle(code, signal);
    });
    emit({ type: "started", pid: child.pid });
  });
}
