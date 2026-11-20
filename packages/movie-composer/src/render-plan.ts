import { CODEC_PROFILES, type CodecProfile, type CodecProfileId } from "./ffmpeg-profiles.js";
import {
  assertFilterSafePath,
  assertSafeInputFile,
  assertSafeOutputPath,
  ffmpegFileInput,
  RenderSecurityError,
} from "./safe-paths.js";

export type SegmentTransition = "cut" | "fade" | "crossfade";

export interface RenderSegment {
  readonly id: string;
  readonly kind: "image" | "video" | "card";
  readonly durationMs: number;
  readonly transitionIn: SegmentTransition;
  /** Absolute path of an image/video; required for `image` and `video`. */
  readonly inputPath?: string;
  /** Text lines for a card; only what the privacy rules allowed into the manifest. */
  readonly lines?: readonly string[];
}

export interface RenderAudioTrack {
  readonly path: string;
  readonly startOffsetMs: number;
  readonly durationMs?: number;
}

export interface RenderPlanInput {
  readonly segments: readonly RenderSegment[];
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly audio: readonly RenderAudioTrack[];
  readonly profile: CodecProfileId;
  readonly outputPath: string;
  readonly inputRoots: readonly string[];
  readonly outputRoots: readonly string[];
  /** Directory (inside outputRoots) where card text files are written. */
  readonly workDir: string;
  readonly fontFile?: string;
  readonly scrubMetadata: boolean;
  /** Only set when the user opted in to a title in the file metadata. */
  readonly metadataTitle?: string;
  readonly threads?: number;
}

export interface CompiledRenderPlan {
  readonly args: readonly string[];
  readonly textFiles: readonly { readonly path: string; readonly content: string }[];
  readonly totalDurationMs: number;
  readonly profile: CodecProfile;
  readonly outputPath: string;
}

const CARD_COLORS = ["0x1f2937", "0x312e81", "0x134e4a", "0x4c1d95"] as const;
const MAX_TRANSITION_MS = 500;
const MAX_DIMENSION = 4096;
const MAX_SEGMENTS = 500;

const sec = (ms: number): string => (ms / 1000).toFixed(3);

function checkInput(input: RenderPlanInput): void {
  if (input.segments.length === 0) throw new RenderSecurityError("Render plan has no segments");
  if (input.segments.length > MAX_SEGMENTS) throw new RenderSecurityError("Too many segments");
  for (const [name, value] of [["width", input.width], ["height", input.height]] as const) {
    if (!Number.isInteger(value) || value < 16 || value > MAX_DIMENSION || value % 2 !== 0) {
      throw new RenderSecurityError(`Invalid ${name}`);
    }
  }
  if (!Number.isInteger(input.fps) || input.fps < 1 || input.fps > 60) throw new RenderSecurityError("Invalid fps");
  if (input.threads !== undefined && (!Number.isInteger(input.threads) || input.threads < 1 || input.threads > 64)) {
    throw new RenderSecurityError("Invalid thread count");
  }
  for (const segment of input.segments) {
    if (!Number.isInteger(segment.durationMs) || segment.durationMs < 100 || segment.durationMs > 600_000) {
      throw new RenderSecurityError(`Invalid duration for segment ${segment.id}`);
    }
  }
}

function sanitizeTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 200);
}

/**
 * Deterministic compiler: segments, transitions and audio become one validated ffmpeg
 * argument array. Same input always yields byte-identical arguments. Nothing is
 * shell-interpolated; user text only reaches ffmpeg through files read by `drawtext`.
 */
