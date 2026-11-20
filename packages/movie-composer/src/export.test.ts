import { describe, expect, it } from "vitest";
import { MovieStudioManager, type MovieProject } from "@social-explorer/story-engine";
import {
  DEFAULT_EXPORT_PRESET,
  EXPORT_PRESETS,
  ExportJobManager,
  ExportRejectedError,
  buildExportManifest,
  manifestToRenderPlan,
} from "./index.js";
import { SoundtrackManager } from "./soundtrack.js";
import { addAsset, seedSynthetic } from "./seed.testutil.js";

function studio() {
  const { db, repos } = seedSynthetic();
  addAsset(repos, "img-1", "image");
  addAsset(repos, "a-song", "audio");
  let n = 0;
  const manager = new MovieStudioManager(db, { newId: () => `id-${String(++n)}`, now: () => "2026-03-01T00:00:00Z" });
  const tracks = new SoundtrackManager(db, { newId: () => `t-${String(++n)}` });
  const exports = new ExportJobManager(db, { studio: manager, newId: () => `x-${String(++n)}`, now: () => "2026-03-01T00:00:00Z" });
  const projectId = manager.createProject({ datasetId: "ds-1", title: "Synthetic movie" }).project.id;
  return { db, repos, manager, tracks, exports, projectId };
}

function loadRequired(manager: MovieStudioManager, projectId: string): MovieProject {
  const movie = manager.load(projectId);
  if (movie === undefined) throw new Error(`Missing project ${projectId}`);
  return movie;
}

function firstChapterId(movie: MovieProject): string {
  const chapter = movie.chapters[0]?.chapter;
  if (chapter === undefined) throw new Error("Missing chapter");
  return chapter.id;
}

const deps = (root: string) => ({
  resolveAssetPath: (id: string) => (id === "img-1" ? `${root}/img-1.png` : id === "a-song" ? `${root}/song.wav` : undefined),
  resolveMessage: (id: string) =>
    id === "m-1" ? { text: "secret body", senderName: "Alice Synthetic" } : undefined,
});

