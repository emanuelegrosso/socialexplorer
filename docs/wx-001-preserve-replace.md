# WX-001 Preserve / Adapt / Replace Manifest

**Date:** 2026-11-20  
**Scope:** Bootstrap audit and migration plan for `emanuelegrosso/socialexplorer` (Wave 1–5 primary + Wave 10 optional connector reference)  
**Authoritative specs:** [`docs/definitive-tds.md`](./definitive-tds.md) (v3.0) and [`docs/codex-tasks.md`](./codex-tasks.md) (v2.0)

---

## 1. Executive Summary

`SocialExplorer` adopts the v3.0 local-first, read-only Electron desktop architecture with multi-source canonical contracts (`@social-explorer/*`) and WhatsApp as the first supported source. Reusable modules from the prior `WhatsAppExplorer` prototype (v2.0) are selectively preserved or adapted where proven, while legacy horizontal chat-lane and standalone 3D network-graph visualizations are retired in favor of **Temporal Interaction Flow**.

### Hygiene & Privacy Verification
- Zero personal data, real phone numbers, real JIDs, `.env` secrets, SQLite databases, or auth credentials are included in repository fixtures or documentation.
- All synthetic fixtures use deterministic reserved fictional identifiers (`+1 555 010 xxxx`, `15551000001@s.whatsapp.net`..`005`, `120363000000000001@g.us`..`002`, `00000001@lid`).

---

## 2. File-by-File Preserve / Adapt / Replace Manifest

**Disposition legend:**
- **PRESERVE** — Port with minimal or package-scope-only changes.
- **ADAPT** — Reuse core design/logic, refactor schemas/interfaces/targets for v3.0 TDS (`docs/definitive-tds.md`).
- **REPLACE / DO NOT PORT** — Superseded by v3.0 TDS.
- **BUILD NEW** — Net-new v3.0 capability with no predecessor.

### 2.1 Wave 1 — Workspace, Tooling, Canonical Contracts & Synthetic Fixtures (`WX-001`..`WX-004`)

| Prior Module | Target Path in `socialexplorer` | Verdict | Notes / Required Changes |
| --- | --- | --- | --- |
| `.gitignore` | `.gitignore` | **ADAPT** | Keep DB/auth/log/env/dist exclusions; add Electron build (`release/`, `out/`), `exports/`, `backups/`, `media-cache/`, `thumbnails/`. |
| `eslint.config.js`, `prettier.config.js`, `.prettierignore` | Root configs | **PRESERVE** | Strict TypeScript + ESLint flat config + Prettier 3. |
| `.env.example` | `.env.example` | **ADAPT** | Pure Electron IPC baseline; add `ENABLE_BAILEYS_CONNECTOR=false` feature flag. |
| `package.json`, `pnpm-workspace.yaml` | Root `package.json`, `pnpm-workspace.yaml` | **ADAPT** | Use `@social-explorer/*` scope covering `apps/*`, `packages/*`, `services/*`. |
| `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts` | Root configs | **ADAPT** | Strict TS with `NodeNext` ESM resolution and workspace project references. |
| `packages/contracts/*` | `packages/contracts/` | **ADAPT** | Multi-source canonical Zod schemas (`Dataset`, `DataSource`, `Contact`, `ContactIdentifier`, `Conversation`, `ConversationParticipant`, `Message`, `ProvenanceRecord`, `ImportBatch`, `MessageReaction`, `Annotation`, 5 relation types, `TemporalFlowReadModel`, Media & Storytelling, Entitlements, typed read-only Electron IPC). |
| `packages/contracts/src/bucket-messages.ts`, `network-metrics.ts` | — | **REPLACE** | Legacy horizontal Chat Flow bucket LOD & standalone Network Graph contracts; replaced by `TemporalFlowReadModel`. |
| `packages/domain/*` | `packages/domain/` | **ADAPT** | Generalize to multi-source canonical IDs, JID/LID/phone/export-name normalization, UTC/local timezone utilities, conservative export fingerprints & dedup classification, reversible identity rules (never auto-merge on display name alone), and redaction. |
| `apps/connector/src/log/redact.ts` | `packages/shared/src/redaction.ts` | **PRESERVE & EXTEND** | Runtime-agnostic redaction of QR, pairing codes, tokens, keys, phone numbers, JIDs, LIDs, and message bodies. |
| `fixtures/synthetic/*` | `fixtures/synthetic/` | **PRESERVE & EXPAND** | Keep synthetic connector events; build synthetic Android/iOS TXT exports + deterministic synthetic ZIP archives with valid tiny PNG/WAV/MP4 media. |

