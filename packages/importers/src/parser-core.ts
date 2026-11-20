import { classifySystemEvent, extractLinks, extractMedia, isDeletedMarker } from "./content.js";
import { stripInvisibleMarks } from "./line-reader.js";
import {
  throwIfAborted,
  type ChatPlatform,
  type DateOrder,
  type LocalDate,
  type LocalTime,
  type ParseIssue,
  type ParsedMessage,
  type SourceLine,
} from "./types.js";

export interface HeaderParts {
  readonly dateA: string;
  readonly dateB: string;
  readonly dateC: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string | null;
  readonly meridiem: string | null;
  readonly timestampText: string;
  readonly rest: string;
}

/** Platform-specific line grammar. Each adapter owns its own header recognition. */
export interface ChatGrammar {
  readonly platform: ChatPlatform;
  match(strippedLine: string): HeaderParts | null;
  /** True when a non-matching line still looks like a (malformed) message header. */
  looksLikeHeader(strippedLine: string): boolean;
}

export interface ParseOptions {
  readonly sourceFile: string;
  readonly dateOrder: DateOrder;
  readonly signal?: AbortSignal | undefined;
}

type Lines = AsyncIterable<SourceLine> | Iterable<SourceLine>;

interface Draft {
  readonly lineStart: number;
  lineEnd: number;
  readonly rawLines: string[];
  readonly bodyLines: string[];
  readonly header: HeaderParts | null;
  readonly forcedUnparsed: boolean;
  readonly forcedIssues: ParseIssue[];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function resolveDate(
  header: Pick<HeaderParts, "dateA" | "dateB" | "dateC">,
  order: DateOrder,
): LocalDate | null {
  const { dateA, dateB, dateC } = header;
  let year: number;
  let month: number;
  let day: number;
  if (dateA.length === 4) {
    year = Number(dateA);
    month = Number(dateB);
    day = Number(dateC);
  } else {
    const first = Number(dateA);
    const second = Number(dateB);
    year = Number(dateC);
    if (dateC.length <= 2) {
      year += 2000;
    }
    if (order === "MDY") {
      month = first;
      day = second;
    } else {
      day = first;
      month = second;
    }
  }
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 2200) {
    return null;
  }
  if (day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

export function resolveTime(
  header: Pick<HeaderParts, "hour" | "minute" | "second" | "meridiem">,
): LocalTime | null {
  let hour = Number(header.hour);
  const minute = Number(header.minute);
  const second = header.second === null ? null : Number(header.second);
  if (header.meridiem !== null) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    const pm = header.meridiem.toLowerCase().startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || (second !== null && second > 59)) {
    return null;
  }
  return { hour, minute, second };
}

function splitSender(rest: string): { sender: string | null; text: string } {
  const index = rest.indexOf(": ");
  if (index <= 0) {
    return { sender: null, text: rest };
  }
  const prefix = rest.slice(0, index);
  if (prefix.length > 80 || /["“”]/.test(prefix) || /end-to-end encrypted/i.test(prefix)) {
    return { sender: null, text: rest };
  }
  return { sender: prefix.trim(), text: rest.slice(index + 2) };
}

function finalize(
  draft: Draft,
  grammar: ChatGrammar,
  options: ParseOptions,
  ordinal: number,
): ParsedMessage {
  const base = {
    ordinal,
    sourceFile: options.sourceFile,
    platform: grammar.platform,
    lineStart: draft.lineStart,
    lineEnd: draft.lineEnd,
    rawLines: draft.rawLines,
  };
  const emptyContent = {
    media: [],
    links: [],
    mediaOmitted: false,
    deleted: false,
    systemEvent: null,
  };

  if (draft.forcedUnparsed || draft.header === null) {
    return {
      ...base,
      parseStatus: "unparsed",
      issues: draft.forcedIssues,
      kind: "unparsed",
      date: null,
      time: null,
      timestampText: draft.header?.timestampText ?? null,
      sender: null,
      text: draft.rawLines.map(stripInvisibleMarks).join("\n"),
      ...emptyContent,
    };
  }

  const header = draft.header;
  const issues = [...draft.forcedIssues];
  const date = resolveDate(header, options.dateOrder);
  const time = resolveTime(header);
  if (time === null) {
    issues.push({
      code: "invalid_time",
      message: `Invalid time "${header.hour}:${header.minute}"`,
    });
  }
  const bodyText = draft.bodyLines.join("\n").replace(/\s+$/, "");
  const { sender, text } = splitSender(bodyText);
  const isSystem = sender === null;
  const { media, mediaOmitted } = extractMedia(text);
  return {
    ...base,
    parseStatus: issues.length === 0 && date !== null ? "complete" : "partial",
    issues,
    kind: isSystem ? "system" : "message",
    date,
    time,
    timestampText: header.timestampText,
    sender,
    text,
    media,
    links: extractLinks(text),
    mediaOmitted,
    deleted: !isSystem && isDeletedMarker(text),
    systemEvent: isSystem ? classifySystemEvent(text) : null,
  };
}

/**
 * Line-by-line state machine shared by the platform adapters. Every input line ends up in
 * exactly one emitted record, so nothing is silently dropped.
 */
export async function* parseWithGrammar(
  lines: Lines,
  grammar: ChatGrammar,
  options: ParseOptions,
): AsyncGenerator<ParsedMessage> {
  let draft: Draft | null = null;
  let ordinal = 0;

  const flush = (): ParsedMessage | null => {
    if (draft === null) {
      return null;
    }
    const record = finalize(draft, grammar, options, ordinal++);
    draft = null;
    return record;
  };

  for await (const line of lines as AsyncIterable<SourceLine>) {
    throwIfAborted(options.signal);
    const stripped = stripInvisibleMarks(line.text);
    const header = grammar.match(stripped);

    if (header !== null) {
      const previous = flush();
      if (previous) {
        yield previous;
      }
      const date = resolveDate(header, options.dateOrder);
      const issues: ParseIssue[] = [];
      if (date === null) {
        issues.push({
          code: "invalid_date",
          message: `Date "${header.dateA}/${header.dateB}/${header.dateC}" is invalid for order ${options.dateOrder}`,
        });
      }
      draft = {
        lineStart: line.lineNumber,
        lineEnd: line.lineNumber,
        rawLines: [line.text],
        bodyLines: [header.rest],
        header,
        forcedUnparsed: date === null,
        forcedIssues: issues,
      };
      continue;
    }

    if (grammar.looksLikeHeader(stripped)) {
      const previous = flush();
      if (previous) {
        yield previous;
      }
      draft = {
        lineStart: line.lineNumber,
        lineEnd: line.lineNumber,
        rawLines: [line.text],
        bodyLines: [stripped],
        header: null,
        forcedUnparsed: true,
        forcedIssues: [
          {
            code: "malformed_header",
            message: "Line resembles a message header but did not parse",
          },
        ],
      };
      continue;
    }

    if (draft === null) {
      if (stripped.trim().length === 0) {
        continue;
      }
      draft = {
        lineStart: line.lineNumber,
        lineEnd: line.lineNumber,
        rawLines: [line.text],
        bodyLines: [stripped],
        header: null,
        forcedUnparsed: true,
        forcedIssues: [{ code: "orphan_line", message: "Line has no preceding message header" }],
      };
      continue;
    }

    draft.rawLines.push(line.text);
    draft.bodyLines.push(stripped);
    if (stripped.trim().length > 0) {
      draft.lineEnd = line.lineNumber;
    }
  }

  const last = flush();
  if (last) {
    yield last;
  }
}
