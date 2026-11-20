import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { BaileysEventMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { BAILEYS_VERSION, LOGGED_OUT_STATUS_CODE, RESTART_REQUIRED_STATUS_CODE } from "./index.js";
import { CONNECTION_REPLACED_STATUS_CODE } from "./version.js";
import type { BaileysSocketLike } from "./baileys-socket.js";

/** Compile-time guards: these fail `tsc` if the pinned Baileys types drift from what the adapter reads. */
type EventKeys =
  | "connection.update"
  | "creds.update"
  | "messaging-history.set"
  | "messaging-history.status"
  | "messages.upsert"
  | "messages.update"
  | "messages.delete"
  | "messages.reaction"
  | "chats.upsert"
  | "chats.update"
  | "chats.delete"
  | "contacts.upsert"
  | "contacts.update"
  | "groups.upsert"
  | "groups.update"
  | "lid-mapping.update";
const eventKeysExist: EventKeys extends keyof BaileysEventMap ? true : false = true;
const upsertType: BaileysEventMap["messages.upsert"]["type"] = "notify";
type SocketSliceOk = WASocket extends BaileysSocketLike ? true : false;
const socketSliceOk = true satisfies SocketSliceOk;
const messageKeyShape = (message: WAMessage): string | null | undefined => message.key.remoteJid;
const historyStatus: BaileysEventMap["messaging-history.status"]["status"] = "paused";

describe("pinned Baileys compatibility", () => {
  const require = createRequire(import.meta.url);

  it("pins the exact version in package.json and the installed package", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@whiskeysockets/baileys"]).toBe(BAILEYS_VERSION);
    const entry = require.resolve("@whiskeysockets/baileys/package.json");
    const installed = JSON.parse(readFileSync(entry, "utf8")) as { version: string };
    expect(installed.version).toBe(BAILEYS_VERSION);
  });

  it("matches verified type and disconnect constants without opening a socket", async () => {
    expect([eventKeysExist, upsertType, historyStatus, socketSliceOk, typeof messageKeyShape]).toBeTruthy();
    const baileys = await import("@whiskeysockets/baileys");
    expect(baileys.DisconnectReason.loggedOut).toBe(LOGGED_OUT_STATUS_CODE);
    expect(baileys.DisconnectReason.restartRequired).toBe(RESTART_REQUIRED_STATUS_CODE);
    expect(baileys.DisconnectReason.connectionReplaced).toBe(CONNECTION_REPLACED_STATUS_CODE);
    expect(typeof baileys.default).toBe("function");
    expect(typeof baileys.initAuthCreds).toBe("function");
  });
});
