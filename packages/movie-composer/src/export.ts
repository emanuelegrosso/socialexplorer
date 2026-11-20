import { randomUUID } from "node:crypto";
import type { MovieExport, SoundtrackTrack } from "@social-explorer/contracts";
import {
  createSettingsRepository,
  type SqliteDatabase,
} from "@social-explorer/database";
import {
  buildPreviewTimeline,
  MovieStudioManager,
  type AspectRatio,
  type MovieProject,
  type TimelineEntry,
} from "@social-explorer/story-engine";
import type { RenderPlanInput, RenderSegment } from "./render-plan.js";
import { renderMovie, type RenderMovieOptions, type RenderResult } from "./render.js";
import {
  resolveSoundtrackPlan,
  type EligibilityContext,
  type SoundtrackEligibilityReport,
  type SoundtrackMode,
  type SoundtrackRejection,
} from "./soundtrack.js";

export interface ExportPreset {
  readonly id: AspectRatio;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export const EXPORT_PRESETS: Readonly<Record<AspectRatio, ExportPreset>> = {
  "16:9": { id: "16:9", label: "Landscape 16:9 (1280x720)", width: 1280, height: 720, fps: 30 },
  "9:16": { id: "9:16", label: "Portrait 9:16 (720x1280)", width: 720, height: 1280, fps: 30 },
  "1:1": { id: "1:1", label: "Square 1:1 (720x720)", width: 720, height: 720, fps: 30 },
};

export const DEFAULT_EXPORT_PRESET: AspectRatio = "16:9";

export interface ExportOptions {
  /** Exports are never automatic: the caller must pass literal `true` for a user action. */
  readonly userInitiated: boolean;
  readonly preset?: AspectRatio;
  /** `true` opts in at project level, `false` hard-excludes, unset defers to saved opt-ins. */
  readonly includeContactNames?: boolean;
  readonly includeMessageText?: boolean;
  /** Default true: strip container/stream metadata. */
  readonly scrubMetadata?: boolean;
  /** Default false: write the movie title into file metadata. */
  readonly includeTitleInMetadata?: boolean;
  readonly soundtrack?: { readonly mode: SoundtrackMode; readonly embedTrackIds?: readonly string[] };
  readonly excludedItemIds?: readonly string[];
  readonly fps?: number;
}

export interface ExportDeps {
  readonly resolveAssetPath: (assetId: string) => string | undefined;
  /** Only ever called for message cards the user opted in to. */
  readonly resolveMessage?: (messageId: string) => { text?: string; senderName?: string } | undefined;
  readonly eligibility?: EligibilityContext;
}

export interface ManifestSegment {
  readonly id: string;
  readonly chapterId: string;
  readonly kind: "image" | "video" | "card";
  readonly startMs: number;
  readonly durationMs: number;
  readonly transitionIn: RenderSegment["transitionIn"];
  readonly mediaAssetId?: string;
  readonly cardLines?: readonly string[];
  readonly messageTextIncluded: boolean;
  readonly contactNameIncluded: boolean;
}

export interface ExportManifest {
  readonly version: 1;
  readonly projectId: string;
  readonly title: string;
  readonly preset: ExportPreset;
  readonly durationMs: number;
  readonly segments: readonly ManifestSegment[];
  readonly includedItemIds: readonly string[];
  readonly soundtrack: {
    readonly mode: SoundtrackMode;
    readonly embeddedTrackIds: readonly string[];
    readonly linkReferences: readonly { trackId: string; url: string; title?: string; artist?: string }[];
    readonly eligibility: SoundtrackEligibilityReport;
  };
  readonly rightsNotice: string;
  readonly privacy: {
    readonly includesContactNames: boolean;
    readonly includesMessageText: boolean;
    readonly metadataScrubbed: boolean;
    readonly titleInMetadata: boolean;
  };
  readonly warnings: readonly string[];
}

export class ExportRejectedError extends Error {
  override readonly name = "ExportRejectedError";
  constructor(
    message: string,
    readonly rejected: readonly SoundtrackRejection[] = [],
  ) {
    super(message);
  }
}

function cardLines(
  entry: TimelineEntry,
  text: boolean,
  name: boolean,
  deps: ExportDeps,
): { lines: string[]; textUsed: boolean; nameUsed: boolean } {
  switch (entry.kind) {
    case "chapter-title":
    case "title-card":
      return { lines: [entry.label ?? ""].filter((l) => l !== ""), textUsed: false, nameUsed: false };
    case "stat-card":
      return {
        lines: entry.stat === undefined ? [] : [entry.stat.label, String(entry.stat.value)],
        textUsed: false,
        nameUsed: false,
      };
    case "message-card": {
      if (!text && !name) return { lines: ["Message"], textUsed: false, nameUsed: false };
      const message = entry.messageId === undefined ? undefined : deps.resolveMessage?.(entry.messageId);
      const lines: string[] = [];
      let textUsed = false;
      let nameUsed = false;
      if (text && message?.text !== undefined && message.text !== "") {
        lines.push(message.text);
        textUsed = true;
      }
      if (name && message?.senderName !== undefined && message.senderName !== "") {
        lines.push(textUsed ? `- ${message.senderName}` : message.senderName);
        nameUsed = true;
      }
      return { lines: lines.length === 0 ? ["Message"] : lines, textUsed, nameUsed };
    }
    default:
      return { lines: [], textUsed: false, nameUsed: false };
  }
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: ExportManifest }
  | { readonly ok: false; readonly reason: string; readonly rejected: readonly SoundtrackRejection[] };

/**
 * Builds the export/preview manifest. Includes only items present in the user's project
 * (minus explicit exclusions), no contact names or message text unless opted in, a rights
 * notice and the soundtrack eligibility report. Unlicensed embedded music is rejected.
 */
export function buildExportManifest(
  movie: MovieProject,
  deps: ExportDeps,
  options: ExportOptions,
): ManifestResult {
  if ((options.userInitiated as unknown) !== true) {
    return { ok: false, reason: "Export must be started by the user", rejected: [] };
  }
  const presetId = options.preset ?? movie.project.aspectRatio;
  const preset = EXPORT_PRESETS[presetId];
  const soundtrackRequest = options.soundtrack ?? { mode: "no-music" as const };
  const soundtrack = resolveSoundtrackPlan(movie.tracks, {
    mode: soundtrackRequest.mode,
    ...(soundtrackRequest.embedTrackIds === undefined ? {} : { embedTrackIds: soundtrackRequest.embedTrackIds }),
    ...(deps.eligibility === undefined ? {} : { context: deps.eligibility }),
  });
  if (!soundtrack.ok) {
    return { ok: false, reason: "Soundtrack contains tracks that cannot be embedded", rejected: soundtrack.rejected };
  }

  const warnings: string[] = [...soundtrack.plan.warnings];
  const excluded = new Set(options.excludedItemIds ?? []);
  const segments: ManifestSegment[] = [];
  const includedItemIds: string[] = [];
  let cursor = 0;
  let anyText = false;
  let anyName = false;
  for (const entry of buildPreviewTimeline(movie).entries) {
    if (entry.itemId !== undefined && excluded.has(entry.itemId)) continue;
    const text = options.includeMessageText === false ? false : options.includeMessageText === true || entry.includeMessageText;
    const name = options.includeContactNames === false ? false : options.includeContactNames === true || entry.includeContactName;
    let kind: ManifestSegment["kind"];
    if (entry.kind === "photo") kind = "image";
    else if (entry.kind === "video") kind = "video";
    else if (entry.kind === "audio") {
      warnings.push(`Audio item ${entry.id} is ignored; add music through the soundtrack.`);
      continue;
    } else kind = "card";
    if (kind !== "card") {
      if (entry.mediaAssetId === undefined || deps.resolveAssetPath(entry.mediaAssetId) === undefined) {
        warnings.push(`Media for item ${entry.id} is unavailable and was skipped.`);
        continue;
      }
    }
    const card = kind === "card" ? cardLines(entry, text, name, deps) : undefined;
    const durationMs = entry.endMs - entry.startMs;
    segments.push({
      id: entry.id,
      chapterId: entry.chapterId,
      kind,
      startMs: cursor,
      durationMs,
      transitionIn: segments.length === 0 ? "cut" : entry.transitionIn,
      ...(entry.mediaAssetId === undefined || kind === "card" ? {} : { mediaAssetId: entry.mediaAssetId }),
      ...(card === undefined ? {} : { cardLines: card.lines }),
      messageTextIncluded: card?.textUsed ?? false,
      contactNameIncluded: card?.nameUsed ?? false,
    });
    anyText ||= card?.textUsed ?? false;
    anyName ||= card?.nameUsed ?? false;
    if (entry.itemId !== undefined) includedItemIds.push(entry.itemId);
    cursor += durationMs;
  }
  if (segments.length === 0) {
    return { ok: false, reason: "The project has no exportable content", rejected: [] };
  }
  const plan = soundtrack.plan;
  return {
    ok: true,
    manifest: {
      version: 1,
      projectId: movie.project.id,
      title: movie.project.title,
      preset: { ...preset, fps: options.fps ?? preset.fps },
      durationMs: cursor,
      segments,
      includedItemIds,
      soundtrack: {
        mode: plan.mode,
        embeddedTrackIds: plan.embeddedTracks.map((t) => t.id),
        linkReferences: plan.linkReferences,
        eligibility: plan.report,
      },
      rightsNotice: plan.rightsNotice,
      privacy: {
        includesContactNames: anyName,
        includesMessageText: anyText,
        metadataScrubbed: options.scrubMetadata ?? true,
        titleInMetadata: options.includeTitleInMetadata ?? false,
      },
      warnings,
    },
  };
}

export interface ManifestRenderContext {
  readonly resolveAssetPath: (assetId: string) => string | undefined;
  readonly tracks: readonly SoundtrackTrack[];
  readonly inputRoots: readonly string[];
  readonly fontFile?: string;
  readonly threads?: number;
}

/** Turns a validated manifest into render-plan input (paths resolved at the last moment). */
export function manifestToRenderPlan(
  manifest: ExportManifest,
  ctx: ManifestRenderContext,
): Omit<RenderPlanInput, "outputPath" | "workDir" | "profile" | "outputRoots"> {
  const segments: RenderSegment[] = manifest.segments.map((segment) => {
    const path = segment.mediaAssetId === undefined ? undefined : ctx.resolveAssetPath(segment.mediaAssetId);
    return {
      id: segment.id,
      kind: segment.kind,
      durationMs: segment.durationMs,
      transitionIn: segment.transitionIn,
      ...(path === undefined ? {} : { inputPath: path }),
      ...(segment.cardLines === undefined ? {} : { lines: segment.cardLines }),
    };
  });
  const audio = manifest.soundtrack.embeddedTrackIds.flatMap((id) => {
    const track = ctx.tracks.find((t) => t.id === id);
    const path = track?.localAssetId === undefined ? undefined : ctx.resolveAssetPath(track.localAssetId);
    return track === undefined || path === undefined
      ? []
      : [{ path, startOffsetMs: track.startOffsetMs, ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }) }];
  });
  return {
    segments,
    width: manifest.preset.width,
    height: manifest.preset.height,
    fps: manifest.preset.fps,
    audio,
    inputRoots: ctx.inputRoots,
    scrubMetadata: manifest.privacy.metadataScrubbed,
    ...(manifest.privacy.titleInMetadata ? { metadataTitle: manifest.title } : {}),
    ...(ctx.fontFile === undefined ? {} : { fontFile: ctx.fontFile }),
    ...(ctx.threads === undefined ? {} : { threads: ctx.threads }),
  };
}

