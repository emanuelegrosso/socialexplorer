import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyUrl,
  EXTERNAL_LINK_POLICY,
  extractExternalLinks,
  toExternalMediaLink,
} from "./external-links.js";

describe("Spotify", () => {
  it.each([
    ["track", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123"],
    ["album", "https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3"],
    ["playlist", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x"],
    ["episode", "https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ"],
  ])("classifies %s and strips tracking", (kind, url) => {
    const link = classifyUrl(url);
    expect(link).toMatchObject({
      provider: "spotify",
      contentKind: kind,
      linkKind: "music",
      rightsStatus: "not-for-export",
      exportStatus: "reference-only",
    });
    expect(link?.canonicalUrl).toBe(`https://open.spotify.com/${kind}/${link?.resourceId ?? ""}`);
  });
  it("handles intl prefixes, embeds, legacy user playlists and short links", () => {
    expect(
      classifyUrl("https://open.spotify.com/intl-it/track/4uLU6hMCjMI75M1A2tKUQC"),
    ).toMatchObject({
      contentKind: "track",
      canonicalUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    });
    expect(
      classifyUrl("https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3")?.contentKind,
    ).toBe("album");
    expect(
      classifyUrl("https://open.spotify.com/user/someone/playlist/37i9dQZF1DXcBWIGoYBM5M"),
    ).toMatchObject({
      contentKind: "playlist",
      resourceId: "37i9dQZF1DXcBWIGoYBM5M",
    });
    expect(classifyUrl("https://spotify.link/AbCdEf")).toMatchObject({
      provider: "spotify",
      contentKind: "unknown",
    });
    expect(classifyUrl("https://open.spotify.com/track/")).toMatchObject({
      contentKind: "unknown",
    });
  });
});

describe("YouTube", () => {
  const id = "dQw4w9WgXcQ";
  it.each([
    [`https://www.youtube.com/watch?v=${id}&t=43s&list=RDx`, "video"],
    [`https://youtube.com/watch?v=${id}`, "video"],
    [`https://m.youtube.com/watch?v=${id}`, "video"],
    [`https://youtu.be/${id}?si=zzz`, "video"],
    [`https://www.youtube.com/embed/${id}`, "video"],
    [`https://www.youtube.com/live/${id}`, "video"],
  ])("normalises %s", (url, kind) => {
    expect(classifyUrl(url)).toMatchObject({
      provider: "youtube",
      contentKind: kind,
      resourceId: id,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      linkKind: "video",
      musicSurface: false,
      rightsStatus: "not-for-export",
    });
  });
  it("classifies shorts, playlists and YouTube Music", () => {
    expect(classifyUrl(`https://www.youtube.com/shorts/${id}`)).toMatchObject({
      contentKind: "short",
      canonicalUrl: `https://www.youtube.com/shorts/${id}`,
    });
    expect(classifyUrl("https://www.youtube.com/playlist?list=PLabc_123-x")).toMatchObject({
      contentKind: "playlist",
      resourceId: "PLabc_123-x",
    });
    expect(classifyUrl(`https://music.youtube.com/watch?v=${id}&si=q`)).toMatchObject({
      provider: "youtube",
      linkKind: "music",
      musicSurface: true,
      canonicalUrl: `https://music.youtube.com/watch?v=${id}`,
    });
  });
  it("does not trust lookalike hosts or malformed ids", () => {
    expect(classifyUrl(`https://youtube.com.evil.example/watch?v=${id}`)?.provider).toBe("other");
    expect(classifyUrl(`https://notyoutube.com/watch?v=${id}`)?.provider).toBe("other");
    expect(classifyUrl("https://www.youtube.com/watch?v=<script>")).toMatchObject({
      contentKind: "unknown",
    });
    expect(classifyUrl("https://youtu.be/")).toMatchObject({
      provider: "youtube",
      contentKind: "unknown",
    });
  });
});

describe("Apple Music", () => {
  it("classifies album, song-in-album, playlist and music videos", () => {
    expect(classifyUrl("https://music.apple.com/it/album/some-album/1234567890")).toMatchObject({
      provider: "apple-music",
      contentKind: "album",
      resourceId: "1234567890",
      canonicalUrl: "https://music.apple.com/it/album/some-album/1234567890",
      rightsStatus: "not-for-export",
    });
    expect(
      classifyUrl("https://music.apple.com/us/album/some-album/1234567890?i=1234567891&uo=4"),
    ).toMatchObject({
      contentKind: "song",
      resourceId: "1234567891",
      canonicalUrl: "https://music.apple.com/us/album/some-album/1234567890?i=1234567891",
    });
    expect(classifyUrl("https://music.apple.com/us/playlist/chill/pl.u-abc123")).toMatchObject({
      contentKind: "playlist",
      resourceId: "pl.u-abc123",
    });
    expect(classifyUrl("https://music.apple.com/us/music-video/clip/987")).toMatchObject({
      contentKind: "music-video",
      linkKind: "video",
    });
    expect(classifyUrl("https://music.apple.com/us/browse")).toMatchObject({
      contentKind: "unknown",
    });
  });
});

describe("generic links and extraction", () => {
  it("normalises generic URLs and marks rights unknown", () => {
    const link = classifyUrl("https://user:pw@Example.COM:443/a?utm_source=x&fbclid=1&keep=1#frag");
    expect(link).toMatchObject({ provider: "other", linkKind: "other", rightsStatus: "unknown" });
    expect(link?.canonicalUrl).toBe("https://example.com/a?keep=1");
  });
  it("rejects non-http schemes and garbage", () => {
    expect(classifyUrl("javascript:alert(1)")).toBeUndefined();
    expect(classifyUrl("ftp://example.com/x")).toBeUndefined();
    expect(classifyUrl("not a url")).toBeUndefined();
  });
  it("extracts, trims punctuation and dedupes by canonical URL", () => {
    const text =
      "Listen (https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=a), again https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC. Also: https://youtu.be/dQw4w9WgXcQ! and https://example.org/page?x=1.";
    const links = extractExternalLinks(text);
    expect(links.map((l) => l.provider)).toEqual(["spotify", "youtube", "other"]);
    expect(links[2]?.canonicalUrl).toBe("https://example.org/page?x=1");
    expect(extractExternalLinks("no links here")).toEqual([]);
  });
  it("maps to the persistable contract without fetching metadata", () => {
    const link = classifyUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(link).toBeDefined();
    if (link === undefined) {
      return;
    }
    const mapped = toExternalMediaLink("l1", "m1", link);
    expect(mapped).toEqual({
      id: "l1",
      messageId: "m1",
      url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      provider: "spotify",
      linkKind: "music",
    });
  });
});

describe("no scraping / downloading / DRM bypass invariant", () => {
  it("declares the policy and imports no network or process modules", () => {
    expect(EXTERNAL_LINK_POLICY).toEqual({
      networkAccess: false,
      scraping: false,
      downloading: false,
      drmBypass: false,
    });
    const source = readFileSync(new URL("./external-links.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:(http|https|net|dns|child_process|tls|fs)/u);
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/u);
  });
});
