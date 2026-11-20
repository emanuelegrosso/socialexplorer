import { DEFAULT_FREE_ENTITLEMENT } from "@social-explorer/contracts";
import type { Repositories } from "@social-explorer/database";
import { UnsupportedIpcError, type IpcHandlers } from "./ipc-router.js";

import type { ConnectorHost } from "../connector-host/connector-host.js";

export function createIpcHandlers(options: {
  readonly repositories: Repositories;
  readonly appVersion: string;
  readonly connectorHost: ConnectorHost;
}): IpcHandlers {
  const { repositories, connectorHost } = options;
  return {
    "app:get-info": () => ({ name: "SocialExplorer", version: options.appVersion }),
    "dataset:list": () => repositories.datasets.list(),
    "conversation:list": (request) => repositories.conversations.listByDataset(request.datasetId),
    "message:list-range": (request) => repositories.messages.listRange(request),
    "media:list-references": (request) =>
      repositories.media.listReferences(request.datasetId, request.conversationId),
    "entitlement:get": () => DEFAULT_FREE_ENTITLEMENT,
    "temporal:get-read-model": () => {
      throw new UnsupportedIpcError("temporal read model arrives with Wave 4");
    },
    "connector:get-snapshot": () => connectorHost.snapshot(),
    "connector:start": (request) => connectorHost.start(request.datasetId),
    "connector:stop": async () => connectorHost.stop(),
    "connector:sign-out": () => connectorHost.signOut(),
    "connector:clear-auth": () => connectorHost.clearAuth(),
    "connector:request-pairing-code": (request) => connectorHost.requestPairingCode(request.phoneNumber),
  };
}
