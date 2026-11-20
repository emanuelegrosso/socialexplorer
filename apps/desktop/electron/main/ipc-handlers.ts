import { createAnalyticsEngine, loadEntityContext, loadMessageFacts } from "@social-explorer/analytics";
import { DEFAULT_FREE_ENTITLEMENT } from "@social-explorer/contracts";
import type { Repositories, SqliteDatabase } from "@social-explorer/database";
import { ContactMergeError } from "@social-explorer/domain";
import { buildTemporalFlowReadModel, resolveRange, TemporalRangeError } from "@social-explorer/visualization-model";
import { ArchiveImportService, type PickedArchive } from "./import-service.js";
import { IpcRejectedError, type IpcHandlers } from "./ipc-router.js";

export interface IpcHandlerOptions {
  readonly repositories: Repositories;
  readonly db: SqliteDatabase;
  readonly appVersion: string;
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
  };
}


