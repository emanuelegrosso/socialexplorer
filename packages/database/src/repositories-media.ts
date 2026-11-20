import type { MediaAsset, MediaReference } from "@social-explorer/contracts";
import type { SqliteDatabase } from "./open.js";
import { nn, stripUndefined } from "./util.js";

interface AssetRow {
  id: string;
  dataset_id: string;
  kind: MediaAsset["kind"];
  original_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  content_hash: string | null;
  storage_relative_path: string | null;
  availability: MediaAsset["availability"];
  imported_at: string;
  provenance_id: string;
}

interface ReferenceRow {
  id: string;
  media_asset_id: string | null;
  message_id: string | null;
  conversation_id: string;
  timestamp_utc: string | null;
  timestamp_local: string;
  caption: string | null;
  availability: MediaReference["availability"];
}

export function createMediaRepository(db: SqliteDatabase) {
  const upsertAsset = db.prepare(`
    INSERT INTO media_assets (id, dataset_id, kind, original_name, mime_type, byte_size, duration_ms,
      width, height, content_hash, storage_relative_path, availability, imported_at, provenance_id)
    VALUES (@id, @datasetId, @kind, @originalName, @mimeType, @byteSize, @durationMs,
      @width, @height, @contentHash, @storageRelativePath, @availability, @importedAt, @provenanceId)
    ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, original_name = excluded.original_name,
      mime_type = excluded.mime_type, byte_size = excluded.byte_size, duration_ms = excluded.duration_ms,
      width = excluded.width, height = excluded.height, content_hash = excluded.content_hash,
      storage_relative_path = excluded.storage_relative_path, availability = excluded.availability`);
  const getAsset = db.prepare("SELECT * FROM media_assets WHERE id = ?");
  const assetsByHash = db.prepare(
    "SELECT * FROM media_assets WHERE dataset_id = ? AND content_hash = ? ORDER BY id",
  );
  const upsertReference = db.prepare(`
    INSERT INTO media_references (id, dataset_id, media_asset_id, message_id, conversation_id,
      timestamp_utc, timestamp_local, caption, availability)
    VALUES (@id, @datasetId, @mediaAssetId, @messageId, @conversationId,
      @timestampUtc, @timestampLocal, @caption, @availability)
    ON CONFLICT (id) DO UPDATE SET media_asset_id = excluded.media_asset_id,
      caption = excluded.caption, availability = excluded.availability`);
  const refsByDataset = db.prepare(
    "SELECT * FROM media_references WHERE dataset_id = ? ORDER BY timestamp_local, id",
  );
  const refsByConversation = db.prepare(
    "SELECT * FROM media_references WHERE dataset_id = ? AND conversation_id = ? ORDER BY timestamp_local, id",
  );

  const mapAsset = (row: AssetRow): MediaAsset =>
    stripUndefined({
      id: row.id,
      datasetId: row.dataset_id,
      kind: row.kind,
      originalName: nn(row.original_name),
      mimeType: nn(row.mime_type),
      byteSize: nn(row.byte_size),
      durationMs: nn(row.duration_ms),
      width: nn(row.width),
      height: nn(row.height),
      contentHash: nn(row.content_hash),
      storageRelativePath: nn(row.storage_relative_path),
      availability: row.availability,
      importedAt: row.imported_at,
      provenanceId: row.provenance_id,
    });
  const mapReference = (row: ReferenceRow): MediaReference =>
    stripUndefined({
      id: row.id,
      mediaAssetId: nn(row.media_asset_id),
      messageId: nn(row.message_id),
      conversationId: row.conversation_id,
      timestampUtc: nn(row.timestamp_utc),
      timestampLocal: row.timestamp_local,
      caption: nn(row.caption),
      availability: row.availability,
    });

  return {
    upsertAsset(asset: MediaAsset): void {
      upsertAsset.run({
        id: asset.id,
        datasetId: asset.datasetId,
        kind: asset.kind,
        originalName: asset.originalName ?? null,
        mimeType: asset.mimeType ?? null,
        byteSize: asset.byteSize ?? null,
        durationMs: asset.durationMs ?? null,
        width: asset.width ?? null,
        height: asset.height ?? null,
        contentHash: asset.contentHash ?? null,
        storageRelativePath: asset.storageRelativePath ?? null,
        availability: asset.availability,
        importedAt: asset.importedAt,
        provenanceId: asset.provenanceId,
      });
    },
    getAsset(id: string): MediaAsset | undefined {
      const row = getAsset.get(id) as AssetRow | undefined;
      return row === undefined ? undefined : mapAsset(row);
    },
    findAssetsByHash(datasetId: string, contentHash: string): MediaAsset[] {
      return (assetsByHash.all(datasetId, contentHash) as AssetRow[]).map(mapAsset);
    },
    upsertReference(datasetId: string, reference: MediaReference): void {
      upsertReference.run({
        id: reference.id,
        datasetId,
        mediaAssetId: reference.mediaAssetId ?? null,
        messageId: reference.messageId ?? null,
        conversationId: reference.conversationId,
        timestampUtc: reference.timestampUtc ?? null,
        timestampLocal: reference.timestampLocal,
        caption: reference.caption ?? null,
        availability: reference.availability,
      });
    },
    listReferences(datasetId: string, conversationId?: string): MediaReference[] {
      const rows =
        conversationId === undefined
          ? refsByDataset.all(datasetId)
          : refsByConversation.all(datasetId, conversationId);
      return (rows as ReferenceRow[]).map(mapReference);
    },
  };
}
