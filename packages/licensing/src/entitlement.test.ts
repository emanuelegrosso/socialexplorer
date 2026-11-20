import { describe, expect, it } from "vitest";
import {
  DATA_ACCESS,
  PLAN_DEFINITIONS,
  PlanSchema,
  TokenError,
  buildEntitlementPayload,
  canonicalize,
  deriveDeviceId,
  evaluateEntitlement,
  freeEntitlement,
  generateInstallSecret,
  generateSigningKeyPair,
  isFeatureEnabled,
  isUpdateEligible,
  signEntitlement,
  verifyEntitlementToken,
  ActivateRequestSchema,
  EntitlementPayloadSchema,
} from "./index.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 1);
const keys = generateSigningKeyPair();
const deviceId = deriveDeviceId("synthetic-install-secret");

function payload(plan: "free" | "personal" | "professional" = "professional") {
  return buildEntitlementPayload({
    licenseId: "lic_synthetic1",
    deviceId,
    plan,
    now: NOW,
    licenseExpiresAt: NOW + 365 * DAY,
    tokenTtlMs: 7 * DAY,
    offlineGraceMs: 14 * DAY,
    updatesUntil: NOW + 365 * DAY,
  });
}

describe("plans", () => {
  it("defines the three plans with escalating features", () => {
    expect(PlanSchema.options).toEqual(["free", "personal", "professional"]);
    expect(PLAN_DEFINITIONS.free.features.movieExport).toBe(false);
    expect(PLAN_DEFINITIONS.professional.features.optionalConnector).toBe(true);
    expect(PLAN_DEFINITIONS.personal.limits.maxArchives).toBeGreaterThan(
      PLAN_DEFINITIONS.free.limits.maxArchives,
    );
  });
});

describe("entitlement evaluation", () => {
  const p = payload();
  it("is active before token expiry", () => {
    const e = evaluateEntitlement(p, NOW + DAY);
    expect(e.state).toBe("active");
    expect(isFeatureEnabled(e, "movieExport")).toBe(true);
  });
  it("keeps paid features during offline grace", () => {
    const e = evaluateEntitlement(p, NOW + 7 * DAY + 5 * DAY);
    expect(e.state).toBe("offline-grace");
    expect(e.plan).toBe("professional");
  });
  it("degrades to Free after grace without locking data", () => {
    const e = evaluateEntitlement(p, NOW + 7 * DAY + 15 * DAY);
    expect(e.state).toBe("expired");
    expect(e.plan).toBe("free");
    expect(isFeatureEnabled(e, "movieExport")).toBe(false);
    expect(e.dataAccess).toEqual({ readLocalData: true, exportData: true, deleteLocalData: true });
  });
  it("degrades after licence expiry regardless of token", () => {
    const short = { ...p, licenseExpiresAt: NOW + 2 * DAY, tokenExpiresAt: NOW + 2 * DAY };
    expect(evaluateEntitlement(short, NOW + 3 * DAY).plan).toBe("free");
  });
  it("data access is invariant across every state and far-future times", () => {
    for (const t of [0, NOW, NOW + 10 * DAY, NOW + 10_000 * DAY]) {
      expect(evaluateEntitlement(p, t).dataAccess).toBe(DATA_ACCESS);
    }
    expect(freeEntitlement().dataAccess).toBe(DATA_ACCESS);
    expect(Object.isFrozen(DATA_ACCESS)).toBe(true);
  });
  it("update eligibility survives expiry for older releases only", () => {
    const e = evaluateEntitlement(p, NOW + 1000 * DAY);
    expect(isUpdateEligible(e, NOW + 100 * DAY)).toBe(true);
    expect(isUpdateEligible(e, NOW + 500 * DAY)).toBe(false);
    expect(isUpdateEligible(freeEntitlement(), NOW)).toBe(false);
  });
  it("rejects unknown payload fields", () => {
    expect(EntitlementPayloadSchema.safeParse({ ...p, email: "a@example.test" }).success).toBe(
      false,
    );
  });
});

describe("signed tokens", () => {
  const token = signEntitlement(payload(), keys.privateKeyPem);
  it("round-trips and binds to device", () => {
    expect(
      verifyEntitlementToken(token, { publicKeyPem: keys.publicKeyPem, expectedDeviceId: deviceId })
        .plan,
    ).toBe("professional");
  });
  it("canonicalizes key order", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[1,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });
  it("rejects tampered payload", () => {
    const [body, sig] = token.split(".") as [string, string];
    const forged = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    forged["plan"] = "free";
    const tampered = `${Buffer.from(canonicalize(forged)).toString("base64url")}.${sig}`;
    expect(() => verifyEntitlementToken(tampered, { publicKeyPem: keys.publicKeyPem })).toThrow(
      TokenError,
    );
  });
  it("rejects wrong key, truncated, and garbage tokens", () => {
    const other = generateSigningKeyPair();
    expect(() => verifyEntitlementToken(token, { publicKeyPem: other.publicKeyPem })).toThrow(
      /bad-signature/u,
    );
    expect(() =>
      verifyEntitlementToken(token.slice(0, -4), { publicKeyPem: keys.publicKeyPem }),
    ).toThrow(TokenError);
    expect(() => verifyEntitlementToken("nope", { publicKeyPem: keys.publicKeyPem })).toThrow(
      /malformed/u,
    );
  });
  it("rejects device mismatch", () => {
    expect(() =>
      verifyEntitlementToken(token, {
        publicKeyPem: keys.publicKeyPem,
        expectedDeviceId: deriveDeviceId("other"),
      }),
    ).toThrow(/device-mismatch/u);
  });
});

describe("privacy", () => {
  it("device ids are pseudonymous hashes", () => {
    const secret = generateInstallSecret();
    expect(deriveDeviceId(secret)).toMatch(/^[a-f0-9]{64}$/u);
    expect(deriveDeviceId(secret)).not.toContain(secret);
  });
  it("request schema rejects chat or extra data", () => {
    const base = {
      licenseKey: "SE-AAAAA-BBBBB-CCCCC-DDDDD",
      deviceId: deviceId,
      appVersion: "1.0.0",
      platform: "win32",
    };
    expect(ActivateRequestSchema.safeParse(base).success).toBe(true);
    expect(
      ActivateRequestSchema.safeParse({ ...base, messages: ["synthetic hello"] }).success,
    ).toBe(false);
    expect(ActivateRequestSchema.safeParse({ ...base, hostname: "synthetic-pc" }).success).toBe(
      false,
    );
  });
});
