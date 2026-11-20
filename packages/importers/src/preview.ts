import {
  buildConfirmationOptions,
  type ImportConfirmationOptions,
  type TimezoneOptions,
} from "./confirmation.js";
import type { DetectedFormat } from "./format-detection.js";
import { parseArchive, type ParseArchiveOptions, type ParsedArchive } from "./parse-archive.js";
import type {
  ArchiveContainer,
  ChatPlatform,
  LinkProvider,
  ParseStatus,
  ParsedMessage,
} from "./types.js";

export interface PreviewOptions extends ParseArchiveOptions, TimezoneOptions {
  readonly maxSamples?: number;
}

export interface ContactCandidate {
  readonly displayName: string;
  readonly messageCount: number;
}

export interface PreviewSample {
  readonly sourceFile: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly parseStatus: ParseStatus;
  readonly issues: readonly string[];
  readonly excerpt: string;
}

export interface ConversationPreview {
  readonly sourceFile: string;
  readonly title: string;
  readonly isGroup: boolean;
  readonly format: DetectedFormat;
  readonly recordCount: number;
  readonly messageCount: number;
  readonly systemMessageCount: number;
  readonly countsByParseStatus: Readonly<Record<ParseStatus, number>>;
  readonly contactCandidates: readonly ContactCandidate[];
  readonly dateRange: { readonly first: string; readonly last: string } | null;
}

export interface ImportPreview {
  readonly name: string;
  readonly container: ArchiveContainer;
  readonly platform: ChatPlatform;
  readonly conversationCount: number;
  readonly conversations: readonly ConversationPreview[];
  readonly contactCandidates: readonly ContactCandidate[];
  readonly countsByParseStatus: Readonly<Record<ParseStatus, number>>;
  readonly totalRecords: number;
  readonly mediaReferenceCount: number;
  readonly mediaAttachedCount: number;
  readonly mediaOmittedCount: number;
  /** Attached file names not found in the ZIP (always all of them for TXT exports). */
  readonly missingMedia: readonly string[];
  readonly externalLinkCount: number;
  readonly externalLinksByProvider: Readonly<Record<LinkProvider, number>>;
  readonly dateRange: { readonly first: string; readonly last: string } | null;
  readonly warnings: readonly PreviewSample[];
  readonly unparsedSamples: readonly PreviewSample[];
  readonly confirmation: ImportConfirmationOptions;
  readonly bytesTotal: number;
  readonly linesTotal: number;
}

const isoDate = (record: ParsedMessage): string | null =>
  record.date === null
    ? null
    : `${String(record.date.year).padStart(4, "0")}-${String(record.date.month).padStart(2, "0")}-${String(record.date.day).padStart(2, "0")}`;

function emptyCounts(): Record<ParseStatus, number> {
  return { complete: 0, partial: 0, unparsed: 0 };
}

function sampleOf(record: ParsedMessage): PreviewSample {
  return {
    sourceFile: record.sourceFile,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    parseStatus: record.parseStatus,
    issues: record.issues.map((issue) => issue.code),
    excerpt: (record.rawLines[0] ?? "").slice(0, 160),
  };
}

function rangeOf(records: readonly ParsedMessage[]): { first: string; last: string } | null {
  let first: string | null = null;
  let last: string | null = null;
  for (const record of records) {
    const date = isoDate(record);
    if (date === null) {
      continue;
    }
    if (first === null || date < first) {
      first = date;
    }
    if (last === null || date > last) {
      last = date;
    }
  }
  return first === null || last === null ? null : { first, last };
}

