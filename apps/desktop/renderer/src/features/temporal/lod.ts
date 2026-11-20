import type { TemporalEventViewModel } from "@social-explorer/contracts";

export type LodLevel = "overview" | "mid" | "detail";

/** Zoom thresholds: below `mid` aggregate clusters, up to `detail` subdivided, then individual events. */
export const LOD_ZOOM_THRESHOLDS = { mid: 1.6, detail: 5 } as const;

export const LOD_BUCKET_SECONDS: Readonly<Record<LodLevel, number>> = {
  overview: 6 * 3600,
  mid: 600,
  detail: 0,
};

export function lodForZoom(zoom: number): LodLevel {
  if (zoom >= LOD_ZOOM_THRESHOLDS.detail) {
    return "detail";
  }
  return zoom >= LOD_ZOOM_THRESHOLDS.mid ? "mid" : "overview";
}

/**
 * The read model is already bucketed by its own `lod.bucketSeconds`; the renderer can merge
 * buckets (zoom out) but never invent finer resolution than the model carries.
 */
export function effectiveBucketSeconds(level: LodLevel, modelBucketSeconds: number): number {
  return Math.max(LOD_BUCKET_SECONDS[level], modelBucketSeconds);
}

export interface ImpulseCluster {
  readonly id: string;
  readonly entityId: string;
  /** Exact number of messages represented. */
  readonly count: number;
  /** Earliest and latest event timestamps merged into this cluster. */
  readonly startMs: number;
  readonly endMs: number;
  /** Count-weighted centroid used for placement along the axis. */
  readonly positionMs: number;
  /** Number of read-model events merged (1 for an individual impulse). */
  readonly eventCount: number;
}

export function buildImpulses(
  events: readonly TemporalEventViewModel[],
  bucketSeconds: number,
): ImpulseCluster[] {
  const bucketMs = bucketSeconds * 1000;
  const groups = new Map<
    string,
    { entityId: string; count: number; start: number; end: number; weighted: number; events: number }
  >();
  for (const event of events) {
    const ms = Date.parse(event.timestamp);
    if (Number.isNaN(ms)) {
      continue;
    }
    const key =
      bucketMs === 0 ? `ev:${event.id}` : `${event.entityId}|${String(Math.floor(ms / bucketMs))}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        entityId: event.entityId,
        count: event.count,
        start: ms,
        end: ms,
        weighted: ms * event.count,
        events: 1,
      });
    } else {
      group.count += event.count;
      group.start = Math.min(group.start, ms);
      group.end = Math.max(group.end, ms);
      group.weighted += ms * event.count;
      group.events += 1;
    }
  }
  return [...groups]
    .map(([key, group]) => ({
      id: key,
      entityId: group.entityId,
      count: group.count,
      startMs: group.start,
      endMs: group.end,
      positionMs: Math.round(group.weighted / group.count),
      eventCount: group.events,
    }))
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
}
