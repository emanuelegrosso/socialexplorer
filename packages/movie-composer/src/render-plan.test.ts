import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileRenderPlan, RenderSecurityError, selectProfile, parseEncoderList, type RenderPlanInput } from "./index.js";
import { TINY_PNG, writeSineWav } from "./seed.testutil.js";

let root: string;
let media: string;
let work: string;
let outside: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "se-plan-test-"));
  media = join(root, "media");
  work = join(root, "work");
  outside = join(root, "outside");
  for (const d of [media, work, outside]) mkdirSync(d);
  writeFileSync(join(media, "a.png"), TINY_PNG);
  writeFileSync(join(media, "b.png"), TINY_PNG);
  writeFileSync(join(outside, "secret.png"), TINY_PNG);
  symlinkSync(join(outside, "secret.png"), join(media, "link.png"));
  writeSineWav(join(media, "tone.wav"), 5);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function base(overrides: Partial<RenderPlanInput> = {}): RenderPlanInput {
  return {
    segments: [
      { id: "s1", kind: "image", durationMs: 2000, transitionIn: "cut", inputPath: join(media, "a.png") },
      { id: "s2", kind: "card", durationMs: 2000, transitionIn: "crossfade", lines: ["Hello"] },
      { id: "s3", kind: "image", durationMs: 2000, transitionIn: "fade", inputPath: join(media, "b.png") },
      { id: "s4", kind: "card", durationMs: 1500, transitionIn: "cut", lines: [] },
    ],
    width: 640,
    height: 360,
    fps: 10,
    audio: [{ path: join(media, "tone.wav"), startOffsetMs: 500 }],
    profile: "webm-vp9",
    outputPath: join(work, "out.webm"),
    inputRoots: [media],
    outputRoots: [work],
    workDir: work,
    scrubMetadata: true,
    ...overrides,
  };
}

describe("compileRenderPlan", () => {
  it("is deterministic and computes transition-adjusted duration", () => {
    const a = compileRenderPlan(base());
    const b = compileRenderPlan(base());
    expect(a.args).toEqual(b.args);
    // 2000 + (2000-500) + (2000-500) + 1500 = 6500
    expect(a.totalDurationMs).toBe(6500);
    const graph = a.args[a.args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("xfade=transition=dissolve");
    expect(graph).toContain("xfade=transition=fadeblack");
    expect(graph).toContain("concat=n=2");
    expect(graph).toContain("adelay=500|500");
    expect(a.args).toContain("-progress");
    expect(a.args.at(-1)).toBe(join(work, "out.webm"));
    expect(a.args.every((x) => typeof x === "string")).toBe(true);
  });

  it("uses file: prefixes for inputs, scrubs metadata and omits audio when none", () => {
    const plan = compileRenderPlan(base({ audio: [] }));
    expect(plan.args.filter((_, i) => plan.args[i - 1] === "-i" && !plan.args[i]?.startsWith("color="))).toEqual([
      `file:${join(media, "a.png")}`,
      `file:${join(media, "b.png")}`,
    ]);
    expect(plan.args).toContain("-an");
    expect(plan.args).toContain("-map_metadata");
    expect(plan.args).not.toContain("-metadata");
  });

  it("only writes a title when explicitly provided and strips control characters", () => {
    const plan = compileRenderPlan(base({ scrubMetadata: false, metadataTitle: "My\nMovie" }));
    expect(plan.args).toContain("title=My Movie");
    expect(plan.args).not.toContain("-map_metadata");
  });

  it("draws card text only with an allowed font, via text files", () => {
    const noFont = compileRenderPlan(base());
    expect(noFont.textFiles).toEqual([]);
    const font = join(media, "font.ttf");
    writeFileSync(font, "x");
    const withFont = compileRenderPlan(base({ fontFile: font }));
    expect(withFont.textFiles).toEqual([{ path: join(work, "card-1.txt"), content: "Hello" }]);
    expect(withFont.args.join(" ")).toContain("drawtext=");
  });

  it("rejects paths outside allowed roots, traversal, symlink escapes and relative paths", () => {
    const seg = (inputPath: string) => [{ id: "s", kind: "image" as const, durationMs: 1000, transitionIn: "cut" as const, inputPath }];
    expect(() => compileRenderPlan(base({ segments: seg(join(outside, "secret.png")) }))).toThrow(RenderSecurityError);
    expect(() => compileRenderPlan(base({ segments: seg(join(media, "link.png")) }))).toThrow(/outside/);
    expect(() => compileRenderPlan(base({ segments: seg(`${media}/../outside/secret.png`) }))).toThrow(/'\.\.'/);
    expect(() => compileRenderPlan(base({ segments: seg("a.png") }))).toThrow(/absolute/);
    expect(() => compileRenderPlan(base({ segments: seg(join(media, "missing.png")) }))).toThrow(/does not exist/);
    expect(() => compileRenderPlan(base({ outputPath: join(outside, "out.webm") }))).toThrow(/outside/);
    expect(() => compileRenderPlan(base({ outputPath: join(work, "out.sh") }))).toThrow(/extension/);
  });

  it("rejects invalid dimensions, durations, offsets and filter-unsafe font paths", () => {
    expect(() => compileRenderPlan(base({ width: 641 }))).toThrow();
    expect(() => compileRenderPlan(base({ fps: 0 }))).toThrow();
    expect(() => compileRenderPlan(base({ segments: [] }))).toThrow();
    expect(() => compileRenderPlan(base({ audio: [{ path: join(media, "tone.wav"), startOffsetMs: 999999 }] }))).toThrow(/offset/);
    const evil = join(media, "fo'nt,x.ttf");
    writeFileSync(evil, "x");
    expect(() => compileRenderPlan(base({ fontFile: evil }))).toThrow(/unsafe/);
  });

  it("selects profiles from available encoders and parses encoder lists", () => {
    const encoders = parseEncoderList(" V....D libvpx-vp9           libvpx VP9\n A....D libopus              libopus Opus\n V.S... mpeg4   MPEG-4\n A....D aac AAC\n");
    expect(selectProfile(encoders)?.id).toBe("webm-vp9");
    expect(selectProfile(new Set(["mpeg4", "aac"]))?.id).toBe("mp4-mpeg4");
    expect(selectProfile(new Set(["libx264", "aac"]))).toBeUndefined();
  });
});
