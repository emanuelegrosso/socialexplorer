import {
  normalizeChats,
  normalizeConnectionUpdate,
  normalizeContacts,
  normalizeGroups,
  normalizeMessages,
  normalizeMessageUpdates,
  normalizeKey,
  normalizeReactions,
} from "./normalize.js";
import type { PortEvent, PortMessageDelete } from "./events.js";
import type { BaileysSocketPort, PortAuthState, PortEventListener } from "./port.js";

type EventBag = Record<string, unknown>;

/**
 * The minimal structural slice of a Baileys `WASocket` that the adapter touches. Anything not
 * listed here (sendMessage, updateProfile, readMessages, ...) is unreachable through the port.
 */
export interface BaileysSocketLike {
  readonly ev: { process(handler: (events: EventBag) => void | Promise<void>): () => void };
  requestPairingCode(phoneNumber: string): Promise<string>;
  logout(message?: string): Promise<void>;
  end(error: Error | undefined): void | Promise<void>;
}

export type BaileysSocketFactory = (auth: PortAuthState) => BaileysSocketLike | Promise<BaileysSocketLike>;

export function translateEvents(events: EventBag): PortEvent[] {
  const output: PortEvent[] = [];
  for (const [name, data] of Object.entries(events)) {
    switch (name) {
      case "connection.update":
        output.push({ name: "connection.update", data: normalizeConnectionUpdate(data) });
        break;
      case "creds.update":
        output.push({ name: "creds.update", data: (data ?? {}) as Record<string, unknown> });
        break;
      case "messaging-history.set": {
        const set = (data ?? {}) as EventBag;
        const progress = set["progress"];
        const syncType = set["syncType"];
        const chunkOrder = set["chunkOrder"];
        output.push({
          name: "history.set",
          data: {
            chats: normalizeChats(set["chats"]),
            contacts: normalizeContacts(set["contacts"]),
            messages: normalizeMessages(set["messages"]),
            ...(typeof set["isLatest"] === "boolean" ? { isLatest: set["isLatest"] } : {}),
            ...(typeof progress === "number" || progress === null ? { progress } : {}),
            ...(typeof syncType === "number" || syncType === null ? { syncType } : {}),
            ...(typeof chunkOrder === "number" || chunkOrder === null ? { chunkOrder } : {}),
          },
        });
        break;
      }
      case "messaging-history.status": {
        const status = (data ?? {}) as EventBag;
        if (
          typeof status["syncType"] === "number" &&
          (status["status"] === "complete" || status["status"] === "paused")
        ) {
          output.push({
            name: "history.status",
            data: {
              syncType: status["syncType"],
              status: status["status"],
              explicit: status["explicit"] === true,
            },
          });
        }
        break;
      }
      case "messages.upsert": {
        const upsert = (data ?? {}) as EventBag;
        output.push({
          name: "messages.upsert",
          data: {
            type: upsert["type"] === "notify" ? "notify" : "append",
            messages: normalizeMessages(upsert["messages"]),
          },
        });
        break;
      }
      case "messages.update":
        output.push({ name: "messages.update", data: normalizeMessageUpdates(data) });
        break;
      case "messages.delete": {
        const del = (data ?? {}) as EventBag;
        let normalized: PortMessageDelete | undefined;
        if (Array.isArray(del["keys"])) {
          normalized = {
            keys: (del["keys"] as unknown[]).flatMap((key) => {
              const parsed = normalizeKey(key);
              return parsed === undefined ? [] : [parsed];
            }),
          };
        } else if (typeof del["jid"] === "string" && del["all"] === true) {
          normalized = { jid: del["jid"], all: true };
        }
        if (normalized !== undefined) {
          output.push({ name: "messages.delete", data: normalized });
        }
        break;
      }
      case "messages.reaction":
        output.push({ name: "messages.reaction", data: normalizeReactions(data) });
        break;
      case "chats.upsert":
        output.push({ name: "chats.upsert", data: normalizeChats(data) });
        break;
      case "chats.update":
        output.push({ name: "chats.update", data: normalizeChats(data) });
        break;
      case "chats.delete":
        output.push({
          name: "chats.delete",
          data: Array.isArray(data) ? (data as unknown[]).filter((id): id is string => typeof id === "string") : [],
        });
        break;
      case "contacts.upsert":
        output.push({ name: "contacts.upsert", data: normalizeContacts(data) });
        break;
      case "contacts.update":
        output.push({ name: "contacts.update", data: normalizeContacts(data) });
        break;
      case "groups.upsert":
        output.push({ name: "groups.upsert", data: normalizeGroups(data) });
        break;
      case "groups.update":
        output.push({ name: "groups.update", data: normalizeGroups(data) });
        break;
      case "lid-mapping.update": {
        const mapping = (data ?? {}) as EventBag;
        if (typeof mapping["lid"] === "string" && typeof mapping["pn"] === "string") {
          output.push({ name: "lid-mapping.update", data: { lid: mapping["lid"], pn: mapping["pn"] } });
        }
        break;
      }
      default:
        break;
    }
  }
  return output;
}

export function createPortFromSocket(socket: BaileysSocketLike): BaileysSocketPort {
  const listeners = new Set<PortEventListener>();
  const detach = socket.ev.process((events) => {
    for (const event of translateEvents(events)) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    }
  });
  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestPairingCode: (phoneNumber) => socket.requestPairingCode(phoneNumber.replace(/\D/gu, "")),
    close() {
      detach();
      listeners.clear();
      void Promise.resolve(socket.end(undefined)).catch(() => undefined);
    },
    logout: () => socket.logout(),
  };
}

/** Read-only socket configuration. Never marks the client online and never requests full history. */
export function readOnlySocketConfig(auth: PortAuthState): Record<string, unknown> {
  return {
    auth,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    logger: silentLogger(),
  };
}

function silentLogger(): Record<string, unknown> {
  const logger: Record<string, unknown> = {
    level: "silent",
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  logger["child"] = () => logger;
  return logger;
}

/** Real socket factory. Baileys is imported lazily so unit tests never load or contact it. */
export async function createBaileysPort(auth: PortAuthState): Promise<BaileysSocketPort> {
  const baileys = await import("@whiskeysockets/baileys");
  const makeSocket = baileys.default as unknown as (config: Record<string, unknown>) => BaileysSocketLike;
  const keys: PortAuthState["keys"] = {
    get: async (type, ids) => {
      const found = await auth.keys.get(type, ids);
      if (type !== "app-state-sync-key") {
        return found;
      }
      return Object.fromEntries(
        Object.entries(found).map(([id, value]) => [
          id,
          baileys.proto.Message.AppStateSyncKeyData.create(value as Record<string, unknown>),
        ]),
      );
    },
    set: (data) => auth.keys.set(data),
  };
  return createPortFromSocket(makeSocket(readOnlySocketConfig({ creds: auth.creds, keys })));
}

/** Fresh Baileys credentials, used when no auth state is stored yet. */
export async function createInitialCreds(): Promise<Record<string, unknown>> {
  const baileys = await import("@whiskeysockets/baileys");
  return { ...baileys.initAuthCreds() };
}
