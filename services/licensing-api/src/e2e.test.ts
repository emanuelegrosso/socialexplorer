import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LicensingClient,
  createFetchTransport,
  createMemoryLicenseStorage,
  generateSigningKeyPair,
  type LicenseStorage,
} from "@social-explorer/licensing";
import {
  InMemoryLicenseRepository,
  LicensingService,
  MorEventSchema,
  WebhookVerificationError,
  createLicensingServer,
  createWebhookHandler,
  signWebhookBody,
  verifyWebhookSignature,
} from "./index.js";

const DAY = 86_400_000;
const SECRET = "whsec_synthetic_test_secret";
const keys = generateSigningKeyPair();

let clock = Date.UTC(2026, 0, 1);
const now = () => clock;

interface Harness {
  readonly baseUrl: string;
  readonly issuedKeys: string[];
  readonly service: LicensingService;
  readonly postWebhook: (
    event: unknown,
    opts?: { secret?: string; ts?: number; body?: string },
  ) => Promise<Response>;
  readonly makeClient: (
    storage?: LicenseStorage,
    transport?: ReturnType<typeof createFetchTransport>,
  ) => LicensingClient;
  readonly server: Server;
}

async function start(): Promise<Harness> {
  clock = Date.UTC(2026, 0, 1);
  const repository = new InMemoryLicenseRepository();
  const service = new LicensingService({ repository, privateKeyPem: keys.privateKeyPem, now });
  const issuedKeys: string[] = [];
  const handle = createWebhookHandler({
    service,
    repository,
    onLicenseIssued: ({ licenseKey }) => {
      issuedKeys.push(licenseKey);
    },
  });
  const server = createLicensingServer({ service, webhook: { secrets: [SECRET], handle }, now });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    baseUrl,
    issuedKeys,
    service,
    server,
    postWebhook: (event, opts = {}) => {
      const body = opts.body ?? JSON.stringify(event);
      return fetch(`${baseUrl}/v1/webhooks/mor`, {
        method: "POST",
        headers: {
          "x-signature": signWebhookBody(
            body,
            opts.secret ?? SECRET,
            opts.ts ?? Math.floor(clock / 1000),
          ),
        },
        body,
      });
    },
    makeClient: (
      storage = createMemoryLicenseStorage(),
      transport = createFetchTransport(baseUrl),
    ) =>
      new LicensingClient({
        transport,
        storage,
        publicKeyPem: keys.publicKeyPem,
        appVersion: "1.0.0",
        platform: "win32",
        now,
      }),
  };
}

const checkout = (over: Record<string, unknown> = {}): unknown => ({
  eventId: "evt_checkout_1",
  type: "checkout.completed",
  plan: "professional",
  subscriptionRef: "sub_synthetic_1",
  customerRef: "ctm_synthetic_1",
  currentPeriodEnd: Date.UTC(2026, 0, 1) + 30 * DAY,
  ...over,
});

describe("webhook signature verification", () => {
  const body = '{"synthetic":true}';
  const base = { rawBody: body, secrets: [SECRET], now: 1_800_000_000_000 };
  const header = signWebhookBody(body, SECRET, 1_800_000_000);
  it("accepts valid signatures, including rotated secrets", () => {
    expect(() => {
      verifyWebhookSignature({ ...base, signatureHeader: header });
    }).not.toThrow();
    expect(() => {
      verifyWebhookSignature({ ...base, secrets: ["old", SECRET], signatureHeader: header });
    }).not.toThrow();
  });
  it("rejects missing, malformed, tampered, wrong-secret and stale signatures", () => {
    const reason = (h: string | undefined, o: object = {}) => {
      try {
        verifyWebhookSignature({ ...base, signatureHeader: h, ...o });
      } catch (e) {
        return (e as WebhookVerificationError).reason;
      }
      return "accepted";
    };
    expect(reason(undefined)).toBe("missing-signature");
    expect(reason("garbage")).toBe("malformed-signature");
    expect(reason(header, { rawBody: body + " " })).toBe("bad-signature");
    expect(reason(header, { secrets: ["other"] })).toBe("bad-signature");
    expect(reason(header, { now: base.now + 10 * 60_000 })).toBe("stale-timestamp");
    expect(reason(header.replace(/h1=./u, "h1=0"))).toBe("bad-signature");
  });
});

