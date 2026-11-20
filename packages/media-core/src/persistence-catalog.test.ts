import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaAsset } from "@social-explorer/contracts";
import { createMediaStorytellingRepository, type SqliteDatabase } from "@social-explorer/database";
import {
  assertAssetInvariants,
  assertReferenceInvariants,
  createMediaCatalog,
  createThumbnailCache,
  managedMediaPath,
  MediaInvariantError,
  readMediaMetadata,
  removeManagedMedia,
  toProductAvailability,
  type ThumbnailGenerator,
} from "./index.js";
import { encodeSolidPng } from "./thumbnails.js";
import { addMessage, createSeededDatabase, T0 } from "./seed.testutil.js";

let root: string;
let db: SqliteDatabase;
let repos: ReturnType<typeof createSeededDatabase>["repos"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "se-media-core-"));
  ({ db, repos } = createSeededDatabase());
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeCopy(bytes: Uint8Array, ext: string): { hash: string; path: string } {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = managedMediaPath(hash, ext);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  return { hash, path };
}

function asset(id: string, over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    datasetId: "ds-1",
    kind: "image",
    availability: "not-imported",
    importedAt: T0,
    provenanceId: "prov-1",
    ...over,
  };
}

describe("persistence round trip against 003_media_storytelling.sql", () => {
  it("round-trips all 8 tables", () => {
    addMessage(repos, "m1", { kind: "link", text: "https://open.spotify.com/track/abc" });
    const repo = createMediaStorytellingRepository(db);
    const full = asset("a1", {
      originalName: "IMG.png",
      mimeType: "image/png",
      byteSize: 69,
      durationMs: 5,
      width: 1,
      height: 2,
      contentHash: "ab".repeat(32),
      storageRelativePath: `media/ab/${"ab".repeat(32)}.png`,
      availability: "available-local",
    });
    repo.upsertAsset(full);
    expect(repo.getAsset("a1")).toEqual(full);
    repo.upsertAsset(asset("a2"));
    expect(repo.getAsset("a2")).toEqual(asset("a2"));
    expect(repo.findAssetByHash("ds-1", "ab".repeat(32))?.id).toBe("a1");
    expect(repo.listAssets("ds-1").map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(repo.getAsset("nope")).toBeUndefined();

    repo.upsertReference("ds-1", {
      id: "r1",
      mediaAssetId: "a1",
      messageId: "m1",
      conversationId: "conv-1",
      timestampUtc: "2026-01-02T09:00:00Z",
      timestampLocal: "2026-01-02T10:00:00",
      caption: "hi",
      availability: "available-local",
    });
    expect(repo.getReference("r1")).toMatchObject({
      datasetId: "ds-1",
      caption: "hi",
      mediaAssetId: "a1",
    });
    expect(repo.listReferencesForMessage("m1")).toHaveLength(1);
    expect(repo.listReferencesForAsset("a1")).toHaveLength(1);

    const link = {
      id: "l1",
      messageId: "m1",
      url: "https://open.spotify.com/track/abc",
      provider: "spotify" as const,
      title: "T",
      creator: "C",
      linkKind: "music" as const,
      resolvedMetadataAt: T0,
    };
    repo.upsertExternalLink(link);
    expect(repo.listExternalLinksForMessage("m1")).toEqual([link]);
    expect(repo.listExternalLinks("ds-1")).toEqual([link]);

    const project = {
      id: "p1",
      datasetId: "ds-1",
      title: "Our story",
      dateRangeStart: T0,
      dateRangeEnd: "2026-02-01T00:00:00Z",
      status: "draft" as const,
      aspectRatio: "16:9" as const,
      createdAt: T0,
      updatedAt: T0,
    };
    repo.upsertProject(project);
    expect(repo.getProject("p1")).toEqual(project);
    expect(repo.listProjects("ds-1")).toEqual([project]);

    const chapter = {
      id: "ch1",
      projectId: "p1",
      title: "Start",
      narrativeText: "once",
      startAt: T0,
      endAt: T0,
      sortOrder: 0,
      transition: "fade" as const,
      durationSeconds: 4.5,
    };
    repo.upsertChapter(chapter);
    repo.upsertChapter({ ...chapter, id: "ch0", sortOrder: 0, title: "A" });
    expect(repo.listChapters("p1").map((c) => c.id)).toEqual(["ch0", "ch1"]);

    const item = {
      id: "i1",
      chapterId: "ch1",
      itemKind: "photo" as const,
      mediaAssetId: "a1",
      messageId: "m1",
      sortOrder: 0,
      startOffsetMs: 0,
      endOffsetMs: 3000,
    };
    repo.upsertChapterItem(item);
    expect(repo.listChapterItems("ch1")).toEqual([item]);

    const track = {
      id: "t1",
      projectId: "p1",
      sourceKind: "shared-link" as const,
      externalUrl: "https://open.spotify.com/track/abc",
      localAssetId: "a2",
      title: "Song",
      artist: "Artist",
      startOffsetMs: 10,
      durationMs: 1000,
      rightsStatus: "not-for-export" as const,
    };
    repo.upsertSoundtrackTrack(track);
    expect(repo.listSoundtrackTracks("p1")).toEqual([track]);

    const movie = {
      id: "e1",
      projectId: "p1",
      preset: "16:9" as const,
      status: "completed" as const,
      includeMessageText: true,
      includeContactNames: false,
      includedSoundtrackTrackIds: [],
      linkReferenceTrackIds: ["t1"],
      createdAt: T0,
      completedAt: T0,
    };
    repo.upsertMovieExport(movie);
    expect(repo.listMovieExports("p1")).toEqual([movie]);
    repo.upsertMovieExport({ ...movie, status: "failed" });
    expect(repo.listMovieExports("p1")[0]?.status).toBe("failed");

    repo.deleteProject("p1");
    expect(repo.listChapters("p1")).toEqual([]);
    expect(repo.listSoundtrackTracks("p1")).toEqual([]);
    expect(repo.listMovieExports("p1")).toEqual([]);
    expect(repo.getAsset("a1")).toBeDefined();
  });

  it("enforces schema CHECK constraints", () => {
    const repo = createMediaStorytellingRepository(db);
    expect(() => {
      repo.upsertAsset(asset("bad", { availability: "weird" as never }));
    }).toThrow();
    expect(() => {
      repo.upsertProject({
        id: "p",
        datasetId: "ds-1",
        title: "",
        status: "draft",
        aspectRatio: "16:9",
        createdAt: T0,
        updatedAt: T0,
      });
    }).toThrow();
  });
});

describe("domain invariants", () => {
  it("distinguishes MediaAsset from MediaReference states", () => {
    expect(toProductAvailability("available-local")).toBe("available");
    expect(toProductAvailability("missing")).toBe("missing");
    expect(toProductAvailability("unsupported")).toBe("unsupported");
    expect(toProductAvailability("not-imported")).toBe("not-imported");
    expect(() => {
      assertAssetInvariants(asset("x", { availability: "available-local" }));
    }).toThrow(MediaInvariantError);
    expect(() => {
      assertAssetInvariants(
        asset("x", { storageRelativePath: "media/ab/x.png", contentHash: "ab".repeat(32) }),
      );
    }).toThrow(MediaInvariantError);
    expect(() => {
      assertAssetInvariants(
        asset("x", {
          availability: "available-local",
          contentHash: "ab".repeat(32),
          storageRelativePath: "media/zz/original-name.png",
        }),
      );
    }).toThrow(MediaInvariantError);
    expect(() => {
      assertReferenceInvariants({
        id: "r",
        conversationId: "c",
        timestampLocal: "2026-01-01T00:00:00",
        availability: "available-local",
      });
    }).toThrow(MediaInvariantError);
    expect(() => {
      assertReferenceInvariants({
        id: "r",
        mediaAssetId: "a",
        conversationId: "c",
        timestampLocal: "2026-01-01T00:00:00",
        availability: "missing",
      });
    }).toThrow(MediaInvariantError);
    expect(() => {
      assertReferenceInvariants(
        {
          id: "r",
          mediaAssetId: "a",
          conversationId: "c",
          timestampLocal: "2026-01-01T00:00:00",
          availability: "available-local",
        },
        asset("a"),
      );
    }).toThrow(MediaInvariantError);
  });
});

describe("catalog and bidirectional message <-> media lookup", () => {
  beforeEach(() => {
    const repo = createMediaStorytellingRepository(db);
    addMessage(repos, "m-photo", { kind: "image", hasAttachment: true });
    addMessage(repos, "m-voice", {
      kind: "voice",
      senderContactId: "c-bob",
      timestampUtc: "2026-02-01T09:00:00Z",
      timestampLocal: "2026-02-01T10:00:00",
    });
    addMessage(repos, "m-video", {
      kind: "video",
      conversationId: "conv-2",
      timestampUtc: "2026-03-01T09:00:00Z",
      timestampLocal: "2026-03-01T10:00:00",
    });
    addMessage(repos, "m-photo2", {
      kind: "image",
      timestampUtc: "2026-01-05T09:00:00Z",
      timestampLocal: "2026-01-05T10:00:00",
    });
    addMessage(repos, "m-omitted", {
      kind: "image",
      timestampUtc: "2026-01-06T09:00:00Z",
      timestampLocal: "2026-01-06T10:00:00",
    });
    repo.upsertAsset(
      asset("a-photo", {
        contentHash: "11".repeat(32),
        availability: "available-local",
        storageRelativePath: `media/11/${"11".repeat(32)}.png`,
      }),
    );
    repo.upsertAsset(asset("a-voice", { kind: "voice" }));
    const ref = (
      id: string,
      messageId: string,
      conversationId: string,
      day: string,
      availability: "available-local" | "missing" | "not-imported" | "unsupported",
      mediaAssetId?: string,
    ): void => {
      repo.upsertReference("ds-1", {
        id,
        ...(mediaAssetId === undefined ? {} : { mediaAssetId }),
        messageId,
        conversationId,
        timestampUtc: `${day}T09:00:00Z`,
        timestampLocal: `${day}T10:00:00`,
        availability,
      });
    };
    ref("r-photo", "m-photo", "conv-1", "2026-01-02", "available-local", "a-photo");
    ref("r-photo2", "m-photo2", "conv-1", "2026-01-05", "available-local", "a-photo");
    ref("r-voice", "m-voice", "conv-1", "2026-02-01", "not-imported", "a-voice");
    ref("r-video", "m-video", "conv-2", "2026-03-01", "missing");
    ref("r-omit", "m-omitted", "conv-1", "2026-01-06", "not-imported");
  });

  it("filters by dataset, conversation, contact, type, dates and availability", () => {
    const catalog = createMediaCatalog(db);
    const ids = (filter: Parameters<typeof catalog.query>[0]): string[] =>
      catalog.query(filter).map((entry) => entry.reference.id);
    expect(ids({ datasetId: "ds-1" })).toEqual([
      "r-photo",
      "r-photo2",
      "r-omit",
      "r-voice",
      "r-video",
    ]);
    expect(ids({ datasetId: "other" })).toEqual([]);
    expect(ids({ datasetId: "ds-1", conversationId: "conv-2" })).toEqual(["r-video"]);
    expect(ids({ datasetId: "ds-1", contactId: "c-bob" })).toEqual(["r-voice"]);
    expect(ids({ datasetId: "ds-1", mediaType: "photo" })).toEqual([
      "r-photo",
      "r-photo2",
      "r-omit",
    ]);
    expect(ids({ datasetId: "ds-1", mediaType: "voice-note" })).toEqual(["r-voice"]);
    expect(ids({ datasetId: "ds-1", mediaType: "video" })).toEqual(["r-video"]);
    expect(ids({ datasetId: "ds-1", mediaType: "audio" })).toEqual([]);
    expect(ids({ datasetId: "ds-1", mediaType: "document" })).toEqual([]);
    expect(
      ids({ datasetId: "ds-1", from: "2026-01-05T00:00:00Z", to: "2026-02-01T00:00:00Z" }),
    ).toEqual(["r-photo2", "r-omit"]);
    expect(ids({ datasetId: "ds-1", availability: ["missing", "not-imported"] })).toEqual([
      "r-omit",
      "r-voice",
      "r-video",
    ]);
    expect(ids({ datasetId: "ds-1", availability: [] })).toEqual([]);
    expect(ids({ datasetId: "ds-1", limit: 2, offset: 1 })).toEqual(["r-photo2", "r-omit"]);
    expect(
      ids({
        datasetId: "ds-1",
        conversationId: "conv-1",
        mediaType: "photo",
        contactId: "c-alice",
        availability: ["available-local"],
      }),
    ).toEqual(["r-photo", "r-photo2"]);
  });

  it("looks up message -> media and media -> messages", () => {
    const catalog = createMediaCatalog(db);
    const forMessage = catalog.mediaForMessage("m-photo");
    expect(forMessage).toHaveLength(1);
    expect(forMessage[0]?.asset?.id).toBe("a-photo");
    expect(forMessage[0]?.mediaType).toBe("photo");
    expect(forMessage[0]?.message?.senderContactId).toBe("c-alice");
    expect(catalog.mediaForMessage("m-video")[0]).toMatchObject({ mediaType: "video" });
    expect(catalog.mediaForMessage("m-video")[0]?.asset).toBeUndefined();
    expect(catalog.mediaForMessage("ghost")).toEqual([]);
    expect(catalog.messagesForAsset("a-photo").map((m) => m.id)).toEqual(["m-photo", "m-photo2"]);
    expect(catalog.messagesForAsset("none")).toEqual([]);
    expect(catalog.countByAvailability("ds-1")).toMatchObject({
      "available-local": 2,
      missing: 1,
      "not-imported": 2,
    });
  });

  it("cleanup removes managed copies but never messages, references or credentials", async () => {
    const png = encodeSolidPng(2, 2, [9, 9, 9]);
    const { hash, path } = storeCopy(png, "png");
    const repo = createMediaStorytellingRepository(db);
    repo.upsertAsset(
      asset("a-managed", {
        contentHash: hash,
        storageRelativePath: path,
        availability: "available-local",
      }),
    );
    repo.upsertReference("ds-1", {
      id: "r-managed",
      mediaAssetId: "a-managed",
      messageId: "m-photo",
      conversationId: "conv-1",
      timestampLocal: "2026-01-02T10:00:00",
      availability: "available-local",
    });
    const cache = createThumbnailCache({ appRoot: root });
    const thumb = await cache.ensure(repo.getAsset("a-managed") as MediaAsset, 64);
    expect(existsSync(join(root, thumb?.relativePath ?? "missing"))).toBe(true);
    const auth = join(root, "connector-auth.json");
    writeFileSync(auth, "secret");
    const messagesBefore = db.prepare("SELECT COUNT(*) AS n FROM messages").get();

    const result = await removeManagedMedia(repo, root, "ds-1");
    expect(result).toMatchObject({ removedCopies: 2, removedThumbnails: 1, keptSharedCopies: 0 });
    expect(existsSync(join(root, path))).toBe(false);
    expect(existsSync(join(root, thumb?.relativePath ?? "missing"))).toBe(false);
    expect(readFileSync(auth, "utf8")).toBe("secret");
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual(messagesBefore);
    expect(repo.getAsset("a-managed")).toMatchObject({ availability: "not-imported" });
    expect(repo.getAsset("a-managed")?.storageRelativePath).toBeUndefined();
    expect(repo.getReference("r-managed")?.availability).toBe("not-imported");
    expect(await removeManagedMedia(repo, root, "ds-1")).toMatchObject({ removedCopies: 0 });
  });
});

describe("rebuildable thumbnail cache", () => {
  it("generates deterministic placeholders, caches and rebuilds identically", async () => {
    const png = encodeSolidPng(40, 20, [1, 2, 3]);
    const { hash, path } = storeCopy(png, "png");
    const wav = Buffer.from("RIFF\0\0\0\0WAVE", "latin1");
    const audio = storeCopy(wav, "wav");
    const a1 = asset("t1", {
      mimeType: "image/png",
      contentHash: hash,
      storageRelativePath: path,
      availability: "available-local",
    });
    const a2 = asset("t2", {
      kind: "audio",
      mimeType: "audio/wav",
      contentHash: audio.hash,
      storageRelativePath: audio.path,
      availability: "available-local",
    });
    const a3 = asset("t3");
    const cache = createThumbnailCache({ appRoot: root });

    const first = await cache.ensure(a1, 10);
    expect(first).toMatchObject({ created: true, generator: "placeholder-v1" });
    expect(first?.relativePath).toBe(`thumbnails/${hash.slice(0, 2)}/${hash}-10.png`);
    const bytes1 = readFileSync(join(root, first?.relativePath ?? ""));
    expect(readMediaMetadata("image/png", bytes1)).toEqual({ width: 10, height: 5 });
    expect((await cache.ensure(a1, 10))?.created).toBe(false);
    expect(await cache.ensure(a3)).toBeUndefined();

    const report = await cache.rebuild([a1, a2, a3], 10);
    expect(report).toEqual({ generated: 2, skipped: 1, failed: [] });
    expect(readFileSync(join(root, first?.relativePath ?? ""))).toEqual(bytes1);

    await cache.purge();
    expect(existsSync(join(root, "thumbnails"))).toBe(false);
    expect(existsSync(join(root, path))).toBe(true);
  });

  it("uses an injected generator and falls back when it fails or declines", async () => {
    const png = encodeSolidPng(4, 4, [1, 2, 3]);
    const { hash, path } = storeCopy(png, "png");
    const a = asset("t", {
      mimeType: "image/png",
      contentHash: hash,
      storageRelativePath: path,
      availability: "available-local",
    });
    const good: ThumbnailGenerator = {
      id: "custom",
      generate: () =>
        Promise.resolve({ bytes: encodeSolidPng(1, 1, [0, 0, 0]), width: 1, height: 1 }),
    };
    expect(
      (await createThumbnailCache({ appRoot: root, generator: good }).ensure(a, 32))?.generator,
    ).toBe("custom");
    await rm2(join(root, "thumbnails"));
    const boom: ThumbnailGenerator = {
      id: "boom",
      generate: () => Promise.reject(new Error("no native binary")),
    };
    expect(
      (await createThumbnailCache({ appRoot: root, generator: boom }).ensure(a, 32))?.generator,
    ).toBe("placeholder-v1");
    await rm2(join(root, "thumbnails"));
    const decline: ThumbnailGenerator = {
      id: "decline",
      generate: () => Promise.resolve(undefined),
    };
    expect(
      (await createThumbnailCache({ appRoot: root, generator: decline }).ensure(a, 32))?.generator,
    ).toBe("placeholder-v1");
  });

  it("refuses traversal via forged storage paths", async () => {
    const hash = "cd".repeat(32);
    const evil = asset("e", {
      contentHash: hash,
      storageRelativePath: "../../etc/passwd",
      availability: "available-local",
    });
    await expect(createThumbnailCache({ appRoot: root }).ensure(evil)).rejects.toThrow();
  });
});

function rm2(path: string): Promise<void> {
  rmSync(path, { recursive: true, force: true });
  return Promise.resolve();
}
