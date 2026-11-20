import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactLogValue, redactText } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  close(): Promise<void>;
}

export interface LogSink {
  write(line: string): void;
  close(): Promise<void>;
}

export interface LoggerOptions {
  readonly sink: LogSink;
  readonly level?: LogLevel;
  readonly now?: () => Date;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

export function createFileLogSink(directory: string, fileName = "social-explorer.log"): LogSink {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stream = createWriteStream(join(directory, fileName), { flags: "a", mode: 0o600 });
  return {
    write: (line) => {
      stream.write(`${line}\n`);
    },
    close: () =>
      new Promise((resolve) => {
        stream.end(() => {
          resolve();
        });
      }),
  };
}

export function createMemoryLogSink(): LogSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
    close: () => Promise.resolve(),
  };
}

/** Structured JSON-lines logger. Every message and meta value is redacted before reaching the sink. */
export function createLogger(options: LoggerOptions): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  const write = (level: LogLevel, message: string, meta: unknown): void => {
    if (LEVEL_ORDER[level] < minimum) {
      return;
    }
    options.sink.write(
      JSON.stringify({
        ts: now().toISOString(),
        level,
        message: redactText(message),
        ...(meta === undefined ? {} : { meta: redactLogValue(meta) }),
      }),
    );
  };
  return {
    debug: (message, meta) => {
      write("debug", message, meta);
    },
    info: (message, meta) => {
      write("info", message, meta);
    },
    warn: (message, meta) => {
      write("warn", message, meta);
    },
    error: (message, meta) => {
      write("error", message, meta);
    },
    close: () => options.sink.close(),
  };
}
