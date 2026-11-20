import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { EntitlementPayloadSchema, type EntitlementPayload } from "./entitlement.js";

export type TokenErrorCode = "malformed" | "bad-signature" | "invalid-payload" | "device-mismatch";

export class TokenError extends Error {
  constructor(readonly code: TokenErrorCode) {
    super(`Entitlement token rejected: ${code}`);
    this.name = "TokenError";
  }
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface KeyPairPem {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export function generateSigningKeyPair(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const b64 = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** Token = base64url(canonical payload JSON) "." base64url(Ed25519 signature over those bytes). */
export function signEntitlement(payload: EntitlementPayload, privateKeyPem: string): string {
  const parsed = EntitlementPayloadSchema.parse(payload);
  const body = Buffer.from(canonicalize(parsed), "utf8");
  const signature = sign(null, body, createPrivateKey(privateKeyPem));
  return `${b64(body)}.${b64(signature)}`;
}

export interface VerifyOptions {
  readonly publicKeyPem: string;
  /** When set, the token must be bound to this device. */
  readonly expectedDeviceId?: string;
}

/**
 * Verifies signature, schema, canonical form and device binding. Expiry is NOT a verification
 * failure: use evaluateEntitlement so expired tokens degrade instead of being discarded.
 */
export function verifyEntitlementToken(token: string, options: VerifyOptions): EntitlementPayload {
  const segments = token.split(".");
  const [bodySegment, signatureSegment] = segments;
  if (segments.length !== 2 || !bodySegment || !signatureSegment) {
    throw new TokenError("malformed");
  }
  const body = Buffer.from(bodySegment, "base64url");
  const signature = Buffer.from(signatureSegment, "base64url");
  if (b64(body) !== bodySegment || b64(signature) !== signatureSegment) {
    throw new TokenError("malformed");
  }
  let valid: boolean;
  try {
    valid = verify(null, body, createPublicKey(options.publicKeyPem), signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new TokenError("bad-signature");
  }
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new TokenError("invalid-payload");
  }
  const parsed = EntitlementPayloadSchema.safeParse(json);
  if (!parsed.success || canonicalize(parsed.data) !== body.toString("utf8")) {
    throw new TokenError("invalid-payload");
  }
  if (options.expectedDeviceId !== undefined && parsed.data.deviceId !== options.expectedDeviceId) {
    throw new TokenError("device-mismatch");
  }
  return parsed.data;
}
