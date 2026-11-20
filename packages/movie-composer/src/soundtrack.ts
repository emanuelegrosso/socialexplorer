import { randomUUID } from "node:crypto";
import {
  isEmbeddableInExport,
  type SoundtrackRightsStatus,
  type SoundtrackTrack,
} from "@social-explorer/contracts";
import {
  createMediaStorytellingRepository,
  type MediaStorytellingRepository,
  type SqliteDatabase,
} from "@social-explorer/database";
import { classifyUrl } from "@social-explorer/media-core";

export type SoundtrackMode = "embed" | "link-reference" | "no-music";

export type EligibilityReason =
  | "eligible-licensed"
  | "eligible-user-confirmed"
  | "shared-link-reference-only"
  | "rights-unknown"
  | "rights-not-for-export"
  | "local-file-unavailable"
  | "no-local-file";

/** UI copy for each rights decision. Kept here so UI and export report cannot drift apart. */
export const RIGHTS_COPY: Readonly<Record<EligibilityReason, string>> = {
  "eligible-licensed": "Licensed track: can be embedded in the exported movie.",
  "eligible-user-confirmed":
    "You confirmed you have the rights to this file: it can be embedded. You remain responsible for sharing it.",
  "shared-link-reference-only":
    "Shared music links are never embedded. The movie keeps the link as a reference instead.",
  "rights-unknown":
    "Rights unknown: this track is not embedded in the movie. Confirm your rights or use a link reference.",
  "rights-not-for-export": "Marked not for export: this track is never embedded in a movie.",
  "local-file-unavailable": "The audio file is missing on this device, so it cannot be embedded.",
  "no-local-file": "No audio file is attached to this track, so it cannot be embedded.",
};

export const RIGHTS_NOTICE_BY_MODE: Readonly<Record<SoundtrackMode, string>> = {
  embed:
    "Embedded music is included only because it is licensed or you confirmed the rights. Check the rights before sharing this movie publicly.",
  "link-reference":
    "No music is embedded. Shared music links are listed as references and stay with their original provider.",
  "no-music": "This movie contains no music.",
};

export interface TrackDecision {
  readonly trackId: string;
  readonly title?: string;
  readonly sourceKind: SoundtrackTrack["sourceKind"];
  readonly rightsStatus: SoundtrackRightsStatus;
  readonly eligibleForEmbedding: boolean;
  readonly reason: EligibilityReason;
  readonly uiCopy: string;
  readonly linkUrl?: string;
}

export interface EligibilityContext {
  /** Whether the track's local audio file is currently available. Defaults to true. */
  readonly isLocalFileAvailable?: (assetId: string) => boolean;
}

export function evaluateTrack(track: SoundtrackTrack, ctx: EligibilityContext = {}): TrackDecision {
  const reason = ((): EligibilityReason => {
    if (track.sourceKind === "shared-link") return "shared-link-reference-only";
    if (track.rightsStatus === "not-for-export") return "rights-not-for-export";
    if (!isEmbeddableInExport(track)) return "rights-unknown";
    if (track.localAssetId === undefined) return "no-local-file";
    if (ctx.isLocalFileAvailable?.(track.localAssetId) === false) return "local-file-unavailable";
    return track.rightsStatus === "licensed" ? "eligible-licensed" : "eligible-user-confirmed";
  })();
  return {
    trackId: track.id,
    ...(track.title === undefined ? {} : { title: track.title }),
    sourceKind: track.sourceKind,
    rightsStatus: track.rightsStatus,
    eligibleForEmbedding: reason === "eligible-licensed" || reason === "eligible-user-confirmed",
    reason,
    uiCopy: RIGHTS_COPY[reason],
    ...(track.externalUrl === undefined ? {} : { linkUrl: track.externalUrl }),
  };
}

export interface SoundtrackEligibilityReport {
  readonly decisions: readonly TrackDecision[];
  readonly eligibleTrackIds: readonly string[];
  readonly ineligibleTrackIds: readonly string[];
}

export function buildEligibilityReport(
  tracks: readonly SoundtrackTrack[],
  ctx: EligibilityContext = {},
): SoundtrackEligibilityReport {
  const decisions = tracks.map((track) => evaluateTrack(track, ctx));
  return {
    decisions,
    eligibleTrackIds: decisions.filter((d) => d.eligibleForEmbedding).map((d) => d.trackId),
    ineligibleTrackIds: decisions.filter((d) => !d.eligibleForEmbedding).map((d) => d.trackId),
  };
}

export interface SoundtrackRejection {
  readonly trackId: string;
  readonly reason: EligibilityReason | "unknown-track";
  readonly message: string;
}

