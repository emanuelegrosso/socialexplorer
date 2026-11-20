import type { ExternalMediaLink, SoundtrackRightsStatus } from "@social-explorer/contracts";

/**
 * Link recognition is purely lexical. These flags are invariants, not options: the module
 * performs no network access, no scraping/metadata fetching, no downloading and no DRM
 * circumvention. Provider content is only ever referenced, never embedded in exports.
 */
export const EXTERNAL_LINK_POLICY = {
  networkAccess: false,
  scraping: false,
  downloading: false,
  drmBypass: false,
} as const;

export type LinkProviderName = "spotify" | "youtube" | "apple-music" | "other";
export type LinkContentKind =
  | "track"
  | "album"
  | "playlist"
  | "episode"
  | "show"
  | "artist"
  | "video"
  | "short"
  | "song"
  | "music-video"
  | "unknown";

export interface ClassifiedLink {
  readonly originalUrl: string;
  readonly canonicalUrl: string;
  readonly provider: LinkProviderName;
  readonly linkKind: ExternalMediaLink["linkKind"];
  readonly contentKind: LinkContentKind;
  readonly resourceId?: string;
  readonly host: string;
  /** True for music.youtube.com. */
  readonly musicSurface: boolean;
  /** Provider content is never exportable; unknown generic links stay `unknown`. */
  readonly rightsStatus: Extract<SoundtrackRightsStatus, "not-for-export" | "unknown">;
  readonly exportStatus: "reference-only";
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'“”‘’«»]+/giu;
const TRAILING = /[.,;:!?)\]}>'"”’]+$/u;
const ID = /^[A-Za-z0-9_-]+$/u;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function base(
  original: string,
  host: string,
  fields: Pick<ClassifiedLink, "canonicalUrl" | "provider" | "linkKind" | "contentKind"> &
    Partial<Pick<ClassifiedLink, "resourceId" | "musicSurface">>,
): ClassifiedLink {
  return {
    originalUrl: original,
    host,
    musicSurface: false,
    rightsStatus: fields.provider === "other" ? "unknown" : "not-for-export",
    exportStatus: "reference-only",
    ...fields,
  };
}

function classifySpotify(original: string, url: URL): ClassifiedLink | undefined {
  const host = url.hostname;
  if (host === "spotify.link" || hostMatches(host, "spotify.link")) {
    return base(original, host, {
      canonicalUrl: `https://${host}${url.pathname}`,
      provider: "spotify",
      linkKind: "music",
      contentKind: "unknown",
    });
  }
  const segments = url.pathname.split("/").filter(Boolean);
  while (segments[0] !== undefined && /^(intl-[a-z]{2,3}|embed)$/iu.test(segments[0])) {
    segments.shift();
  }
  if (segments[0] === "user" && segments[2] === "playlist") {
    segments.splice(0, 3, "playlist");
  }
  const kind = segments[0];
  const id = segments[1];
  const known = ["track", "album", "playlist", "episode", "show", "artist"] as const;
  const found = known.find((candidate) => candidate === kind);
  if (found === undefined || id === undefined || !/^[A-Za-z0-9]+$/u.test(id)) {
    return base(original, host, {
      canonicalUrl: `https://open.spotify.com${url.pathname}`,
      provider: "spotify",
      linkKind: "music",
      contentKind: "unknown",
    });
  }
  return base(original, host, {
    canonicalUrl: `https://open.spotify.com/${found}/${id}`,
    provider: "spotify",
    linkKind: "music",
    contentKind: found,
    resourceId: id,
  });
}

function classifyYouTube(original: string, url: URL): ClassifiedLink | undefined {
  const host = url.hostname;
  const isMusic = host === "music.youtube.com";
  const segments = url.pathname.split("/").filter(Boolean);
  const origin = isMusic ? "https://music.youtube.com" : "https://www.youtube.com";
  const linkKind: ClassifiedLink["linkKind"] = isMusic ? "music" : "video";
  const make = (
    contentKind: LinkContentKind,
    canonicalUrl: string,
    resourceId?: string,
  ): ClassifiedLink =>
    base(original, host, {
      canonicalUrl,
      provider: "youtube",
      linkKind,
      contentKind,
      musicSurface: isMusic,
      ...(resourceId === undefined ? {} : { resourceId }),
    });

  if (host === "youtu.be") {
    const id = segments[0];
    return id !== undefined && ID.test(id)
      ? make("video", `https://www.youtube.com/watch?v=${id}`, id)
      : make("unknown", "https://www.youtube.com/");
  }
  const first = segments[0];
  if (first === "watch") {
    const id = url.searchParams.get("v");
    if (id !== null && ID.test(id)) {
      return make("video", `${origin}/watch?v=${id}`, id);
    }
    const list = url.searchParams.get("list");
    if (list !== null && ID.test(list)) {
      return make("playlist", `${origin}/playlist?list=${list}`, list);
    }
    return make("unknown", `${origin}/`);
  }
  if (first === "shorts" || first === "embed" || first === "live" || first === "v") {
    const id = segments[1];
    if (id !== undefined && ID.test(id)) {
      return first === "shorts"
        ? make("short", `https://www.youtube.com/shorts/${id}`, id)
        : make("video", `${origin}/watch?v=${id}`, id);
    }
  }
  if (first === "playlist") {
    const list = url.searchParams.get("list");
    if (list !== null && ID.test(list)) {
      return make("playlist", `${origin}/playlist?list=${list}`, list);
    }
  }
  return make("unknown", `${origin}${url.pathname}`);
}

