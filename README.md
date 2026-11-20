# SocialExplorer

**Windows-first, local-first, read-only desktop application** ("The Movie of Your Life") that transforms social message archives (starting with WhatsApp) into an interactive personal-history experience across two unified consumer journeys (**Discovery** and **Memories**), centered on **Temporal Interaction Flow** and **Guided Movie Studio**.

## Architecture (v3.0 Baseline)

- **Desktop shell:** Electron (`contextIsolation: true`, `nodeIntegration: false`, strict CSP, narrow typed read-only IPC), React + TypeScript strict + Vite, Zustand, pure Three.js.
- **Persistence:** Local SQLite (`better-sqlite3`, WAL mode, foreign keys, chunked transactions) stored under OS user data (`SocialExplorer/`), completely separate from protected connector auth state.
- **Dual independent acquisition into one canonical domain:**
  1. **Archive Import (Primary):** WhatsApp TXT and recognized ZIP exports (separate Android & iOS streaming parsers), opt-in media indexing, and external music/video link recognition.
  2. **Baileys Connector (Optional):** Isolated behind a feature flag in `packages/baileys-adapter` and a supervised child process; never a prerequisite for core functionality.
- **Privacy & CI Policy:** 100% local-first and read-only. Automated tests and CI use **synthetic fixtures only** — never real accounts, phone numbers, JIDs, exports, or credentials.

## Workspace Layout

```text
apps/
  desktop/                    # @social-explorer/desktop — Electron main/preload + Vite React 19 renderer shell
packages/
  shared/                     # @social-explorer/shared — Result/error helpers, deterministic hashing, log redaction
  contracts/                  # @social-explorer/contracts — Strict Zod schemas, TemporalFlowReadModel, IPC, Media/Story, Entitlements
  domain/                     # @social-explorer/domain — Deterministic IDs, JID/LID/phone normalization, timezone, dedup, identity rules
  database/                   # @social-explorer/database — better-sqlite3, versioned SQL migrations (24 tables), typed repositories
  security/                   # @social-explorer/security — AES-256-GCM protected store, KeyStore (OS keyring/memory), redacted logger
services/                     # Metadata-only commercial licensing service (Wave 11+)
docs/                         # Authoritative v3.0 TDS, Codex task plan, and WX-001 manifest
fixtures/synthetic/           # Deterministic 100% synthetic Android/iOS TXT/ZIP & connector event fixtures
tests/                        # Cross-package integration & fixture hygiene tests
```

## Authoritative Documentation

- [`docs/definitive-tds.md`](docs/definitive-tds.md) — Definitive Technical Specification (v3.0)
- [`docs/codex-tasks.md`](docs/codex-tasks.md) — Implementation Task Plan (v2.0)
- [`docs/wx-001-preserve-replace.md`](docs/wx-001-preserve-replace.md) — WX-001 Preserve / Adapt / Replace Manifest

## Architecture map (consumer shell)

```text
apps/desktop/
  electron/main/     IPC router, import service, demo seed, security policy
  electron/preload/  contextBridge → typed SocialExplorerApi
  renderer/          React 19 shell: Home, Discovery, Timeline, Memories, Analytics, Import
  e2e/               Playwright smoke (mock IPC, synthetic only)
packages/
  contracts/         Zod IPC + TemporalFlowReadModel + domain types
  database/          SQLite migrations + repositories + ingest
  importers/         WhatsApp TXT/ZIP parsers + ZIP safety limits
  analytics/         Derived daily/hourly tables + relations
  visualization-model/  buildTemporalFlowReadModel (pure TS)
  security/          ProtectedStore, KeyStore, redacted logger
fixtures/synthetic/  Android/iOS TXT/ZIP + connector JSON (CI-only)
packages/visualization-model/  WX-072 bench test (`wx-072.bench.test.ts`)
docs/                TDS, onboarding, security checklist, release readiness
```

Packaging, licensing API, and signed Windows installers are documented on branch `cursor/wx-063-064-packaging-1db5` (`docs/commercial-licensing.md`, `docs/windows-packaging.md`).

## Development Scripts

Requires **Node.js >= 22.12** and **pnpm >= 10**.

```bash
pnpm install        # Install workspace dependencies
pnpm build          # Build all workspace packages
pnpm typecheck      # Run strict TypeScript typechecking across all packages
pnpm lint           # Run ESLint strict type-checked rules
pnpm test           # Build and run Vitest unit/contract/fixture suites
pnpm bench          # WX-072 synthetic benchmarks (1k + 10k messages)
pnpm test:e2e       # Playwright renderer smoke (see apps/desktop/e2e/README.md)
pnpm clean          # Remove build artifacts (dist, coverage, tsbuildinfo)
```

First-time Playwright: `pnpm exec playwright install chromium` (from `apps/desktop/`).

## User and launch documentation

- [`docs/onboarding.md`](docs/onboarding.md) — first run, import, privacy defaults
- [`docs/security-privacy-legal.md`](docs/security-privacy-legal.md) — WX-071 checklist
- [`docs/benchmarks.md`](docs/benchmarks.md) — WX-072 how to run and interpret
- [`docs/release-readiness.md`](docs/release-readiness.md) — WX-074 commercial gate

## Desktop shell notes

- Run the shell: `pnpm build && pnpm --filter @social-explorer/desktop start` (renderer-only preview: `pnpm --filter @social-explorer/desktop dev:renderer`).
- User data lives under `<userData>/SocialExplorer/{database,connector-auth,logs,exports,backups,settings,media,thumbnails}`; the SQLite file and connector auth are stored and deleted independently.
- `better-sqlite3` must be rebuilt against Electron's ABI when packaging — see `docs/windows-packaging.md`.