### 2.2 Wave 2 — Electron Desktop, User Data, SQLite & Secure Storage (`WX-010`..`WX-013`)

| Prior Module | Target Path in `socialexplorer` | Verdict | Notes / Required Changes |
| --- | --- | --- | --- |
| *(None)* | `apps/desktop/electron/{main,preload}/` | **BUILD NEW** | Electron shell (`contextIsolation: true`, `nodeIntegration: false`, strict CSP, narrow typed IPC, `app.getPath("userData")/SocialExplorer`, graceful shutdown & worker supervision). |
| `packages/database/src/open.ts`, `migrate.ts` | `packages/database/src/` | **PRESERVE** | SQLite WAL, foreign keys, versioned migration runner; verify `better-sqlite3` ABI rebuild with Electron. |
| `packages/database/src/migrations/*` | `packages/database/src/migrations/` | **ADAPT** | Evolve from 10 tables to 24 tables (`datasets`, `data_sources`, `conversations`, `contacts`, `contact_identifiers`, `conversation_participants`, `messages`, `message_reactions`, `provenance_records`, `import_batches`, `sync_state`, `sync_checkpoints`, `app_settings`, `annotations`, `analytics_daily`, `analytics_hourly`, plus 8 media/storytelling tables). |
| `packages/database/src/repositories.ts`, `identity.ts`, `search-messages.ts`, `messages-range.ts` | `packages/database/src/` | **ADAPT** | Scope by `dataset_id`, add chunked import staging/commit/rollback, provenance recording, and reversible manual merge/unmerge. |
| `packages/database/src/bucket-messages.ts` | — | **REPLACE** | Tied to legacy 7-day hourly bucket model; replaced by `TemporalFlowReadModel` zoom-window drilldown. |
| `apps/connector/src/auth/*` | `packages/shared/` or `packages/connector-core/` | **PRESERVE** | AES-256-GCM + `@napi-rs/keyring` (OS credential manager) + `MemoryKeyStore` for CI tests. |

### 2.3 Wave 3 — Archive Import (`WX-020`..`WX-025`)

| Prior Module | Target Path in `socialexplorer` | Verdict | Notes / Required Changes |
| --- | --- | --- | --- |
| *(None)* | `packages/importers/` + Import Worker | **BUILD NEW** | Format detection, ZIP bomb & path-traversal guards (`WX-020`), separate Android/iOS streaming parsers (`WX-021`), timezone/self confirmation (`WX-022`), preview & cancellation (`WX-023`), multi-archive duplicate/ambiguous review (`WX-024`), chunked transactional commit & crash recovery (`WX-025`). |

### 2.4 Wave 4 — Canonical Ingestion, Analytics & Temporal Read Model (`WX-030`..`WX-033`)

| Prior Module | Target Path in `socialexplorer` | Verdict | Notes / Required Changes |
| --- | --- | --- | --- |
| `apps/connector/src/ingest/*` | `packages/database/src/ingestion/` | **ADAPT** | Decouple canonical ingestion pipeline so both Archive Import and optional Baileys connector feed one idempotent transactional pipeline (`WX-031`). |
| `packages/analytics/*` | `packages/analytics/` | **ADAPT** | Preserve hourly/daily aggregations and distinct intersection semantics; add dataset scoping, contact/group analytics, and all 5 explicit relation types (`WX-032`). |
| `packages/visualization-model/*` | `packages/visualization-model/` | **REPLACE / REFACTOR** | Refactor to emit `TemporalFlowReadModel` with deterministic stable `X/Z` lane layout (`WX-033`). |
| `packages/visualization-model/src/network-*` | — | **REPLACE** | Standalone 3D Network Graph layout & metrics are superseded by Temporal Interaction Flow. |

