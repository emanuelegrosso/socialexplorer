export type ChatPlatform = "android" | "ios";
export type ArchiveContainer = "txt" | "zip";
export type DateOrder = "DMY" | "MDY" | "YMD";
export type HourCycle = "12h" | "24h" | "unknown";
export type ParseStatus = "complete" | "partial" | "unparsed";
export type MessageKind = "message" | "system" | "unparsed";
export type Direction = "incoming" | "outgoing" | "system";
export type TimestampPrecision = "minute" | "second";

export type SystemEventKind =
  | "encryption_notice"
  | "group_created"
  | "member_added"
  | "member_removed"
  | "member_left"
  | "subject_changed"
  | "icon_changed"
  | "other";

export type MediaType = "image" | "video" | "audio" | "sticker" | "gif" | "document" | "unknown";

export interface MediaReference {
  /** `attached` names a file in the export; `omitted` is a placeholder without a file. */
  readonly kind: "attached" | "omitted";
  readonly fileName: string | null;
  readonly mediaType: MediaType;
  readonly marker: string;
}

export type LinkProvider = "spotify" | "youtube" | "apple_music" | "other";

export interface ExternalLink {
  readonly url: string;
  readonly provider: LinkProvider;
  readonly host: string;
}

export interface ParseIssue {
  readonly code: string;
  readonly message: string;
}

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface LocalTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number | null;
}

export interface ParsedMessage {
  /** Ordinal of this record within its source file. */
  readonly ordinal: number;
  readonly sourceFile: string;
  readonly platform: ChatPlatform;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Original lines exactly as read (provenance), before invisible-mark stripping. */
  readonly rawLines: readonly string[];
  readonly parseStatus: ParseStatus;
  readonly issues: readonly ParseIssue[];
  readonly kind: MessageKind;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  /** Original timestamp text as found in the export. */
  readonly timestampText: string | null;
  readonly sender: string | null;
  readonly text: string;
  readonly media: readonly MediaReference[];
  readonly links: readonly ExternalLink[];
  readonly mediaOmitted: boolean;
  readonly deleted: boolean;
  readonly systemEvent: SystemEventKind | null;
}

export interface SourceLine {
  readonly lineNumber: number;
  readonly text: string;
}

export interface ImportProgress {
  readonly phase: "inspect" | "parse" | "summarize";
  readonly bytesProcessed: number;
  readonly bytesTotal: number;
  readonly linesProcessed: number;
}

export type ProgressCallback = (progress: ImportProgress) => void;

export class ImportAbortedError extends Error {
  override readonly name = "AbortError";
  constructor(message = "Import was canceled") {
    super(message);
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ImportAbortedError();
  }
}

export interface ArchiveInput {
  readonly name: string;
  readonly data: Uint8Array;
}