export function compileRenderPlan(input: RenderPlanInput): CompiledRenderPlan {
  checkInput(input);
  const profile = CODEC_PROFILES[input.profile];
  const outputPath = assertSafeOutputPath(input.outputPath, input.outputRoots, [profile.extension], "output");
  const fontFile =
    input.fontFile === undefined
      ? undefined
      : assertFilterSafePath(assertSafeInputFile(input.fontFile, input.inputRoots, "font"), "font");

  const inputArgs: string[] = [];
  const textFiles: { path: string; content: string }[] = [];
  const chains: string[] = [];
  const { width, height, fps } = input;
  const norm = `format=yuv420p`;

  input.segments.forEach((segment, index) => {
    const d = sec(segment.durationMs);
    if (segment.kind === "card") {
      const color = CARD_COLORS[index % CARD_COLORS.length] as string;
      inputArgs.push("-f", "lavfi", "-i", `color=c=${color}:s=${String(width)}x${String(height)}:r=${String(fps)}:d=${d}`);
      let filter = `[${String(index)}:v]setsar=1,${norm}`;
      const lines = (segment.lines ?? []).map((line) => sanitizeTitle(line)).filter((line) => line.length > 0);
      if (fontFile !== undefined && lines.length > 0) {
        const textPath = assertFilterSafePath(`${input.workDir}/card-${String(index)}.txt`, "card text");
        textFiles.push({ path: textPath, content: lines.join("\n") });
        filter += `,drawtext=fontfile=${fontFile}:textfile=${textPath}:reload=0:fontcolor=white:fontsize=${String(Math.round(height / 16))}:x=(w-text_w)/2:y=(h-text_h)/2`;
      }
      chains.push(`${filter}[v${String(index)}]`);
      return;
    }
    if (segment.inputPath === undefined) throw new RenderSecurityError(`Segment ${segment.id} needs an input`);
    const path = assertSafeInputFile(segment.inputPath, input.inputRoots, `segment ${segment.id}`);
    const fit = `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${String(fps)}`;
    if (segment.kind === "image") {
      inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", d, "-i", ffmpegFileInput(path));
      chains.push(`[${String(index)}:v]${fit},${norm}[v${String(index)}]`);
    } else {
      inputArgs.push("-t", d, "-i", ffmpegFileInput(path));
      chains.push(
        `[${String(index)}:v]${fit},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS,${norm}[v${String(index)}]`,
      );
    }
  });

  let currentLabel = "v0";
  let accumulatedMs = input.segments[0]?.durationMs ?? 0;
  let previousMs = accumulatedMs;
  for (let index = 1; index < input.segments.length; index += 1) {
    const segment = input.segments[index] as RenderSegment;
    const next = `j${String(index)}`;
    if (segment.transitionIn === "cut") {
      chains.push(`[${currentLabel}][v${String(index)}]concat=n=2:v=1:a=0[${next}]`);
      accumulatedMs += segment.durationMs;
    } else {
      const td = Math.min(MAX_TRANSITION_MS, Math.floor(segment.durationMs / 2), Math.floor(previousMs / 2));
      const kind = segment.transitionIn === "fade" ? "fadeblack" : "dissolve";
      chains.push(
        `[${currentLabel}][v${String(index)}]xfade=transition=${kind}:duration=${sec(td)}:offset=${sec(accumulatedMs - td)}[${next}]`,
      );
      accumulatedMs += segment.durationMs - td;
    }
    previousMs = segment.durationMs;
    currentLabel = next;
  }
  const totalDurationMs = accumulatedMs;

  const videoInputCount = input.segments.length;
  const audioLabels: string[] = [];
  input.audio.forEach((track, index) => {
    const path = assertSafeInputFile(track.path, input.inputRoots, `audio ${String(index)}`);
    if (!Number.isInteger(track.startOffsetMs) || track.startOffsetMs < 0 || track.startOffsetMs >= totalDurationMs) {
      throw new RenderSecurityError("Audio start offset outside the movie");
    }
    inputArgs.push("-i", ffmpegFileInput(path));
    const available = totalDurationMs - track.startOffsetMs;
    const length = Math.min(track.durationMs ?? available, available);
    const label = `a${String(index)}`;
    chains.push(
      `[${String(videoInputCount + index)}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${sec(length)},asetpts=PTS-STARTPTS,adelay=${String(track.startOffsetMs)}|${String(track.startOffsetMs)}[${label}]`,
    );
    audioLabels.push(label);
  });
  const hasAudio = audioLabels.length > 0;
  if (hasAudio) {
    const mixed = audioLabels.length === 1 ? (audioLabels[0] as string) : "amixed";
    if (audioLabels.length > 1) {
      chains.push(`${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${String(audioLabels.length)}:duration=longest:normalize=0[amixed]`);
    }
    const fade = Math.min(1, totalDurationMs / 2000);
    chains.push(
      `[${mixed}]atrim=0:${sec(totalDurationMs)},afade=t=out:st=${sec(totalDurationMs - fade * 1000)}:d=${fade.toFixed(3)}[aout]`,
    );
  }

  const metadataArgs: string[] = input.scrubMetadata
    ? ["-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"]
    : [];
  if (input.metadataTitle !== undefined) {
    const title = sanitizeTitle(input.metadataTitle);
    if (title.length > 0) metadataArgs.push("-metadata", `title=${title}`);
  }

  const args = [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-y",
    ...inputArgs,
    "-filter_complex",
    chains.join(";"),
    "-map",
    `[${currentLabel}]`,
    ...(hasAudio ? ["-map", "[aout]", ...profile.audioArgs] : ["-an"]),
    ...profile.videoArgs,
    "-r",
    String(fps),
    "-t",
    sec(totalDurationMs),
    ...(input.threads === undefined ? [] : ["-threads", String(input.threads), "-filter_complex_threads", String(input.threads)]),
    ...metadataArgs,
    ...profile.containerArgs,
    outputPath,
  ];
  return { args, textFiles, totalDurationMs, profile, outputPath };
}