function contactsOf(records: readonly ParsedMessage[]): ContactCandidate[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.kind === "message" && record.sender !== null) {
      counts.set(record.sender, (counts.get(record.sender) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([displayName, messageCount]) => ({ displayName, messageCount }))
    .sort((a, b) => b.messageCount - a.messageCount || a.displayName.localeCompare(b.displayName));
}

export function summarizeArchive(
  archive: ParsedArchive,
  options: PreviewOptions = {},
): ImportPreview {
  const maxSamples = options.maxSamples ?? 20;
  const all = archive.conversations.flatMap((conversation) => conversation.records);
  const counts = emptyCounts();
  const providers: Record<LinkProvider, number> = {
    spotify: 0,
    youtube: 0,
    apple_music: 0,
    other: 0,
  };
  const warnings: PreviewSample[] = [];
  const unparsedSamples: PreviewSample[] = [];
  let mediaAttached = 0;
  let mediaOmitted = 0;
  let linkCount = 0;
  const attachedNames = new Set<string>();

  for (const record of all) {
    counts[record.parseStatus]++;
    for (const media of record.media) {
      if (media.kind === "attached") {
        mediaAttached++;
        if (media.fileName !== null) {
          attachedNames.add(media.fileName);
        }
      } else {
        mediaOmitted++;
      }
    }
    for (const link of record.links) {
      linkCount++;
      providers[link.provider]++;
    }
    if (record.parseStatus === "unparsed" && unparsedSamples.length < maxSamples) {
      unparsedSamples.push(sampleOf(record));
    }
    if (record.parseStatus !== "complete" && warnings.length < maxSamples) {
      warnings.push(sampleOf(record));
    }
  }

  const zipBaseNames = new Set(
    archive.mediaEntries.map((entry) => entry.split("/").pop() ?? entry),
  );
  const missingMedia = [...attachedNames].filter((name) => !zipBaseNames.has(name)).sort();

  const conversations: ConversationPreview[] = archive.conversations.map((conversation) => {
    const perStatus = emptyCounts();
    for (const record of conversation.records) {
      perStatus[record.parseStatus]++;
    }
    return {
      sourceFile: conversation.sourceFile,
      title: conversation.title,
      isGroup: conversation.isGroup,
      format: conversation.format,
      recordCount: conversation.records.length,
      messageCount: conversation.records.filter((record) => record.kind === "message").length,
      systemMessageCount: conversation.records.filter((record) => record.kind === "system").length,
      countsByParseStatus: perStatus,
      contactCandidates: contactsOf(conversation.records),
      dateRange: rangeOf(conversation.records),
    };
  });

  const platform = archive.conversations[0]?.platform;
  if (platform === undefined) {
    throw new Error("Archive has no conversations");
  }
  return {
    name: archive.name,
    container: archive.container,
    platform,
    conversationCount: conversations.length,
    conversations,
    contactCandidates: contactsOf(all),
    countsByParseStatus: counts,
    totalRecords: all.length,
    mediaReferenceCount: mediaAttached + mediaOmitted,
    mediaAttachedCount: mediaAttached,
    mediaOmittedCount: mediaOmitted,
    missingMedia,
    externalLinkCount: linkCount,
    externalLinksByProvider: providers,
    dateRange: rangeOf(all),
    warnings,
    unparsedSamples,
    confirmation: buildConfirmationOptions(archive, options),
    bytesTotal: archive.bytesTotal,
    linesTotal: archive.linesTotal,
  };
}

export interface ArchivePreviewResult {
  readonly preview: ImportPreview;
  readonly archive: ParsedArchive;
}

/**
 * Parses and summarizes an archive without any persistence. Supports progress callbacks and
 * cooperative cancellation through `options.signal`.
 */
export async function previewArchiveImport(
  input: { readonly name: string; readonly data: Uint8Array },
  options: PreviewOptions = {},
): Promise<ArchivePreviewResult> {
  options.onProgress?.({
    phase: "inspect",
    bytesProcessed: 0,
    bytesTotal: input.data.length,
    linesProcessed: 0,
  });
  const archive = await parseArchive(input, options);
  options.onProgress?.({
    phase: "summarize",
    bytesProcessed: archive.bytesTotal,
    bytesTotal: archive.bytesTotal,
    linesProcessed: archive.linesTotal,
  });
  return { preview: summarizeArchive(archive, options), archive };
}
