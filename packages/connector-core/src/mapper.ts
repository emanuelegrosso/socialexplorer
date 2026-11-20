import type {
  PortChat,
  PortContact,
  PortGroup,
  PortMessage,
  PortReaction,
} from "@social-explorer/baileys-adapter";
import { deterministicId, fnv1a64Hex } from "@social-explorer/shared";
import type {
  Contact,
  Conversation,
  ConversationParticipant,
  Message,
  MessageReaction,
} from "./ingestion-types.js";

export interface MapperOptions {
  readonly datasetId: string;
  readonly timezone: string;
}

type Source = "baileys-history" | "baileys-live";

const SOURCE_LABEL = "baileys-connector";

export function normalizeJid(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) {
    return jid;
  }
  const local = jid.slice(0, at).split(":")[0] ?? "";
  return `${local}@${jid.slice(at + 1)}`;
}

function localPart(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}

function identifierType(jid: string): "jid" | "lid" | "other" {
  if (jid.endsWith("@lid") || jid.endsWith("@hosted.lid")) {
    return "lid";
  }
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@hosted")) {
    return "jid";
  }
  return "other";
}

function toUtcIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function toLocalWallClock(timestampMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

/** Maps normalized port events to canonical contract records with deterministic, idempotent ids. */
export class CanonicalMapper {
  private selfJid: string | undefined;
  private readonly chatNames = new Map<string, string>();

  constructor(private readonly options: MapperOptions) {}

  get datasetId(): string {
    return this.options.datasetId;
  }

  setSelfJid(jid: string | undefined): void {
    this.selfJid = jid === undefined ? undefined : normalizeJid(jid);
  }

  conversationId(remoteJid: string): string {
    return deterministicId("conv", [this.options.datasetId, normalizeJid(remoteJid)]);
  }

  contactIdFor(jid: string): string {
    const normalized = normalizeJid(jid);
    return deterministicId("contact", [this.options.datasetId, identifierType(normalized), normalized]);
  }

  selfContactId(): string {
    return this.selfJid === undefined
      ? deterministicId("contact", [this.options.datasetId, "other", "self"])
      : this.contactIdFor(this.selfJid);
  }

  messageId(remoteJid: string, sourceMessageId: string): string {
    return deterministicId("msg", [
      this.options.datasetId,
      this.conversationId(remoteJid),
      `wa:${sourceMessageId}`,
    ]);
  }

  reactionId(messageId: string, reactorKey: string): string {
    return deterministicId("react", [messageId, reactorKey]);
  }

  private provenance(locator: string): string {
    const sourceId = deterministicId("source", [this.options.datasetId, SOURCE_LABEL]);
    return deterministicId("prov", [this.options.datasetId, sourceId, locator]);
  }

  rememberChatName(jid: string, name: string | undefined): void {
    if (name !== undefined && name.length > 0) {
      this.chatNames.set(normalizeJid(jid), name);
    }
  }

  conversation(remoteJid: string): Conversation {
    const jid = normalizeJid(remoteJid);
    const kind = jid.endsWith("@g.us")
      ? "group"
      : identifierType(jid) === "other"
        ? "other"
        : "private";
    return {
      id: this.conversationId(jid),
      datasetId: this.options.datasetId,
      sourceConversationId: jid,
      title: this.chatNames.get(jid) ?? localPart(jid),
      kind,
    };
  }

  mapChat(chat: PortChat): Conversation {
    this.rememberChatName(chat.id, chat.name);
    return this.conversation(chat.id);
  }

  mapGroup(group: PortGroup): {
    conversation: Conversation;
    contacts: Contact[];
    participants: ConversationParticipant[];
  } {
    this.rememberChatName(group.id, group.subject);
    const conversation = this.conversation(group.id);
    const ids = group.participantIds ?? [];
    return {
      conversation,
      contacts: ids.map((id) => this.placeholderContact(id, undefined)),
      participants: ids.map((id) => ({
        conversationId: conversation.id,
        contactId: this.contactIdFor(id),
        confidence: "confirmed" as const,
      })),
    };
  }

  placeholderContact(jid: string, name: string | undefined): Contact {
    const normalized = normalizeJid(jid);
    const type = identifierType(normalized);
    const id = this.contactIdFor(normalized);
    const isSelf = id === this.selfContactId() && this.selfJid !== undefined;
    return {
      id,
      displayName: name ?? localPart(normalized),
      aliases: [],
      identifiers: [{ type, value: normalized, confidence: "confirmed" }],
      isSelf,
      colorKey: `color-${String(parseInt(fnv1a64Hex(id).slice(0, 4), 16) % 12)}`,
    };
  }

  mapContact(contact: PortContact): Contact {
    const primary = contact.phoneNumberJid ?? contact.id;
    const display = contact.name ?? contact.notify ?? localPart(primary);
    const aliases = [contact.notify, contact.name].filter(
      (alias): alias is string => alias !== undefined && alias !== display,
    );
    const identifiers = new Map<string, Contact["identifiers"][number]>();
    for (const jid of [contact.id, contact.phoneNumberJid, contact.lid]) {
      if (jid !== undefined) {
        const normalized = normalizeJid(jid);
        identifiers.set(normalized, {
          type: identifierType(normalized),
          value: normalized,
          confidence: "confirmed",
        });
      }
    }
    const base = this.placeholderContact(primary, display);
    return { ...base, aliases: [...new Set(aliases)], identifiers: [...identifiers.values()] };
  }

  mapMessage(
    message: PortMessage,
    source: Source,
  ): { message: Message; conversation: Conversation; contact?: Contact; participant?: ConversationParticipant } {
    const conversation = this.conversation(message.key.remoteJid);
    const isGroup = conversation.kind === "group";
    const senderJid = message.key.fromMe
      ? undefined
      : isGroup
        ? message.key.participant
        : message.key.remoteJid;
    const senderContactId = message.key.fromMe
      ? this.selfContactId()
      : senderJid === undefined
        ? undefined
        : this.contactIdFor(senderJid);
    const contact =
      senderJid === undefined
        ? undefined
        : this.placeholderContact(senderJid, message.pushName);
    const id = this.messageId(message.key.remoteJid, message.key.id);
    const timestampIso = toUtcIso(message.timestampMs);
    const canonical: Message = {
      id,
      datasetId: this.options.datasetId,
      conversationId: conversation.id,
      sourceMessageId: message.key.id,
      ...(senderContactId === undefined ? {} : { senderContactId }),
      timestampUtc: timestampIso,
      timestampLocal: toLocalWallClock(message.timestampMs, this.options.timezone),
      timezone: this.options.timezone,
      direction: message.key.fromMe ? "outgoing" : "incoming",
      kind: message.kind,
      ...(message.text === undefined ? {} : { text: message.text }),
      hasAttachment: message.hasAttachment,
      sourceKind: source,
      parseStatus: "complete",
      provenanceId: this.provenance(`msg:${message.key.id}`),
    };
    const participantContactId = senderContactId;
    return {
      message: canonical,
      conversation,
      ...(contact === undefined ? {} : { contact }),
      ...(participantContactId === undefined
        ? {}
        : {
            participant: {
              conversationId: conversation.id,
              contactId: participantContactId,
              firstSeenAt: timestampIso,
              lastSeenAt: timestampIso,
              confidence: "confirmed" as const,
            },
          }),
    };
  }

  mapReaction(reaction: PortReaction): { reaction?: MessageReaction; removedId?: string; messageId: string } {
    const messageId = this.messageId(reaction.key.remoteJid, reaction.key.id);
    const reactorJid = reaction.reactorId;
    const reactorKey = reactorJid === undefined ? "self" : normalizeJid(reactorJid);
    const id = this.reactionId(messageId, reactorKey);
    if (reaction.emoji === "") {
      return { removedId: id, messageId };
    }
    return {
      messageId,
      reaction: {
        id,
        messageId,
        ...(reactorJid === undefined
          ? { reactorContactId: this.selfContactId() }
          : { reactorContactId: this.contactIdFor(reactorJid) }),
        emoji: reaction.emoji,
        ...(reaction.timestampMs === undefined ? {} : { reactedAtUtc: toUtcIso(reaction.timestampMs) }),
        provenanceId: this.provenance(`react:${id}`),
      },
    };
  }
}
