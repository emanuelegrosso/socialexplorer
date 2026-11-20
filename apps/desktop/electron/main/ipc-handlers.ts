import { createAnalyticsEngine, loadEntityContext, loadMessageFacts } from "@social-explorer/analytics";
import { DEFAULT_FREE_ENTITLEMENT } from "@social-explorer/contracts";
import type { Repositories, SqliteDatabase } from "@social-explorer/database";
import { ContactMergeError } from "@social-explorer/domain";
import { createMediaCatalog } from "@social-explorer/media-core";
import { buildTemporalFlowReadModel, resolveRange, TemporalRangeError } from "@social-explorer/visualization-model";
import { randomUUID } from "node:crypto";
import { ArchiveImportService, type PickedArchive } from "./import-service.js";
import {
  getFirstRunStatus,
  resetSyntheticDemo,
  seedSyntheticDemo,
  skipFirstRun,
} from "./demo-service.js";
import { IpcRejectedError, type IpcHandlers } from "./ipc-router.js";
import { listMemoryCards, removeMemoryCard, saveMemoryCard } from "./memory-cards.js";
import { mapCatalogResults, queryOnThisDay } from "./memories-service.js";

export interface IpcHandlerOptions {
  readonly repositories: Repositories;
  readonly db: SqliteDatabase;
  readonly appVersion: string;
  readonly userDataDir?: string;
  readonly pickArchiveFile?: () => Promise<PickedArchive | undefined>;
  readonly now?: () => string;
  /** Exposed so tests can stage archives without a native dialog. */
  readonly importService?: ArchiveImportService;
}

const NOT_FOUND = new Set(["contact_not_found", "group_not_found", "dataset_not_found"]);

function rejectKnown<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ContactMergeError || error instanceof TemporalRangeError) {
      throw new IpcRejectedError(error.message);
    }
    if (error instanceof Error && NOT_FOUND.has(error.message)) {
      throw new IpcRejectedError(error.message.replace(/_/gu, " "));
    }
    throw error;
  }
}

