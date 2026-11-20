import type { LaneLayout } from "./layout";

export type SelectionMode = "normal" | "selected" | "isolated";

export interface SelectionState {
  readonly mode: SelectionMode;
  readonly entityId?: string;
  /** A contact highlighted from a group participant list. */
  readonly participantId?: string;
}

export const NO_SELECTION: SelectionState = { mode: "normal" };

export function selectEntity(state: SelectionState, entityId: string): SelectionState {
  if (state.entityId === entityId && state.mode !== "normal") {
    return state;
  }
  return { mode: "selected", entityId };
}

/** Selected <-> isolated toggle for the current entity; no-op without a selection. */
export function toggleIsolation(state: SelectionState): SelectionState {
  if (state.entityId === undefined) {
    return NO_SELECTION;
  }
  return { ...state, mode: state.mode === "isolated" ? "selected" : "isolated" };
}

export function clearSelection(): SelectionState {
  return NO_SELECTION;
}

export function highlightParticipant(
  state: SelectionState,
  participantId: string | undefined,
): SelectionState {
  if (state.entityId === undefined) {
    return state;
  }
  const rest = { mode: state.mode, entityId: state.entityId };
  return participantId === undefined ? rest : { ...rest, participantId };
}

export interface ArcEndpoints {
  readonly sourceId: string;
  readonly targetId: string;
}

export function connectedEntityIds(
  arcs: readonly ArcEndpoints[],
  entityId: string,
): ReadonlySet<string> {
  const connected = new Set<string>();
  for (const arc of arcs) {
    if (arc.sourceId === entityId) {
      connected.add(arc.targetId);
    } else if (arc.targetId === entityId) {
      connected.add(arc.sourceId);
    }
  }
  return connected;
}

export type LaneVisual = "normal" | "selected" | "connected" | "dimmed" | "hidden";
export type ArcVisual = "normal" | "focused" | "highlighted" | "dimmed" | "hidden";

export const LANE_OPACITY: Readonly<Record<LaneVisual, number>> = {
  normal: 0.55,
  selected: 1,
  connected: 0.85,
  dimmed: 0.15,
  hidden: 0,
};

export const ARC_OPACITY: Readonly<Record<ArcVisual, number>> = {
  normal: 0.55,
  focused: 1,
  highlighted: 0.9,
  dimmed: 0.08,
  hidden: 0,
};

export function laneVisual(
  entityId: string,
  selection: SelectionState,
  connected: ReadonlySet<string>,
): LaneVisual {
  if (selection.mode === "normal" || selection.entityId === undefined) {
    return "normal";
  }
  if (entityId === selection.entityId) {
    return "selected";
  }
  if (connected.has(entityId)) {
    return "connected";
  }
  return selection.mode === "isolated" ? "hidden" : "dimmed";
}

export function arcVisual(arc: ArcEndpoints, selection: SelectionState): ArcVisual {
  if (selection.mode === "normal" || selection.entityId === undefined) {
    return "normal";
  }
  const touches = arc.sourceId === selection.entityId || arc.targetId === selection.entityId;
  if (!touches) {
    return selection.mode === "isolated" ? "hidden" : "dimmed";
  }
  if (selection.participantId !== undefined) {
    return arc.sourceId === selection.participantId || arc.targetId === selection.participantId
      ? "focused"
      : "highlighted";
  }
  return "highlighted";
}

export interface PanelTarget {
  readonly kind: "none" | "contact" | "group";
  readonly entityId?: string;
}

/** The side analytics panel always follows the 3D selection. */
export function panelTarget(
  selection: SelectionState,
  lanes: ReadonlyMap<string, LaneLayout>,
): PanelTarget {
  if (selection.mode === "normal" || selection.entityId === undefined) {
    return { kind: "none" };
  }
  const lane = lanes.get(selection.entityId);
  return lane === undefined
    ? { kind: "none" }
    : { kind: lane.kind, entityId: selection.entityId };
}
