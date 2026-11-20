import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CONNECTOR_PUSH_CHANNEL, connectorPushEventSchema, IPC_CHANNEL_NAMES, isIpcChannel } from "@social-explorer/contracts";
import { BRIDGE_GLOBAL_NAME, createBridge } from "../../shared/bridge";

const allowed = new Set<string>(IPC_CHANNEL_NAMES);

const invokeApi = createBridge((channel, request) => {
  if (!allowed.has(channel) || !isIpcChannel(channel)) {
    return Promise.reject(new Error("channel not allowed"));
  }
  return ipcRenderer.invoke(channel, request) as Promise<unknown>;
});

const api = {
  ...invokeApi,
  subscribeConnector(listener: Parameters<typeof invokeApi.subscribeConnector>[0]) {
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      const parsed = connectorPushEventSchema.safeParse(payload);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on(CONNECTOR_PUSH_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(CONNECTOR_PUSH_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL_NAME, api);