### 2.5 Wave 5 — Temporal Interaction Flow Scene & Frontend (`WX-040`..`WX-048`)

| Prior Module | Target Path in `socialexplorer` | Verdict | Notes / Required Changes |
| --- | --- | --- | --- |
| `apps/web/src/features/temporal/*` | `packages/visualization-model/` + `apps/desktop/renderer/src/features/temporal/` | **ADAPT** | Consume `TemporalFlowReadModel` over typed Electron IPC; enforce fixed perspective camera (no orbit/rotation), continuous time axis, zoom-adaptive LOD, and Playback (`WX-040`..`WX-048`). |
| `apps/web/src/visualization/core/webgl.ts`, `interaction/{reduced-motion,picking}.ts`, `ui/labels.ts` | `apps/desktop/renderer/src/` | **PRESERVE** | Pure Three.js utilities and safe label formatting. |
| `apps/web/src/playback/timeline.ts` | `apps/desktop/renderer/src/playback/` | **ADAPT** | Extend to continuous simulated timestamp cursor (`1x/2x/5x/10x`, seek, step, resume). |
| `apps/web/src/components/{ExplorerScene,NetworkGraphScene}.tsx` | — | **REPLACE / DO NOT PORT** | Legacy horizontal tube/day-plane visualization and standalone Network Graph are retired. |

### 2.6 Wave 10 Reference — Optional Baileys Connector & Benchmarks (`WX-050`..`WX-055`, `WX-072`)

| Prior Module | Target Path in `socialexplorer` | Verdict | Notes / Required Changes |
| --- | --- | --- | --- |
| `apps/connector/src/{baileys,history,live}/*` | `packages/baileys-adapter/` | **ISOLATE / ADAPT** | Sole package allowed to import pinned `@whiskeysockets/baileys`; emit v3.0 canonical domain events; read-only (zero send APIs). |
| `apps/connector/src/lifecycle/*` | `packages/connector-core/` + `apps/desktop/electron/connector-host/` | **PRESERVE / ADAPT** | Supervised child process behind feature flag with exponential backoff+jitter and explicit logout. |
| `apps/connector/src/bench/*` | `tests/bench/` | **ADAPT** | Extend 1k/10k/50k/100k synthetic benchmark suite to Archive Import and `TemporalFlowReadModel`. |

---

## 3. Recommended Bootstrap Sequence

1. **Wave 1 (`WX-002`, `WX-003`, `WX-004`):** Workspace & tooling, `@social-explorer/{shared,contracts,domain}`, authoritative docs, and 100% synthetic Android/iOS TXT/ZIP & connector fixtures.
2. **Wave 2 (`WX-010`..`WX-013`):** Electron shell (main/preload + React/Vite renderer), OS `userData/SocialExplorer` directories, SQLite 24-table migrations (`better-sqlite3`), and secure storage.
3. **Wave 3–5 (`WX-020`..`WX-048` — Vertical Slice A):** Archive Import, canonical ingestion, analytics, `TemporalFlowReadModel`, and Temporal Interaction Flow UI/scene.
4. **Wave 6–9 (`WX-080`..`WX-090` — Vertical Slice C):** Consumer shell (Discovery + Memories), media catalog/viewers, external links, Guided Movie Studio, rights-aware soundtrack, local FFmpeg render.
5. **Wave 10–12 (`WX-050`..`WX-074` — Vertical Slice B & Launch):** Optional Baileys connector, commercial licensing/packaging, Playwright E2E, benchmarks, and security/legal launch gates.
