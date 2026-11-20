import type {
  ContactSummary,
  Dataset,
  GlobalMetrics,
  GroupMetrics,
  GroupSummary,
  TemporalFlowReadModel,
} from "@social-explorer/contracts";
import {
  DEFAULT_FREE_ENTITLEMENT,
  ipcChannels,
  type IpcChannel,
  type IpcResponse,
} from "@social-explorer/contracts";
import { IpcError, type SocialExplorerApi } from "../../shared/bridge";
import { createSyntheticReadModel } from "./features/temporal/test-model";
import { readMockPreview } from "./features/import/synthetic-sample";

export const MOCK_APP_VERSION = "0.0.0-preview";
const DEMO_DATASET_ID = "ds_synthetic";

/** Headless fallback used by `vite preview` and tests where Electron's preload is absent. */
export function createMockApi(): SocialExplorerApi {
  const unsupported = (): Promise<never> =>
    Promise.reject(new IpcError({ code: "UNSUPPORTED", message: "not available in preview" }));
  const datasets: Dataset[] = [
    {
      id: DEMO_DATASET_ID,
      name: "Synthetic demo",
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Europe/Rome",
      sourceIds: [],
      coverageStart: "2026-01-19T00:00:00Z",
      coverageEnd: "2026-01-20T23:00:00Z",
    },
  ];
  const readModel = createSyntheticReadModel();
  const contacts: ContactSummary[] = readModel.lanes
    .filter((lane) => lane.kind === "contact")
    .map((lane) => ({
      id: lane.entityId,
      displayName: lane.label,
      aliases: [],
      identifiers: [],
      isSelf: false,
      colorKey: `palette-0`,
      mergedContactIds: [],
    }));
  const groups: GroupSummary[] = readModel.lanes
    .filter((lane) => lane.kind === "group")
    .map((lane) => ({
      conversationId: lane.entityId,
      title: lane.label,
      participantContactIds: contacts.map((contact) => contact.id),
      messageCount: readModel.coverage.messageCount,
    }));
  const metricsFromModel = (model: TemporalFlowReadModel): GlobalMetrics => ({
    datasetId: DEMO_DATASET_ID,
    timezone: model.range.timezone,
    range: {},
    contactCount: contacts.length,
    groupCount: groups.length,
    conversationCount: groups.length + 1,
    dailyAverage: model.coverage.messageCount / 2,
    totalMessages: model.coverage.messageCount,
    activeDays: model.dailyMarkers.length,
    hourly: Array.from({ length: 24 }, (_, hour) =>
      model.events.some((event) => new Date(event.timestamp).getUTCHours() === hour) ? 1 : 0,
    ),
    weekday: Array.from({ length: 7 }, () => 0),
    peakHour: 8,
    peakWeekday: 1,
    busiestDays: model.dailyMarkers.map((day) => ({ date: day.date, count: 1 })),
    daily: model.dailyMarkers.map((day) => ({ date: day.date, count: 1 })),
    firstMessageAt: model.coverage.start ?? model.range.start,
    lastMessageAt: model.coverage.end ?? model.range.end,
    bursts: { burstCount: 1, longestBurst: model.coverage.messageCount, averageBurstLength: 2 },
  });

  return {
    getAppInfo: () => Promise.resolve({ name: "SocialExplorer", version: MOCK_APP_VERSION }),
    listDatasets: () => Promise.resolve(datasets),
    listConversations: () => Promise.resolve([]),
    listMessagesInRange: () => Promise.resolve([]),
    getTemporalReadModel: (request) => {
      if (request.datasetId !== DEMO_DATASET_ID) {
        return unsupported();
      }
      return Promise.resolve(readModel);
    },
    listMediaReferences: () => Promise.resolve([]),
    getEntitlement: () => Promise.resolve(DEFAULT_FREE_ENTITLEMENT),
    pickArchiveFile: () => Promise.resolve({ canceled: true }),
    stageFixture: () => Promise.resolve({ canceled: true }),
    previewArchive: (request) => {
      const preview = readMockPreview(request.stagedId);
      return preview === undefined ? unsupported() : Promise.resolve(preview);
    },
    confirmArchive: () =>
      Promise.resolve({
        stagedId: "mock",
        datasetId: DEMO_DATASET_ID,
        planId: "plan",
        counts: { new: 1, exactDuplicate: 0, ambiguous: 0 },
        contacts: [],
        reviews: [],
      }),
    commitArchive: () =>
      Promise.resolve({
        stagedId: "mock",
        datasetId: DEMO_DATASET_ID,
        batchId: "batch",
        status: "committed",
        totalChunks: 1,
        committedItems: 1,
        resumedFromChunk: 0,
        persisted: {
          messagesInserted: 2,
          messagesLinked: 0,
          contactsCreated: 2,
          conversationsCreated: 1,
          unplacedRecords: 0,
        },
      }),
    cancelArchive: () => Promise.resolve({ canceled: false }),
    listContacts: () => Promise.resolve(contacts),
    listGroups: () => Promise.resolve(groups),
    mergeContacts: unsupported,
    unmergeContact: unsupported,
    listContactMerges: () => Promise.resolve([]),
    getGlobalAnalytics: (request) => {
      if (request.datasetId !== DEMO_DATASET_ID) {
        return unsupported();
      }
      return Promise.resolve(metricsFromModel(readModel));
    },
    getContactAnalytics: (request) =>
      Promise.resolve({
        datasetId: DEMO_DATASET_ID,
        contactId: request.contactId,
        displayName: contacts.find((contact) => contact.id === request.contactId)?.displayName ?? request.contactId,
        range: request.range ?? {},
        conversationCount: 1,
        groupCount: 0,
        topCounterparties: [],
        response: { samples: 0, medianSeconds: null, meanSeconds: null },
        totalMessages: 1,
        activeDays: 1,
        hourly: Array.from({ length: 24 }, () => 0),
        weekday: Array.from({ length: 7 }, () => 0),
        peakHour: null,
        peakWeekday: null,
        busiestDays: [],
        daily: [],
        firstMessageAt: null,
        lastMessageAt: null,
        bursts: { burstCount: 0, longestBurst: 0, averageBurstLength: 0 },
      }),
    getGroupAnalytics: (request): Promise<GroupMetrics> =>
      Promise.resolve({
        datasetId: DEMO_DATASET_ID,
        conversationId: request.conversationId,
        title: groups.find((group) => group.conversationId === request.conversationId)?.title ?? "Group",
        range: request.range ?? {},
        participantCount: contacts.length,
        participants: contacts.map((contact) => ({
          contactId: contact.id,
          displayName: contact.displayName,
          messageCount: 1,
        })),
        totalMessages: 2,
        activeDays: 1,
        hourly: Array.from({ length: 24 }, () => 0),
        weekday: Array.from({ length: 7 }, () => 0),
        peakHour: null,
        peakWeekday: null,
        busiestDays: [],
        daily: [],
        firstMessageAt: null,
        lastMessageAt: null,
        bursts: { burstCount: 0, longestBurst: 0, averageBurstLength: 0 },
      }),
    getRelations: () =>
      Promise.resolve({
        datasetId: DEMO_DATASET_ID,
        windowMinutes: 30,
        shared_participant: [],
        temporal_overlap: [],
        cross_chat_activity: [],
        direct_message: [],
        group_post: [],
      }),
    rebuildAnalytics: () =>
      Promise.resolve({ datasetId: DEMO_DATASET_ID, daily: 1, hourly: 1, messages: 1, version: 1 }),
    queryMediaCatalog: (request) => {
      if (request.datasetId !== DEMO_DATASET_ID) {
        return unsupported();
      }
      return Promise.resolve([
        {
          reference: {
            id: "ref_demo",
            datasetId: DEMO_DATASET_ID,
            conversationId: "conv_demo",
            messageId: "msg_demo",
            timestampLocal: "2026-01-15T09:20:00",
            availability: "missing",
          },
          mediaType: "photo",
          message: {
            id: "msg_demo",
            conversationId: "conv_demo",
            timestampLocal: "2026-01-15T09:20:00",
            kind: "image",
            text: "IMG-20260115-WA0001.png",
          },
        },
      ]);
    },
    getOnThisDay: (request) => {
      if (request.datasetId !== DEMO_DATASET_ID) {
        return unsupported();
      }
      return Promise.resolve({
        monthDay: "01-15",
        timezone: "Europe/Rome",
        referenceDate: request.referenceAt ?? "2026-01-15T12:00:00.000Z",
        media: [],
        messages: [],
        coverageNote: "Preview mock — import synthetic data for full On This Day coverage.",
      });
    },
    listBookmarks: () => Promise.resolve([]),
    toggleBookmark: (request) =>
      Promise.resolve({
        id: "ann_demo",
        datasetId: request.datasetId,
        targetKind: request.targetKind,
        targetId: request.targetId,
        bookmarked: request.bookmarked,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    listMemoryCards: () => Promise.resolve([]),
    saveMemoryCard: (request) => Promise.resolve(request),
    removeMemoryCard: () => Promise.resolve({ removed: true }),
    getFirstRunStatus: () =>
      Promise.resolve({ state: "seeded", datasetId: DEMO_DATASET_ID, datasetName: "Synthetic demo" }),
    seedSyntheticDemo: () =>
      Promise.resolve({
        datasetId: DEMO_DATASET_ID,
        status: "already-seeded",
        messageCount: 10,
        mediaReferenceCount: 2,
      }),
    skipFirstRun: () => Promise.resolve({ state: "skipped" }),
    resetSyntheticDemo: () => Promise.resolve({ state: "pending" }),
  };
}

export interface IpcClient {
  readonly api: SocialExplorerApi;
  readonly isNative: boolean;
}

export function resolveApi(
  globalLike: { socialExplorer?: SocialExplorerApi | undefined } | undefined,
): IpcClient {
  const native = globalLike?.socialExplorer;
  return native === undefined
    ? { api: createMockApi(), isNative: false }
    : { api: native, isNative: true };
}

export function parseResponse<C extends IpcChannel>(channel: C, value: unknown): IpcResponse<C> {
  const result = ipcChannels[channel].response.safeParse(value);
  if (!result.success) {
    throw new IpcError({ code: "INVALID_RESPONSE", message: `invalid ${channel} response` });
  }
  return result.data as IpcResponse<C>;
}

/** Typed client: re-validates native responses against the shared contracts before the UI sees them. */
export function createIpcClient(
  globalLike: Parameters<typeof resolveApi>[0] = globalThis as Parameters<typeof resolveApi>[0],
) {
  const { api, isNative } = resolveApi(globalLike);
  return {
    isNative,
    async getAppInfo() {
      return parseResponse("app:get-info", await api.getAppInfo());
    },
    async listDatasets() {
      return parseResponse("dataset:list", await api.listDatasets());
    },
    async getEntitlement() {
      return parseResponse("entitlement:get", await api.getEntitlement());
    },
    api,
  };
}

export type RendererIpcClient = ReturnType<typeof createIpcClient>;