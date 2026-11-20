import type { IpcChannel, IpcRequest, IpcResponse } from "@social-explorer/contracts";

export type IpcErrorCode =
  | "UNKNOWN_CHANNEL"
  | "UNTRUSTED_SENDER"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED"
  | "INTERNAL_ERROR";

export interface IpcFailure {
  readonly code: IpcErrorCode;
  readonly message: string;
}

export type IpcEnvelope<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcFailure };

export class IpcError extends Error {
  readonly code: IpcErrorCode;
  constructor(failure: IpcFailure) {
    super(failure.message);
    this.name = "IpcError";
    this.code = failure.code;
  }
}

/** Narrow, validated surface exposed to the renderer as `window.socialExplorer`. */
export interface SocialExplorerApi {
  getAppInfo(): Promise<IpcResponse<"app:get-info">>;
  listDatasets(): Promise<IpcResponse<"dataset:list">>;
  listConversations(
    request: IpcRequest<"conversation:list">,
  ): Promise<IpcResponse<"conversation:list">>;
  listMessagesInRange(
    request: IpcRequest<"message:list-range">,
  ): Promise<IpcResponse<"message:list-range">>;
  getTemporalReadModel(
    request: IpcRequest<"temporal:get-read-model">,
  ): Promise<IpcResponse<"temporal:get-read-model">>;
  listMediaReferences(
    request: IpcRequest<"media:list-references">,
  ): Promise<IpcResponse<"media:list-references">>;
  getEntitlement(): Promise<IpcResponse<"entitlement:get">>;
  pickArchiveFile(): Promise<IpcResponse<"archive-import:pick-file">>;
  stageFixture(
    request: IpcRequest<"archive-import:stage-fixture">,
  ): Promise<IpcResponse<"archive-import:stage-fixture">>;
  previewArchive(
    request: IpcRequest<"archive-import:preview">,
  ): Promise<IpcResponse<"archive-import:preview">>;
  confirmArchive(
    request: IpcRequest<"archive-import:confirm">,
  ): Promise<IpcResponse<"archive-import:confirm">>;
  commitArchive(
    request: IpcRequest<"archive-import:commit">,
  ): Promise<IpcResponse<"archive-import:commit">>;
  cancelArchive(
    request: IpcRequest<"archive-import:cancel">,
  ): Promise<IpcResponse<"archive-import:cancel">>;
  listContacts(request: IpcRequest<"contact:list">): Promise<IpcResponse<"contact:list">>;
  listGroups(request: IpcRequest<"group:list">): Promise<IpcResponse<"group:list">>;
  mergeContacts(request: IpcRequest<"contact:merge">): Promise<IpcResponse<"contact:merge">>;
  unmergeContact(request: IpcRequest<"contact:unmerge">): Promise<IpcResponse<"contact:unmerge">>;
  listContactMerges(
    request: IpcRequest<"contact:list-merges">,
  ): Promise<IpcResponse<"contact:list-merges">>;
  getGlobalAnalytics(
    request: IpcRequest<"analytics:get-global">,
  ): Promise<IpcResponse<"analytics:get-global">>;
  getContactAnalytics(
    request: IpcRequest<"analytics:get-contact">,
  ): Promise<IpcResponse<"analytics:get-contact">>;
  getGroupAnalytics(
    request: IpcRequest<"analytics:get-group">,
  ): Promise<IpcResponse<"analytics:get-group">>;
  getRelations(
    request: IpcRequest<"analytics:get-relations">,
  ): Promise<IpcResponse<"analytics:get-relations">>;
  rebuildAnalytics(
    request: IpcRequest<"analytics:rebuild">,
  ): Promise<IpcResponse<"analytics:rebuild">>;
}

export type IpcInvoke = (channel: IpcChannel, request: unknown) => Promise<unknown>;

export const BRIDGE_GLOBAL_NAME = "socialExplorer" as const;

function isEnvelope(value: unknown): value is IpcEnvelope<unknown> {
  return (
    typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean"
  );
}

export function createBridge(invoke: IpcInvoke): SocialExplorerApi {
  const call = async <C extends IpcChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> => {
    const envelope = await invoke(channel, request);
    if (!isEnvelope(envelope)) {
      throw new IpcError({ code: "INVALID_RESPONSE", message: "malformed ipc envelope" });
    }
    if (!envelope.ok) {
      throw new IpcError(envelope.error);
    }
    return envelope.value as IpcResponse<C>;
  };
  return {
    getAppInfo: () => call("app:get-info", {}),
    listDatasets: () => call("dataset:list", {}),
    listConversations: (request) => call("conversation:list", request),
    listMessagesInRange: (request) => call("message:list-range", request),
    getTemporalReadModel: (request) => call("temporal:get-read-model", request),
    listMediaReferences: (request) => call("media:list-references", request),
    getEntitlement: () => call("entitlement:get", {}),
    pickArchiveFile: () => call("archive-import:pick-file", {}),
    stageFixture: (request) => call("archive-import:stage-fixture", request),
    previewArchive: (request) => call("archive-import:preview", request),
    confirmArchive: (request) => call("archive-import:confirm", request),
    commitArchive: (request) => call("archive-import:commit", request),
    cancelArchive: (request) => call("archive-import:cancel", request),
    listContacts: (request) => call("contact:list", request),
    listGroups: (request) => call("group:list", request),
    mergeContacts: (request) => call("contact:merge", request),
    unmergeContact: (request) => call("contact:unmerge", request),
    listContactMerges: (request) => call("contact:list-merges", request),
    getGlobalAnalytics: (request) => call("analytics:get-global", request),
    getContactAnalytics: (request) => call("analytics:get-contact", request),
    getGroupAnalytics: (request) => call("analytics:get-group", request),
    getRelations: (request) => call("analytics:get-relations", request),
    rebuildAnalytics: (request) => call("analytics:rebuild", request),
  };
}
