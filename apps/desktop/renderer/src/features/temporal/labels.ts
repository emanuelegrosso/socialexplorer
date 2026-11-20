import type { TemporalFlowReadModel } from "@social-explorer/contracts";
import type { OverlayLabel } from "./canvas-host";
import type { SceneFrame } from "./frame";
import type { LaneRegistry } from "./layout";
import type { SelectionState } from "./selection";

export function buildOverlayLabels(
  _model: TemporalFlowReadModel,
  registry: LaneRegistry,
  frame: SceneFrame,
  selection: SelectionState,
): OverlayLabel[] {
  const labels: OverlayLabel[] = [];
  for (const lane of frame.lanes) {
    labels.push({
      key: `lane:${lane.entityId}`,
      kind: "lane",
      text: lane.label,
      x: lane.x,
      y: frame.axis.height + 0.35,
      z: lane.z,
      entityId: lane.entityId,
      color: lane.color,
      active: selection.entityId === lane.entityId,
    });
  }
  for (const day of frame.marks.days) {
    labels.push({
      key: `day:${day.date}`,
      kind: "day",
      text: day.label,
      x: registry.lanes.size > 0 ? Math.min(...[...registry.lanes.values()].map((l) => l.x)) - 1.2 : -2,
      y: day.y,
      z: 0,
    });
  }
  const showHours = frame.lod.level !== "overview";
  for (const hour of frame.marks.hours) {
    if (!showHours) {
      continue;
    }
    labels.push({
      key: `hour:${String(hour.timestampMs)}`,
      kind: "hour",
      text: `${hour.hour.toString().padStart(2, "0")}:00`,
      x: (registry.lanes.size > 0 ? Math.min(...[...registry.lanes.values()].map((l) => l.x)) : -2) - 0.6,
      y: hour.y,
      z: 0,
    });
  }
  return labels;
}