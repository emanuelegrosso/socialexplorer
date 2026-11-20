import type { MediaCatalogEntry, OnThisDayResult } from "@social-explorer/contracts";
import type { MediaCatalog } from "@social-explorer/media-core";
import type { Repositories, SqliteDatabase } from "@social-explorer/database";
import { IpcRejectedError } from "./ipc-router.js";

function toCatalogEntry(
  entry: ReturnType<MediaCatalog["query"]>[number],
): MediaCatalogEntry {
  const { reference, asset, message, mediaType } = entry;
  return {
    reference: {
      id: reference.id,
      datasetId: reference.datasetId,
      conversationId: reference.conversationId,
      timestampLocal: reference.timestampLocal,
      availability: reference.availability,
      ...(reference.mediaAssetId === undefined ? {} : { mediaAssetId: reference.mediaAssetId }),
      ...(reference.messageId === undefined ? {} : { messageId: reference.messageId }),
      ...(reference.timestampUtc === undefined ? {} : { timestampUtc: reference.timestampUtc }),
      ...(reference.caption === undefined ? {} : { caption: reference.caption }),
    },
    ...(asset === undefined
      ? {}
      : {
          asset: {
            ...asset,
            ...(asset.originalName === undefined ? {} : { originalName: asset.originalName }),
          },
        }),
    ...(message === undefined
      ? {}
      : {
          message: {
            id: message.id,
            conversationId: message.conversationId,
            timestampLocal: message.timestampLocal,
            kind: message.kind,
            ...(message.senderContactId === undefined
              ? {}
              : { senderContactId: message.senderContactId }),
            ...(message.text === undefined ? {} : { text: message.text }),
          },
        }),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function monthDayInTimezone(isoUtc: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(isoUtc));
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${month}-${day}`;
}

export function queryOnThisDay(options: {
  readonly db: SqliteDatabase;
  readonly repositories: Repositories;
  readonly catalog: MediaCatalog;
  readonly datasetId: string;
  readonly referenceAt: string;
  readonly now: () => string;
}): OnThisDayResult {
  const dataset = options.repositories.datasets.get(options.datasetId);
  if (dataset === undefined) {
    throw new IpcRejectedError("dataset not found");
  }
  const monthDay = monthDayInTimezone(options.referenceAt, dataset.timezone);
  const mediaRows = options.catalog.query({
    datasetId: options.datasetId,
    limit: 200,
  });
  const media = mediaRows
    .filter((entry) => entry.reference.timestampLocal.slice(5, 10) === monthDay)
  .map(toCatalogEntry);

  const messageIds = options.db
    .prepare(
      `SELECT id FROM messages WHERE dataset_id = ? AND substr(timestamp_local, 6, 5) = ?
       ORDER BY timestamp_local LIMIT 200`,
    )
    .all(options.datasetId, monthDay) as { id: string }[];
  const messages = messageIds
    .map((row) => options.repositories.messages.get(row.id))
    .filter((message): message is NonNullable<typeof message> => message !== undefined);

  const coverageNote =
    media.length === 0 && messages.length === 0
      ? "No messages on this calendar day in your imported coverage. Historical gaps are expected."
      : undefined;

  return {
    monthDay,
    timezone: dataset.timezone,
    referenceDate: options.referenceAt,
    media,
    messages,
    ...(coverageNote === undefined ? {} : { coverageNote }),
  };
}

export function mapCatalogResults(entries: ReturnType<MediaCatalog["query"]>): MediaCatalogEntry[] {
  return entries.map(toCatalogEntry);
}