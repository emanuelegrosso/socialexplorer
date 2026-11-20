import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class RenderSecurityError extends Error {
  override readonly name = "RenderSecurityError";
}

/** Characters that never need escaping inside an ffmpeg filtergraph option value. */
const FILTER_SAFE = /^[A-Za-z0-9_./-]+$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

function realOrResolved(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function assertBasics(path: string, label: string): void {
  if (typeof path !== "string" || path.length === 0) throw new RenderSecurityError(`${label}: empty path`);
  if (CONTROL.test(path)) throw new RenderSecurityError(`${label}: control characters in path`);
  if (!isAbsolute(path)) throw new RenderSecurityError(`${label}: path must be absolute`);
  if (path.split(/[\\/]/u).includes("..")) throw new RenderSecurityError(`${label}: '..' segments are not allowed`);
}

/**
 * Validates an existing input file: absolute, no traversal, and (after symlink resolution)
 * inside one of the allowed roots. Returns the resolved real path.
 */
export function assertSafeInputFile(path: string, allowedRoots: readonly string[], label = "input"): string {
  assertBasics(path, label);
  if (!existsSync(path)) throw new RenderSecurityError(`${label}: file does not exist`);
  const real = realpathSync(path);
  const roots = allowedRoots.map(realOrResolved);
  if (!roots.some((root) => within(root, real))) {
    throw new RenderSecurityError(`${label}: path is outside the allowed roots`);
  }
  return real;
}

/** Validates a not-yet-existing output path: its parent must exist inside the allowed roots. */
export function assertSafeOutputPath(
  path: string,
  allowedRoots: readonly string[],
  extensions: readonly string[],
  label = "output",
): string {
  assertBasics(path, label);
  if (!extensions.some((ext) => path.endsWith(ext))) {
    throw new RenderSecurityError(`${label}: unexpected extension`);
  }
  const parent = dirname(path);
  if (!existsSync(parent)) throw new RenderSecurityError(`${label}: parent directory does not exist`);
  const realParent = realpathSync(parent);
  const roots = allowedRoots.map(realOrResolved);
  if (!roots.some((root) => within(root, realParent))) {
    throw new RenderSecurityError(`${label}: path is outside the allowed roots`);
  }
  return resolve(realParent, path.slice(parent.length + 1));
}

/** Paths embedded in filtergraphs are restricted to a charset that needs no escaping. */
export function assertFilterSafePath(path: string, label: string): string {
  if (!FILTER_SAFE.test(path)) throw new RenderSecurityError(`${label}: path has characters unsafe for filters`);
  return path;
}

/** `file:` stops ffmpeg from interpreting the value as a protocol or option. */
export function ffmpegFileInput(path: string): string {
  return `file:${path}`;
}
