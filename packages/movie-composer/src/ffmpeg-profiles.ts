export type CodecProfileId = "mp4-openh264" | "webm-vp9" | "mp4-mpeg4";

export interface CodecProfile {
  readonly id: CodecProfileId;
  readonly container: "mp4" | "webm";
  readonly extension: ".mp4" | ".webm";
  readonly videoEncoder: string;
  readonly audioEncoder: string;
  readonly videoArgs: readonly string[];
  readonly audioArgs: readonly string[];
  readonly containerArgs: readonly string[];
  readonly note: string;
}

/**
 * Distribution-safe profiles only. libx264/libx265/libfdk_aac are deliberately absent:
 * they would make a bundled FFmpeg GPL / non-free (see docs/ffmpeg-licensing.md).
 */
export const CODEC_PROFILES: Readonly<Record<CodecProfileId, CodecProfile>> = {
  "mp4-openh264": {
    id: "mp4-openh264",
    container: "mp4",
    extension: ".mp4",
    videoEncoder: "libopenh264",
    audioEncoder: "aac",
    videoArgs: ["-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p"],
    audioArgs: ["-c:a", "aac", "-b:a", "128k"],
    containerArgs: ["-f", "mp4", "-movflags", "+faststart"],
    note: "H.264 via Cisco OpenH264 (BSD, binary-distribution patent licence) + native AAC.",
  },
  "webm-vp9": {
    id: "webm-vp9",
    container: "webm",
    extension: ".webm",
    videoEncoder: "libvpx-vp9",
    audioEncoder: "libopus",
    videoArgs: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuv420p"],
    audioArgs: ["-c:a", "libopus", "-b:a", "96k"],
    containerArgs: ["-f", "webm"],
    note: "Royalty-free VP9 + Opus in WebM; preferred default for redistribution.",
  },
  "mp4-mpeg4": {
    id: "mp4-mpeg4",
    container: "mp4",
    extension: ".mp4",
    videoEncoder: "mpeg4",
    audioEncoder: "aac",
    videoArgs: ["-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p"],
    audioArgs: ["-c:a", "aac", "-b:a", "128k"],
    containerArgs: ["-f", "mp4", "-movflags", "+faststart"],
    note: "FFmpeg-native MPEG-4 Part 2 + AAC: always LGPL-clean fallback, larger files.",
  },
};

export const DEFAULT_PROFILE_ORDER: readonly CodecProfileId[] = ["webm-vp9", "mp4-openh264", "mp4-mpeg4"];

export function selectProfile(
  availableEncoders: ReadonlySet<string>,
  preferred: readonly CodecProfileId[] = DEFAULT_PROFILE_ORDER,
): CodecProfile | undefined {
  for (const id of preferred) {
    const profile = CODEC_PROFILES[id];
    if (availableEncoders.has(profile.videoEncoder) && availableEncoders.has(profile.audioEncoder)) {
      return profile;
    }
  }
  return undefined;
}

export function parseEncoderList(output: string): Set<string> {
  const encoders = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^\s*[VAS][A-Z.]{5}\s+(\S+)\s/u.exec(line);
    if (match?.[1] !== undefined) encoders.add(match[1]);
  }
  return encoders;
}
