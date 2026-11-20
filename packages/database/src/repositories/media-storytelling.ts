import type {
  ExternalMediaLink,
  MediaAsset,
  MediaReference,
  MovieExport,
  SoundtrackTrack,
  StoryChapter,
  StoryChapterItem,
  StoryProject,
} from "@social-explorer/contracts";
import type { SqliteDatabase } from "../open.js";
import { bool, nn, parseJsonArray, stripUndefined } from "../util.js";

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return row[key] as string;
}

function optStr(row: Row, key: string): string | undefined {
  return nn(row[key] as string | null);
}

function optNum(row: Row, key: string): number | undefined {
  return nn(row[key] as number | null);
}

export interface MediaReferenceRecord extends MediaReference {
  readonly datasetId: string;
}

function mapAsset(row: Row): MediaAsset {
  return stripUndefined({
    id: str(row, "id"),
    datasetId: str(row, "dataset_id"),
    kind: row["kind"] as MediaAsset["kind"],
    originalName: optStr(row, "original_name"),
    mimeType: optStr(row, "mime_type"),
    byteSize: optNum(row, "byte_size"),
    durationMs: optNum(row, "duration_ms"),
    width: optNum(row, "width"),
    height: optNum(row, "height"),
    contentHash: optStr(row, "content_hash"),
    storageRelativePath: optStr(row, "storage_relative_path"),
    availability: row["availability"] as MediaAsset["availability"],
    importedAt: str(row, "imported_at"),
    provenanceId: str(row, "provenance_id"),
  });
}

function mapReference(row: Row): MediaReferenceRecord {
  return stripUndefined({
    id: str(row, "id"),
    datasetId: str(row, "dataset_id"),
    mediaAssetId: optStr(row, "media_asset_id"),
    messageId: optStr(row, "message_id"),
    conversationId: str(row, "conversation_id"),
    timestampUtc: optStr(row, "timestamp_utc"),
    timestampLocal: str(row, "timestamp_local"),
    caption: optStr(row, "caption"),
    availability: row["availability"] as MediaReference["availability"],
  });
}

function mapLink(row: Row): ExternalMediaLink {
  return stripUndefined({
    id: str(row, "id"),
    messageId: str(row, "message_id"),
    url: str(row, "url"),
    provider: optStr(row, "provider") as ExternalMediaLink["provider"],
    title: optStr(row, "title"),
    creator: optStr(row, "creator"),
    linkKind: row["link_kind"] as ExternalMediaLink["linkKind"],
    resolvedMetadataAt: optStr(row, "resolved_metadata_at"),
  });
}

function mapProject(row: Row): StoryProject {
  return stripUndefined({
    id: str(row, "id"),
    datasetId: str(row, "dataset_id"),
    title: str(row, "title"),
    dateRangeStart: optStr(row, "date_range_start"),
    dateRangeEnd: optStr(row, "date_range_end"),
    status: row["status"] as StoryProject["status"],
    aspectRatio: row["aspect_ratio"] as StoryProject["aspectRatio"],
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  });
}

function mapChapter(row: Row): StoryChapter {
  return stripUndefined({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    title: str(row, "title"),
    narrativeText: optStr(row, "narrative_text"),
    startAt: optStr(row, "start_at"),
    endAt: optStr(row, "end_at"),
    sortOrder: row["sort_order"] as number,
    transition: row["transition"] as StoryChapter["transition"],
    durationSeconds: row["duration_seconds"] as number,
  });
}

function mapItem(row: Row): StoryChapterItem {
  return stripUndefined({
    id: str(row, "id"),
    chapterId: str(row, "chapter_id"),
    itemKind: row["item_kind"] as StoryChapterItem["itemKind"],
    mediaAssetId: optStr(row, "media_asset_id"),
    messageId: optStr(row, "message_id"),
    sortOrder: row["sort_order"] as number,
    startOffsetMs: optNum(row, "start_offset_ms"),
    endOffsetMs: optNum(row, "end_offset_ms"),
  });
}

function mapTrack(row: Row): SoundtrackTrack {
  return stripUndefined({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    sourceKind: row["source_kind"] as SoundtrackTrack["sourceKind"],
    externalUrl: optStr(row, "external_url"),
    localAssetId: optStr(row, "local_asset_id"),
    title: optStr(row, "title"),
    artist: optStr(row, "artist"),
    startOffsetMs: row["start_offset_ms"] as number,
    durationMs: optNum(row, "duration_ms"),
    rightsStatus: row["rights_status"] as SoundtrackTrack["rightsStatus"],
  });
}

