import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupStaleRenderDirs,
  probeFfmpeg,
  renderMovie,
  RENDER_TEMP_PREFIX,
  selectProfile,
  type CodecProfileId,
  type FfmpegCapabilities,
  type FfmpegRunnerFn,
  type RenderEvent,
  type RenderMovieOptions,
} from "./index.js";
import { TINY_PNG, writeSineWav } from "./seed.testutil.js";

let root: string;
let media: string;
let out: string;
let temp: string;
let caps: FfmpegCapabilities;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "se-render-test-"));
  media = join(root, "media");
  out = join(root, "out");
  temp = join(root, "tmp");
  for (const d of [media, out, temp]) mkdirSync(d);
  writeFileSync(join(media, "a.png"), TINY_PNG);
  writeSineWav(join(media, "tone.wav"), 4);
  caps = await probeFfmpeg();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(overrides: Partial<RenderMovieOptions> = {}, name = "movie.webm"): RenderMovieOptions {
  return {
    plan: {
      segments: [
        { id: "s1", kind: "image", durationMs: 1500, transitionIn: "cut", inputPath: join(media, "a.png") },
        { id: "s2", kind: "card", durationMs: 1500, transitionIn: "crossfade", lines: ["Synthetic card"] },
      ],
      width: 320,
      height: 180,
      fps: 10,
      audio: [{ path: join(media, "tone.wav"), startOffsetMs: 0 }],
      inputRoots: [media],
      scrubMetadata: true,
    },
    finalOutputPath: join(out, name),
    outputRoots: [out],
    tempRoot: temp,
    ...overrides,
  };
}

const leftovers = (): string[] => readdirSync(temp).filter((n) => n.startsWith(RENDER_TEMP_PREFIX));

