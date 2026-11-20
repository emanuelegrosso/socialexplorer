import type {
  PortChat,
  PortConnectionUpdate,
  PortContact,
  PortGroup,
  PortMessage,
  PortMessageKey,
  PortMessageKind,
  PortMessageUpdate,
  PortReaction,
} from "./events.js";

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose | undefined {
  return typeof value === "object" && value !== null ? (value as Loose) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const record = asRecord(value);
  if (record !== undefined && typeof record["toNumber"] === "function") {
    const result = (record["toNumber"] as () => unknown)();
    return typeof result === "number" && Number.isFinite(result) ? result : undefined;
  }
  if (record !== undefined && typeof record["low"] === "number") {
    return record["low"];
  }
  return undefined;
}

export function normalizeKey(raw: unknown): PortMessageKey | undefined {
  const key = asRecord(raw);
  const remoteJid = str(key?.["remoteJid"]);
  const id = str(key?.["id"]);
  if (key === undefined || remoteJid === undefined || id === undefined) {
    return undefined;
  }
  const participant = str(key["participant"]);
  return {
    remoteJid,
    id,
    fromMe: key["fromMe"] === true,
    ...(participant === undefined ? {} : { participant }),
  };
}

const WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;

function unwrap(content: Loose | undefined): Loose | undefined {
  let current = content;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const wrapper = WRAPPERS.find((name) => asRecord(current?.[name]) !== undefined);
    if (wrapper === undefined) {
      return current;
    }
    current = asRecord(asRecord(current[wrapper])?.["message"]);
  }
  return current;
}

const IGNORED_CONTENT = new Set([
  "protocolMessage",
  "reactionMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
]);

interface Classified {
  readonly kind: PortMessageKind;
  readonly text?: string;
  readonly hasAttachment: boolean;
}

function classify(content: Loose): Classified | undefined {
  const keys = Object.keys(content).filter((key) => content[key] !== undefined && content[key] !== null);
  const meaningful = keys.filter((key) => key !== "messageContextInfo");
  if (meaningful.length > 0 && meaningful.every((key) => IGNORED_CONTENT.has(key))) {
    return undefined;
  }
  const conversation = str(content["conversation"]);
  if (conversation !== undefined) {
    return { kind: "text", text: conversation, hasAttachment: false };
  }
  const extended = asRecord(content["extendedTextMessage"]);
  if (extended !== undefined) {
    const text = str(extended["text"]);
    return {
      kind: str(extended["matchedText"]) === undefined ? "text" : "link",
      ...(text === undefined ? {} : { text }),
      hasAttachment: false,
    };
  }
  const media: readonly [string, PortMessageKind][] = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
  ];
  for (const [name, kind] of media) {
    const entry = asRecord(content[name]);
    if (entry !== undefined) {
      const caption = str(entry["caption"]);
      return { kind, ...(caption === undefined ? {} : { text: caption }), hasAttachment: true };
    }
  }
  const audio = asRecord(content["audioMessage"]);
  if (audio !== undefined) {
    return { kind: audio["ptt"] === true ? "voice" : "audio", hasAttachment: true };
  }
  if (asRecord(content["stickerMessage"]) !== undefined) {
    return { kind: "image", hasAttachment: true };
  }
  return { kind: "unknown", hasAttachment: false };
}

/** Reduces a Baileys WAMessage to read-only metadata. Returns undefined for non-content stanzas. */
export function normalizeMessage(raw: unknown): PortMessage | undefined {
  const message = asRecord(raw);
  const key = normalizeKey(message?.["key"]);
  if (message === undefined || key === undefined) {
    return undefined;
  }
  const seconds = toNumber(message["messageTimestamp"]);
  if (seconds === undefined) {
    return undefined;
  }
  const stubType = toNumber(message["messageStubType"]);
  let classified: Classified | undefined;
  const content = unwrap(asRecord(message["message"]));
  if (content === undefined) {
    if (stubType === undefined) {
      return undefined;
    }
    classified = { kind: "system", hasAttachment: false };
  } else {
    classified = classify(content);
  }
  if (classified === undefined) {
    return undefined;
  }
  const pushName = str(message["pushName"]);
  return {
    key,
    timestampMs: Math.trunc(seconds) * 1000,
    kind: classified.kind,
    ...(classified.text === undefined ? {} : { text: classified.text }),
    hasAttachment: classified.hasAttachment,
    ...(pushName === undefined ? {} : { pushName }),
  };
}

export function normalizeMessages(raw: unknown): PortMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown) => {
    const normalized = normalizeMessage(entry);
    return normalized === undefined ? [] : [normalized];
  });
}

export function normalizeChats(raw: unknown): PortChat[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown) => {
    const chat = asRecord(entry);
    const id = str(chat?.["id"]);
    if (chat === undefined || id === undefined) {
      return [];
    }
    const name = str(chat["name"]);
    return [{ id, ...(name === undefined ? {} : { name }) }];
  });
}

