export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly jitterRatio: number;
}

/** Exponential backoff with symmetric jitter. `attempt` starts at 1. `random` returns [0,1). */
export function computeBackoffMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(options.maxMs, options.baseMs * 2 ** Math.min(exponent, 30));
  const spread = raw * options.jitterRatio;
  const jittered = raw - spread + random() * 2 * spread;
  return Math.max(0, Math.min(options.maxMs, Math.round(jittered)));
}
