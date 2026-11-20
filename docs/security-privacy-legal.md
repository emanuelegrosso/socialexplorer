# Security, privacy and legal checklist (WX-071)

Launch-gate review for SocialExplorer v3.0 on the Electron desktop path. Items marked **Pass** are verifiable in this repository; **Manual** need human or legal sign-off before public beta.

## Electron shell and IPC

| Control | Status | Evidence |
| -------- | ------ | -------- |
| `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer | **Pass** | `apps/desktop/electron/main/security-policy.ts` (`SECURE_WEB_PREFERENCES`) |
| Strict Content-Security-Policy (no remote scripts by default) | **Pass** | `buildCsp()` — `default-src 'none'`, tight `connect-src` in production |
| Preload exposes only allow-listed IPC channels | **Pass** | `electron/preload/index.ts` + `IPC_CHANNEL_NAMES` |
| Untrusted navigation / `window.open` denied | **Pass** | `decideNavigation`, `decideWindowOpen` |
| IPC request/response Zod validation, generic errors to UI | **Pass** | `electron/main/ipc-router.ts` |
| Trusted sender URL check | **Pass** | `isTrustedAppUrl` in security policy tests |

## Protected storage and secrets

| Control | Status | Evidence |
| -------- | ------ | -------- |
| Connector auth outside SQLite, AES-256-GCM at rest | **Pass** | `packages/security/src/protected-store.ts` |
| OS keyring hook (`KeyStore`) | **Pass** | `packages/security/src/key-store.ts` |
| SQLite application DB not encrypted (documented) | **Pass** | TDS + onboarding; rely on OS ACL |
| Dataset delete does not wipe connector auth | **Pass** | `repositories-core.ts` cascade comments + tests |

## Archive import and ZIP safety

| Control | Status | Evidence |
| -------- | ------ | -------- |
| ZIP bomb limits (entries, ratio, total uncompressed) | **Pass** | `DEFAULT_ZIP_LIMITS` in `packages/importers/src/zip-safety.ts` |
| Path traversal / absolute paths rejected | **Pass** | `validateZipEntryName`, `zip-safety.test.ts` |
| Symlinks, encrypted entries, zip64 blocked | **Pass** | `ZipSafetyError` codes |
| Streaming parsers; synthetic fixtures in CI only | **Pass** | `fixtures/synthetic`, CI workflow |

## Logging and redaction

| Control | Status | Evidence |
| -------- | ------ | -------- |
| JID / phone / bearer / message text redacted | **Pass** | `packages/shared/src/redaction.ts`, `packages/security/src/redact.ts` |
| IPC errors never include stacks/paths | **Pass** | `ipc-router.ts` |
| No product telemetry cloud in core app | **Pass** | No outbound analytics client in `apps/desktop` |

## GDPR and data residency

| Control | Status | Evidence |
| -------- | ------ | -------- |
| Local-first: chat data stays on device | **Pass** | SQLite under user data; no sync |
| User can delete dataset independently of connector | **Pass** | IPC dataset lifecycle |
| Export path local only | **Pass** | paths under `exports/` |
| Licensing API must not receive chat content | **Pass** (design) | `docs/commercial-licensing.md` (packaging branch); **Manual**: verify when `services/licensing-api` is merged |
| DPA / privacy policy for website + installer | **Manual** | Legal draft not in repo |
| EU data residency for MoR checkout only (no chat upload) | **Pass** (architecture) | Chat never sent to MoR |

## Baileys connector and WhatsApp ToS

| Control | Status | Evidence |
| -------- | ------ | -------- |
| Connector isolated; feature-flagged; not required for core UX | **Pass** (design) | TDS § dual acquisition; no `baileys-adapter` in consumer branch yet |
| Unofficial client / account ban risk disclosed | **Manual** | Onboarding + terms |
| QR / pairing secrets in ProtectedStore only | **Pass** (design) | `connector-auth/` separation |
| No message send APIs | **Pass** | Read-only IPC surface |

## Commercial licensing minimization

| Control | Status | Evidence |
| -------- | ------ | -------- |
| Entitlement requests: device hash + licence key only | **Pass** (packaging branch) | `docs/commercial-licensing.md` |
| Expiry/revocation never deletes local archives | **Pass** (packaging branch) | `dataAccess` invariant in licensing doc |
| Ed25519 offline grace | **Pass** (packaging branch) | Same |

## CI and test policy

| Control | Status | Evidence |
| -------- | ------ | -------- |
| Synthetic fixtures only in automated tests | **Pass** | `fixtures/synthetic`, mock IPC in renderer |
| Shared hashing works in renderer (no `node:crypto` in browser) | **Pass** | `@noble/hashes` in `packages/shared/src/hash.ts` |
| Playwright E2E without real exports | **Pass** | `apps/desktop/e2e/` |
| Security unit tests (crypto, protected store, zip) | **Pass** | `packages/security`, `packages/importers` |

## Remaining manual gates (before public release)

1. **Windows Authenticode signing** — certificate provisioning (`CSC_LINK`); see `docs/windows-packaging.md`.
2. **Merchant of Record** — Paddle vs Lemon Squeezy decision (WX-062); tax/invoicing ownership.
3. **Baileys / WhatsApp legal** — written accept/reject of optional connector distribution.
4. **Privacy policy, EULA, refund policy** — linked from installer and purchase flow.
5. **FFmpeg / codec redistribution** — if enabled in export paths (Wave 9+).
6. **Penetration test / external security review** — optional for beta, recommended before wide release.

## Sign-off

| Role | Name | Date | Notes |
| ---- | ---- | ---- | ----- |
| Engineering | _pending_ | | Automated checks green; no critical code findings in table above |
| Legal | _pending_ | | Connector + MoR + GDPR public docs |
| Security | _pending_ | | Manual threat walkthrough on signed build |