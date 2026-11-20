import { createHash } from "node:crypto";
import { parseAndroidChat } from "./android-parser.js";
import { extractGroupTitle } from "./content.js";
import {
  detectChatFormat,
  detectContainer,
  ImportFormatError,
  sampleLinesFromText,
  type DetectedFormat,
} from "./format-detection.js";
import { parseIosChat } from "./ios-parser.js";
import { DEFAULT_CHUNK_SIZE, readLines } from "./line-reader.js";
import {
  throwIfAborted,
  type ArchiveContainer,
  type ArchiveInput,
  type ChatPlatform,
  type DateOrder,
  type ParsedMessage,
  type ProgressCallback,
} from "./types.js";
import {
  DEFAULT_ZIP_LIMITS,
  inspectZip,
  streamZipEntry,
  type ZipArchiveInfo,
  type ZipEntryInfo,
  type ZipExtractionBudget,
  type ZipLimits,
} from "./zip-safety.js";

export interface ParseArchiveOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressCallback;
  readonly zipLimits?: ZipLimits;
  /** Override auto-detection. */
  readonly platform?: ChatPlatform;
  readonly dateOrder?: DateOrder;
  /** Bytes per decoded chunk; smaller values give finer progress/cancellation granularity. */
  readonly chunkSize?: number;
  readonly sampleBytes?: number;
}

export interface ParsedConversation {
  readonly sourceFile: string;
  readonly title: string;
  readonly isGroup: boolean;
  readonly format: DetectedFormat;
  readonly platform: ChatPlatform;
  readonly dateOrder: DateOrder;
  readonly records: readonly ParsedMessage[];
}

export interface ParsedArchive {
  readonly name: string;
  readonly container: ArchiveContainer;
  readonly zip: ZipArchiveInfo | null;
  readonly conversations: readonly ParsedConversation[];
  /** Names of non-chat files inside a ZIP (media candidates). Never extracted to disk. */
  readonly mediaEntries: readonly string[];
  readonly bytesTotal: number;
  readonly linesTotal: number;
}

interface ChatSource {
  readonly sourceFile: string;
  readonly size: number;
  open(signal: AbortSignal | undefined, counted: boolean): AsyncGenerator<Uint8Array>;
}

function chatEntryScore(name: string): number {
  const base = name.split("/").pop() ?? name;
  if (base === "_chat.txt") {
    return 0;
  }
  if (/^WhatsApp Chat/i.test(base)) {
    return 1;
  }
  return 2;
}

async function readSample(chunks: AsyncIterable<Uint8Array>, sampleBytes: number): Promise<string> {
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  for await (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
    total += chunk.length;
    if (total >= sampleBytes) {
      break;
    }
  }
  return text.replace(/^\uFEFF/, "");
}

async function* bytesOf(data: Uint8Array, chunkSize: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    yield data.subarray(offset, offset + chunkSize);
    await Promise.resolve();
  }
}

export function deriveTitle(sourceFile: string, records: readonly ParsedMessage[]): string {
  for (const record of records) {
    if (record.systemEvent === "group_created") {
      const title = extractGroupTitle(record.text);
      if (title !== null) {
        return title;
      }
    }
  }
  const base = (sourceFile.split("/").pop() ?? sourceFile).replace(/\.txt$/i, "");
  const named = /^WhatsApp Chat (?:with|-)\s+(.+)$/i.exec(base);
  return named?.[1] ?? base;
}

export function deriveConversationKey(title: string): string {
  const digest = createHash("sha256").update(title.normalize("NFC").toLowerCase()).digest("hex");
  return `conv_${digest.slice(0, 24)}`;
}

/**
 * Parses a TXT or ZIP export fully in memory-bounded streaming fashion. ZIP entries are
 * validated up-front (`inspectZip`) and inflated to memory only, never to disk.
 */
