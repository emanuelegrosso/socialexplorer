import type { TemporalFlowReadModel } from "@social-explorer/contracts";
import {
  aggregateArcs,
  arcCurve,
  validateArcs,
  type ArcCurve,
  type RejectedArc,
} from "./arcs";
import { buildAxisMarks, createTimeAxis, type AxisMarks, type TimeAxis } from "./axis";
import { kindVisible, type EntityFilter } from "./filters";
import type { LaneLayout, LaneRegistry } from "./layout";
import {
  buildImpulses,
  effectiveBucketSeconds,
  lodForZoom,
  type LodLevel,
} from "./lod";
import type { ViewMode } from "./playback";
import {
  ARC_OPACITY,
  LANE_OPACITY,
  arcVisual,
  connectedEntityIds,
  laneVisual,
  type ArcVisual,
  type LaneVisual,
  type SelectionState,
} from "./selection";

export interface FrameSettings {
  readonly registry: LaneRegistry;
  readonly zoom: number;
  readonly mode: ViewMode;
  readonly cursorMs: number;
  readonly selection: SelectionState;
  readonly entityFilter: EntityFilter;
  readonly reducedMotion: boolean;
}

export interface FrameLane extends LaneLayout {
  readonly visual: LaneVisual;
  readonly opacity: number;
}

export interface FrameImpulse {
  readonly id: string;
  readonly entityId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly count: number;
  readonly color: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly radius: number;
  readonly opacity: number;
}

export interface FrameArc {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: "private-message" | "group-post";
  readonly count: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly color: string;
  readonly curve: ArcCurve;
  readonly visual: ArcVisual;
  readonly opacity: number;
}

export interface SceneFrame {
  readonly axis: TimeAxis;
  readonly marks: AxisMarks;
  readonly lanes: readonly FrameLane[];
  readonly impulses: readonly FrameImpulse[];
  readonly arcs: readonly FrameArc[];
  readonly pulseArcIds: readonly string[];
  readonly playheadY: number | undefined;
  readonly lod: { readonly level: LodLevel; readonly bucketSeconds: number };
  readonly rejectedArcs: readonly RejectedArc[];
  readonly messageCount: number;
}

export const MAX_PULSES = 48;
const PLAYBACK_PULSE_WINDOW = 0.03;

export const impulseRadius = (count: number): number =>
  Math.min(0.12 + 0.09 * Math.log2(Math.max(count, 1)), 0.9);

/** Pure translation of the read model into drawable primitives; no domain recomputation. */
export function buildSceneFrame(model: TemporalFlowReadModel, settings: FrameSettings): SceneFrame {
  const { registry, selection } = settings;
  const axis = createTimeAxis(model.range);
  const marks = buildAxisMarks(model, axis);
  const playback = settings.mode === "playback";
  const withinRange = (ms: number): boolean => ms >= axis.startMs && ms < axis.endMs;
  const reached = (ms: number): boolean => !playback || ms <= settings.cursorMs;

  const { valid, rejected } = validateArcs(model.arcs, registry.lanes);
  const visibleArcSource = valid.filter((arc) => {
    const ms = Date.parse(arc.timestamp);
    return withinRange(ms) && reached(ms);
  });
  const level = lodForZoom(settings.zoom);
  const bucketSeconds = effectiveBucketSeconds(level, model.lod.bucketSeconds);
  const arcClusters = aggregateArcs(visibleArcSource, bucketSeconds);
  const connected = selection.entityId === undefined
    ? new Set<string>()
    : connectedEntityIds(arcClusters, selection.entityId);

  const filterVisible = (entityId: string): boolean => {
    const lane = registry.lanes.get(entityId);
    return lane !== undefined && kindVisible(lane.kind, settings.entityFilter);
  };

  const lanes: FrameLane[] = [...registry.lanes.values()]
    .filter((lane) => kindVisible(lane.kind, settings.entityFilter))
    .map((lane) => {
      const visual = laneVisual(lane.entityId, selection, connected);
      return { ...lane, visual, opacity: LANE_OPACITY[visual] };
    });
  const laneState = new Map(lanes.map((lane) => [lane.entityId, lane]));

  const events = model.events.filter((event) => {
    const ms = Date.parse(event.timestamp);
    return withinRange(ms) && reached(ms) && filterVisible(event.entityId);
  });
  const impulses: FrameImpulse[] = [];
  for (const cluster of buildImpulses(events, bucketSeconds)) {
    const lane = laneState.get(cluster.entityId);
    if (lane === undefined || lane.visual === "hidden") {
      continue;
    }
    impulses.push({
      id: cluster.id,
      entityId: cluster.entityId,
      x: lane.x,
      y: axis.yAt(cluster.positionMs),
      z: lane.z,
      count: cluster.count,
      color: lane.color,
      startMs: cluster.startMs,
      endMs: cluster.endMs,
      radius: impulseRadius(cluster.count),
      opacity: Math.max(lane.opacity, lane.visual === "dimmed" ? 0.2 : 0.5),
    });
  }

  const arcs: FrameArc[] = [];
  for (const cluster of arcClusters) {
    const from = laneState.get(cluster.sourceId);
    const to = laneState.get(cluster.targetId);
    if (from === undefined || to === undefined) {
      continue;
    }
    const visual = arcVisual(cluster, selection);
    if (visual === "hidden") {
      continue;
    }
    arcs.push({
      id: cluster.id,
      sourceId: cluster.sourceId,
      targetId: cluster.targetId,
      kind: cluster.kind,
      count: cluster.count,
      startMs: cluster.startMs,
      endMs: cluster.endMs,
      color: cluster.color,
      curve: arcCurve(from, to, axis.yAt((cluster.startMs + cluster.endMs) / 2)),
      visual,
      opacity: ARC_OPACITY[visual],
    });
  }

  let pulseArcIds: string[] = [];
  if (!settings.reducedMotion) {
    const span = axis.endMs - axis.startMs;
    const candidates = playback
      ? arcs.filter((arc) => arc.endMs > settings.cursorMs - span * PLAYBACK_PULSE_WINDOW)
      : arcs.filter((arc) => arc.visual !== "dimmed");
    pulseArcIds = [...candidates]
      .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
      .slice(0, MAX_PULSES)
      .map((arc) => arc.id);
  }

  return {
    axis,
    marks,
    lanes,
    impulses,
    arcs,
    pulseArcIds,
    playheadY: playback ? axis.yAt(settings.cursorMs) : undefined,
    lod: { level, bucketSeconds },
    rejectedArcs: rejected,
    messageCount: impulses.reduce((sum, impulse) => sum + impulse.count, 0),
  };
}
