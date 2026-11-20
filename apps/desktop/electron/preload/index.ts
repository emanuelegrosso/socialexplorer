import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNEL_NAMES, isIpcChannel } from "@social-explorer/contracts";
import { BRIDGE_GLOBAL_NAME, createBridge } from "../../shared/bridge";

const allowed = new Set<string>(IPC_CHANNEL_NAMES);

const api = createBridge((channel, request) => {
  if (!allowed.has(channel) || !isIpcChannel(channel)) {
    return Promise.reject(new Error("channel not allowed"));
  }
  return ipcRenderer.invoke(channel, request) as Promise<unknown>;
});

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL_NAME, api);
