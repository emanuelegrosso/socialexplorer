import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload, PAYLOAD_VERSION } from "./crypto.js";

describe("AES-256-GCM payloads", () => {
  const key = randomBytes(32);

  it("round-trips and uses a fresh nonce each time", () => {
    const plaintext = Buffer.from("synthetic secret");
    const a = encryptPayload(key, plaintext);
    const b = encryptPayload(key, plaintext);
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(PAYLOAD_VERSION);
    expect(a.includes(plaintext)).toBe(false);
    expect(decryptPayload(key, a).equals(plaintext)).toBe(true);
  });

  it("round-trips empty payloads", () => {
    expect(decryptPayload(key, encryptPayload(key, Buffer.alloc(0))).byteLength).toBe(0);
  });

  it("rejects tampering, wrong keys, short and unversioned payloads", () => {
    const payload = encryptPayload(key, Buffer.from("data"));
    const tampered = Buffer.from(payload);
    tampered[14] = (tampered[14] ?? 0) ^ 0xff;
    expect(() => decryptPayload(key, tampered)).toThrow();
    expect(() => decryptPayload(randomBytes(32), payload)).toThrow();
    expect(() => decryptPayload(key, Buffer.alloc(5))).toThrow("secure_storage_payload_too_short");
    const wrongVersion = Buffer.from(payload);
    wrongVersion[0] = 9;
    expect(() => decryptPayload(key, wrongVersion)).toThrow(
      "secure_storage_payload_version_unsupported",
    );
  });

  it("requires a 32-byte key", () => {
    expect(() => encryptPayload(Buffer.alloc(16), Buffer.from("x"))).toThrow(
      "secure_storage_key_invalid_length",
    );
  });
});
