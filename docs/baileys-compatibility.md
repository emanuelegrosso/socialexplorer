# Baileys compatibility and isolation (WX-050)

## Pinned version

| Package | Version | npm tag (verified 2026-11-20) |
| --- | --- | --- |
| `@whiskeysockets/baileys` | **7.0.0-rc14** | `latest` |
| Legacy stable line | 6.7.24 | `legacy` (not used) |

There is no published stable `7.0.0` yet. `7.0.0-rc14` is the current npm `latest` release and is what `@social-explorer/baileys-adapter` pins in `package.json`. `6.7.24` depends on a git-hosted `libsignal` build that pnpm blocks under `blockExoticSubdeps`; `7.0.0-rc14` uses npm `libsignal` (^6.0.0).

## Adapter boundary (`@social-explorer/baileys-adapter`)

The adapter is the **only** package that imports Baileys. Downstream code uses:

- `BaileysSocketPort` — read-only surface: `onEvent`, `requestPairingCode`, `close`, `logout`.
- `MockSocketPort` — deterministic test double (no network).
- Normalized `PortEvent` types — no protobuf, no media ciphertext, no write APIs.

**Explicitly not exposed:** `sendMessage`, presence/read receipts, profile/group mutations, history fetch triggers, or any other write/modify API. Static tests scan adapter sources and assert the `BaileysSocketLike` slice has no send capability.

Socket defaults (read-only posture):

- `markOnlineOnConnect: false`
- `syncFullHistory: false`
- `emitOwnEvents: false`
- `generateHighQualityLinkPreview: false`
- Silent logger (no QR printed to stderr)

## Verified Baileys 7.x API / event signatures

Compared against installed `lib/*.d.ts` for `7.0.0-rc14` (not copied from 6.x examples):

| Area | Verified shape |
| --- | --- |
| Factory | `makeWASocket(config)` default export; `auth` required on `UserFacingSocketConfig` |
| Lifecycle | `sock.ev.process(handler)`; `sock.end(error)`; `sock.logout()`; `sock.requestPairingCode(phone)` |
| DisconnectReason | `loggedOut = 401`, `restartRequired = 515`, `connectionReplaced = 440` |
| History | `messaging-history.set` — `chats`, `contacts`, `messages`, optional `progress`, `isLatest`, `syncType`, `chunkOrder` |
| History status | `messaging-history.status` — `{ syncType, status: 'complete' \| 'paused', explicit: boolean }` |
| Live | `messages.upsert` — `type: 'append' \| 'notify'` only (no `history` upsert type) |
| Updates | `messages.update`, `messages.delete`, `messages.reaction` |
| Chats / contacts / groups | `chats.*`, `contacts.*`, `groups.*`, `lid-mapping.update` |
| Pairing | `connection.update` may include `qr`; pairing code via `requestPairingCode` |

`messages.upsert.type` is only `append` or `notify`; bulk history arrives via `messaging-history.set`.

## Connector stack (`@social-explorer/connector-core`)

- **IPC:** Zod-validated discriminated unions (`protocol.ts`); no generic command execution.
- **Supervisor:** `child_process.fork` of `dist/worker-entry.js`; heartbeat, bounded restart, graceful shutdown.
- **Auth:** `ProtectedAuthState` → `@social-explorer/security` `ProtectedStore` only (never SQLite/renderer/logs).
- **Ingestion:** `ConnectorIngestionSink` + canonical batches; Wave 4 SQLite plugs in here.
- **Feature flag:** `connectorEnabled: false` by default (`parseConnectorConfig`).

## CI / testing

All connector and adapter tests use **synthetic fixtures** only (`fixtures/synthetic/connector-port-events.json`, `fixtures/synthetic/connector-events.json`). No live WhatsApp network calls in CI.

## Technical risks

| Risk | Mitigation |
| --- | --- |
| Pre-release dependency (`7.0.0-rc14`) | Pinned exact version; `compat.test.ts` type guards against drift; document upgrade path when stable 7.x ships |
| Baileys API churn | Events normalized in adapter; connector depends on port types, not protobuf |
| Child-process IPC | Strict schemas; invalid child messages trigger protocol-violation recovery |
| History coverage | `messaging-history.status` with `explicit: false` surfaced as partial coverage warning |
| LID / JID mapping | `lid-mapping.update` mapped to contact identifiers; resolver gaps possible |
| `syncFullHistory: false` | May limit how much server-pushed history arrives until deliberately enabled and verified |
| Node native / WA bridge transitive deps | `whatsapp-rust-bridge` pulled by Baileys; monitor ABI and supply chain on packaging (WX-063) |

## Legal and release-gate risks

| Topic | Notes |
| --- | --- |
| WhatsApp Terms of Service | Unofficial clients and automated access may violate Meta/WhatsApp terms. The connector is **optional**, **disabled by default**, and **read-only** in this stack, but legal review is still required before any production pairing (WX-071). |
| User consent | Pairing must be an explicit user action; no silent cloud sync. |
| Data minimization | Adapter strips payloads to metadata needed for archive visualization; no outbound messaging API. |
| AGPL / library licenses | Review Baileys and transitive licenses before retail distribution. |
| Release gate | Do not enable `connectorEnabled` in retail builds until compatibility note, threat model, and legal sign-off are recorded. |

## Upgrade checklist

1. Check npm for new `7.0.0` stable or newer `rc`.
2. Run `packages/baileys-adapter` `compat.test.ts` and update this document.
3. Re-run synthetic history/live fixture suites in `connector-core`.
4. Re-evaluate legal/release notes before flipping feature flags.