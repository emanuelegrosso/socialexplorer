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

/** Narrow, read-only surface exposed to the renderer as `window.socialExplorer`. */
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
  };
}