interface StoredJob {
  readonly preset: AspectRatio;
  readonly manifest: ExportManifest;
  readonly outputPath?: string;
}

const jobKey = (id: string): string => `movie-export:${id}`;

/**
 * Export job lifecycle persisted in `movie_exports`. The table's preset column only allows
 * '16:9', so the real preset and manifest are kept alongside in app settings.
 */
export class ExportJobManager {
  readonly #db: SqliteDatabase;
  readonly #studio: MovieStudioManager;
  readonly #settings: ReturnType<typeof createSettingsRepository>;
  readonly #newId: () => string;
  readonly #now: () => string;

  constructor(
    db: SqliteDatabase,
    options: { studio?: MovieStudioManager; newId?: () => string; now?: () => string } = {},
  ) {
    this.#db = db;
    this.#studio = options.studio ?? new MovieStudioManager(db);
    this.#settings = createSettingsRepository(db);
    this.#newId = options.newId ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"));
  }

  /** Preview: the manifest only; nothing is persisted or rendered. */
  preview(projectId: string, deps: ExportDeps, options: ExportOptions): ManifestResult {
    const movie = this.#studio.load(projectId);
    if (movie === undefined) return { ok: false, reason: "Unknown project", rejected: [] };
    return buildExportManifest(movie, deps, options);
  }

