import type { TemporalEntityViewModel } from "@social-explorer/contracts";
import { GROUP_NEUTRAL_COLOR, colorForColorKey, contactColor } from "@social-explorer/domain";

/** Bump when lane placement rules change so renderers can invalidate cached positions. */
export const LAYOUT_VERSION = 1;
export const LANE_SPACING = 2;
export const GROUP_DEPTH = 1;

export interface TemporalContactInput {
  readonly id: string;
  readonly displayName: string;
  readonly colorKey?: string | undefined;
}

export interface TemporalGroupInput {
  /** The group entity is its conversation; its lane id is the conversation id. */
  readonly conversationId: string;
  readonly title: string;
}

/**
 * One lane per contact and per group over the whole dataset (not only the visible range), ordered
 * by `kind:id` so positions never change with date range, playback or label edits. Contacts sit
 * at depth 0 and groups at depth 1; both share the same horizontal field.
 */
export function buildLanes(
  contacts: readonly TemporalContactInput[],
  groups: readonly TemporalGroupInput[],
): TemporalEntityViewModel[] {
  const entries = [
    ...contacts.map((contact) => ({
      key: `contact:${contact.id}`,
      lane: {
        entityId: contact.id,
        kind: "contact" as const,
        label: contact.displayName,
        color:
          contact.colorKey === undefined
            ? contactColor(contact.id)
            : colorForColorKey(contact.colorKey, contact.id),
      },
    })),
    ...groups.map((group) => ({
      key: `group:${group.conversationId}`,
      lane: {
        entityId: group.conversationId,
        kind: "group" as const,
        label: group.title,
        color: GROUP_NEUTRAL_COLOR,
      },
    })),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const center = (entries.length - 1) / 2;
  return entries.map(({ lane }, index) => ({
    ...lane,
    stableX: (index - center) * LANE_SPACING,
    stableZ: lane.kind === "group" ? GROUP_DEPTH : 0,
  }));
}
