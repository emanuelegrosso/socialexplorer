import { throwIfAborted, type SourceLine } from "./types.js";

export type ByteSource = AsyncIterable<Uint8Array | string> | Uint8Array | string;

export interface LineReaderOptions {
  readonly signal?: AbortSignal;
  readonly chunkSize?: number;
  readonly onChunk?: (stats: { bytesProcessed: number; linesProcessed: number }) => void;
}

export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** Chars removed before grammar matching: BOM, LRM/RLM, LRE..RLO embeddings, isolates. */
export const INVISIBLE_MARKS = /[\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function stripInvisibleMarks(text: string): string {
  return text.replace(INVISIBLE_MARKS, "");
}

async function* chunkBytes(
  data: Uint8Array | string,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    yield bytes.subarray(offset, offset + chunkSize);
    await Promise.resolve();
  }
}

/**
 * Incrementally decodes UTF-8 chunks into lines. The whole file is never held in memory
 * (beyond the caller's own buffer) and no regex ever runs across the entire text.
 */
export async function* readLines(
  source: ByteSource,
  options: LineReaderOptions = {},
): AsyncGenerator<SourceLine> {
  const chunks: AsyncIterable<Uint8Array | string> =
    source instanceof Uint8Array || typeof source === "string"
      ? chunkBytes(source, options.chunkSize ?? DEFAULT_CHUNK_SIZE)
      : source;
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let pending = "";
  let lineNumber = 0;
  let bytesProcessed = 0;
  let first = true;

  const encoder = new TextEncoder();
  for await (const chunk of chunks) {
    throwIfAborted(options.signal);
    let text: string;
    if (typeof chunk === "string") {
      text = chunk;
      bytesProcessed += encoder.encode(chunk).length;
    } else {
      text = decoder.decode(chunk, { stream: true });
      bytesProcessed += chunk.length;
    }
    if (first && text.length > 0) {
      text = text.replace(/^\uFEFF/, "");
      first = false;
    }
    pending += text;
    let newline = pending.indexOf("\n");
    let start = 0;
    while (newline !== -1) {
      let line = pending.slice(start, newline);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      lineNumber++;
      yield { lineNumber, text: line };
      start = newline + 1;
      newline = pending.indexOf("\n", start);
    }
    pending = pending.slice(start);
    options.onChunk?.({ bytesProcessed, linesProcessed: lineNumber });
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    lineNumber++;
    yield { lineNumber, text: pending.endsWith("\r") ? pending.slice(0, -1) : pending };
    options.onChunk?.({ bytesProcessed, linesProcessed: lineNumber });
  }
}