describe("sandbox purchase to activation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await start();
  });
  afterEach(async () => {
    await new Promise((resolve) => h.server.close(resolve));
  });

  it("serves /health and rejects unknown routes", async () => {
    expect((await fetch(`${h.baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${h.baseUrl}/nope`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("rejects unsigned and badly signed webhooks without issuing licenses", async () => {
    const unsigned = await fetch(`${h.baseUrl}/v1/webhooks/mor`, {
      method: "POST",
      body: JSON.stringify(checkout()),
    });
    expect(unsigned.status).toBe(401);
    expect((await h.postWebhook(checkout(), { secret: "wrong" })).status).toBe(401);
    expect((await h.postWebhook(checkout(), { ts: Math.floor(clock / 1000) - 3600 })).status).toBe(
      401,
    );
    expect(h.issuedKeys).toHaveLength(0);
  });

  it("rejects events with unexpected fields", async () => {
    expect(
      (await h.postWebhook({ ...(checkout() as object), buyerEmail: "x@example.test" })).status,
    ).toBe(400);
    expect(MorEventSchema.safeParse({ ...(checkout() as object), plan: "free" }).success).toBe(
      false,
    );
  });

  it("runs the full lifecycle: purchase, activate, tamper, offline grace, expiry, data intact", async () => {
    const res = await h.postWebhook(checkout());
    expect(await res.json()).toEqual({ result: "processed" });
    const duplicate = await h.postWebhook(checkout());
    expect(await duplicate.json()).toEqual({ result: "duplicate" });
    expect(h.issuedKeys).toHaveLength(1);

    const storage = createMemoryLicenseStorage();
    const client = h.makeClient(storage);
    const active = await client.activate(h.issuedKeys[0] ?? "");
    expect(active.state).toBe("active");
    expect(active.plan).toBe("professional");
    expect(active.features.movieExport).toBe(true);

    const saved = await storage.load();
    if (!saved) throw new Error("expected stored state");
    const [body, sig] = (saved.token as string).split(".") as [string, string];
    const forged = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    forged["licenseExpiresAt"] = 9_999_999_999_999;
    const tamperedToken = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    await storage.save({ ...saved, token: tamperedToken });
    expect((await client.current()).plan).toBe("free");
    await storage.save(saved);
    expect((await client.current()).plan).toBe("professional");

    const down = h.makeClient(storage, () => Promise.reject(new Error("ECONNREFUSED")));
    clock += 7 * DAY + 1000;
    const grace = await down.refresh();
    expect(grace.kind).toBe("offline");
    expect(grace.entitlement.state).toBe("offline-grace");
    expect(grace.entitlement.plan).toBe("professional");

    clock = Date.UTC(2026, 0, 1) + 29 * DAY;
    const refreshed = await client.refresh();
    expect(refreshed.kind).toBe("refreshed");

    clock = Date.UTC(2026, 0, 1) + 31 * DAY;
    const expired = await client.current();
    expect(expired.state).toBe("expired");
    expect(expired.plan).toBe("free");
    expect(expired.features.movieExport).toBe(false);
    expect(expired.dataAccess).toEqual({
      readLocalData: true,
      exportData: true,
      deleteLocalData: true,
    });

    const rejected = await client.refresh();
    expect(rejected).toMatchObject({ kind: "rejected", code: "license_expired" });
    expect(rejected.entitlement.dataAccess.readLocalData).toBe(true);
  });

  it("renewal extends expiry; cancel keeps period; refund revokes", async () => {
    await h.postWebhook(checkout());
    const client = h.makeClient();
    await client.activate(h.issuedKeys[0] ?? "");

    const newEnd = Date.UTC(2026, 0, 1) + 60 * DAY;
    await h.postWebhook({
      eventId: "evt_renew_1",
      type: "subscription.renewed",
      subscriptionRef: "sub_synthetic_1",
      currentPeriodEnd: newEnd,
    });
    clock = Date.UTC(2026, 0, 1) + 40 * DAY;
    expect((await client.refresh()).kind).toBe("refreshed");

    const canceled = await h.postWebhook({
      eventId: "evt_cancel_1",
      type: "subscription.canceled",
      subscriptionRef: "sub_synthetic_1",
    });
    expect(await canceled.json()).toEqual({ result: "processed" });
    expect((await client.refresh()).kind).toBe("refreshed");

    await h.postWebhook({
      eventId: "evt_refund_1",
      type: "subscription.refunded",
      subscriptionRef: "sub_synthetic_1",
    });
    const out = await client.refresh();
    expect(out).toMatchObject({ kind: "rejected", code: "license_revoked" });
    expect(out.entitlement.plan).toBe("free");
    expect(out.entitlement.dataAccess.exportData).toBe(true);

    const unknown = await h.postWebhook({
      eventId: "evt_x",
      type: "subscription.refunded",
      subscriptionRef: "sub_missing",
    });
    expect(await unknown.json()).toEqual({ result: "ignored" });
  });

  it("enforces device limits and supports transfer via deactivate", async () => {
    await h.postWebhook(checkout({ plan: "personal" }));
    const key = h.issuedKeys[0] ?? "";
    const a = h.makeClient();
    const b = h.makeClient();
    const c = h.makeClient();
    await a.activate(key);
    await b.activate(key);
    await expect(c.activate(key)).rejects.toThrow(/device_limit_reached/u);
    await a.deactivate();
    expect((await a.current()).plan).toBe("free");
    expect((await c.activate(key)).plan).toBe("personal");
  });

  it("rejects chat data or extra fields sent to licensing endpoints", async () => {
    const device = await h.makeClient().getDeviceId();
    const post = (path: string, body: unknown) =>
      fetch(`${h.baseUrl}${path}`, { method: "POST", body: JSON.stringify(body) });
    const bad = await post("/v1/licenses/activate", {
      licenseKey: "SE-AAAAA-BBBBB-CCCCC-DDDDD",
      deviceId: device,
      appVersion: "1.0.0",
      platform: "win32",
      chat: "synthetic message text",
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("synthetic message");
    expect((await post("/v1/licenses/refresh", "not-an-object")).status).toBe(400);
    const big = await fetch(`${h.baseUrl}/v1/licenses/activate`, {
      method: "POST",
      body: "x".repeat(40_000),
    });
    expect([413, 400]).toContain(big.status);
    const unknownKey = await post("/v1/licenses/activate", {
      licenseKey: "SE-AAAAA-BBBBB-CCCCC-DDDDD",
      deviceId: device,
      appVersion: "1.0.0",
      platform: "win32",
    });
    expect(unknownKey.status).toBe(404);
  });
});
