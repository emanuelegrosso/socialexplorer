import { describe, expect, it } from "vitest";
import {
  createAppError,
  deterministicId,
  err,
  hashObject,
  isAppError,
  isSensitiveKey,
  maskJid,
  maskPhoneNumber,
  mapResult,
  ok,
  redactText,
  redactValue,
  stableStringify,
  unwrapOr,
} from "./index.js";

describe("result helpers", () => {
  it("maps ok values and passes errors through", () => {
    expect(mapResult(ok(2), (n) => n * 2)).toEqual(ok(4));
    const failure = err(createAppError("NOT_FOUND", "missing"));
    expect(mapResult(failure, (n: number) => n * 2)).toBe(failure);
    expect(unwrapOr(failure, 7)).toBe(7);
    expect(isAppError(failure.error)).toBe(true);
    expect(isAppError("nope")).toBe(false);
  });
});

describe("deterministic hashing", () => {
  it("is stable and key-order independent", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
    expect(hashObject({ x: 1, y: 2 })).toBe(hashObject({ y: 2, x: 1 }));
    expect(deterministicId("msg", ["a", "b"])).toBe(deterministicId("msg", ["a", "b"]));
    expect(deterministicId("msg", ["a", "b"])).not.toBe(deterministicId("msg", ["ab"]));
    expect(deterministicId("msg", ["a"])).toMatch(/^msg_[0-9a-f]{24}$/u);
  });
});

describe("redaction", () => {
  it("masks jids, phones and bearer placeholders in text", () => {
    expect(redactText("user 15551000001@s.whatsapp.net joined")).toBe("user [redacted-jid] joined");
    expect(redactText("call +1 555-0101 now")).toContain("[redacted-phone]");
    expect(redactText("Authorization: Bearer EXAMPLE_TOKEN_1234")).toContain("Bearer [redacted]");
    expect(redactText("group 120363000000000001@g.us")).toContain("[redacted-jid]");
  });

  it("masks sensitive fields and bodies recursively", () => {
    const output = redactValue({
      remoteJid: "15551000001@s.whatsapp.net",
      text: "synthetic body",
      token: "EXAMPLE_TOKEN_1234",
      nested: { credentials: "SYNTHETIC_CREDENTIAL_PLACEHOLDER", count: 3 },
      list: [{ caption: "x" }],
    });
    expect(output).toEqual({
      remoteJid: "[redacted]",
      text: "[redacted]",
      token: "[redacted]",
      nested: { credentials: "[redacted]", count: 3 },
      list: [{ caption: "[redacted]" }],
    });
    expect(isSensitiveKey("phone_number")).toBe(true);
    expect(isSensitiveKey("count")).toBe(false);
  });

  it("masks phone numbers and jids partially", () => {
    expect(maskPhoneNumber("+1 555-0101")).toBe("[redacted-phone:***01]");
    expect(maskJid("15551000001@s.whatsapp.net")).toBe("[redacted-jid]@s.whatsapp.net");
  });
});