  createJob(projectId: string, deps: ExportDeps, options: ExportOptions): MovieExport {
    const result = this.preview(projectId, deps, options);
    if (!result.ok) throw new ExportRejectedError(result.reason, result.rejected);
    const { manifest } = result;
    const job: MovieExport = {
      id: this.#newId(),
      projectId,
      preset: "16:9",
      status: "queued",
      includeMessageText: manifest.privacy.includesMessageText,
      includeContactNames: manifest.privacy.includesContactNames,
      includedSoundtrackTrackIds: [...manifest.soundtrack.embeddedTrackIds],
      linkReferenceTrackIds: manifest.soundtrack.linkReferences.map((r) => r.trackId),
      createdAt: this.#now(),
    };
    this.#studio.repository.upsertMovieExport(job);
    this.#settings.set(jobKey(job.id), { preset: manifest.preset.id, manifest } satisfies StoredJob, this.#now());
    return job;
  }

  getStoredManifest(jobId: string): { preset: AspectRatio; manifest: ExportManifest } | undefined {
    return this.#settings.get(jobKey(jobId)) as StoredJob | undefined;
  }

  async run(
    jobId: string,
    projectId: string,
    ctx: ManifestRenderContext,
    render: Pick<
      RenderMovieOptions,
      "finalOutputPath" | "outputRoots" | "executable" | "profiles" | "tempRoot" | "signal" | "timeoutMs" | "maxOutputBytes" | "onEvent" | "runner"
    >,
  ): Promise<RenderResult> {
    const stored = this.getStoredManifest(jobId);
    const job = this.#studio.repository.listMovieExports(projectId).find((j) => j.id === jobId);
    const movie = this.#studio.load(projectId);
    if (stored === undefined || job === undefined || movie === undefined) {
      throw new ExportRejectedError("Unknown export job");
    }
    const setStatus = (status: MovieExport["status"], projectStatus: MovieProject["project"]["status"]): void => {
      this.#studio.repository.upsertMovieExport({
        ...job,
        status,
        ...(status === "completed" || status === "failed" || status === "cancelled" ? { completedAt: this.#now() } : {}),
      });
      this.#studio.repository.upsertProject({ ...movie.project, status: projectStatus, updatedAt: this.#now() });
    };
    setStatus("rendering", "rendering");
    let result: RenderResult;
    try {
      result = await renderMovie({ ...render, plan: manifestToRenderPlan(stored.manifest, ctx) });
    } catch (error) {
      setStatus("failed", "failed");
      throw error;
    }
    if (result.status === "completed") setStatus("completed", "ready");
    else if (result.status === "cancelled") setStatus("cancelled", "draft");
    else setStatus("failed", "failed");
    return result;
  }

  list(projectId: string): MovieExport[] {
    return this.#studio.repository.listMovieExports(projectId);
  }

  get db(): SqliteDatabase {
    return this.#db;
  }
}