export interface SoundtrackPlan {
  readonly mode: SoundtrackMode;
  readonly embeddedTracks: readonly SoundtrackTrack[];
  readonly linkReferences: readonly { trackId: string; url: string; title?: string; artist?: string }[];
  readonly rightsNotice: string;
  readonly report: SoundtrackEligibilityReport;
  readonly warnings: readonly string[];
}

export type SoundtrackPlanResult =
  | { readonly ok: true; readonly plan: SoundtrackPlan }
  | { readonly ok: false; readonly rejected: readonly SoundtrackRejection[]; readonly report: SoundtrackEligibilityReport };

export interface SoundtrackPlanRequest {
  readonly mode: SoundtrackMode;
  /** For `embed`: explicit tracks to embed. Any ineligible one rejects the whole manifest. */
  readonly embedTrackIds?: readonly string[];
  readonly context?: EligibilityContext;
}

/**
 * Export manifest validation. Unlicensed / unknown / not-for-export tracks can never be
 * embedded: asking for them is a hard rejection, not a silent drop. `no-music` and
 * `link-reference` always succeed.
 */
export function resolveSoundtrackPlan(
  tracks: readonly SoundtrackTrack[],
  request: SoundtrackPlanRequest,
): SoundtrackPlanResult {
  const report = buildEligibilityReport(tracks, request.context);
  const linkReferences = tracks.flatMap((track) =>
    track.externalUrl === undefined
      ? []
      : [
          {
            trackId: track.id,
            url: track.externalUrl,
            ...(track.title === undefined ? {} : { title: track.title }),
            ...(track.artist === undefined ? {} : { artist: track.artist }),
          },
        ],
  );
  const base = { rightsNotice: RIGHTS_NOTICE_BY_MODE[request.mode], report };

  if (request.mode === "no-music") {
    return { ok: true, plan: { mode: "no-music", embeddedTracks: [], linkReferences: [], warnings: [], ...base } };
  }
  if (request.mode === "link-reference") {
    return { ok: true, plan: { mode: "link-reference", embeddedTracks: [], linkReferences, warnings: [], ...base } };
  }

  const explicit = request.embedTrackIds !== undefined;
  const requested = request.embedTrackIds ?? report.eligibleTrackIds;
  const rejected: SoundtrackRejection[] = [];
  const embedded: SoundtrackTrack[] = [];
  for (const id of requested) {
    const track = tracks.find((t) => t.id === id);
    const decision = report.decisions.find((d) => d.trackId === id);
    if (track === undefined || decision === undefined) {
      rejected.push({ trackId: id, reason: "unknown-track", message: "Track is not part of this project." });
    } else if (!decision.eligibleForEmbedding) {
      rejected.push({ trackId: id, reason: decision.reason, message: decision.uiCopy });
    } else {
      embedded.push(track);
    }
  }
  if (explicit && rejected.length > 0) return { ok: false, rejected, report };
  const warnings =
    embedded.length === 0 ? ["No eligible track to embed; the movie is exported without music."] : [];
  return {
    ok: true,
    plan: {
      mode: "embed",
      embeddedTracks: embedded,
      linkReferences: linkReferences.filter((ref) => !embedded.some((t) => t.id === ref.trackId)),
      warnings,
      ...base,
    },
  };
}

const PREVIEWABLE_AUDIO = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
]);

export function isPreviewableAudio(mimeType: string | undefined): boolean {
  return mimeType !== undefined && PREVIEWABLE_AUDIO.has(mimeType.toLowerCase());
}

export class SoundtrackError extends Error {
  override readonly name = "SoundtrackError";
}

export interface SoundtrackManagerClock {
  readonly newId: () => string;
}

/** Persists soundtrack tracks (`soundtrack_tracks`) and enforces rights invariants. */
export class SoundtrackManager {
  readonly #db: SqliteDatabase;
  readonly #repo: MediaStorytellingRepository;
  readonly #newId: () => string;

  constructor(db: SqliteDatabase, clock: Partial<SoundtrackManagerClock> = {}) {
    this.#db = db;
    this.#repo = createMediaStorytellingRepository(db);
    this.#newId = clock.newId ?? (() => randomUUID());
  }

  list(projectId: string): SoundtrackTrack[] {
    return this.#repo.listSoundtrackTracks(projectId);
  }

