import {
  DEFAULT_FREE_ENTITLEMENT,
  ipcChannels,
  type IpcChannel,
  type IpcResponse,
} from "@social-explorer/contracts";
import { IpcError, type SocialExplorerApi } from "../../shared/bridge";

export const MOCK_APP_VERSION = "0.0.0-preview";

/** Headless fallback used by `vite preview` and tests where Electron's preload is absent. */
export function createMockApi(): SocialExplorerApi {
  const unsupported = (): Promise<never> =>
    Promise.reject(new IpcError({ code: "UNSUPPORTED", message: "not available in preview" }));
  return {
    getAppInfo: () => Promise.resolve({ name: "SocialExplorer", version: MOCK_APP_VERSION }),
    listDatasets: () => Promise.resolve([]),
    listConversations: () => Promise.resolve([]),
    listMessagesInRange: () => Promise.resolve([]),
    getTemporalReadModel: unsupported,
    listMediaReferences: () => Promise.resolve([]),
    getEntitlement: () => Promise.resolve(DEFAULT_FREE_ENTITLEMENT),
    pickArchiveFile: () => Promise.resolve({ canceled: true }),
    previewArchive: unsupported,
    confirmArchive: unsupported,
    commitArchive: unsupported,
    cancelArchive: () => Promise.resolve({ canceled: false }),
    listContacts: () => Promise.resolve([]),
    listGroups: () => Promise.resolve([]),
    mergeContacts: unsupported,
    unmergeContact: unsupported,
    listContactMerges: () => Promise.resolve([]),
    getGlobalAnalytics: unsupported,
    getContactAnalytics: unsupported,
    getGroupAnalytics: unsupported,
    getRelations: unsupported,
    rebuildAnalytics: unsupported,
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
