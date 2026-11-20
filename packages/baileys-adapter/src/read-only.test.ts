import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockSocketPort, READ_ONLY_PORT_METHODS } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(join(here, name), "utf8") }));

const FORBIDDEN =
  /\b(sendMessage|relayMessage|sendPresenceUpdate|readMessages|sendReceipt|updateProfile\w*|updateBlockStatus|chatModify|groupUpdate\w*|groupParticipantsUpdate|groupCreate|groupLeave|newsletter\w*Create|fetchMessageHistory|presenceSubscribe|rejectCall|createCall|sendRawMessage|sendPeerDataOperationMessage|appPatch|star|archiveChat|pinMessage|deleteMessage|editMessage|reactToMessage)\s*[:(=]/u;

describe("read-only adapter boundary", () => {
  it("exposes only the allowed port methods", () => {
    expect([...READ_ONLY_PORT_METHODS].sort()).toEqual(
      ["close", "logout", "onEvent", "requestPairingCode"].sort(),
    );
    const port = new MockSocketPort();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(port) as object).filter(
      (name) => name !== "constructor" && typeof (port as unknown as Record<string, unknown>)[name] === "function",
    );
    expect(methods.sort()).toEqual(["close", "emit", "logout", "onEvent", "requestPairingCode"]);
  });

  it("source never declares or calls a write/modify API", () => {
    for (const { name, text } of sources) {
      const stripped = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
      expect(FORBIDDEN.test(stripped), `forbidden write API in ${name}`).toBe(false);
    }
  });

  it("socket-like slice used by the adapter lists no send capability", () => {
    const text = sources.find((source) => source.name === "baileys-socket.ts")?.text ?? "";
    const start = text.indexOf("export interface BaileysSocketLike");
    const block = text.slice(start, text.indexOf("}\n", text.indexOf("end(error", start)) + 1);
    expect(block).toContain("requestPairingCode");
    expect(block).not.toMatch(/send|update|modify|readMessages|presence/iu);
  });
});