function classifyAppleMusic(original: string, url: URL): ClassifiedLink {
  const host = url.hostname;
  const segments = url.pathname.split("/").filter(Boolean);
  const storefront =
    segments[0] !== undefined && /^[a-z]{2}$/iu.test(segments[0]) ? segments.shift() : undefined;
  const kind = segments[0];
  const track = url.searchParams.get("i");
  const id = segments.at(-1);
  const sf = storefront?.toLowerCase() ?? "us";
  const map: Readonly<Record<string, LinkContentKind>> = {
    album: "album",
    playlist: "playlist",
    song: "song",
    artist: "artist",
    "music-video": "music-video",
  };
  const contentKind = kind === undefined ? undefined : map[kind];
  if (
    contentKind === undefined ||
    id === undefined ||
    segments.length < 2 ||
    !/^[\w.-]+$/u.test(id)
  ) {
    return base(original, host, {
      canonicalUrl: `https://music.apple.com/${sf}`,
      provider: "apple-music",
      linkKind: "music",
      contentKind: "unknown",
    });
  }
  const path = `/${sf}/${segments.map((part) => encodeURIComponent(decodeURIComponent(part))).join("/")}`;
  if (contentKind === "album" && track !== null && /^\d+$/u.test(track)) {
    return base(original, host, {
      canonicalUrl: `https://music.apple.com${path}?i=${track}`,
      provider: "apple-music",
      linkKind: "music",
      contentKind: "song",
      resourceId: track,
    });
  }
  return base(original, host, {
    canonicalUrl: `https://music.apple.com${path}`,
    provider: "apple-music",
    linkKind: contentKind === "music-video" ? "video" : "music",
    contentKind,
    resourceId: id,
  });
}

function classifyGeneric(original: string, url: URL): ClassifiedLink {
  const clean = new URL(url.href);
  clean.username = "";
  clean.password = "";
  clean.hash = "";
  for (const key of [...clean.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|igshid$)/iu.test(key)) {
      clean.searchParams.delete(key);
    }
  }
  return base(original, url.hostname, {
    canonicalUrl: clean.href,
    provider: "other",
    linkKind: "other",
    contentKind: "unknown",
  });
}

/** Classifies a single URL string. Returns `undefined` for non-http(s) or unparseable input. */
export function classifyUrl(raw: string): ClassifiedLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host === "open.spotify.com" || host === "spotify.link" || host === "play.spotify.com") {
    return classifySpotify(raw, url);
  }
  if (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "www.youtube-nocookie.com"
  ) {
    return classifyYouTube(raw, url);
  }
  if (host === "music.apple.com" || host === "itunes.apple.com") {
    return classifyAppleMusic(raw, url);
  }
  return classifyGeneric(raw, url);
}

/** Finds and classifies every distinct (by canonical URL) http(s) link in message text. */
export function extractExternalLinks(text: string): ClassifiedLink[] {
  const seen = new Set<string>();
  const links: ClassifiedLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING, "");
    const classified = classifyUrl(candidate);
    if (classified === undefined || seen.has(classified.canonicalUrl)) {
      continue;
    }
    seen.add(classified.canonicalUrl);
    links.push(classified);
  }
  return links;
}

/** Maps a classified link to its persistable contract form; no title/creator is ever fetched. */
export function toExternalMediaLink(
  id: string,
  messageId: string,
  link: ClassifiedLink,
): ExternalMediaLink {
  return {
    id,
    messageId,
    url: link.canonicalUrl,
    provider: link.provider,
    linkKind: link.linkKind,
  };
}
