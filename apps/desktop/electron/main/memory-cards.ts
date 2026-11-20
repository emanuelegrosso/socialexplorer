import { randomUUID } from "node:crypto";
import type { Annotation, MemoryCard } from "@social-explorer/contracts";
import type { Repositories, SqliteDatabase } from "@social-explorer/database";

export const MEMORY_CARD_NOTE_PREFIX = "memory-card:v1:";

function encodeCard(card: MemoryCard): string {
  return `${MEMORY_CARD_NOTE_PREFIX}${JSON.stringify({ title: card.title, items: card.items })}`;
}

function decodeCard(annotation: Annotation): MemoryCard | undefined {
  const note = annotation.note;
  if (note === undefined || !note.startsWith(MEMORY_CARD_NOTE_PREFIX)) {
    return undefined;
  }
  try {
    const payload = JSON.parse(note.slice(MEMORY_CARD_NOTE_PREFIX.length)) as {
      title?: string;
      items?: MemoryCard["items"];
    };
    if (typeof payload.title !== "string" || !Array.isArray(payload.items)) {
      return undefined;
    }
    return {
      id: annotation.id,
      datasetId: annotation.datasetId,
      title: payload.title,
      items: payload.items,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function mapAnnotationRow(row: {
  id: string;
  dataset_id: string;
  target_kind: Annotation["targetKind"];
  target_id: string;
  note: string | null;
  bookmarked: number;
  created_at: string;
  updated_at: string;
}): Annotation {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    ...(row.note === null ? {} : { note: row.note }),
    bookmarked: row.bookmarked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMemoryCards(db: SqliteDatabase, datasetId: string): MemoryCard[] {
  const rows = db
    .prepare(
      "SELECT * FROM annotations WHERE dataset_id = ? AND note LIKE ? ORDER BY updated_at DESC, id",
    )
    .all(datasetId, `${MEMORY_CARD_NOTE_PREFIX}%`) as Parameters<typeof mapAnnotationRow>[0][];
  return rows
    .map((row) => decodeCard(mapAnnotationRow(row)))
    .filter((card): card is MemoryCard => card !== undefined);
}

export function saveMemoryCard(
  repositories: Repositories,
  card: MemoryCard,
  now: string,
): MemoryCard {
  const normalized: MemoryCard = {
    ...card,
    id: card.id.length > 0 ? card.id : `mc_${randomUUID()}`,
    createdAt: card.createdAt.length > 0 ? card.createdAt : now,
    updatedAt: now,
  };
  repositories.annotations.upsert({
    id: normalized.id,
    datasetId: normalized.datasetId,
    targetKind: "time-interval",
    targetId: normalized.id,
    note: encodeCard(normalized),
    bookmarked: false,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  });
  return normalized;
}

export function removeMemoryCard(
  repositories: Repositories,
  datasetId: string,
  cardId: string,
): boolean {
  const existing = repositories.annotations.get(cardId);
  if (existing === undefined || existing.datasetId !== datasetId) {
    return false;
  }
  return repositories.annotations.delete(cardId);
}