export function normalizeContacts(raw: unknown): PortContact[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown) => {
    const contact = asRecord(entry);
    const id = str(contact?.["id"]);
    if (contact === undefined || id === undefined) {
      return [];
    }
    const lid = str(contact["lid"]);
    const phoneNumberJid = str(contact["phoneNumber"]);
    const name = str(contact["name"]);
    const notify = str(contact["notify"]);
    return [
      {
        id,
        ...(lid === undefined ? {} : { lid }),
        ...(phoneNumberJid === undefined ? {} : { phoneNumberJid }),
        ...(name === undefined ? {} : { name }),
        ...(notify === undefined ? {} : { notify }),
      },
    ];
  });
}

export function normalizeGroups(raw: unknown): PortGroup[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown) => {
    const group = asRecord(entry);
    const id = str(group?.["id"]);
    if (group === undefined || id === undefined) {
      return [];
    }
    const subject = str(group["subject"]);
    const participants = Array.isArray(group["participants"])
      ? (group["participants"] as unknown[]).flatMap((participant) => {
          const pid = str(asRecord(participant)?.["id"]);
          return pid === undefined ? [] : [pid];
        })
      : undefined;
    return [
      {
        id,
        ...(subject === undefined ? {} : { subject }),
        ...(participants === undefined ? {} : { participantIds: participants }),
      },
    ];
  });
}

export function normalizeConnectionUpdate(raw: unknown): PortConnectionUpdate {
  const update = asRecord(raw) ?? {};
  const connection = update["connection"];
  const qr = str(update["qr"]);
  const lastDisconnect = asRecord(update["lastDisconnect"]);
  const error = asRecord(lastDisconnect?.["error"]);
  const output = asRecord(error?.["output"]);
  const statusCode = toNumber(output?.["statusCode"]) ?? toNumber(error?.["statusCode"]);
  const message = str(error?.["message"]);
  return {
    ...(connection === "open" || connection === "connecting" || connection === "close"
      ? { connection }
      : {}),
    ...(qr === undefined ? {} : { qr }),
    ...(typeof update["isNewLogin"] === "boolean" ? { isNewLogin: update["isNewLogin"] } : {}),
    ...(typeof update["receivedPendingNotifications"] === "boolean"
      ? { receivedPendingNotifications: update["receivedPendingNotifications"] }
      : {}),
    ...(lastDisconnect === undefined
      ? {}
      : {
          disconnect: {
            ...(statusCode === undefined ? {} : { statusCode }),
            ...(message === undefined ? {} : { message }),
          },
        }),
  };
}

const PROTOCOL_REVOKE = 0;
const PROTOCOL_MESSAGE_EDIT = 14;

export function normalizeMessageUpdates(raw: unknown): PortMessageUpdate[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown) => {
    const item = asRecord(entry);
    const key = normalizeKey(item?.["key"]);
    const update = asRecord(item?.["update"]);
    if (key === undefined || update === undefined) {
      return [];
    }
    const content = asRecord(update["message"]);
    const protocol = asRecord(content?.["protocolMessage"]);
    const protocolType = toNumber(protocol?.["type"]);
    const revoked = protocolType === PROTOCOL_REVOKE || toNumber(update["messageStubType"]) === 1;
    const editedContainer = asRecord(content?.["editedMessage"]);
    const editedContent =
      protocolType === PROTOCOL_MESSAGE_EDIT
        ? asRecord(protocol?.["editedMessage"])
        : asRecord(editedContainer?.["message"]);
    const classified = editedContent === undefined ? undefined : classify(editedContent);
    const editedText = classified?.text;
    const editedAtMs =
      toNumber(protocol?.["timestampMs"]) ??
      ((): number | undefined => {
        const seconds = toNumber(update["messageTimestamp"]);
        return seconds === undefined ? undefined : seconds * 1000;
      })();
    if (!revoked && editedText === undefined) {
      return [];
    }
    return [
      {
        key,
        ...(revoked ? { revoked: true } : {}),
        ...(editedText === undefined ? {} : { editedText }),
        ...(editedText === undefined || editedAtMs === undefined ? {} : { editedAtMs }),
      },
    ];
  });
}

export function normalizeReactions(raw: unknown): PortReaction[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown) => {
    const item = asRecord(entry);
    const key = normalizeKey(item?.["key"]);
    const reaction = asRecord(item?.["reaction"]);
    if (key === undefined || reaction === undefined) {
      return [];
    }
    const reactorKey = normalizeKey(reaction["key"]);
    const reactorId = reactorKey?.participant ?? (reactorKey?.fromMe === true ? undefined : reactorKey?.remoteJid);
    const timestampMs = toNumber(reaction["senderTimestampMs"]);
    return [
      {
        key,
        ...(reactorId === undefined ? {} : { reactorId }),
        emoji: str(reaction["text"]) ?? "",
        ...(timestampMs === undefined ? {} : { timestampMs }),
      },
    ];
  });
}