export function createIpcHandlers(options: IpcHandlerOptions): IpcHandlers {
  const { repositories, db } = options;
  const now = options.now ?? ((): string => new Date().toISOString());
  const engine = createAnalyticsEngine(db);
  const imports =
    options.importService ??
    new ArchiveImportService({
      db,
      repositories,
      pickFile: options.pickArchiveFile,
      now,
    });
  const userDataDir = options.userDataDir ?? "";
  const catalog = createMediaCatalog(db);

  return {
    "app:get-info": () => ({ name: "SocialExplorer", version: options.appVersion }),
    "dataset:list": () => repositories.datasets.list(),
    "conversation:list": (request) => repositories.conversations.listByDataset(request.datasetId),
    "message:list-range": (request) => repositories.messages.listRange(request),
    "media:list-references": (request) =>
      repositories.media.listReferences(request.datasetId, request.conversationId),
    "entitlement:get": () => DEFAULT_FREE_ENTITLEMENT,

    "archive-import:pick-file": () => imports.pickFile(),
    "archive-import:stage-fixture": (request) => imports.stageFixture(request.file),
    "archive-import:preview": (request) => imports.preview(request.stagedId),
    "archive-import:confirm": (request) => imports.confirm(request),
    "archive-import:commit": (request) => imports.commit(request),
    "archive-import:cancel": (request) => ({ canceled: imports.cancel(request.stagedId) }),

    "contact:list": (request) => repositories.identity.listActiveContacts(request.datasetId),
    "group:list": (request) => {
      const context = rejectKnown(() => loadEntityContext(db, request.datasetId));
      const counts = new Map<string, number>();
      for (const fact of loadMessageFacts(db, request.datasetId)) {
        counts.set(fact.conversationId, (counts.get(fact.conversationId) ?? 0) + 1);
      }
      return [...context.conversations.values()]
        .filter((conversation) => conversation.kind === "group")
        .map((conversation) => ({
          conversationId: conversation.id,
          title: conversation.title,
          participantContactIds: [...conversation.participantIds].sort(),
          messageCount: counts.get(conversation.id) ?? 0,
        }));
    },
    "contact:merge": (request) =>
      rejectKnown(() => {
        const merge = repositories.identity.mergeContacts(
          request.datasetId,
          request.primaryContactId,
          request.secondaryContactId,
          { now: now(), ...(request.reason === undefined ? {} : { reason: request.reason }) },
        );
        engine.rebuild(request.datasetId);
        return merge;
      }),
    "contact:unmerge": (request) =>
      rejectKnown(() => {
        const merge = repositories.identity.unmergeContact(
          request.datasetId,
          request.secondaryContactId,
          now(),
        );
        engine.rebuild(request.datasetId);
        return merge;
      }),
    "contact:list-merges": (request) => repositories.identity.listMerges(request.datasetId),

    "analytics:get-global": (request) =>
      rejectKnown(() => engine.global(request.datasetId, request.range)),
    "analytics:get-contact": (request) =>
      rejectKnown(() => engine.contact(request.datasetId, request.contactId, request.range)),
    "analytics:get-group": (request) =>
      rejectKnown(() => engine.group(request.datasetId, request.conversationId, request.range)),
    "analytics:get-relations": (request) =>
      rejectKnown(() => engine.relations(request.datasetId, request.windowMinutes)),
    "analytics:rebuild": (request) => rejectKnown(() => engine.rebuild(request.datasetId)),

    "temporal:get-read-model": (request) =>
      rejectKnown(() => {
        const dataset = repositories.datasets.get(request.datasetId);
        if (dataset === undefined) {
          throw new IpcRejectedError("dataset not found");
        }
        const range = resolveRange({
          preset: request.preset,
          timezone: dataset.timezone,
          now: now(),
          customStart: request.start,
          customEnd: request.end,
        });
        const context = loadEntityContext(db, request.datasetId);
        const facts = loadMessageFacts(db, request.datasetId, {
          startUtc: range.start,
          endUtc: range.end,
        });
        return buildTemporalFlowReadModel({
          datasetId: dataset.id,
          timezone: dataset.timezone,
          preset: request.preset,
          now: now(),
          customStart: request.start,
          customEnd: request.end,
          contacts: [...context.contacts.values()].map((contact) => ({
            id: contact.id,
            displayName: contact.displayName,
            colorKey: contact.colorKey,
          })),
          groups: [...context.conversations.values()]
            .filter((conversation) => conversation.kind === "group")
            .map((conversation) => ({ conversationId: conversation.id, title: conversation.title })),
          conversations: [...context.conversations.values()].map((conversation) => ({
            id: conversation.id,
            kind: conversation.kind,
            participantIds: [...conversation.participantIds],
          })),
          messages: facts.flatMap((fact) =>
            fact.timestampUtc === null
              ? []
              : [
                  {
                    id: fact.messageId,
                    conversationId: fact.conversationId,
                    senderId: fact.senderId,
                    timestampUtc: fact.timestampUtc,
                    partial: fact.partial,
                  },
                ],
          ),
          datasetCoverage: { start: dataset.coverageStart, end: dataset.coverageEnd },
        });
      }),

    "media:query-catalog": (request) =>
      rejectKnown(() => {
        if (repositories.datasets.get(request.datasetId) === undefined) {
          throw new IpcRejectedError("dataset not found");
        }
        return mapCatalogResults(
          catalog.query({
            datasetId: request.datasetId,
            ...(request.conversationId === undefined
              ? {}
              : { conversationId: request.conversationId }),
            ...(request.contactId === undefined ? {} : { contactId: request.contactId }),
            ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
            ...(request.from === undefined ? {} : { from: request.from }),
            ...(request.to === undefined ? {} : { to: request.to }),
            ...(request.limit === undefined ? {} : { limit: request.limit }),
            ...(request.offset === undefined ? {} : { offset: request.offset }),
          }),
        );
      }),

    "memories:on-this-day": (request) => {
      try {
        return queryOnThisDay({
          db,
          repositories,
          catalog,
          datasetId: request.datasetId,
          referenceAt: request.referenceAt ?? now(),
          now,
        });
      } catch (error) {
        if (error instanceof IpcRejectedError) {
          throw error;
        }
        throw error;
      }
    },

    "annotation:list-bookmarks": (request) =>
      rejectKnown(() => {
        if (repositories.datasets.get(request.datasetId) === undefined) {
          throw new IpcRejectedError("dataset not found");
        }
        return repositories.annotations.listBookmarks(request.datasetId);
      }),

    "annotation:toggle-bookmark": (request) =>
      rejectKnown(() => {
        if (repositories.datasets.get(request.datasetId) === undefined) {
          throw new IpcRejectedError("dataset not found");
        }
        const existing = repositories.annotations
          .listByTarget(request.datasetId, request.targetKind, request.targetId)
          .find((row) => row.bookmarked || row.note !== undefined);
        const timestamp = now();
        const annotation = {
          id: existing?.id ?? `ann_${randomUUID()}`,
          datasetId: request.datasetId,
          targetKind: request.targetKind,
          targetId: request.targetId,
          bookmarked: request.bookmarked,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          ...(request.note === undefined
            ? existing?.note === undefined
              ? {}
              : { note: existing.note }
            : { note: request.note }),
        };
        repositories.annotations.upsert(annotation);
        const saved = repositories.annotations.get(annotation.id);
        if (saved === undefined) {
          throw new IpcRejectedError("bookmark save failed");
        }
        return saved;
      }),

    "memory-card:list": (request) =>
      rejectKnown(() => {
        if (repositories.datasets.get(request.datasetId) === undefined) {
          throw new IpcRejectedError("dataset not found");
        }
        return listMemoryCards(db, request.datasetId);
      }),

    "memory-card:save": (request) =>
      rejectKnown(() => {
        if (repositories.datasets.get(request.datasetId) === undefined) {
          throw new IpcRejectedError("dataset not found");
        }
        return saveMemoryCard(repositories, request, now());
      }),

    "memory-card:remove": (request) =>
      rejectKnown(() => ({
        removed: removeMemoryCard(repositories, request.datasetId, request.cardId),
      })),

    "demo:get-first-run": () => getFirstRunStatus(userDataDir, repositories),

    "demo:seed-synthetic": async (request) =>
      seedSyntheticDemo({
        userDataDir,
        repositories,
        db,
        imports,
        ...(request.force === undefined ? {} : { force: request.force }),
      }),

    "demo:skip-first-run": () => skipFirstRun(userDataDir),

    "demo:reset-synthetic": () => resetSyntheticDemo(userDataDir, repositories),
  };
}


