import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const PAYLOAD_VERSION = 1;
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key: Buffer): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("secure_storage_key_invalid_length");
  }
}

/** AES-256-GCM. Layout: version(1) | nonce(12) | ciphertext | tag(16). */
export function encryptPayload(key: Buffer, plaintext: Buffer): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([PAYLOAD_VERSION]), nonce, ciphertext, cipher.getAuthTag()]);
}

export function decryptPayload(key: Buffer, payload: Buffer): Buffer {
  assertKey(key);
  if (payload.byteLength < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error("secure_storage_payload_too_short");
  }
  if (payload[0] !== PAYLOAD_VERSION) {
    throw new Error("secure_storage_payload_version_unsupported");
  }
  const nonce = payload.subarray(1, 1 + NONCE_BYTES);
  const tag = payload.subarray(payload.byteLength - TAG_BYTES);
  const ciphertext = payload.subarray(1 + NONCE_BYTES, payload.byteLength - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