export async function parseArchive(
  input: ArchiveInput,
  options: ParseArchiveOptions = {},
): Promise<ParsedArchive> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const limits = options.zipLimits ?? DEFAULT_ZIP_LIMITS;
  const sampleBytes = options.sampleBytes ?? 256 * 1024;
  throwIfAborted(options.signal);
  if (input.data.length === 0) {
    throw new ImportFormatError("empty_input", "Input is empty");
  }

  const container = detectContainer(input.data);
  let zip: ZipArchiveInfo | null = null;
  const sources: ChatSource[] = [];
  const mediaEntries: string[] = [];
  const budget: ZipExtractionBudget = { extractedBytes: 0 };

  if (container === "zip") {
    const info = inspectZip(input.data, limits);
    zip = info;
    const files = info.entries.filter((entry) => !entry.isDirectory);
    const chats = files
      .filter((entry) => /\.txt$/i.test(entry.name))
      .sort(
        (a, b) => chatEntryScore(a.name) - chatEntryScore(b.name) || a.name.localeCompare(b.name),
      );
    if (chats.length === 0) {
      throw new ImportFormatError("no_chat_file", "ZIP archive contains no .txt chat export");
    }
    const bestScore = chatEntryScore(chats[0]?.name ?? "");
    const selected: ZipEntryInfo[] = chats.filter(
      (entry) => chatEntryScore(entry.name) === bestScore,
    );
    const selectedNames = new Set(selected.map((entry) => entry.name));
    for (const entry of files) {
      if (!selectedNames.has(entry.name)) {
        mediaEntries.push(entry.name);
      }
    }
    for (const entry of selected) {
      sources.push({
        sourceFile: entry.name,
        size: entry.uncompressedSize,
        open: (signal, counted) =>
          streamZipEntry(input.data, entry, {
            limits,
            ...(counted ? { budget } : {}),
            ...(signal ? { signal } : {}),
          }),
      });
    }
  } else {
    sources.push({
      sourceFile: input.name,
      size: input.data.length,
      open: () => bytesOf(input.data, chunkSize),
    });
  }

  const bytesTotal = sources.reduce((sum, source) => sum + source.size, 0);
  const conversations: ParsedConversation[] = [];
  let bytesBefore = 0;
  let linesBefore = 0;

  for (const source of sources) {
    const sample = await readSample(source.open(options.signal, false), sampleBytes);
    const format = detectChatFormat(sampleLinesFromText(sample));
    const platform = options.platform ?? (format.platform === "unknown" ? null : format.platform);
    if (platform === null) {
      throw new ImportFormatError(
        "unknown_format",
        `Could not recognize an Android or iOS WhatsApp export in "${source.sourceFile}"`,
      );
    }
    const dateOrder = options.dateOrder ?? format.dateOrder;

    let linesInFile = 0;
    const reader = readLines(source.open(options.signal, true), {
      ...(options.signal ? { signal: options.signal } : {}),
      onChunk: (stats) => {
        linesInFile = stats.linesProcessed;
        options.onProgress?.({
          phase: "parse",
          bytesProcessed: bytesBefore + stats.bytesProcessed,
          bytesTotal,
          linesProcessed: linesBefore + stats.linesProcessed,
        });
      },
    });
    const parseOptions = {
      sourceFile: source.sourceFile,
      dateOrder,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const stream =
      platform === "android"
        ? parseAndroidChat(reader, parseOptions)
        : parseIosChat(reader, parseOptions);
    const records: ParsedMessage[] = [];
    for await (const record of stream) {
      records.push(record);
    }
    throwIfAborted(options.signal);

    const senders = new Set(
      records.flatMap((record) =>
        record.kind === "message" && record.sender ? [record.sender] : [],
      ),
    );
    const isGroup =
      records.some((record) => record.systemEvent === "group_created") || senders.size > 2;
    conversations.push({
      sourceFile: source.sourceFile,
      title: deriveTitle(source.sourceFile, records),
      isGroup,
      format,
      platform,
      dateOrder,
      records,
    });
    bytesBefore += source.size;
    linesBefore += linesInFile;
  }

  return {
    name: input.name,
    container,
    zip,
    conversations,
    mediaEntries,
    bytesTotal,
    linesTotal: linesBefore,
  };
}
