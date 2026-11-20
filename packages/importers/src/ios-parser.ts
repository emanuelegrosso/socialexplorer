import {
  parseWithGrammar,
  type ChatGrammar,
  type HeaderParts,
  type ParseOptions,
} from "./parser-core.js";
import type { ParsedMessage, SourceLine } from "./types.js";

/** iOS: `[DD/MM/YY, HH:MM:SS] Sender: text` (bracketed, comma required, 12h supported). */
export const IOS_HEADER =
  /^\[(\d{1,4})[./-](\d{1,4})[./-](\d{1,4}),\s+(\d{1,2})[:.](\d{2})(?::(\d{2}))?(?:\s*([AaPp]\.?\s?[Mm]\.?))?\]\s?(.*)$/;
const IOS_LOOSE = /^\[\d/;

export const iosGrammar: ChatGrammar = {
  platform: "ios",
  match(line: string): HeaderParts | null {
    const m = IOS_HEADER.exec(line);
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
    const closing = whole.indexOf("]");
    return {
      dateA,
      dateB,
      dateC,
      hour,
      minute,
      second: second ?? null,
      meridiem: meridiem ?? null,
      timestampText: whole.slice(1, closing),
      rest,
    };
  },
  looksLikeHeader(line: string): boolean {
    return IOS_LOOSE.test(line);
  },
};

export function parseIosChat(
  lines: AsyncIterable<SourceLine> | Iterable<SourceLine>,
  options: ParseOptions,
): AsyncGenerator<ParsedMessage> {
  return parseWithGrammar(lines, iosGrammar, options);
}
