import type { MediaAsset } from "@social-explorer/contracts";

export type SniffedKind = Extract<MediaAsset["kind"], "image" | "video" | "audio">;

export interface SniffedMedia {
  readonly mimeType: string;
  readonly kind: SniffedKind;
  /** Canonical, generated file extension (never taken from an archive file name). */
  readonly extension: string;
}

export const SNIFF_HEAD_BYTES = 4096;

export const SUPPORTED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "video/mp4",
  "video/webm",
] as const;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** Identifies a media file from its leading bytes only; file names and extensions are ignored. */
export function sniffMedia(head: Uint8Array): SniffedMedia | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", kind: "image", extension: "png" };
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", kind: "image", extension: "jpg" };
  }
  const gif = ascii(head, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { mimeType: "image/gif", kind: "image", extension: "gif" };
  }
  if (ascii(head, 0, 4) === "RIFF" && head.length >= 12) {
    const form = ascii(head, 8, 4);
    if (form === "WEBP") {
      return { mimeType: "image/webp", kind: "image", extension: "webp" };
    }
    if (form === "WAVE") {
      return { mimeType: "audio/wav", kind: "audio", extension: "wav" };
    }
    return undefined;
  }
  if (ascii(head, 0, 4) === "OggS") {
    const isOpus = ascii(head, 0, Math.min(head.length, 128)).includes("OpusHead");
    return isOpus
      ? { mimeType: "audio/opus", kind: "audio", extension: "opus" }
      : { mimeType: "audio/ogg", kind: "audio", extension: "ogg" };
  }
  if (head.length >= 12 && ascii(head, 4, 4) === "ftyp") {
    return { mimeType: "video/mp4", kind: "video", extension: "mp4" };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mimeType: "video/webm", kind: "video", extension: "webm" };
  }
  if (ascii(head, 0, 3) === "ID3") {
    return { mimeType: "audio/mpeg", kind: "audio", extension: "mp3" };
  }
  const b0 = head[0];
  const b1 = head[1];
  if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0) {
    return { mimeType: "audio/mpeg", kind: "audio", extension: "mp3" };
  }
  return undefined;
}
