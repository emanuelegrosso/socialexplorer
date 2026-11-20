import type { EntityKind, TemporalEntityViewModel, TemporalFlowReadModel } from "@social-explorer/contracts";
import { GROUP_NEUTRAL_COLOR } from "@social-explorer/domain";
import type { WorldBounds } from "./camera";

export interface LaneLayout {
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly label: string;
  readonly color: string;
  readonly x: number;
  readonly z: number;
}

export interface LaneRegistry {
  readonly layoutVersion: number;
  readonly lanes: ReadonlyMap<string, LaneLayout>;
}

const HEX = /^#[0-9A-Fa-f]{6}$/u;
export const FALLBACK_CONTACT_COLOR = "#FFFFFF";

/** Group lanes are always neutral; contact colors come from the read model (id-derived palette). */
export function laneColor(lane: Pick<TemporalEntityViewModel, "kind" | "color">): string {
  if (lane.kind === "group") {
    return GROUP_NEUTRAL_COLOR;
  }
  return HEX.test(lane.color) ? lane.color.toUpperCase() : FALLBACK_CONTACT_COLOR;
}

/**
 * Lanes come straight from the read model. While `layoutVersion` is unchanged, a lane that was
 * already placed keeps its exact position and color, so changing the date range, playback or
 * filters never makes lanes jump.
 */
export function buildLaneRegistry(
  model: Pick<TemporalFlowReadModel, "lanes" | "layoutVersion">,
  previous?: LaneRegistry,
): LaneRegistry {
  const reuse = previous !== undefined && previous.layoutVersion === model.layoutVersion;
  const lanes = new Map<string, LaneLayout>();
  for (const lane of model.lanes) {
    const known = reuse ? previous.lanes.get(lane.entityId) : undefined;
    lanes.set(lane.entityId, {
      entityId: lane.entityId,
      kind: lane.kind,
      label: lane.label,
      color: known !== undefined && known.kind === lane.kind ? known.color : laneColor(lane),
      x: known?.x ?? lane.stableX,
      z: known?.z ?? lane.stableZ,
    });
  }
  return { layoutVersion: model.layoutVersion, lanes };
}

export const LANE_MARGIN = 2;

export function laneXBounds(registry: LaneRegistry): { readonly minX: number; readonly maxX: number } {
  const xs = [...registry.lanes.values()].map((lane) => lane.x);
  if (xs.length === 0) {
    return { minX: -LANE_MARGIN, maxX: LANE_MARGIN };
  }
  return { minX: Math.min(...xs) - LANE_MARGIN, maxX: Math.max(...xs) + LANE_MARGIN };
}

export function worldBounds(registry: LaneRegistry, axisHeight: number): WorldBounds {
  const { minX, maxX } = laneXBounds(registry);
  return { minX, maxX, minY: -1, maxY: axisHeight + 3 };
}
