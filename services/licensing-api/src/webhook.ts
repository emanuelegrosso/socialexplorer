import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { LicenseRepository } from "./repository.js";
import type { LicensingService } from "./service.js";

export class WebhookVerificationError extends Error {
  constructor(
    readonly reason:
      "missing-signature" | "malformed-signature" | "stale-timestamp" | "bad-signature",
  ) {
    super(`Webhook rejected: ${reason}`);
    this.name = "WebhookVerificationError";
  }
}

export interface VerifyWebhookOptions {
  readonly rawBody: string;
  readonly signatureHeader: string | undefined;
  /** Accepts several secrets to support rotation. */
  readonly secrets: readonly string[];
  readonly now: number;
  readonly toleranceMs?: number;
}

/**
 * Paddle-style scheme: header `ts=<unix seconds>;h1=<hex hmac-sha256>` where the MAC covers
 * `<ts>:<raw body>`. `t=`/`v1=` aliases (comma or semicolon separated) are also accepted.
 * Lemon Squeezy signs only the body (hex `X-Signature`); an adapter can wrap it by supplying the
 * event timestamp as `ts` - see docs/commercial-licensing.md.
 */
export function verifyWebhookSignature(options: VerifyWebhookOptions): void {
  const header = options.signatureHeader;
  if (header === undefined || header.length === 0) {
    throw new WebhookVerificationError("missing-signature");
  }
  let ts: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(/[;,]/u)) {
    const [rawKey, rawValue] = part.trim().split("=");
    const key = rawKey?.toLowerCase();
    if ((key === "ts" || key === "t") && rawValue) {
      ts = rawValue;
    } else if ((key === "h1" || key === "v1") && rawValue) {
      signatures.push(rawValue);
    }
  }
  if (ts === undefined || !/^\d{1,12}$/u.test(ts) || signatures.length === 0) {
    throw new WebhookVerificationError("malformed-signature");
  }
  const tolerance = options.toleranceMs ?? 5 * 60_000;
  if (Math.abs(options.now - Number(ts) * 1000) > tolerance) {
    throw new WebhookVerificationError("stale-timestamp");
  }
  const matches = options.secrets.some((secret) => {
    const expected = createHmac("sha256", secret)
      .update(ts + ":" + options.rawBody)
      .digest();
    return signatures.some((candidate) => {
      const given = Buffer.from(candidate, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  });
  if (!matches) {
    throw new WebhookVerificationError("bad-signature");
  }
}

export function signWebhookBody(rawBody: string, secret: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret)
    .update(String(timestampSeconds) + ":" + rawBody)
    .digest("hex");
  return `ts=${String(timestampSeconds)};h1=${mac}`;
}

const Ref = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/u);

/** Provider-agnostic event; provider adapters map their payloads onto this shape. */
export const MorEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    eventId: Ref,
    type: z.literal("checkout.completed"),
    plan: z.enum(["personal", "professional"]),
    subscriptionRef: Ref,
    customerRef: Ref,
    currentPeriodEnd: z.number().int().positive(),
  }),
  z.strictObject({
    eventId: Ref,
    type: z.literal("subscription.renewed"),
    subscriptionRef: Ref,
    currentPeriodEnd: z.number().int().positive(),
  }),
  z.strictObject({ eventId: Ref, type: z.literal("subscription.refunded"), subscriptionRef: Ref }),
  z.strictObject({ eventId: Ref, type: z.literal("subscription.canceled"), subscriptionRef: Ref }),
]);
export type MorEvent = z.infer<typeof MorEventSchema>;

export type WebhookResult = "processed" | "duplicate" | "ignored";

export interface WebhookHandlerOptions {
  readonly service: LicensingService;
  readonly repository: LicenseRepository;
  /** Delivers a freshly issued key to the buyer (e.g. via MoR fulfilment e-mail). Never logged. */
  readonly onLicenseIssued: (issued: {
    licenseKey: string;
    subscriptionRef: string;
    customerRef: string;
  }) => Promise<void> | void;
}

export function createWebhookHandler(
  options: WebhookHandlerOptions,
): (event: MorEvent) => Promise<WebhookResult> {
  return async (event) => {
    if (!(await options.repository.claimEvent(event.eventId))) {
      return "duplicate";
    }
    switch (event.type) {
      case "checkout.completed": {
        if (await options.repository.findBySubscriptionRef(event.subscriptionRef)) {
          return "duplicate";
        }
        const { licenseKey } = await options.service.issueLicense({
          plan: event.plan,
          subscriptionRef: event.subscriptionRef,
          customerRef: event.customerRef,
          expiresAt: event.currentPeriodEnd,
        });
        await options.onLicenseIssued({
          licenseKey,
          subscriptionRef: event.subscriptionRef,
          customerRef: event.customerRef,
        });
        return "processed";
      }
      case "subscription.renewed":
        return (await options.service.extend(event.subscriptionRef, event.currentPeriodEnd))
          ? "processed"
          : "ignored";
      case "subscription.canceled":
        return (await options.service.cancel(event.subscriptionRef)) ? "processed" : "ignored";
      case "subscription.refunded":
        return (await options.service.revoke(event.subscriptionRef)) ? "processed" : "ignored";
    }
  };
}
