import { ANDROID_HEADER } from "./android-parser.js";
import { IOS_HEADER } from "./ios-parser.js";
import { stripInvisibleMarks } from "./line-reader.js";
import { isZipData } from "./zip-safety.js";
import type { ArchiveContainer, ChatPlatform, DateOrder, HourCycle } from "./types.js";

export class ImportFormatError extends Error {
  override readonly name = "ImportFormatError";
  constructor(
    readonly code: "unknown_format" | "no_chat_file" | "empty_input",
    message: string,
  ) {
    super(message);
  }
}

export interface DetectedFormat {
  readonly platform: ChatPlatform | "unknown";
  /** 0..1 share of recognized header lines matching the winning grammar (halved for a single sample). */
  readonly confidence: number;
  readonly bracketed: boolean;
  readonly dateOrder: DateOrder;
  /** `ambiguous` when every sampled date is compatible with both DD/MM and MM/DD. */
  readonly dateOrderConfidence: "certain" | "likely" | "ambiguous";
  readonly hourCycle: HourCycle;
  readonly hasSeconds: boolean;
  readonly sampledLines: number;
  readonly matchedLines: number;
}

export function detectContainer(data: Uint8Array): ArchiveContainer {
  return isZipData(data) ? "zip" : "txt";
}

export function detectChatFormat(sampleLines: readonly string[]): DetectedFormat {
  let android = 0;
  let ios = 0;
  let sampled = 0;
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  let twelve = 0;
  let twentyFour = 0;
  let seconds = 0;

  for (const raw of sampleLines) {
    const line = stripInvisibleMarks(raw);
    if (line.trim().length === 0) {
      continue;
    }
    sampled++;
    const a = ANDROID_HEADER.exec(line);
    const i = IOS_HEADER.exec(line);
    const m = i ?? a;
    if (m === null) {
      continue;
    }
    if (i === null) {
      android++;
    } else {
      ios++;
    }
    const [, dateA = "", dateB = "", , hour = "", , second, meridiem] = m;
    if (dateA.length === 4) {
      ymd++;
    } else {
      const first = Number(dateA);
      const second2 = Number(dateB);
      if (first > 12 && second2 <= 12) {
        dmy++;
      } else if (second2 > 12 && first <= 12) {
        mdy++;
      }
    }
    if (meridiem === undefined) {
      if (Number(hour) > 12 || hour.length === 2) {
        twentyFour++;
      }
    } else {
      twelve++;
    }
    if (second !== undefined) {
      seconds++;
    }
  }

  const matched = android + ios;
  const platform: ChatPlatform | "unknown" =
    matched === 0 ? "unknown" : ios >= android ? "ios" : "android";
  const winning = Math.max(android, ios);

  let dateOrder: DateOrder = "DMY";
  let dateOrderConfidence: DetectedFormat["dateOrderConfidence"] = "ambiguous";
  if (ymd > 0 && dmy === 0 && mdy === 0) {
    dateOrder = "YMD";
    dateOrderConfidence = "certain";
  } else if (dmy > 0 && mdy === 0) {
    dateOrder = "DMY";
    dateOrderConfidence = "certain";
  } else if (mdy > 0 && dmy === 0) {
    dateOrder = "MDY";
    dateOrderConfidence = "certain";
  } else if (dmy > 0 && mdy > 0) {
    dateOrder = dmy >= mdy ? "DMY" : "MDY";
    dateOrderConfidence = "likely";
  }

  return {
    platform,
    confidence: matched === 0 ? 0 : (winning / matched) * (matched < 2 ? 0.5 : 1),
    bracketed: platform === "ios",
    dateOrder,
    dateOrderConfidence,
    hourCycle: twelve > 0 && twentyFour === 0 ? "12h" : twentyFour > 0 ? "24h" : "unknown",
    hasSeconds: matched > 0 && seconds / matched > 0.5,
    sampledLines: sampled,
    matchedLines: matched,
  };
}

export function sampleLinesFromText(text: string, maxLines = 500): string[] {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < maxLines && start <= text.length) {
    const end = text.indexOf("\n", start);
    if (end === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, end).replace(/\r$/, ""));
    start = end + 1;
  }
  return lines;
}
