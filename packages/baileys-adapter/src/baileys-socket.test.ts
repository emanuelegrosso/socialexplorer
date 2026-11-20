import { describe, expect, it } from "vitest";
import {
  createPortFromSocket,
  readOnlySocketConfig,
  translateEvents,
  type BaileysSocketLike,
  type PortEvent,
} from "./index.js";

function fakeSocket(): { socket: BaileysSocketLike; fire: (events: Record<string, unknown>) => void; ended: () => boolean } {
  let handler: ((events: Record<string, unknown>) => void | Promise<void>) | undefined;
  let ended = false;
  return {
    socket: {
      ev: {
        process: (h) => {
          handler = h;
          return () => {
            handler = undefined;
          };
        },
      },
      requestPairingCode: (phone) => Promise.resolve(`code-for-${phone}`),
      logout: () => Promise.resolve(),
      end: () => {
        ended = true;
      },
    },
    fire: (events) => {
      void handler?.(events);
    },
    ended: () => ended,
  };
}

const rawMessage = {
  key: { remoteJid: "15551000001@s.whatsapp.net", id: "SYNTH-1", fromMe: false },
  messageTimestamp: { toNumber: () => 1768468800 },
  message: { extendedTextMessage: { text: "hello", matchedText: "https://example.test" } },
};

describe("translateEvents", () => {
  it("normalizes history, upserts, reactions, edits and revokes", () => {
    const events = translateEvents({
      "messaging-history.set": {
        chats: [{ id: "15551000001@s.whatsapp.net", name: "Synthetic" }, { nope: true }],
        contacts: [{ id: "15551000001@s.whatsapp.net", notify: "Alice Example" }],
        messages: [rawMessage, { key: { remoteJid: "x@g.us", id: "R" }, messageTimestamp: 1, message: { protocolMessage: { type: 0 } } }],
        progress: 40,
        isLatest: false,
        syncType: 3,
      },
      "messages.upsert": { type: "notify", messages: [{ ...rawMessage, message: { imageMessage: { caption: "cap" } } }] },
      "messages.reaction": [
        {
          key: rawMessage.key,
          reaction: { text: "👍", key: { remoteJid: "g@g.us", id: "X", participant: "15551000002@s.whatsapp.net" }, senderTimestampMs: 5 },
        },
      ],
      "messages.update": [
        { key: rawMessage.key, update: { message: { protocolMessage: { type: 14, editedMessage: { conversation: "edited" }, timestampMs: 9 } } } },
        { key: rawMessage.key, update: { message: { protocolMessage: { type: 0 } } } },
        { key: rawMessage.key, update: { status: 3 } },
      ],
      "messages.delete": { keys: [rawMessage.key] },
      "connection.update": { connection: "close", lastDisconnect: { error: { message: "x", output: { statusCode: 401 } } } },
      "presence.update": { id: "ignored" },
    });
    const byName = new Map(events.map((event) => [event.name, event]));
    expect(events.map((event) => event.name)).not.toContain("presence.update");
    const history = byName.get("history.set") as Extract<PortEvent, { name: "history.set" }>;
    expect(history.data.chats).toHaveLength(1);
    expect(history.data.messages).toHaveLength(1);
    expect(history.data.messages[0]).toMatchObject({ kind: "link", timestampMs: 1768468800000 });
    const upsert = byName.get("messages.upsert") as Extract<PortEvent, { name: "messages.upsert" }>;
    expect(upsert.data.messages[0]).toMatchObject({ kind: "image", text: "cap", hasAttachment: true });
    const reaction = byName.get("messages.reaction") as Extract<PortEvent, { name: "messages.reaction" }>;
    expect(reaction.data[0]).toMatchObject({ emoji: "👍", reactorId: "15551000002@s.whatsapp.net" });
    const updates = byName.get("messages.update") as Extract<PortEvent, { name: "messages.update" }>;
    expect(updates.data).toHaveLength(2);
    expect(updates.data[0]).toMatchObject({ editedText: "edited", editedAtMs: 9 });
    expect(updates.data[1]).toMatchObject({ revoked: true });
    const connection = byName.get("connection.update") as Extract<PortEvent, { name: "connection.update" }>;
    expect(connection.data.disconnect?.statusCode).toBe(401);
  });
});

describe("createPortFromSocket", () => {
  it("fans events out, strips non-digits from pairing numbers, and closes cleanly", async () => {
    const { socket, fire, ended } = fakeSocket();
    const port = createPortFromSocket(socket);
    const seen: string[] = [];
    port.onEvent((event) => seen.push(event.name));
    fire({ "chats.upsert": [{ id: "a@g.us" }] });
    expect(seen).toEqual(["chats.upsert"]);
    await expect(port.requestPairingCode("+1 (555) 010-0001")).resolves.toBe("code-for-15550100001");
    port.close();
    expect(ended()).toBe(true);
    fire({ "chats.upsert": [{ id: "a@g.us" }] });
    expect(seen).toHaveLength(1);
  });

  it("builds a read-only socket config", () => {
    const config = readOnlySocketConfig({ creds: {}, keys: { get: () => ({}), set: () => undefined } });
    expect(config["markOnlineOnConnect"]).toBe(false);
    expect(config["syncFullHistory"]).toBe(false);
  });
});
