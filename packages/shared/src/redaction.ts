const MASK = "[redacted]";

const JID_PATTERN =
  /[A-Za-z0-9._+-]+(?::\d+)?@(?:s\.whatsapp\.net|g\.us|lid|hosted(?:\.lid)?|broadcast|newsletter)/gu;
const BEARER_PATTERN = /Bearer\s+\S+/giu;
const PHONE_PATTERN = /(?<![\w.])\+\d[\d\s().-]{6,17}\d/gu;
const LONG_HEX_PATTERN = /\b[a-f0-9]{32,}\b/giu;

const SECRET_KEY_PATTERN =
  /^(qr|pairingcode|token|accesstoken|apitoken|secret|password|passphrase|authorization|creds|credential|credentials|privatekey|licensekey)$/iu;

const SENSITIVE_FIELD_NAMES = new Set([
  "remotejid",
  "participantjid",
  "jid",
  "lid",
  "phone",
  "phonenumber",
  "text",
  "body",
  "textpreview",
  "caption",
  "displayname",
  "pushname",
  "aliases",
  "title",
  "narrativetext",
]);

export const REDACTION_MASK = MASK;

export function maskPhoneNumber(value: string): string {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 4) {
    return "[redacted-phone]";
  }
  return `[redacted-phone:***${digits.slice(-2)}]`;
}

export function maskJid(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) {
    return "[redacted-jid]";
  }
  return `[redacted-jid]@${value.slice(at + 1)}`;
}

export function redactText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(JID_PATTERN, "[redacted-jid]")
    .replace(PHONE_PATTERN, "[redacted-phone]")
    .replace(LONG_HEX_PATTERN, "[redacted-hex]");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_-]/gu, "").toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(normalized) || SECRET_KEY_PATTERN.test(normalized);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? MASK : redactValue(nested);
    }
    return output;
  }
  return MASK;
}
