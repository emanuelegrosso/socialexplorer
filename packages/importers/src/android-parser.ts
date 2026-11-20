import {
  parseWithGrammar,
  type ChatGrammar,
  type HeaderParts,
  type ParseOptions,
} from "./parser-core.js";
import type { ParsedMessage, SourceLine } from "./types.js";

/** Android: `DD/MM/YYYY, HH:MM - Sender: text` (comma optional, 12h with AM/PM supported). */
export const ANDROID_HEADER =
  /^(\d{1,4})[./-](\d{1,4})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?::(\d{2}))?(?:\s*([AaPp]\.?\s?[Mm]\.?))?\s+-\s(.*)$/;
const ANDROID_LOOSE = /^\d{1,4}[./-]\d{1,4}[./-]\d{1,4}\b/;

export const androidGrammar: ChatGrammar = {
  platform: "android",
  match(line: string): HeaderParts | null {
    const m = ANDROID_HEADER.exec(line);
    if (m === null) {
      return null;
    }
    const [whole, dateA, dateB, dateC, hour, minute, second, meridiem, rest] = m;
    if (
      dateA === undefined ||
      dateB === undefined ||
      dateC === undefined ||
      hour === undefined ||
      minute === undefined ||
      rest === undefined
    ) {
      return null;
    }
    return {
      dateA,
      dateB,
      dateC,
      hour,
      minute,
      second: second ?? null,
      meridiem: meridiem ?? null,
      timestampText: whole.slice(0, whole.length - rest.length - 3),
      rest,
    };
  },
  looksLikeHeader(line: string): boolean {
    return ANDROID_LOOSE.test(line) && /\s-\s/.test(line.slice(0, 40));
  },
};

export function parseAndroidChat(
  lines: AsyncIterable<SourceLine> | Iterable<SourceLine>,
  options: ParseOptions,
): AsyncGenerator<ParsedMessage> {
  return parseWithGrammar(lines, androidGrammar, options);
}