describe("export presets and manifest (WX-090)", () => {
  it("exposes 16:9 default and portrait/square presets", () => {
    expect(DEFAULT_EXPORT_PRESET).toBe("16:9");
    expect(EXPORT_PRESETS["16:9"].width).toBe(1280);
    expect(EXPORT_PRESETS["9:16"].height).toBe(1280);
    expect(EXPORT_PRESETS["1:1"].width).toBe(EXPORT_PRESETS["1:1"].height);
  });

  it("rejects export when not user-initiated", () => {
    const { manager, projectId } = studio();
    manager.addChapter(projectId, { title: "Ch", transition: "cut", durationSeconds: 4, origin: "user" });
    const result = buildExportManifest(loadRequired(manager, projectId), deps("/media"), { userInitiated: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/user/i);
  });

  it("excludes contact names and message text by default", () => {
    const { manager, projectId } = studio();
    manager.addChapter(projectId, { title: "Ch", transition: "cut", durationSeconds: 6, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, projectId));
    manager.addItem(projectId, ch, { itemKind: "message-card", messageId: "m-1" });
    const manifest = buildExportManifest(loadRequired(manager, projectId), deps("/media"), { userInitiated: true });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.manifest.privacy.includesMessageText).toBe(false);
    expect(manifest.manifest.privacy.includesContactNames).toBe(false);
    expect(manifest.manifest.segments[0]?.cardLines).toEqual(["Message"]);
    expect(manifest.manifest.privacy.metadataScrubbed).toBe(true);
    expect(manifest.manifest.soundtrack.mode).toBe("no-music");
    expect(manifest.manifest.rightsNotice).toMatch(/no music/i);
  });

  it("opts in to text and names only when requested", () => {
    const { manager, projectId } = studio();
    manager.addChapter(projectId, { title: "Ch", transition: "cut", durationSeconds: 4, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, projectId));
    manager.addItem(projectId, ch, { itemKind: "message-card", messageId: "m-1" });
    const manifest = buildExportManifest(loadRequired(manager, projectId), deps("/media"), {
      userInitiated: true,
      includeMessageText: true,
      includeContactNames: true,
    });
    expect(manifest.ok && manifest.manifest.privacy.includesMessageText).toBe(true);
    expect(manifest.ok && manifest.manifest.segments[0]?.cardLines?.join(" ")).toContain("secret body");
    expect(manifest.ok && manifest.manifest.segments[0]?.cardLines?.join(" ")).toContain("Alice");
  });

  it("rejects unlicensed embedded soundtrack tracks", () => {
    const { manager, tracks, projectId } = studio();
    manager.addChapter(projectId, { title: "Ch", transition: "cut", durationSeconds: 4, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, projectId));
    manager.addItem(projectId, ch, { itemKind: "title-card" });
    const unknown = tracks.addUserFile(projectId, { localAssetId: "a-song" });
    const result = buildExportManifest(loadRequired(manager, projectId), deps("/media"), {
      userInitiated: true,
      soundtrack: { mode: "embed", embedTrackIds: [unknown.id] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected.length).toBe(1);
  });

  it("includes only selected items minus exclusions and reports eligibility", () => {
    const { manager, tracks, projectId } = studio();
    manager.addChapter(projectId, { title: "Ch", transition: "cut", durationSeconds: 8, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, projectId));
    manager.addItem(projectId, ch, { itemKind: "photo", mediaAssetId: "img-1" });
    manager.addItem(projectId, ch, { itemKind: "title-card", extras: { label: "A" } });
    const skipItem = loadRequired(manager, projectId).chapters[0]?.items[1];
    if (skipItem === undefined) throw new Error("expected second item");
    const skipId = skipItem.id;
    tracks.addSharedLink(projectId, { url: "https://open.spotify.com/track/x" });
    const licensed = tracks.addLicensedLibraryEntry(projectId, { localAssetId: "a-song" });
    const movie = loadRequired(manager, projectId);
    const manifest = buildExportManifest(movie, deps("/media"), {
      userInitiated: true,
      preset: "9:16",
      excludedItemIds: [skipId],
      soundtrack: { mode: "embed", embedTrackIds: [licensed.id] },
    });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.manifest.preset.id).toBe("9:16");
    expect(manifest.manifest.includedItemIds).toHaveLength(1);
    expect(manifest.manifest.soundtrack.embeddedTrackIds).toEqual([licensed.id]);
    expect(manifest.manifest.soundtrack.linkReferences).toHaveLength(1);
    expect(manifest.manifest.soundtrack.eligibility.eligibleTrackIds).toContain(licensed.id);
  });

  it("maps a manifest to a render plan with resolved paths", () => {
    const { manager, projectId } = studio();
    manager.addChapter(projectId, { title: "Ch", transition: "cut", durationSeconds: 4, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, projectId));
    manager.addItem(projectId, ch, { itemKind: "photo", mediaAssetId: "img-1" });
    const built = buildExportManifest(loadRequired(manager, projectId), deps("/data"), { userInitiated: true });
    if (!built.ok) throw new Error("expected manifest");
    const plan = manifestToRenderPlan(built.manifest, {
      resolveAssetPath: (id) => `/data/${id}.png`,
      tracks: [],
      inputRoots: ["/data"],
    });
    expect(plan.segments[0]?.inputPath).toBe("/data/img-1.png");
    expect(plan.scrubMetadata).toBe(true);
  });
});

describe("ExportJobManager", () => {
  it("creates queued jobs and stores the manifest for resume", () => {
    const { manager, exports, projectId } = studio();
    manager.addChapter(projectId, { title: "Ch", transition: "cut", durationSeconds: 4, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, projectId));
    manager.addItem(projectId, ch, { itemKind: "title-card" });
    const job = exports.createJob(projectId, deps("/media"), { userInitiated: true });
    expect(job.status).toBe("queued");
    expect(job.includeMessageText).toBe(false);
    const stored = exports.getStoredManifest(job.id);
    expect(stored?.manifest.projectId).toBe(projectId);
    expect(exports.preview(projectId, deps("/media"), { userInitiated: true }).ok).toBe(true);
    expect(() => exports.createJob(projectId, deps("/media"), { userInitiated: false })).toThrow(ExportRejectedError);
  });
});