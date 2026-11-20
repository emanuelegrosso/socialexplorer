import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CODEC_PROFILES, DEFAULT_PROFILE_ORDER, parseEncoderList, selectProfile, type CodecProfileId } from "./ffmpeg-profiles.js";
import { compileRenderPlan, type RenderPlanInput } from "./render-plan.js";
import { runSupervised, type FfmpegRunnerFn, type RunnerEvent, type RunOutcome } from "./runner.js";
import { assertSafeOutputPath, RenderSecurityError } from "./safe-paths.js";

export const RENDER_TEMP_PREFIX = "social-explorer-render-";

export interface FfmpegCapabilities {
  readonly available: boolean;
  readonly version?: string;
  readonly encoders: ReadonlySet<string>;
}

export async function probeFfmpeg(executable = "ffmpeg"): Promise<FfmpegCapabilities> {
  const run = (args: string[]): Promise<string | undefined> =>
    new Promise((resolve) => {
      try {
        const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
        });
        child.once("error", () => {
          resolve(undefined);
        });
        child.once("close", (code) => {
          resolve(code === 0 ? out : undefined);
        });
      } catch {
        resolve(undefined);
      }
    });
  const version = await run(["-hide_banner", "-version"]);
  if (version === undefined) return { available: false, encoders: new Set() };
  const encoders = await run(["-hide_banner", "-encoders"]);
  return {
    available: true,
    version: version.split("\n")[0] ?? "",
    encoders: parseEncoderList(encoders ?? ""),
  };
}

export type RenderEvent =
  | RunnerEvent
  | { readonly type: "attempt"; readonly attempt: number; readonly profile: CodecProfileId };

export interface RenderMovieOptions {
  readonly plan: Omit<RenderPlanInput, "outputPath" | "workDir" | "profile" | "outputRoots">;
  /** Final destination; its parent must be inside `outputRoots`. */
  readonly finalOutputPath: string;
  readonly outputRoots: readonly string[];
  readonly executable?: string;
  /** Profiles to try in order; a failed attempt (not a cancel/timeout) falls back to the next. */
  readonly profiles?: readonly CodecProfileId[];
  readonly tempRoot?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly onEvent?: (event: RenderEvent) => void;
  readonly runner?: FfmpegRunnerFn;
}

export interface RenderAttempt {
  readonly profile: CodecProfileId;
  readonly outcome: RunOutcome;
}

export interface RenderResult {
  readonly status: "completed" | "failed" | "cancelled" | "timeout" | "limit-exceeded";
  readonly outputPath?: string;
  readonly totalDurationMs: number;
  readonly attempts: readonly RenderAttempt[];
  readonly error?: string;
}

/**
 * Renders in a supervised child process (never blocking the caller's event loop), always
 * inside a private temp directory that is removed afterwards, and publishes the output
 * atomically only after ffmpeg succeeded. Cancelled or failed renders leave no output.
 */
export async function renderMovie(options: RenderMovieOptions): Promise<RenderResult> {
  const runner = options.runner ?? runSupervised;
  const executable = options.executable ?? "ffmpeg";
  const profiles = options.profiles ?? DEFAULT_PROFILE_ORDER;
  const tempRoot = options.tempRoot ?? tmpdir();
  const attempts: RenderAttempt[] = [];
  let totalDurationMs = 0;
  const workDir = await mkdtemp(join(tempRoot, RENDER_TEMP_PREFIX));
  try {
    const finalPath = assertSafeOutputPath(
      options.finalOutputPath,
      options.outputRoots,
      [".mp4", ".webm"],
      "final output",
    );
    for (const [index, profileId] of profiles.entries()) {
      const profile = CODEC_PROFILES[profileId];
      if (!finalPath.endsWith(profile.extension)) {
        attempts.push({
          profile: profileId,
          outcome: { status: "failed", exitCode: null, signal: null, stderrTail: "", error: "profile does not match output extension" },
        });
        continue;
      }
      const compiled = compileRenderPlan({
        ...options.plan,
        profile: profileId,
        workDir,
        outputRoots: [workDir],
        outputPath: join(workDir, `render${profile.extension}`),
        inputRoots: [...options.plan.inputRoots, workDir],
      });
      totalDurationMs = compiled.totalDurationMs;
      for (const file of compiled.textFiles) await writeFile(file.path, file.content, { mode: 0o600 });
      options.onEvent?.({ type: "attempt", attempt: index + 1, profile: profileId });
      const outcome = await runner({
        executable,
        args: compiled.args,
        cwd: workDir,
        expectedDurationMs: compiled.totalDurationMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      attempts.push({ profile: profileId, outcome });
      if (outcome.status === "completed") {
        const info = await stat(compiled.outputPath).catch(() => undefined);
        if (info === undefined || info.size === 0) {
          attempts[attempts.length - 1] = {
            profile: profileId,
            outcome: { ...outcome, status: "failed", error: "ffmpeg produced no output" },
          };
          continue;
        }
        await publish(compiled.outputPath, finalPath);
        return { status: "completed", outputPath: finalPath, totalDurationMs, attempts };
      }
      if (outcome.status !== "failed" && outcome.status !== "spawn-error") {
        return { status: outcome.status, totalDurationMs, attempts };
      }
      if (outcome.status === "spawn-error") break;
    }
    const last = attempts[attempts.length - 1]?.outcome;
    return {
      status: "failed",
      totalDurationMs,
      attempts,
      error: last?.error ?? (last?.stderrTail === undefined || last.stderrTail === "" ? "render failed" : last.stderrTail),
    };
  } catch (error) {
    if (error instanceof RenderSecurityError) {
      return { status: "failed", totalDurationMs, attempts, error: error.message };
    }
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function publish(source: string, destination: string): Promise<void> {
  const partial = join(dirname(destination), `.${basename(destination)}.partial`);
  try {
    await copyFile(source, partial);
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** Removes render temp directories left behind by a crashed process. */
export async function cleanupStaleRenderDirs(
  tempRoot = tmpdir(),
  olderThanMs = 3_600_000,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RENDER_TEMP_PREFIX)) continue;
    const path = join(tempRoot, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs >= olderThanMs) {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}

export { selectProfile };