  /** A shared music link is only ever a reference; its rights are never user-upgradable. */
  addSharedLink(
    projectId: string,
    input: { url: string; title?: string; artist?: string; startOffsetMs?: number },
  ): SoundtrackTrack {
    const classified = classifyUrl(input.url);
    if (classified === undefined) throw new SoundtrackError("Only http(s) links can be added as references");
    return this.#insert({
      projectId,
      sourceKind: "shared-link",
      externalUrl: classified.canonicalUrl,
      rightsStatus: classified.rightsStatus,
      title: input.title,
      artist: input.artist,
      startOffsetMs: input.startOffsetMs ?? 0,
    });
  }

  /** A user-provided file starts as `unknown`; the user must explicitly confirm rights. */
  addUserFile(
    projectId: string,
    input: {
      localAssetId: string;
      title?: string;
      artist?: string;
      startOffsetMs?: number;
      durationMs?: number;
      rightsStatus?: Extract<SoundtrackRightsStatus, "unknown" | "user-confirmed" | "not-for-export">;
    },
  ): SoundtrackTrack {
    const asset = this.#repo.getAsset(input.localAssetId);
    if (asset?.kind !== "audio" && asset?.kind !== "voice") {
      throw new SoundtrackError("The selected asset is not an audio file");
    }
    return this.#insert({
      projectId,
      sourceKind: "user-file",
      localAssetId: input.localAssetId,
      rightsStatus: input.rightsStatus ?? "unknown",
      title: input.title ?? asset.originalName,
      artist: input.artist,
      startOffsetMs: input.startOffsetMs ?? 0,
      durationMs: input.durationMs ?? asset.durationMs,
    });
  }

  /** Future licensed library hook: entries arrive already licensed with an app-managed asset. */
  addLicensedLibraryEntry(
    projectId: string,
    input: { localAssetId: string; title?: string; artist?: string; startOffsetMs?: number },
  ): SoundtrackTrack {
    if (this.#repo.getAsset(input.localAssetId) === undefined) {
      throw new SoundtrackError("Unknown library asset");
    }
    return this.#insert({
      projectId,
      sourceKind: "licensed-library",
      localAssetId: input.localAssetId,
      rightsStatus: "licensed",
      title: input.title,
      artist: input.artist,
      startOffsetMs: input.startOffsetMs ?? 0,
    });
  }

  setRights(trackId: string, projectId: string, rightsStatus: SoundtrackRightsStatus): SoundtrackTrack {
    const track = this.#repo.listSoundtrackTracks(projectId).find((t) => t.id === trackId);
    if (track === undefined) throw new SoundtrackError(`Unknown track ${trackId}`);
    if (track.sourceKind === "shared-link" && rightsStatus !== "unknown" && rightsStatus !== "not-for-export") {
      throw new SoundtrackError("Shared links cannot be marked embeddable");
    }
    if (track.sourceKind === "licensed-library" && rightsStatus !== "licensed") {
      throw new SoundtrackError("Licensed library tracks keep their licensed status");
    }
    if (track.sourceKind === "user-file" && rightsStatus === "licensed") {
      throw new SoundtrackError("Only the licensed library can grant a licensed status");
    }
    const updated = { ...track, rightsStatus };
    this.#repo.upsertSoundtrackTrack(updated);
    return updated;
  }

  remove(trackId: string): void {
    this.#db.prepare("DELETE FROM soundtrack_tracks WHERE id = ?").run(trackId);
  }

  eligibility(projectId: string): SoundtrackEligibilityReport {
    return buildEligibilityReport(this.list(projectId), {
      isLocalFileAvailable: (id) => {
        const asset = this.#repo.getAsset(id);
        return asset?.availability === "available-local" && asset.storageRelativePath !== undefined;
      },
    });
  }

  #insert(input: {
    projectId: string;
    sourceKind: SoundtrackTrack["sourceKind"];
    externalUrl?: string | undefined;
    localAssetId?: string | undefined;
    title?: string | undefined;
    artist?: string | undefined;
    startOffsetMs: number;
    durationMs?: number | undefined;
    rightsStatus: SoundtrackRightsStatus;
  }): SoundtrackTrack {
    if (!Number.isInteger(input.startOffsetMs) || input.startOffsetMs < 0) {
      throw new SoundtrackError("Start offset must be a non-negative integer (ms)");
    }
    const track: SoundtrackTrack = {
      id: this.#newId(),
      projectId: input.projectId,
      sourceKind: input.sourceKind,
      ...(input.externalUrl === undefined ? {} : { externalUrl: input.externalUrl }),
      ...(input.localAssetId === undefined ? {} : { localAssetId: input.localAssetId }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.artist === undefined ? {} : { artist: input.artist }),
      startOffsetMs: input.startOffsetMs,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      rightsStatus: input.rightsStatus,
    };
    this.#repo.upsertSoundtrackTrack(track);
    return track;
  }
}
