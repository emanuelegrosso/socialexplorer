export type SensitivityClass = "identifier" | "content" | "secret" | "public";

const IDENTIFIER_FIELDS = ["remoteId", "jid", "lid", "phone", "participantId", "displayName", "aliases", "title"];
const CONTENT_FIELDS = ["text", "body", "caption", "narrativeText", "note"];
const SECRET_FIELDS = ["token", "credentials", "licenseKey", "qr", "pairingCode", "secret"];

const lookup = new Map<string, SensitivityClass>([
  ...IDENTIFIER_FIELDS.map((f) => [f.toLowerCase(), "identifier"] as const),
  ...CONTENT_FIELDS.map((f) => [f.toLowerCase(), "content"] as const),
  ...SECRET_FIELDS.map((f) => [f.toLowerCase(), "secret"] as const),
]);

export function classifyField(name: string): SensitivityClass {
  return lookup.get(name.toLowerCase()) ?? "public";
}

export function isSensitiveField(name: string): boolean {
  return classifyField(name) !== "public";
}
