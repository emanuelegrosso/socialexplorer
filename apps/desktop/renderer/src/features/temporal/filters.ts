import type { EntityKind } from "@social-explorer/contracts";
import type { LaneLayout } from "./layout";

export type EntityFilter = "all" | EntityKind;
export const ENTITY_FILTERS: readonly { readonly id: EntityFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "contact", label: "Contacts" },
  { id: "group", label: "Groups" },
];

export const kindVisible = (kind: EntityKind, filter: EntityFilter): boolean =>
  filter === "all" || filter === kind;

export interface SearchHit {
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly label: string;
  readonly matchedOn: "name" | "alias";
  readonly matchedText: string;
}

export const normalizeText = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

function score(candidate: string, query: string): number | undefined {
  const text = normalizeText(candidate);
  if (text === query) {
    return 0;
  }
  if (text.startsWith(query)) {
    return 1;
  }
  if (text.split(/\s+/u).some((word) => word.startsWith(query))) {
    return 2;
  }
  return text.includes(query) ? 3 : undefined;
}

/** Local search over lane names and contact aliases; the renderer never queries message text. */
export function searchEntities(
  lanes: Iterable<LaneLayout>,
  aliases: ReadonlyMap<string, readonly string[]>,
  query: string,
  filter: EntityFilter = "all",
  limit = 8,
): SearchHit[] {
  const needle = normalizeText(query);
  if (needle === "") {
    return [];
  }
  const hits: { hit: SearchHit; rank: number }[] = [];
  for (const lane of lanes) {
    if (!kindVisible(lane.kind, filter)) {
      continue;
    }
    const candidates: { text: string; on: "name" | "alias" }[] = [
      { text: lane.label, on: "name" },
      ...(aliases.get(lane.entityId) ?? []).map((text) => ({ text, on: "alias" as const })),
    ];
    let best: { rank: number; text: string; on: "name" | "alias" } | undefined;
    for (const candidate of candidates) {
      const rank = score(candidate.text, needle);
      if (rank !== undefined && (best === undefined || rank < best.rank)) {
        best = { rank, ...candidate };
      }
    }
    if (best !== undefined) {
      hits.push({
        rank: best.rank,
        hit: {
          entityId: lane.entityId,
          kind: lane.kind,
          label: lane.label,
          matchedOn: best.on,
          matchedText: best.text,
        },
      });
    }
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.hit.label.localeCompare(b.hit.label))
    .slice(0, limit)
    .map(({ hit }) => hit);
}
