import type { MediaAsset, MediaReference } from "@social-explorer/contracts";
import {
  createMediaStorytellingRepository,
  type MediaReferenceRecord,
  type SqliteDatabase,
} from "@social-explorer/database";
import {
  catalogMediaTypeToKind,
  kindToCatalogMediaType,
  type CatalogMediaType,
  type MediaKind,
} from "./domain.js";

export interface MediaCatalogFilter {
  readonly datasetId: string;
  readonly conversationId?: string;
  /** Sender contact of the message the media belongs to. */
  readonly contactId?: string;
  readonly mediaType?: CatalogMediaType;
  /** Inclusive lower bound on COALESCE(timestamp_utc, timestamp_local). */
  readonly from?: string;
  /** Exclusive upper bound on COALESCE(timestamp_utc, timestamp_local). */
  readonly to?: string;
  readonly availability?: readonly MediaReference["availability"][];
  readonly limit?: number;
  readonly offset?: number;
}

export interface CatalogMessageSummary {
  readonly id: string;
  readonly conversationId: string;
  readonly senderContactId?: string;
  readonly timestampLocal: string;
  readonly kind: string;
  readonly text?: string;
}

export interface MediaCatalogEntry {
  readonly reference: MediaReferenceRecord;
  readonly asset?: MediaAsset;
  readonly message?: CatalogMessageSummary;
  /** Asset kind when known, else the owning message's kind, mapped to the catalog vocabulary. */
  readonly mediaType?: CatalogMediaType;
}

interface JoinedRow {
  ref_id: string;
  message_id: string | null;
  msg_id: string | null;
  msg_conversation_id: string | null;
  msg_sender: string | null;
  msg_local: string | null;
  msg_kind: string | null;
  msg_text: string | null;
}

const SELECT = `
  SELECT r.id AS ref_id, r.message_id AS message_id,
         m.id AS msg_id, m.conversation_id AS msg_conversation_id,
         m.sender_contact_id AS msg_sender, m.timestamp_local AS msg_local,
         m.kind AS msg_kind, m.text AS msg_text
  FROM media_references r
  LEFT JOIN media_assets a ON a.id = r.media_asset_id
  LEFT JOIN messages m ON m.id = r.message_id`;

function summarize(row: JoinedRow): CatalogMessageSummary | undefined {
  if (row.msg_id === null || row.msg_conversation_id === null || row.msg_local === null) {
    return undefined;
  }
  return {
    id: row.msg_id,
    conversationId: row.msg_conversation_id,
    ...(row.msg_sender === null ? {} : { senderContactId: row.msg_sender }),
    timestampLocal: row.msg_local,
    kind: row.msg_kind ?? "unknown",
    ...(row.msg_text === null ? {} : { text: row.msg_text }),
  };
}

export function createMediaCatalog(db: SqliteDatabase) {
  const repo = createMediaStorytellingRepository(db);

  function hydrate(rows: readonly JoinedRow[]): MediaCatalogEntry[] {
    const entries: MediaCatalogEntry[] = [];
    for (const row of rows) {
      const reference = repo.getReference(row.ref_id);
      if (reference === undefined) {
        continue;
      }
      const asset =
        reference.mediaAssetId === undefined ? undefined : repo.getAsset(reference.mediaAssetId);
      const message = summarize(row);
      const kind: MediaKind | undefined = asset?.kind ?? messageKindToMedia(row.msg_kind);
      const mediaType = kind === undefined ? undefined : kindToCatalogMediaType(kind);
      entries.push({
        reference,
        ...(asset === undefined ? {} : { asset }),
        ...(message === undefined ? {} : { message }),
        ...(mediaType === undefined ? {} : { mediaType }),
      });
    }
    return entries;
  }

  return {
    query(filter: MediaCatalogFilter): MediaCatalogEntry[] {
      const where = ["r.dataset_id = @datasetId"];
      const params: Record<string, string | number> = { datasetId: filter.datasetId };
      if (filter.conversationId !== undefined) {
        where.push("r.conversation_id = @conversationId");
        params["conversationId"] = filter.conversationId;
      }
      if (filter.contactId !== undefined) {
        where.push("m.sender_contact_id = @contactId");
        params["contactId"] = filter.contactId;
      }
      if (filter.mediaType !== undefined) {
        where.push("COALESCE(a.kind, m.kind) = @kind");
        params["kind"] = catalogMediaTypeToKind(filter.mediaType);
      }
      if (filter.from !== undefined) {
        where.push("COALESCE(r.timestamp_utc, r.timestamp_local) >= @from");
        params["from"] = filter.from;
      }
      if (filter.to !== undefined) {
        where.push("COALESCE(r.timestamp_utc, r.timestamp_local) < @to");
        params["to"] = filter.to;
      }
      if (filter.availability !== undefined) {
        if (filter.availability.length === 0) {
          return [];
        }
        const names = filter.availability.map((value, index) => {
          params[`av${String(index)}`] = value;
          return `@av${String(index)}`;
        });
        where.push(`r.availability IN (${names.join(", ")})`);
      }
      params["limit"] = Math.min(Math.max(filter.limit ?? 500, 1), 5000);
      params["offset"] = Math.max(filter.offset ?? 0, 0);
      const rows = db
        .prepare(
          `${SELECT} WHERE ${where.join(" AND ")}
           ORDER BY r.timestamp_local, r.id LIMIT @limit OFFSET @offset`,
        )
        .all(params) as JoinedRow[];
      return hydrate(rows);
    },
    /** message -> media */
    mediaForMessage(messageId: string): MediaCatalogEntry[] {
      const rows = db
        .prepare(`${SELECT} WHERE r.message_id = ? ORDER BY r.timestamp_local, r.id`)
        .all(messageId) as JoinedRow[];
      return hydrate(rows);
    },
    /** media -> messages (every message referencing this physical asset, after dedup) */
    messagesForAsset(assetId: string): CatalogMessageSummary[] {
      const rows = db
        .prepare(`${SELECT} WHERE r.media_asset_id = ? ORDER BY r.timestamp_local, r.id`)
        .all(assetId) as JoinedRow[];
      return rows.flatMap((row) => {
        const summary = summarize(row);
        return summary === undefined ? [] : [summary];
      });
    },
    countByAvailability(datasetId: string): Record<MediaReference["availability"], number> {
      const counts: Record<MediaReference["availability"], number> = {
        "available-local": 0,
        "external-link": 0,
        missing: 0,
        unsupported: 0,
        "not-imported": 0,
      };
      const rows = db
        .prepare(
          "SELECT availability, COUNT(*) AS n FROM media_references WHERE dataset_id = ? GROUP BY availability",
        )
        .all(datasetId) as { availability: MediaReference["availability"]; n: number }[];
      for (const row of rows) {
        counts[row.availability] = row.n;
      }
      return counts;
    },
  };
}

function messageKindToMedia(kind: string | null): MediaKind | undefined {
  switch (kind) {
    case "image":
    case "video":
    case "audio":
    case "voice":
    case "document":
      return kind;
    default:
      return undefined;
  }
}

export type MediaCatalog = ReturnType<typeof createMediaCatalog>;
