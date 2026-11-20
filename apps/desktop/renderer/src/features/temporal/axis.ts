import type { TemporalFlowReadModel } from "@social-explorer/contracts";
import { clamp } from "./camera";

export const HEIGHT_PER_DAY = 6;
export const MIN_AXIS_HEIGHT = 12;
export const MAX_AXIS_HEIGHT = 300;

/**
 * Continuous time axis: the start of the range (the past) sits at the top (largest y) and the end
 * (the present) at the bottom (y = 0). Placement is a pure linear function of the UTC instant, so
 * there are no per-day blocks; local-day boundaries come from the read model's markers.
 */
export interface TimeAxis {
  readonly startMs: number;
  readonly endMs: number;
  readonly height: number;
  yAt(ms: number): number;
  msAt(y: number): number;
}

export function createTimeAxis(range: { readonly start: string; readonly end: string }): TimeAxis {
  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  const span = Math.max(endMs - startMs, 1);
  const days = span / 86_400_000;
  const height = clamp(days * HEIGHT_PER_DAY, MIN_AXIS_HEIGHT, MAX_AXIS_HEIGHT);
  return {
    startMs,
    endMs,
    height,
    yAt: (ms) => height * (1 - (ms - startMs) / span),
    msAt: (y) => startMs + (1 - y / height) * span,
  };
}

export interface DayMark {
  readonly date: string;
  readonly label: string;
  readonly y: number;
  readonly timestampMs: number;
}

export interface HourTick {
  readonly hour: number;
  readonly date: string;
  readonly y: number;
  readonly timestampMs: number;
}

export interface AxisMarks {
  readonly days: readonly DayMark[];
  readonly hours: readonly HourTick[];
}

export function buildAxisMarks(
  model: Pick<TemporalFlowReadModel, "dailyMarkers" | "hourMarks">,
  axis: TimeAxis,
): AxisMarks {
  const inRange = (ms: number): boolean => ms >= axis.startMs && ms < axis.endMs;
  return {
    days: model.dailyMarkers
      .map((marker) => ({
        date: marker.date,
        label: marker.label,
        timestampMs: Date.parse(marker.timestamp),
      }))
      .filter((marker) => inRange(marker.timestampMs))
      .map((marker) => ({ ...marker, y: axis.yAt(marker.timestampMs) })),
    hours: model.hourMarks
      .map((mark) => ({ hour: mark.hour, date: mark.date, timestampMs: Date.parse(mark.timestamp) }))
      .filter((mark) => inRange(mark.timestampMs))
      .map((mark) => ({ ...mark, y: axis.yAt(mark.timestampMs) })),
  };
}