function mapExport(row: Row): MovieExport {
  return stripUndefined({
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    preset: "16:9" as const,
    status: row["status"] as MovieExport["status"],
    includeMessageText: row["include_message_text"] === 1,
    includeContactNames: row["include_contact_names"] === 1,
    includedSoundtrackTrackIds: parseJsonArray(str(row, "included_soundtrack_track_ids_json")),
    linkReferenceTrackIds: parseJsonArray(str(row, "link_reference_track_ids_json")),
    createdAt: str(row, "created_at"),
    completedAt: optStr(row, "completed_at"),
  });
}

/** Typed persistence for the 8 tables of `003_media_storytelling.sql`. */
export function createMediaStorytellingRepository(db: SqliteDatabase) {
  const upsertAsset = db.prepare(`
    INSERT INTO media_assets (id, dataset_id, kind, original_name, mime_type, byte_size, duration_ms,
      width, height, content_hash, storage_relative_path, availability, imported_at, provenance_id)
    VALUES (@id, @datasetId, @kind, @originalName, @mimeType, @byteSize, @durationMs,
      @width, @height, @contentHash, @storageRelativePath, @availability, @importedAt, @provenanceId)
    ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, original_name = excluded.original_name,
      mime_type = excluded.mime_type, byte_size = excluded.byte_size, duration_ms = excluded.duration_ms,
      width = excluded.width, height = excluded.height, content_hash = excluded.content_hash,
      storage_relative_path = excluded.storage_relative_path, availability = excluded.availability`);
  const upsertReference = db.prepare(`
    INSERT INTO media_references (id, dataset_id, media_asset_id, message_id, conversation_id,
      timestamp_utc, timestamp_local, caption, availability)
    VALUES (@id, @datasetId, @mediaAssetId, @messageId, @conversationId,
      @timestampUtc, @timestampLocal, @caption, @availability)
    ON CONFLICT (id) DO UPDATE SET media_asset_id = excluded.media_asset_id,
      message_id = excluded.message_id, caption = excluded.caption,
      availability = excluded.availability`);
  const upsertLink = db.prepare(`
    INSERT INTO external_media_links (id, message_id, url, provider, title, creator, link_kind,
      resolved_metadata_at)
    VALUES (@id, @messageId, @url, @provider, @title, @creator, @linkKind, @resolvedMetadataAt)
    ON CONFLICT (id) DO UPDATE SET url = excluded.url, provider = excluded.provider,
      title = excluded.title, creator = excluded.creator, link_kind = excluded.link_kind,
      resolved_metadata_at = excluded.resolved_metadata_at`);
  const upsertProject = db.prepare(`
    INSERT INTO story_projects (id, dataset_id, title, date_range_start, date_range_end, status,
      aspect_ratio, created_at, updated_at)
    VALUES (@id, @datasetId, @title, @dateRangeStart, @dateRangeEnd, @status, @aspectRatio,
      @createdAt, @updatedAt)
    ON CONFLICT (id) DO UPDATE SET title = excluded.title, date_range_start = excluded.date_range_start,
      date_range_end = excluded.date_range_end, status = excluded.status,
      aspect_ratio = excluded.aspect_ratio, updated_at = excluded.updated_at`);
  const upsertChapter = db.prepare(`
    INSERT INTO story_chapters (id, project_id, title, narrative_text, start_at, end_at, sort_order,
      transition, duration_seconds)
    VALUES (@id, @projectId, @title, @narrativeText, @startAt, @endAt, @sortOrder, @transition,
      @durationSeconds)
    ON CONFLICT (id) DO UPDATE SET title = excluded.title, narrative_text = excluded.narrative_text,
      start_at = excluded.start_at, end_at = excluded.end_at, sort_order = excluded.sort_order,
      transition = excluded.transition, duration_seconds = excluded.duration_seconds`);
  const upsertItem = db.prepare(`
    INSERT INTO story_chapter_items (id, chapter_id, item_kind, media_asset_id, message_id,
      sort_order, start_offset_ms, end_offset_ms)
    VALUES (@id, @chapterId, @itemKind, @mediaAssetId, @messageId, @sortOrder, @startOffsetMs,
      @endOffsetMs)
    ON CONFLICT (id) DO UPDATE SET item_kind = excluded.item_kind,
      media_asset_id = excluded.media_asset_id, message_id = excluded.message_id,
      sort_order = excluded.sort_order, start_offset_ms = excluded.start_offset_ms,
      end_offset_ms = excluded.end_offset_ms`);
  const upsertTrack = db.prepare(`
    INSERT INTO soundtrack_tracks (id, project_id, source_kind, external_url, local_asset_id, title,
      artist, start_offset_ms, duration_ms, rights_status)
    VALUES (@id, @projectId, @sourceKind, @externalUrl, @localAssetId, @title, @artist,
      @startOffsetMs, @durationMs, @rightsStatus)
    ON CONFLICT (id) DO UPDATE SET source_kind = excluded.source_kind,
      external_url = excluded.external_url, local_asset_id = excluded.local_asset_id,
      title = excluded.title, artist = excluded.artist, start_offset_ms = excluded.start_offset_ms,
      duration_ms = excluded.duration_ms, rights_status = excluded.rights_status`);
  const upsertExport = db.prepare(`
    INSERT INTO movie_exports (id, project_id, preset, status, include_message_text,
      include_contact_names, included_soundtrack_track_ids_json, link_reference_track_ids_json,
      created_at, completed_at)
    VALUES (@id, @projectId, @preset, @status, @includeMessageText, @includeContactNames,
      @includedJson, @linkRefJson, @createdAt, @completedAt)
    ON CONFLICT (id) DO UPDATE SET status = excluded.status,
      include_message_text = excluded.include_message_text,
      include_contact_names = excluded.include_contact_names,
      included_soundtrack_track_ids_json = excluded.included_soundtrack_track_ids_json,
      link_reference_track_ids_json = excluded.link_reference_track_ids_json,
      completed_at = excluded.completed_at`);

  const all = (sql: string, ...params: unknown[]): Row[] => db.prepare(sql).all(...params) as Row[];
  const one = (sql: string, ...params: unknown[]): Row | undefined =>
    db.prepare(sql).get(...params) as Row | undefined;

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
      const row = one("SELECT * FROM media_assets WHERE id = ?", id);
      return row === undefined ? undefined : mapAsset(row);
    },
    listAssets(datasetId: string): MediaAsset[] {
      return all("SELECT * FROM media_assets WHERE dataset_id = ? ORDER BY id", datasetId).map(
        mapAsset,
      );
    },
    findAssetByHash(datasetId: string, contentHash: string): MediaAsset | undefined {
      const row = one(
        "SELECT * FROM media_assets WHERE dataset_id = ? AND content_hash = ? ORDER BY id LIMIT 1",
        datasetId,
        contentHash,
      );
      return row === undefined ? undefined : mapAsset(row);
    },
    /** Assets whose bytes live in app-managed storage. */
    listManagedAssets(datasetId: string): MediaAsset[] {
      return all(
        "SELECT * FROM media_assets WHERE dataset_id = ? AND storage_relative_path IS NOT NULL ORDER BY id",
        datasetId,
      ).map(mapAsset);
    },
    /** How many assets (in any dataset) point at a managed file; copies are shared by hash. */
    countAssetsUsingStoragePath(
      storageRelativePath: string,
      exceptAssetIds: readonly string[],
    ): number {
      const rows = all(
        "SELECT id FROM media_assets WHERE storage_relative_path = ?",
        storageRelativePath,
      );
      return rows.filter((row) => !exceptAssetIds.includes(str(row, "id"))).length;
    },
    /**
     * Marks an asset's managed copy as removed. Only media_assets is touched: references,
     * messages and everything else are left intact.
     */
    markManagedCopyRemoved(assetId: string): void {
      db.prepare(
        `UPDATE media_assets SET storage_relative_path = NULL, availability = 'not-imported'
         WHERE id = ? AND storage_relative_path IS NOT NULL`,
      ).run(assetId);
      db.prepare(
        `UPDATE media_references SET availability = 'not-imported'
         WHERE media_asset_id = ? AND availability = 'available-local'`,
      ).run(assetId);
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
    getReference(id: string): MediaReferenceRecord | undefined {
      const row = one("SELECT * FROM media_references WHERE id = ?", id);
      return row === undefined ? undefined : mapReference(row);
    },
    listReferencesForMessage(messageId: string): MediaReferenceRecord[] {
      return all(
        "SELECT * FROM media_references WHERE message_id = ? ORDER BY timestamp_local, id",
        messageId,
      ).map(mapReference);
    },
    listReferencesForAsset(assetId: string): MediaReferenceRecord[] {
      return all(
        "SELECT * FROM media_references WHERE media_asset_id = ? ORDER BY timestamp_local, id",
        assetId,
      ).map(mapReference);
    },
    upsertExternalLink(link: ExternalMediaLink): void {
      upsertLink.run({
        id: link.id,
        messageId: link.messageId,
        url: link.url,
        provider: link.provider ?? null,
        title: link.title ?? null,
        creator: link.creator ?? null,
        linkKind: link.linkKind,
        resolvedMetadataAt: link.resolvedMetadataAt ?? null,
      });
    },
    listExternalLinksForMessage(messageId: string): ExternalMediaLink[] {
      return all(
        "SELECT * FROM external_media_links WHERE message_id = ? ORDER BY id",
        messageId,
      ).map(mapLink);
    },
    listExternalLinks(datasetId: string): ExternalMediaLink[] {
      return all(
        `SELECT l.* FROM external_media_links l JOIN messages m ON m.id = l.message_id
         WHERE m.dataset_id = ? ORDER BY m.timestamp_local, l.id`,
        datasetId,
      ).map(mapLink);
    },
    upsertProject(project: StoryProject): void {
      upsertProject.run({
        id: project.id,
        datasetId: project.datasetId,
        title: project.title,
        dateRangeStart: project.dateRangeStart ?? null,
        dateRangeEnd: project.dateRangeEnd ?? null,
        status: project.status,
        aspectRatio: project.aspectRatio,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    },
    getProject(id: string): StoryProject | undefined {
      const row = one("SELECT * FROM story_projects WHERE id = ?", id);
      return row === undefined ? undefined : mapProject(row);
    },
    listProjects(datasetId: string): StoryProject[] {
      return all(
        "SELECT * FROM story_projects WHERE dataset_id = ? ORDER BY created_at, id",
        datasetId,
      ).map(mapProject);
    },
    deleteProject(id: string): void {
      db.prepare("DELETE FROM story_projects WHERE id = ?").run(id);
    },
    upsertChapter(chapter: StoryChapter): void {
      upsertChapter.run({
        id: chapter.id,
        projectId: chapter.projectId,
        title: chapter.title,
        narrativeText: chapter.narrativeText ?? null,
        startAt: chapter.startAt ?? null,
        endAt: chapter.endAt ?? null,
        sortOrder: chapter.sortOrder,
        transition: chapter.transition,
        durationSeconds: chapter.durationSeconds,
      });
    },
    listChapters(projectId: string): StoryChapter[] {
      return all(
        "SELECT * FROM story_chapters WHERE project_id = ? ORDER BY sort_order, id",
        projectId,
      ).map(mapChapter);
    },
    upsertChapterItem(item: StoryChapterItem): void {
      upsertItem.run({
        id: item.id,
        chapterId: item.chapterId,
        itemKind: item.itemKind,
        mediaAssetId: item.mediaAssetId ?? null,
        messageId: item.messageId ?? null,
        sortOrder: item.sortOrder,
        startOffsetMs: item.startOffsetMs ?? null,
        endOffsetMs: item.endOffsetMs ?? null,
      });
    },
    listChapterItems(chapterId: string): StoryChapterItem[] {
      return all(
        "SELECT * FROM story_chapter_items WHERE chapter_id = ? ORDER BY sort_order, id",
        chapterId,
      ).map(mapItem);
    },
    upsertSoundtrackTrack(track: SoundtrackTrack): void {
      upsertTrack.run({
        id: track.id,
        projectId: track.projectId,
        sourceKind: track.sourceKind,
        externalUrl: track.externalUrl ?? null,
        localAssetId: track.localAssetId ?? null,
        title: track.title ?? null,
        artist: track.artist ?? null,
        startOffsetMs: track.startOffsetMs,
        durationMs: track.durationMs ?? null,
        rightsStatus: track.rightsStatus,
      });
    },
    listSoundtrackTracks(projectId: string): SoundtrackTrack[] {
      return all("SELECT * FROM soundtrack_tracks WHERE project_id = ? ORDER BY id", projectId).map(
        mapTrack,
      );
    },
    upsertMovieExport(movie: MovieExport): void {
      upsertExport.run({
        id: movie.id,
        projectId: movie.projectId,
        preset: movie.preset,
        status: movie.status,
        includeMessageText: bool(movie.includeMessageText),
        includeContactNames: bool(movie.includeContactNames),
        includedJson: JSON.stringify(movie.includedSoundtrackTrackIds),
        linkRefJson: JSON.stringify(movie.linkReferenceTrackIds),
        createdAt: movie.createdAt,
        completedAt: movie.completedAt ?? null,
      });
    },
    listMovieExports(projectId: string): MovieExport[] {
      return all(
        "SELECT * FROM movie_exports WHERE project_id = ? ORDER BY created_at, id",
        projectId,
      ).map(mapExport);
    },
  };
}

export type MediaStorytellingRepository = ReturnType<typeof createMediaStorytellingRepository>;
