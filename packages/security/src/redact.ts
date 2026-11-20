import { redactText as baseRedactText, REDACTION_MASK } from "@social-explorer/shared";

const QR_PAYLOAD = /\b\d@[A-Za-z0-9+/=_-]{16,}(?:,[A-Za-z0-9+/=_-]{8,}){2,}/gu;
const PAIRING_CODE = /(pairing[\s_-]*code\W{0,4})[A-Z0-9]{4}-?[A-Z0-9]{4}\b/giu;
const KEY_VALUE_SECRET = /\b(token|secret|password|passphrase|api[_-]?key)=\S+/giu;
const SENSITIVE_KEY_FRAGMENTS = [
  "pairing",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "creds",
  "authorization",
  "privatekey",
  "apikey",
  "licensekey",
  "cookie",
  "msisdn",
  "caption",
  "pushname",
  "displayname",
  "narrative",
] as const;

const SENSITIVE_EXACT_KEYS = new Set([
  "qr",
  "qrcode",
  "qrpayload",
  "jid",
  "lid",
  "remotejid",
  "participantjid",
  "phone",
  "phonenumber",
  "body",
  "text",
  "textpreview",
  "aliases",
  "key",
  "keys",
  "auth",
]);

export { REDACTION_MASK };

export function redactText(value: string): string {
  return baseRedactText(
    value
      .replace(QR_PAYLOAD, "[redacted-qr]")
      .replace(PAIRING_CODE, "$1[redacted-pairing-code]")
      .replace(KEY_VALUE_SECRET, "$1=[redacted]"),
  );
}

export function isSensitiveLogKey(key: string): boolean {
  const normalized = key.replace(/[_\-\s]/gu, "").toLowerCase();
  if (SENSITIVE_EXACT_KEYS.has(normalized) || normalized.endsWith("key")) {
    return true;
  }
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth > 8) {
    return REDACTION_MASK;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return REDACTION_MASK;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = isSensitiveLogKey(key) ? REDACTION_MASK : redactLogValue(nested, depth + 1);
    }
    return output;
  }
  return REDACTION_MASK;
}
