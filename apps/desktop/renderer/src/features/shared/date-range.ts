import type { AnalyticsRange, DateRangePreset } from "@social-explorer/contracts";
import {
  localDateOfInstant,
  resolveRange,
  shiftLocalDate,
  startOfLocalDay,
} from "@social-explorer/visualization-model";
import { create } from "zustand";

export const RANGE_CHOICES = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "all", label: "All" },
  { id: "custom", label: "Custom" },
] as const;

export type RangeChoice = (typeof RANGE_CHOICES)[number]["id"];

export interface DateRangeSelection {
  readonly choice: RangeChoice;
  /** Local calendar dates (dataset timezone), inclusive. */
  readonly customStartDate?: string;
  readonly customEndDate?: string;
}

export interface RangeContext {
  readonly timezone: string;
  readonly now: string;
  readonly coverageStart?: string | undefined;
  readonly coverageEnd?: string | undefined;
}

export interface TemporalRangeRequest {
  readonly preset: DateRangePreset;
  readonly start?: string;
  readonly end?: string;
}

export interface SharedRange {
  readonly temporal: TemporalRangeRequest;
  readonly analytics: AnalyticsRange;
  /** Inclusive start / exclusive end instants. */
  readonly startMs: number;
  readonly endMs: number;
}

export type RangeResolution =
  | { readonly ok: true; readonly range: SharedRange }
  | { readonly ok: false; readonly error: string };

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const iso = (ms: number): string => new Date(ms).toISOString();

function fromBounds(
  startMs: number,
  endMs: number,
  timezone: string,
  temporal: TemporalRangeRequest,
): SharedRange {
  return {
    temporal,
    analytics: {
      startDate: localDateOfInstant(startMs, timezone),
      endDate: localDateOfInstant(endMs - 1, timezone),
    },
    startMs,
    endMs,
  };
}

/**
 * One resolution for both Temporal Flow and Analytics: every boundary is a local-day boundary in
 * the dataset timezone, and the analytics local-date range is derived from the same instants.
 */
export function resolveSelection(
  selection: DateRangeSelection,
  context: RangeContext,
): RangeResolution {
  const { timezone } = context;
  try {
    if (selection.choice === "custom") {
      const { customStartDate: from, customEndDate: to } = selection;
      if (from === undefined || to === undefined || !LOCAL_DATE.test(from) || !LOCAL_DATE.test(to)) {
        return { ok: false, error: "Choose a start and end date." };
      }
      if (to < from) {
        return { ok: false, error: "The end date must not be before the start date." };
      }
      const startMs = startOfLocalDay(from, timezone);
      const endMs = startOfLocalDay(shiftLocalDate(to, 1), timezone);
      return {
        ok: true,
        range: fromBounds(startMs, endMs, timezone, {
          preset: "custom",
          start: iso(startMs),
          end: iso(endMs),
        }),
      };
    }
    if (selection.choice === "all") {
      if (context.coverageStart !== undefined && context.coverageEnd !== undefined) {
        const first = localDateOfInstant(Date.parse(context.coverageStart), timezone);
        const last = localDateOfInstant(Date.parse(context.coverageEnd), timezone);
        const startMs = startOfLocalDay(first, timezone);
        const endMs = startOfLocalDay(shiftLocalDate(last, 1), timezone);
        return {
          ok: true,
          range: {
            temporal: { preset: "custom", start: iso(startMs), end: iso(endMs) },
            analytics: {},
            startMs,
            endMs,
          },
        };
      }
      return resolveSelection({ choice: "90d" }, context);
    }
    const resolved = resolveRange({ preset: selection.choice, timezone, now: context.now });
    return {
      ok: true,
      range: fromBounds(Date.parse(resolved.start), Date.parse(resolved.end), timezone, {
        preset: selection.choice,
      }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid date range." };
  }
}

export interface DateRangeState {
  readonly selection: DateRangeSelection;
  readonly setChoice: (choice: RangeChoice) => void;
  readonly setCustom: (startDate: string, endDate: string) => void;
}

/** Shared by the Temporal view and the Analytics page so both always show the same range. */
export const createDateRangeStore = (initial: DateRangeSelection = { choice: "all" }) =>
  create<DateRangeState>()((set) => ({
    selection: initial,
    setChoice: (choice) => {
      set((state) => ({ selection: { ...state.selection, choice } }));
    },
    setCustom: (customStartDate, customEndDate) => {
      set({ selection: { choice: "custom", customStartDate, customEndDate } });
    },
  }));

export const useDateRangeStore = createDateRangeStore();
