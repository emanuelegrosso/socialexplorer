import type { ChatKind, ContactIdentifier } from "@social-explorer/contracts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const JID_SERVERS = new Set(["s.whatsapp.net", "hosted"]);
const LID_SERVERS = new Set(["lid", "hosted.lid"]);

export interface ParsedJid {
  readonly user: string;
  readonly server: string;
  readonly device?: number;
}

export function parseJid(value: string): ParsedJid | undefined {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || /\s/u.test(value)) {
    return undefined;
  }
  const local = value.slice(0, at);
  const server = value.slice(at + 1);
  const pieces = local.split(":");
  const user = pieces[0];
  if (user === undefined || !NAME_PATTERN.test(user) || !NAME_PATTERN.test(server)) {
    return undefined;
  }
  if (pieces.length > 2) {
    return undefined;
  }
  if (pieces.length === 2) {
    const device = pieces[1];
    if (device === undefined || !/^\d+$/u.test(device)) {
      return undefined;
    }
    return { user, server, device: Number(device) };
  }
  return { user, server };
}

export function classifyJidChat(value: string): ChatKind | undefined {
  const parsed = parseJid(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed.server === "g.us") {
    return "group";
  }
  if (JID_SERVERS.has(parsed.server) || LID_SERVERS.has(parsed.server)) {
    return "private";
  }
  return "other";
}

export function classifyIdentifierType(value: string): "jid" | "lid" | undefined {
  const parsed = parseJid(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (JID_SERVERS.has(parsed.server)) {
    return "jid";
  }
  if (LID_SERVERS.has(parsed.server)) {
    return "lid";
  }
  return undefined;
}

/** Strips the device suffix so one account maps to one stable identifier key. */
export function normalizeJid(value: string): string | undefined {
  const parsed = parseJid(value);
  if (parsed === undefined) {
    return undefined;
  }
  return `${parsed.user}@${parsed.server}`;
}

/** Returns E.164-like `+digits` or undefined when the value is not a plausible phone number. */
export function normalizePhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/u.test(trimmed)) {
    return undefined;
  }
  const digits = trimmed.replace(/\D/gu, "");
  if (digits.length < 7 || digits.length > 15) {
    return undefined;
  }
  return `+${digits}`;
}

export function normalizeExportName(value: string): string {
  return value
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ");
}

export function classifyIdentifier(
  value: string,
): Pick<ContactIdentifier, "type" | "value"> {
  const jidType = classifyIdentifierType(value);
  if (jidType !== undefined) {
    return { type: jidType, value: normalizeJid(value) ?? value };
  }
  const phone = normalizePhone(value);
  if (phone !== undefined) {
    return { type: "phone", value: phone };
  }
  return { type: "other", value: value.trim() };
}

export function identifierKey(identifier: Pick<ContactIdentifier, "type" | "value">): string {
  return `${identifier.type}\u001f${identifier.value}`;
}
