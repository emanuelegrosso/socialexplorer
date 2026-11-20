import type { TemporalArcViewModel } from "@social-explorer/contracts";
import type { LaneLayout } from "./layout";

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type RejectionReason =
  | "unknown_source"
  | "unknown_target"
  | "source_not_contact"
  | "self_arc"
  | "private_target_not_contact"
  | "group_target_not_group";

export interface RejectedArc {
  readonly arc: TemporalArcViewModel;
  readonly reason: RejectionReason;
}

/**
 * Enforces the arc rules on whatever the read model delivers: a 1:1 message is
 * `sender -> recipient` (contact lanes), a group post is `sender -> group` (group lane). An arc
 * from a sender to another group member is never legal, so it is rejected rather than drawn.
 */
export function validateArcs(
  arcs: readonly TemporalArcViewModel[],
  lanes: ReadonlyMap<string, LaneLayout>,
): { readonly valid: TemporalArcViewModel[]; readonly rejected: RejectedArc[] } {
  const valid: TemporalArcViewModel[] = [];
  const rejected: RejectedArc[] = [];
  for (const arc of arcs) {
    const source = lanes.get(arc.sourceEntityId);
    const target = lanes.get(arc.targetEntityId);
    let reason: RejectionReason | undefined;
    if (source === undefined) {
      reason = "unknown_source";
    } else if (target === undefined) {
      reason = "unknown_target";
    } else if (source.kind !== "contact") {
      reason = "source_not_contact";
    } else if (arc.sourceEntityId === arc.targetEntityId) {
      reason = "self_arc";
    } else if (arc.relationKind === "private-message" && target.kind !== "contact") {
      reason = "private_target_not_contact";
    } else if (arc.relationKind === "group-post" && target.kind !== "group") {
      reason = "group_target_not_group";
    }
    if (reason === undefined) {
      valid.push(arc);
    } else {
      rejected.push({ arc, reason });
    }
  }
  return { valid, rejected };
}

export interface ArcCluster {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: TemporalArcViewModel["relationKind"];
  readonly count: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly color: string;
}

/** Temporal aggregation: arcs with the same direction and kind inside one bucket merge. */
export function aggregateArcs(
  arcs: readonly TemporalArcViewModel[],
  bucketSeconds: number,
): ArcCluster[] {
  const bucketMs = bucketSeconds * 1000;
  const groups = new Map<string, ArcCluster>();
  for (const arc of arcs) {
    const ms = Date.parse(arc.timestamp);
    if (Number.isNaN(ms)) {
      continue;
    }
    const slot = bucketMs === 0 ? arc.id : String(Math.floor(ms / bucketMs));
    const key = `${arc.sourceEntityId}>${arc.targetEntityId}|${arc.relationKind}|${slot}`;
    const existing = groups.get(key);
    groups.set(
      key,
      existing === undefined
        ? {
            id: key,
            sourceId: arc.sourceEntityId,
            targetId: arc.targetEntityId,
            kind: arc.relationKind,
            count: arc.count,
            startMs: ms,
            endMs: ms,
            color: arc.sourceColor,
          }
        : {
            ...existing,
            count: existing.count + arc.count,
            startMs: Math.min(existing.startMs, ms),
            endMs: Math.max(existing.endMs, ms),
          },
    );
  }
  return [...groups.values()].sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
}

export interface ArcCurve {
  readonly from: Vec3;
  readonly control: Vec3;
  readonly to: Vec3;
}

/** Quadratic bridge between two lanes at one instant; it bulges toward the camera. */
export function arcCurve(from: LaneLayout, to: LaneLayout, y: number): ArcCurve {
  const span = Math.abs(to.x - from.x);
  return {
    from: { x: from.x, y, z: from.z },
    control: {
      x: (from.x + to.x) / 2,
      y,
      z: Math.max(from.z, to.z) + 0.6 + 0.3 * span,
    },
    to: { x: to.x, y, z: to.z },
  };
}

export function pointOnCurve(curve: ArcCurve, t: number): Vec3 {
  const u = 1 - t;
  const blend = (a: number, b: number, c: number): number => u * u * a + 2 * u * t * b + t * t * c;
  return {
    x: blend(curve.from.x, curve.control.x, curve.to.x),
    y: blend(curve.from.y, curve.control.y, curve.to.y),
    z: blend(curve.from.z, curve.control.z, curve.to.z),
  };
}

export const PULSE_PERIOD_MS = 2400;

function phaseOf(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  }
  return (hash % 1000) / 1000;
}

/** Progress 0..1 of a pulse travelling source -> target (never reversed). */
export function pulseProgress(arcId: string, timeMs: number): number {
  const value = timeMs / PULSE_PERIOD_MS + phaseOf(arcId);
  return value - Math.floor(value);
}
