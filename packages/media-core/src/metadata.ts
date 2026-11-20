/** Pure-Node, best-effort metadata readers. They never throw on malformed input. */
export interface MediaMetadata {
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

function u32be(b: Uint8Array, o: number): number {
  return (
    (b[o] ?? 0) * 0x1000000 + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0)
  );
}
function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}
function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
}
function u32le(b: Uint8Array, o: number): number {
  return u16le(b, o) + u16le(b, o + 2) * 0x10000;
}
function tag(b: Uint8Array, o: number, n = 4): string {
  return String.fromCharCode(...Array.from(b.subarray(o, o + n)));
}

function valid(width: number, height: number): MediaMetadata {
  return width > 0 && height > 0 && width < 1_000_000 && height < 1_000_000
    ? { width, height }
    : {};
}

export function readPngDimensions(b: Uint8Array): MediaMetadata {
  if (b.length < 24 || tag(b, 12) !== "IHDR") {
    return {};
  }
  return valid(u32be(b, 16), u32be(b, 20));
}

export function readGifDimensions(b: Uint8Array): MediaMetadata {
  return b.length < 10 ? {} : valid(u16le(b, 6), u16le(b, 8));
}

export function readJpegDimensions(b: Uint8Array): MediaMetadata {
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = b[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = u16be(b, offset + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return valid(u16be(b, offset + 7), u16be(b, offset + 5));
    }
    if (length < 2) {
      return {};
    }
    offset += 2 + length;
  }
  return {};
}

export function readWebpDimensions(b: Uint8Array): MediaMetadata {
  if (b.length < 30) {
    return {};
  }
  const chunk = tag(b, 12);
  if (chunk === "VP8X") {
    return valid(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  if (chunk === "VP8L") {
    const bits = u32le(b, 21);
    return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    return valid(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  return {};
}

export function readWavDuration(b: Uint8Array): MediaMetadata {
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= b.length) {
    const id = tag(b, offset);
    const size = u32le(b, offset + 4);
    if (id === "fmt " && offset + 20 <= b.length) {
      byteRate = u32le(b, offset + 16);
    } else if (id === "data") {
      if (byteRate <= 0) {
        return {};
      }
      const available = Math.min(size, Math.max(0, b.length - offset - 8));
      const bytes = size === 0xffffffff || size === 0 ? available : size;
      return { durationMs: Math.round((bytes / byteRate) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  return {};
}

/** Reads dimensions/duration from the leading bytes when the MIME type is parseable. */
export function readMediaMetadata(mimeType: string, bytes: Uint8Array): MediaMetadata {
  switch (mimeType) {
    case "image/png":
      return readPngDimensions(bytes);
    case "image/gif":
      return readGifDimensions(bytes);
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
    case "audio/wav":
      return readWavDuration(bytes);
    default:
      return {};
  }
}
