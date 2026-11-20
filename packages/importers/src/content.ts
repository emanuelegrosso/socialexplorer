import type {
  ExternalLink,
  LinkProvider,
  MediaReference,
  MediaType,
  SystemEventKind,
} from "./types.js";

const OMITTED_ANGLE =
  /^<[^<>]*(?:omitted|omessi|omesso|omitido|omitida|ausgeschlossen|oculta|oculto|omis|omise|weggelaten)[^<>]*>$/i;
const OMITTED_WORD =
  /^(image|video|audio|sticker|gif|document|voice message|contact card|photo)\s+omitted$/i;
const FILE_ATTACHED = /^(.+?\.[A-Za-z0-9]{2,5})\s+\(file attached\)$/;
const ATTACHED_TAG = /<attached:\s*([^<>]+?)\s*>/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'“”]+/gi;

const EXTENSION_TYPES: Record<string, MediaType> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  heic: "image",
  webp: "image",
  gif: "gif",
  mp4: "video",
  mov: "video",
  "3gp": "video",
  mkv: "video",
  opus: "audio",
  ogg: "audio",
  m4a: "audio",
  mp3: "audio",
  wav: "audio",
  aac: "audio",
  amr: "audio",
  pdf: "document",
  docx: "document",
  xlsx: "document",
  pptx: "document",
  txt: "document",
  vcf: "document",
};

export function mediaTypeFromFileName(fileName: string): MediaType {
  const extension = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase();
  const byExtension = extension === undefined ? undefined : EXTENSION_TYPES[extension];
  if (extension === "webp" && /^STK-|-STICKER-/i.test(fileName)) {
    return "sticker";
  }
  return byExtension ?? "unknown";
}

function mediaTypeFromWord(word: string): MediaType {
  switch (word.toLowerCase()) {
    case "image":
    case "photo":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "voice message":
      return "audio";
    case "sticker":
      return "sticker";
    case "gif":
      return "gif";
    case "document":
      return "document";
    default:
      return "unknown";
  }
}

export interface ExtractedContent {
  readonly media: MediaReference[];
  readonly mediaOmitted: boolean;
}

export function extractMedia(text: string): ExtractedContent {
  const media: MediaReference[] = [];
  const trimmed = text.trim();
  let mediaOmitted = false;

  if (OMITTED_ANGLE.test(trimmed)) {
    media.push({ kind: "omitted", fileName: null, mediaType: "unknown", marker: trimmed });
    mediaOmitted = true;
  }
  const word = OMITTED_WORD.exec(trimmed);
  if (word?.[1] !== undefined) {
    media.push({
      kind: "omitted",
      fileName: null,
      mediaType: mediaTypeFromWord(word[1]),
      marker: trimmed,
    });
    mediaOmitted = true;
  }
  for (const line of text.split("\n")) {
    const attached = FILE_ATTACHED.exec(line.trim());
    if (attached?.[1] !== undefined) {
      media.push({
        kind: "attached",
        fileName: attached[1],
        mediaType: mediaTypeFromFileName(attached[1]),
        marker: line.trim(),
      });
    }
  }
  for (const match of text.matchAll(ATTACHED_TAG)) {
    const fileName = match[1];
    if (fileName !== undefined) {
      media.push({
        kind: "attached",
        fileName,
        mediaType: mediaTypeFromFileName(fileName),
        marker: match[0],
      });
    }
  }
  return { media, mediaOmitted };
}

function providerFor(host: string): LinkProvider {
  if (host === "open.spotify.com" || host === "spotify.link" || host.endsWith(".spotify.com")) {
    return "spotify";
  }
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
    return "youtube";
  }
  if (host === "music.apple.com" || host === "itunes.apple.com") {
    return "apple_music";
  }
  return "other";
}

export function extractLinks(text: string): ExternalLink[] {
  const links: ExternalLink[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:!?)\]}]+$/, "");
    if (seen.has(url)) {
      continue;
    }
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    seen.add(url);
    links.push({ url, provider: providerFor(host), host });
  }
  return links;
}

export function isDeletedMarker(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === "You deleted this message" ||
    trimmed === "This message was deleted" ||
    trimmed === "You deleted this message."
  );
}

export function classifySystemEvent(text: string): SystemEventKind {
  if (/end-to-end encrypted/i.test(text)) {
    return "encryption_notice";
  }
  if (/created (?:this )?group/i.test(text)) {
    return "group_created";
  }
  if (/changed (?:this group.s|the group) icon/i.test(text)) {
    return "icon_changed";
  }
  if (/changed the (?:subject|group name|group description)/i.test(text)) {
    return "subject_changed";
  }
  if (/\sremoved\s/i.test(text)) {
    return "member_removed";
  }
  if (/\sleft$/i.test(text.trim())) {
    return "member_left";
  }
  if (/\sadded\s|\sjoined\s/i.test(text)) {
    return "member_added";
  }
  return "other";
}

const GROUP_TITLE = /created (?:this )?group\s+["“”'‘’]?(.+?)["“”'‘’]?\s*$/i;

export function extractGroupTitle(text: string): string | null {
  return GROUP_TITLE.exec(text.trim())?.[1] ?? null;
}
