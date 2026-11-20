import type { TemporalFlowReadModel } from "@social-explorer/contracts";
import { clamp } from "./camera";

export const PLAYBACK_SPEEDS = [1, 2, 5, 10] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];
export type ViewMode = "static" | "playback";

/** At 1x the whole visible range plays in this many wall-clock milliseconds. */
export const PLAYBACK_BASE_MS = 60_000;
/** With reduced motion, playback jumps one event stop per interval instead of animating. */
export const REDUCED_STEP_INTERVAL_MS = 1000;

export interface PlaybackState {
  readonly mode: ViewMode;
  readonly playing: boolean;
  readonly speed: PlaybackSpeed;
  readonly cursorMs: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly reducedMotion: boolean;
  readonly accumulatorMs: number;
}

export function createPlayback(
  startMs: number,
  endMs: number,
  reducedMotion = false,
): PlaybackState {
  return {
    mode: "static",
    playing: false,
    speed: 1,
    cursorMs: startMs,
    startMs,
    endMs,
    reducedMotion,
    accumulatorMs: 0,
  };
}

export function setMode(state: PlaybackState, mode: ViewMode): PlaybackState {
  return { ...state, mode, playing: mode === "playback" ? state.playing : false, accumulatorMs: 0 };
}

export function play(state: PlaybackState): PlaybackState {
  const atEnd = state.cursorMs >= state.endMs;
  return {
    ...state,
    mode: "playback",
    playing: true,
    cursorMs: atEnd ? state.startMs : state.cursorMs,
    accumulatorMs: 0,
  };
}

export const pause = (state: PlaybackState): PlaybackState => ({ ...state, playing: false });

export const setSpeed = (state: PlaybackState, speed: PlaybackSpeed): PlaybackState => ({
  ...state,
  speed,
});

export const seek = (state: PlaybackState, ms: number): PlaybackState => ({
  ...state,
  cursorMs: clamp(ms, state.startMs, state.endMs),
  accumulatorMs: 0,
});

/** Re-anchors playback to a new range while keeping the relative position (paused). */
export function rebase(state: PlaybackState, startMs: number, endMs: number): PlaybackState {
  return {
    ...state,
    startMs,
    endMs,
    cursorMs: clamp(state.cursorMs, startMs, endMs),
    playing: false,
    accumulatorMs: 0,
  };
}

export function nextStop(stops: readonly number[], cursorMs: number): number | undefined {
  return stops.find((stop) => stop > cursorMs);
}

export function previousStop(stops: readonly number[], cursorMs: number): number | undefined {
  for (let index = stops.length - 1; index >= 0; index--) {
    const stop = stops[index];
    if (stop !== undefined && stop < cursorMs) {
      return stop;
    }
  }
  return undefined;
}

export function stepForward(state: PlaybackState, stops: readonly number[]): PlaybackState {
  const target = nextStop(stops, state.cursorMs) ?? state.endMs;
  return { ...seek(state, target), mode: "playback", playing: false };
}

export function stepBack(state: PlaybackState, stops: readonly number[]): PlaybackState {
  const target = previousStop(stops, state.cursorMs) ?? state.startMs;
  return { ...seek(state, target), mode: "playback", playing: false };
}

/** Advances chronologically; never moves backwards and stops (paused) at the end of the range. */
export function tick(
  state: PlaybackState,
  deltaMs: number,
  stops: readonly number[],
): PlaybackState {
  if (!state.playing || deltaMs <= 0) {
    return state;
  }
  const span = Math.max(state.endMs - state.startMs, 1);
  let cursorMs = state.cursorMs;
  let accumulatorMs = state.accumulatorMs;
  if (state.reducedMotion) {
    accumulatorMs += deltaMs * state.speed;
    while (accumulatorMs >= REDUCED_STEP_INTERVAL_MS) {
      accumulatorMs -= REDUCED_STEP_INTERVAL_MS;
      cursorMs = nextStop(stops, cursorMs) ?? state.endMs;
      if (cursorMs >= state.endMs) {
        break;
      }
    }
  } else {
    cursorMs += (deltaMs * state.speed * span) / PLAYBACK_BASE_MS;
  }
  if (cursorMs >= state.endMs) {
    return { ...state, cursorMs: state.endMs, playing: false, accumulatorMs: 0 };
  }
  return { ...state, cursorMs, accumulatorMs };
}

/** Sorted unique instants at which something happens, taken from the read model. */
export function playbackStops(
  model: Pick<TemporalFlowReadModel, "events" | "arcs">,
): number[] {
  const stops = new Set<number>();
  for (const item of [...model.events, ...model.arcs]) {
    const ms = Date.parse(item.timestamp);
    if (!Number.isNaN(ms)) {
      stops.add(ms);
    }
  }
  return [...stops].sort((a, b) => a - b);
}

export function formatTimestamp(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
