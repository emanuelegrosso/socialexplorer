import { describe, expect, it } from "vitest";
import { createMediaStorytellingRepository } from "@social-explorer/database";
import { MovieStudioManager } from "@social-explorer/story-engine";
import {
  buildEligibilityReport,
  evaluateTrack,
  isPreviewableAudio,
  resolveSoundtrackPlan,
  RIGHTS_COPY,
  SoundtrackManager,
} from "./index.js";
import { addAsset, seedSynthetic } from "./seed.testutil.js";

function setup() {
  const { db, repos } = seedSynthetic();
  addAsset(repos, "a-song", "audio");
  addAsset(repos, "a-lib", "audio");
  addAsset(repos, "img-1", "image");
  let n = 0;
  const studio = new MovieStudioManager(db);
  const projectId = studio.createProject({ datasetId: "ds-1", title: "Synthetic" }).project.id;
  const tracks = new SoundtrackManager(db, { newId: () => `t-${String(++n)}` });
  return { db, repos, projectId, tracks };
}

describe("soundtrack rights", () => {
  it("never allows shared links to be embedded or upgraded", () => {
    const { tracks, projectId } = setup();
    const link = tracks.addSharedLink(projectId, { url: "https://open.spotify.com/track/abc123", title: "Song" });
    expect(link.rightsStatus).not.toBe("licensed");
    expect(evaluateTrack(link).eligibleForEmbedding).toBe(false);
    expect(evaluateTrack(link).reason).toBe("shared-link-reference-only");
    expect(() => tracks.setRights(link.id, projectId, "user-confirmed")).toThrow(/cannot be marked embeddable/);
    expect(() => tracks.addSharedLink(projectId, { url: "javascript:alert(1)" })).toThrow();
  });

  it("treats user files as unknown until the user confirms rights", () => {
    const { tracks, projectId } = setup();
    const file = tracks.addUserFile(projectId, { localAssetId: "a-song" });
    expect(file.rightsStatus).toBe("unknown");
    expect(evaluateTrack(file).reason).toBe("rights-unknown");
    const confirmed = tracks.setRights(file.id, projectId, "user-confirmed");
    expect(evaluateTrack(confirmed).eligibleForEmbedding).toBe(true);
    expect(() => tracks.setRights(file.id, projectId, "licensed")).toThrow();
    expect(evaluateTrack(tracks.setRights(file.id, projectId, "not-for-export")).reason).toBe("rights-not-for-export");
    expect(() => tracks.addUserFile(projectId, { localAssetId: "img-1" })).toThrow(/not an audio/);
  });

  it("supports licensed library entries", () => {
    const { tracks, projectId } = setup();
    const entry = tracks.addLicensedLibraryEntry(projectId, { localAssetId: "a-lib", title: "Lib" });
    expect(evaluateTrack(entry).reason).toBe("eligible-licensed");
    expect(() => tracks.setRights(entry.id, projectId, "unknown")).toThrow();
  });

  it("flags unavailable local files", () => {
    const { tracks, projectId } = setup();
    const t = tracks.setRights(tracks.addUserFile(projectId, { localAssetId: "a-song" }).id, projectId, "user-confirmed");
    expect(evaluateTrack(t, { isLocalFileAvailable: () => false }).reason).toBe("local-file-unavailable");
  });

  it("rejects explicit embedding of ineligible tracks but keeps links accessible", () => {
    const { tracks, projectId } = setup();
    const link = tracks.addSharedLink(projectId, { url: "https://youtu.be/abcdefghijk" });
    const unknown = tracks.addUserFile(projectId, { localAssetId: "a-song" });
    const lib = tracks.addLicensedLibraryEntry(projectId, { localAssetId: "a-lib" });
    const all = tracks.list(projectId);

    const rejected = resolveSoundtrackPlan(all, { mode: "embed", embedTrackIds: [unknown.id, lib.id, link.id] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.rejected.map((r) => r.trackId).sort()).toEqual([link.id, unknown.id].sort());
      expect(rejected.rejected.every((r) => r.message === RIGHTS_COPY[r.reason as keyof typeof RIGHTS_COPY])).toBe(true);
    }
    const unknownTrack = resolveSoundtrackPlan(all, { mode: "embed", embedTrackIds: ["nope"] });
    expect(unknownTrack.ok).toBe(false);

    const implicit = resolveSoundtrackPlan(all, { mode: "embed" });
    expect(implicit.ok && implicit.plan.embeddedTracks.map((t) => t.id)).toEqual([lib.id]);
    expect(implicit.ok && implicit.plan.linkReferences.map((r) => r.trackId)).toEqual([link.id]);
  });

  it("always supports no-music and link-reference fallbacks", () => {
    const { tracks, projectId } = setup();
    tracks.addSharedLink(projectId, { url: "https://music.apple.com/us/album/x/123?i=456" });
    tracks.addUserFile(projectId, { localAssetId: "a-song" });
    const all = tracks.list(projectId);
    const none = resolveSoundtrackPlan(all, { mode: "no-music" });
    expect(none.ok && none.plan.embeddedTracks).toEqual([]);
    expect(none.ok && none.plan.rightsNotice).toMatch(/no music/i);
    const refs = resolveSoundtrackPlan(all, { mode: "link-reference" });
    expect(refs.ok && refs.plan.embeddedTracks).toEqual([]);
    expect(refs.ok && refs.plan.linkReferences).toHaveLength(1);
    expect(refs.ok && refs.plan.rightsNotice).toMatch(/reference/i);
  });

  it("warns when embed mode has nothing eligible", () => {
    const { tracks, projectId } = setup();
    tracks.addUserFile(projectId, { localAssetId: "a-song" });
    const r = resolveSoundtrackPlan(tracks.list(projectId), { mode: "embed" });
    expect(r.ok && r.plan.warnings.length).toBe(1);
  });

  it("builds an eligibility report from stored assets and previews supported formats", () => {
    const { tracks, projectId, db } = setup();
    tracks.setRights(tracks.addUserFile(projectId, { localAssetId: "a-song" }).id, projectId, "user-confirmed");
    expect(tracks.eligibility(projectId).eligibleTrackIds).toHaveLength(1);
    createMediaStorytellingRepository(db).markManagedCopyRemoved("a-song");
    expect(tracks.eligibility(projectId).decisions[0]?.reason).toBe("local-file-unavailable");
    expect(buildEligibilityReport([]).decisions).toEqual([]);
    expect(isPreviewableAudio("audio/mpeg")).toBe(true);
    expect(isPreviewableAudio("audio/x-weird")).toBe(false);
    const track = tracks.list(projectId)[0];
    if (track === undefined) throw new Error("expected track");
    tracks.remove(track.id);
    expect(tracks.list(projectId)).toEqual([]);
  });
});
