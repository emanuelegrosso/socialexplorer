import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNEL_NAMES } from "@social-explorer/contracts";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIpcHandlers } from "./ipc-handlers.js";
import { createIpcRouter } from "./ipc-router.js";
import { createAppRuntime, type AppRuntime } from "./runtime.js";
import {
  buildCsp,
  decideNavigation,
  decideWindowOpen,
  isTrustedAppUrl,
  SECURE_WEB_PREFERENCES,
  type TrustedOrigins,
} from "./security-policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = join(here, "..", "..");
const rendererIndex = join(distRoot, "renderer", "index.html");
const preloadScript = join(distRoot, "preload", "index.cjs");

const devServerOrigin = app.isPackaged
  ? undefined
  : process.env["SOCIAL_EXPLORER_DEV_SERVER_URL"]?.replace(/\/$/u, "");

const trusted: TrustedOrigins = {
  rendererFileUrl: pathToFileURL(rendererIndex).href,
  devServerOrigin,
};

let runtime: AppRuntime | undefined;
let mainWindow: BrowserWindow | undefined;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#071321",
    show: false,
    title: "SocialExplorer",
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: preloadScript },
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  void (devServerOrigin === undefined
    ? window.loadFile(rendererIndex)
    : window.loadURL(devServerOrigin));
  return window;
}

function installSecurity(): void {
  const csp = buildCsp({ devServerOrigin });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (decideNavigation(url, trusted) === "deny") {
        event.preventDefault();
        runtime?.logger.warn("blocked navigation");
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (decideNavigation(url, trusted) === "deny") {
        event.preventDefault();
      }
    });
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    contents.setWindowOpenHandler(() => decideWindowOpen());
  });
}

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

async function pickArchiveFile(): Promise<{ name: string; data: Uint8Array } | undefined> {
  const options = {
    title: "Select a WhatsApp export",
    properties: ["openFile" as const],
    filters: [{ name: "WhatsApp export", extensions: ["txt", "zip"] }],
  };
  const chosen =
    mainWindow === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(mainWindow, options);
  const filePath = chosen.filePaths[0];
  if (chosen.canceled || filePath === undefined) {
    return undefined;
  }
  if ((await stat(filePath)).size > MAX_ARCHIVE_BYTES) {
    throw new Error("archive too large");
  }
  return { name: basename(filePath), data: await readFile(filePath) };
}

function registerIpc(active: AppRuntime): void {
  const router = createIpcRouter({
    handlers: createIpcHandlers({
      repositories: active.repositories,
      db: active.db,
      appVersion: app.getVersion(),
      pickArchiveFile: pickArchiveFile,
    }),
    isTrustedSender: (url) => isTrustedAppUrl(url, trusted),
    logger: active.logger,
  });
  for (const channel of IPC_CHANNEL_NAMES) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) =>
      router.handle(channel, payload, event.senderFrame?.url),
    );
  }
  active.shutdown.register("ipc", () => {
    for (const channel of IPC_CHANNEL_NAMES) {
      ipcMain.removeHandler(channel);
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    installSecurity();
    runtime = createAppRuntime({
      userDataDir: app.getPath("userData"),
      logLevel: process.env["SOCIAL_EXPLORER_LOG_LEVEL"],
    });
    registerIpc(runtime);
    mainWindow = createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  let shuttingDown = false;
  app.on("before-quit", (event) => {
    if (shuttingDown || runtime === undefined) {
      return;
    }
    event.preventDefault();
    shuttingDown = true;
    void runtime.shutdown.run().finally(() => {
      app.exit(0);
    });
  });
}