describe("renderMovie with a mock runner", () => {
  it("publishes output atomically, reports progress and cleans temp dirs", async () => {
    const events: RenderEvent[] = [];
    const runner: FfmpegRunnerFn = (opts) => {
      writeFileSync(opts.args.at(-1) as string, "fake-movie");
      opts.onEvent?.({ type: "progress", progress: { fraction: 0.5, outTimeMs: 1000, done: false } });
      return Promise.resolve({ status: "completed", exitCode: 0, signal: null, stderrTail: "" });
    };
    const result = await renderMovie(options({ runner, profiles: ["webm-vp9"], onEvent: (e) => events.push(e) }, "mock-ok.webm"));
    expect(result.status).toBe("completed");
    expect(existsSync(join(out, "mock-ok.webm"))).toBe(true);
    expect(readdirSync(out).some((n) => n.endsWith(".partial"))).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["attempt", "progress"]);
    expect(leftovers()).toEqual([]);
  });

  it("falls back to the next profile after a crash and reports both attempts", async () => {
    let calls = 0;
    const runner: FfmpegRunnerFn = (opts) => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ status: "failed", exitCode: 1, signal: null, stderrTail: "Unknown encoder" });
      writeFileSync(opts.args.at(-1) as string, "ok");
      return Promise.resolve({ status: "completed", exitCode: 0, signal: null, stderrTail: "" });
    };
    const result = await renderMovie(options({ runner, profiles: ["mp4-openh264", "mp4-mpeg4"] }, "fallback.mp4"));
    expect(result.status).toBe("completed");
    expect(result.attempts.map((a) => [a.profile, a.outcome.status])).toEqual([["mp4-openh264", "failed"], ["mp4-mpeg4", "completed"]]);
    expect(leftovers()).toEqual([]);
  });

  it("fails cleanly, leaves no output and cleans up when every attempt fails", async () => {
    const runner: FfmpegRunnerFn = (opts) => {
      writeFileSync(opts.args.at(-1) as string, "partial garbage");
      return Promise.resolve({ status: "failed", exitCode: 1, signal: null, stderrTail: "disk full" });
    };
    const result = await renderMovie(options({ runner, profiles: ["webm-vp9"] }, "fail.webm"));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("disk full");
    expect(existsSync(join(out, "fail.webm"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("does not retry after cancellation and treats empty output as failure", async () => {
    let calls = 0;
    const cancelled: FfmpegRunnerFn = () => {
      calls += 1;
      return Promise.resolve({ status: "cancelled", exitCode: null, signal: "SIGTERM", stderrTail: "" });
    };
    const r1 = await renderMovie(options({ runner: cancelled, profiles: ["webm-vp9", "mp4-mpeg4"] }, "c.webm"));
    expect([r1.status, calls]).toEqual(["cancelled", 1]);
    const empty: FfmpegRunnerFn = (opts) => {
      writeFileSync(opts.args.at(-1) as string, "");
      return Promise.resolve({ status: "completed", exitCode: 0, signal: null, stderrTail: "" });
    };
    const r2 = await renderMovie(options({ runner: empty, profiles: ["webm-vp9"] }, "e.webm"));
    expect(r2.status).toBe("failed");
    expect(leftovers()).toEqual([]);
  });

  it("reports security errors as failures without spawning", async () => {
    let spawned = false;
    const runner: FfmpegRunnerFn = () => {
      spawned = true;
      return Promise.resolve({ status: "completed", exitCode: 0, signal: null, stderrTail: "" });
    };
    const bad = options({ runner, profiles: ["webm-vp9"], finalOutputPath: join(root, "elsewhere.webm") });
    const result = await renderMovie(bad);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/outside/);
    expect(spawned).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("removes stale render directories", async () => {
    const stale = join(temp, `${RENDER_TEMP_PREFIX}old`);
    mkdirSync(stale);
    mkdirSync(join(temp, "unrelated"));
    const removed = await cleanupStaleRenderDirs(temp, 0, Date.now() + 1000);
    expect(removed).toEqual([stale]);
    expect(existsSync(join(temp, "unrelated"))).toBe(true);
  });
});

describe("renderMovie with a fake ffmpeg executable (real spawn lifecycle)", () => {
  function fakeFfmpeg(body: string): string {
    const path = join(root, `fake-${String(Math.random()).slice(2, 8)}.cjs`);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("runs progress to completion", async () => {
    const exe = fakeFfmpeg(`const fs=require("node:fs");const out=process.argv.at(-1);
process.stdout.write("out_time_us=1500000\\nprogress=continue\\n");
fs.writeFileSync(out,"movie");process.stdout.write("out_time_us=2500000\\nprogress=end\\n");`);
    const events: RenderEvent[] = [];
    const result = await renderMovie(options({ executable: exe, profiles: ["webm-vp9"], onEvent: (e) => events.push(e) }, "fake-ok.webm"));
    expect(result.status).toBe("completed");
    expect(events.some((e) => e.type === "progress" && e.progress.done)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("cancels a hung render and cleans up", async () => {
    const exe = fakeFfmpeg(`setInterval(()=>{},1000)`);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 200);
    const result = await renderMovie(options({ executable: exe, profiles: ["webm-vp9"], signal: controller.signal }, "fake-cancel.webm"));
    expect(result.status).toBe("cancelled");
    expect(existsSync(join(out, "fake-cancel.webm"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("times out a hung render", async () => {
    const exe = fakeFfmpeg(`setInterval(()=>{},1000)`);
    const result = await renderMovie(options({ executable: exe, profiles: ["webm-vp9"], timeoutMs: 200 }, "fake-timeout.webm"));
    expect(result.status).toBe("timeout");
    expect(leftovers()).toEqual([]);
  });

  it("surfaces crashes with stderr", async () => {
    const exe = fakeFfmpeg(`process.stderr.write("segfault-ish");process.exit(139)`);
    const result = await renderMovie(options({ executable: exe, profiles: ["webm-vp9"] }, "fake-crash.webm"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("segfault-ish");
    expect(leftovers()).toEqual([]);
  });
});

describe.skipIf(process.env["SE_SKIP_FFMPEG"] === "1")("real ffmpeg integration", () => {
  it("renders a playable sample movie with the best available LGPL-safe profile", async (ctx) => {
    if (!caps.available) return ctx.skip();
    const fast: CodecProfileId[] = caps.encoders.has("mpeg4") ? ["mp4-mpeg4"] : [];
    const profile = selectProfile(caps.encoders, fast.length > 0 ? fast : undefined);
    if (profile === undefined) return ctx.skip();
    const name = `sample${profile.extension}`;
    const events: RenderEvent[] = [];
    const result = await renderMovie(
      options({ profiles: [profile.id], timeoutMs: 60_000, onEvent: (e) => events.push(e) }, name),
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    const file = join(out, name);
    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }),
    ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string; tags?: Record<string, string> } };
    const video = probe.streams.find((s) => s.codec_type === "video");
    expect([video?.width, video?.height]).toEqual([320, 180]);
    expect(probe.streams.some((s) => s.codec_type === "audio")).toBe(true);
    expect(Number(probe.format.duration)).toBeGreaterThan(2);
    expect(Number(probe.format.duration)).toBeLessThan(3.6);
    const tags = Object.keys(probe.format.tags ?? {}).filter((k) => k !== "encoder");
    const containerOnly = new Set(["major_brand", "minor_version", "compatible_brands"]);
    expect(tags.every((k) => containerOnly.has(k))).toBe(true);
    expect(events.some((e) => e.type === "progress")).toBe(true);
    // Decode every frame to prove the file is playable.
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
    expect(leftovers()).toEqual([]);
  }, 90_000);

  it("falls back across profiles on the real binary when the first encoder is missing", async (ctx) => {
    if (!caps.available || !caps.encoders.has("mpeg4")) return ctx.skip();
    const result = await renderMovie(options({ profiles: ["mp4-openh264", "mp4-mpeg4"], timeoutMs: 60_000 }, caps.encoders.has("libopenh264") ? "skip.mp4" : "fallback-real.mp4"));
    expect(result.status).toBe("completed");
    expect(result.attempts.at(-1)?.profile).toBe(caps.encoders.has("libopenh264") ? "mp4-openh264" : "mp4-mpeg4");
  }, 90_000);
});
