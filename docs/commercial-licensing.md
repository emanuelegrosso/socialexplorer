# Commercial licensing, entitlements and payments

Packages: `packages/licensing` (contract, tokens, client), `services/licensing-api` (metadata-only HTTP service and MoR webhook handler). Covers WX-060, WX-061, WX-062.

## Entitlement tiers (schema v1)

|                        | Free   | Personal | Professional |
| ---------------------- | ------ | -------- | ------------ |
| Archive import         | yes    | yes      | yes          |
| Temporal flow          | no     | yes      | yes          |
| Media export           | no     | yes      | yes          |
| Movie export           | no     | no       | yes          |
| Optional connector     | no     | no       | yes          |
| Max archives           | 1      | 5        | 100          |
| Max messages / archive | 50k    | 1M       | 10M          |
| Update channel         | stable | stable   | beta         |
| Devices                | 1      | 2        | 3            |

Definitions live in `PLAN_DEFINITIONS`; the signed payload (`EntitlementPayloadSchema`, strict, `v: 1`) carries plan, features, limits, update channel, `updatesUntil`, `licenseExpiresAt`, `tokenExpiresAt` and `offlineGraceMs`.

## Offline grace and expiry

- Tokens are Ed25519-signed, short lived (default 7 days) and device bound. The client refreshes when online.
- After `tokenExpiresAt` the app stays on paid features for `offlineGraceMs` (default 14 days) so outages do not hurt customers.
- After grace, or after `licenseExpiresAt`, the effective entitlement is Free (`state: "expired"`).
- Tampered, wrong-key, malformed or other-device tokens are treated as Free.
- Updates are gated by `updatesUntil`: older builds keep working forever.
- A server rejection (revoked/expired) drops the stored token; a network error never changes state.

## Privacy invariants

- **Expiry, outage, revocation or tamper never lock, hide or delete local data.** `EffectiveEntitlement.dataAccess` is a frozen constant (`readLocalData`, `exportData`, `deleteLocalData` all `true`); only paid features are gated.
- Requests carry only: licence key, pseudonymous device id (SHA-256 of a random per-install secret, no hardware or user data), app version, platform. All request schemas are strict, so extra fields (chat text, hostnames, file names) are rejected with a generic error that never echoes input.
- The server stores key hashes, plan, status, expiry, opaque MoR references and device hashes only. No names or e-mail addresses; those stay with the Merchant of Record.
- Licence state on the client is stored via a `ProtectedStore`-compatible adapter (`createProtectedLicenseStorage`).

## Merchant of Record evaluation

|                   | Paddle (Billing)                                                      | Lemon Squeezy                                                                           |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Role              | MoR: seller of record, collects and remits VAT/sales tax worldwide    | MoR (Stripe-owned), same model                                                          |
| Invoicing         | Paddle issues invoices and receipts                                   | Lemon Squeezy issues receipts and invoices                                              |
| Webhook signature | `Paddle-Signature: ts=...;h1=HMAC-SHA256(ts:body)` with replay window | `X-Signature: HMAC-SHA256(body)` hex, no timestamp                                      |
| Fit               | Matches our verifier directly                                         | Needs an adapter that supplies the event timestamp; idempotency is covered by event ids |
| Considerations    | Stricter product/vertical review; fees around 5% + 50c                | Simpler onboarding; payouts and fee schedule change as Stripe integrates                |

Recommendation: Paddle as primary (signature scheme and subscriptions map one-to-one), Lemon Squeezy as fallback. The final selection still requires the eligibility/terms review noted in WX-062 (acceptable-use review of a chat-analysis product, fees, payout countries); the code is provider-agnostic via `MorEventSchema`.

VAT/invoicing: the MoR is the seller of record, so it calculates, collects and remits VAT/sales tax and issues customer invoices. We keep no tax data. Our responsibility is the MoR's own reporting of its fees and keeping the refund/cancel mapping correct.

## Webhooks (`POST /v1/webhooks/mor`)

- `verifyWebhookSignature`: HMAC-SHA256 over `<ts>:<raw body>`, constant-time `timingSafeEqual`, 5 minute replay window, multiple secrets for rotation. Header is read from `x-signature`.
- Events (strict `MorEventSchema`): `checkout.completed` issues a licence (key delivered via the injected `onLicenseIssued`, only the hash is stored); `subscription.renewed` extends expiry; `subscription.canceled` stops renewal but keeps access to the paid period end; `subscription.refunded` revokes (clients fall to Free, data untouched).
- Idempotency: each `eventId` is claimed once (`claimEvent`); replays return `duplicate`.

## Service

`GET /health`, `POST /v1/licenses/{activate,refresh,deactivate}`. Deactivate frees a device seat, which is how a licence is transferred. The repository is an interface; `InMemoryLicenseRepository` is provided for tests and local sandboxes. A durable SQL implementation is a deployment-time follow-up. Signing keys come from `generateSigningKeyPair`; only the public key ships in the app.
