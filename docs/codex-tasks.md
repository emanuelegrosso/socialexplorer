# WhatsApp Explorer \| Codex Implementation Tasks

**Version 2.0 \| Reference: `docs/definitive-tds.md`**

## 1. Global instructions

Read the definitive TDS before coding. Inspect and preserve the existing
repository. Do not replace working code without an approved migration
plan.

Non-negotiable: 1. Archive Import and Baileys are independent adapters
into one canonical domain. 2. Only `packages/baileys-adapter` may import
Baileys. 2a. Discovery, Memories and Movie Studio are one product over
one canonical dataset, not separate apps. 2b. Guided movie composition
is user-directed; suggestions are editable and never silently decide
the user's story. 2c. Media and movie rendering stay local. 2d. Do not
embed external/commercial music in an export unless rights are verified. 3. Renderer has no Node integration and no direct
DB/filesystem/auth access. 4. Three.js never imports Baileys types or
reads SQLite. 5. Temporal Interaction Flow semantics supersede all
previous visualization concepts. 6. All ingestion is idempotent and
provenance-aware. 7. Never claim complete WhatsApp history. 8. Never
implement message sending or WhatsApp mutation. 9. Never log QR, pairing
codes, credentials, key material, message bodies, phone numbers or full
JIDs. 10. CI uses synthetic fixtures and mocks, never personal WhatsApp
accounts. 11. No chat content is sent to licensing, telemetry or update
services. 12. Pin dependencies and Baileys version; no blind automatic
connector updates. 13. Ask before making unresolved product/security
decisions.

Every task must finish with changed files, tests, commands, results,
assumptions, risks and tasks unblocked.

## 2. Ownership

  Role                     Ownership
  ------------------------ ---------------------------------------------
  Architect / Integrator   workspace, contracts, integration
  Desktop Engineer         Electron main/preload, packaging
  Import Engineer          archive detection, parsing, preview, merge
  Connector Engineer       Baileys adapter, auth, sync
  Data Engineer            SQLite, migrations, repositories, analytics
  Frontend Engineer        React, Zustand, screens
  Three.js Engineer        scene, temporal layout, arcs, playback
  Commercial Engineer      licensing, entitlements, payment
  Media Engineer            media import, catalog, playback, link metadata
  Storytelling Engineer     chapter suggestions, Movie Studio, rendering
  QA / Security            fixtures, test, threat model, release gates

## 3. EPIC 0: Audit and foundations

### WX-001 Repository audit

**P0 \| Architect \| No dependencies**

Inspect repository, current app, package manager, scripts, data model,
UI and visualization. Identify reusable code and obsolete assumptions.
Do not modify code.

Done: repository report, preserve/replace list, migration risks and
proposed first tasks.

### WX-002 Workspace and tooling

**P0 \| Architect \| WX-001 approved**

Establish/retain workspace; TypeScript strict, lint, format, Vitest,
scripts, `.gitignore` for DB/auth/logs/exports/build/secrets,
`.env.example`.

Done: reproducible install and dev/build/test/lint/typecheck scripts.

### WX-003 Canonical contracts

**P0 \| Architect + Data \| WX-002**

Define Dataset, Source, Conversation, Contact, Identifier, Participant,
Message, Provenance, ImportBatch, Connector events and validation
schemas. Define timezone, identity and relation semantics.

Done: no parser/Baileys types in domain; both acquisition paths map to
same contracts; contract tests.

### WX-004 Synthetic fixtures

**P0 \| QA \| WX-003**

Create synthetic Android/iOS exports and connector events:
private/group, multiline, system, media placeholder, Unicode, ambiguous
dates, duplicates, malformed/truncated samples. Document CI data policy.

Done: fixture matrix, deterministic tests, no personal data.

## 4. EPIC 1: Electron desktop and persistence

### WX-010 Electron shell

**P0 \| Desktop \| WX-002**

Create Electron main/preload + React/Vite renderer. Set
`contextIsolation`, disable `nodeIntegration`, strict CSP, sandbox where
compatible, narrow typed IPC, sender/payload validation, block arbitrary
navigation.

Done: Windows dev app starts; renderer cannot access Node; IPC tests
pass.

### WX-011 App data directories and lifecycle

**P0 \| Desktop \| WX-010**

Use Electron userData path. Create database, connector-auth, logs,
exports, backups. Graceful shutdown and child process cleanup. Keep data
outside install folder.

Done: restart preserves data; install/update does not overwrite user
data.

### WX-012 SQLite foundation

**P0 \| Data \| WX-003, WX-011**

Select Electron-compatible driver; migrations, WAL where appropriate,
foreign keys, repositories, transactions, indexes, integrity/backup
strategy.

Done: migration and repository tests; native module packaging
compatibility documented.

### WX-013 Secure storage

**P1 \| Desktop + Security \| WX-011**

OS keychain abstraction, protected connector auth, separate secrets from
SQLite, safe fallback, log redaction.

Done: secrets never reach renderer; fallback documented.

## 5. EPIC 2: Archive Import

### WX-020 Format detection

**P1 \| Import \| WX-003, WX-004**

Detect supported TXT/ZIP and Android/iOS families; encoding;
file/archive limits; reject unsafe paths and suspicious archives.

Done: fixtures correctly classified; malformed files fail safely; ZIP
traversal/expansion tests.

### WX-021 Streaming parser adapters

**P1 \| Import \| WX-020**

Separate Android/iOS parsers. Handle multiline, Unicode, system events,
media placeholders, malformed lines, partial parse. Preserve original
timestamps. Process incrementally off renderer.

Done: fixture matrix passes; parsed/partial/unparsed counts; no
monolithic regex.

### WX-022 Timezone and self identity

**P1 \| Import + Frontend \| WX-021**

Timezone setup, self identification, preserve original timestamps,
corrections before commit.

Done: ambiguous dates not silently reinterpreted; self identity stored
per dataset.

### WX-023 Import preview and validation

**P1 \| Import + Frontend \| WX-021, WX-022**

Preview title, format, date coverage, authors, counts, warnings, parse
quality. Cancel, progress, cancellation.

Done: accurate preview; cancel leaves no committed partial dataset.

### WX-024 Multi-archive merge and duplicate review

**P1 \| Data + Import \| WX-012, WX-023**

Multiple imports into dataset; exact duplicates; conservative
fingerprints; new/duplicate/ambiguous counts; explicit merge; provenance
retained.

Done: no silent deletion of ambiguous records; transactional and
repeatable merge.

### WX-025 Import commit and recovery

**P1 \| Data \| WX-024**

Chunked transactions, staging/rollback/cancel, import provenance,
analytics invalidation, crash recovery.

Done: cancellation/crash leaves no half-committed dataset; re-import
idempotent.

## 6. EPIC 3: Domain, persistence, analytics

### WX-030 Identity resolution

**P1 \| Data \| WX-003, WX-012, WX-025**

Canonical identities, identifiers/aliases, manual merge/unmerge,
confidence/provenance. Never merge by display name alone.

Done: ambiguous identities stay separate; reversible merge tests.

### WX-031 Canonical ingestion pipeline

**P1 \| Data \| WX-003, WX-012**

Common validation, normalization, idempotent upsert, transaction,
provenance, update/delete/reaction semantics where supported.

Done: import and connector fixtures create canonical records; repeated
events do not duplicate.

### WX-032 Analytics engine

**P1 \| Data \| WX-030, WX-031**

Global/contact/group daily/hourly metrics, first/last activity,
coverage, typed relations and rebuildable/versioned aggregates.

Done: exact synthetic expected metrics; no conflation of relation types.

### WX-033 Temporal read model

**P1 \| Data + Three.js \| WX-032**

Define entity/event/arc/day view models, stable lane positions,
counts/LOD, relation kind/direction, coverage/timezone.

Done: renderer uses no raw messages or domain calculations;
deterministic layout.

## 7. EPIC 4: Temporal Interaction Flow

### WX-040 Scene foundation

**P1 \| Three.js \| WX-010, WX-033**

Renderer/scene/camera/resize, dark navy style, fixed perspective,
pan/zoom/reset, reduced motion, resource disposal.

Done: no orbit/rotation; lifecycle and resize tests.

### WX-041 Entity lanes and deterministic layout

**P1 \| Three.js \| WX-033, WX-040**

Vertical lanes for contacts and groups, stable across date ranges,
proximity based on documented interactions, deterministic layout
version, stable contact palette and neutral group color.

Done: no lane jumps on date change; color rules correct.

### WX-042 Temporal axis

**P1 \| Three.js \| WX-041**

Past top, present bottom, continuous time, daily separators/date labels,
secondary hour marks, timezone-aware placement.

Done: timestamps map correctly; no daily block layout.

### WX-043 Message impulses and LOD

**P1 \| Three.js \| WX-042**

Sender-lane impulses; aggregate clusters at zoom-out, subdivision at mid
zoom, individual events at zoom-in; density/count encoding;
InstancedMesh.

Done: zoom preserves counts/time; large data uses LOD.

### WX-044 Directional curved arcs

**P1 \| Three.js \| WX-043**

Private sender→recipient arcs; group sender→group arcs; curved bridge
geometry; directional pulse; sender color on group arc; only in-range
connections in Static; temporal aggregation.

Done: no synthetic arcs to group members; direction correct; no stale
out-of-range links.

### WX-045 Static and Playback

**P1 \| Three.js + Frontend \| WX-044**

Static mode; chronological playback; play/pause, 1x/2x/5x/10x, seek,
step, timestamp, resume, reduced motion.

Done: chronological order and seek verified; lanes fixed.

### WX-046 Selection and panels

**P1 \| Frontend + Three.js \| WX-041, WX-044**

Contact/group selection, normal/selected/isolated, highlight arcs, dim
others, analytics panel, group participant click highlights contact.

Done: panel and scene synchronized; no invented group relations.

### WX-047 Search, date range, filters

**P1 \| Frontend \| WX-046**

Local search names/aliases; Today, Yesterday, Last 7/30/90 days, custom;
entity filters; pan/zoom to result; stable lane positions.

Done: date boundaries respect dataset timezone; selection retained
appropriately.

### WX-048 Analytics page

**P1 \| Frontend + Data \| WX-032**

Total messages, contact/group count, daily average, busiest days/hours;
shared date range.

Done: exact agreement with analytics read model.

## 8. EPIC 5: Consumer journeys and media foundation

### WX-080 Product shell: Discovery and Memories

**P1 | Frontend + Product | WX-033, WX-048**

Implement one home screen and two entry journeys, Discovery and Memories, sharing dataset selection, filters, timeline and Temporal Interaction Flow. Navigation includes Home, Discovery, Memories, Timeline, Analytics, Archive & Import and Movie Studio.

Done: both journeys operate on the same dataset and selection state; no duplicated domain logic; synthetic first-run demo works without import.

### WX-081 Media domain contracts and migrations

**P1 | Architect + Data | WX-003, WX-012**

Add MediaAsset, MediaReference, ExternalMediaLink, StoryProject, StoryChapter, StoryChapterItem, SoundtrackTrack and MovieExport contracts, schemas and SQLite migrations. Separate a media asset from message references. Include availability and rights status.

Done: migrations/repositories/contract tests; provenance preserved; media rows can represent available, external-link, missing and unsupported states.

### WX-082 Safe archive media discovery and import

**P1 | Media + Import + Security | WX-020, WX-021, WX-025, WX-081**

Discover media files in supported ZIP exports; validate type, MIME, size, archive paths and expansion limits; hash duplicates; stage and import incrementally. Media copy into app-managed storage is opt-in. Match media to messages conservatively.

Done: photo/video/audio/voice fixtures indexed; missing media reported; cancellation/recovery tested; ZIP traversal/bomb protections pass; no arbitrary extraction paths.

### WX-083 Media catalog, thumbnails and playback

**P1 | Media + Frontend | WX-081, WX-082**

Create local media catalog, image thumbnails, video metadata/thumbnails and audio duration metadata. Implement photo viewer, video player and audio/voice-note player with timestamp and source-message navigation.

Done: unsupported/missing files show clear state; playback does not block UI; generated thumbnails are rebuildable; all files remain local.

### WX-084 External music/video link recognition

**P1 | Media | WX-003, WX-021, WX-081**

Recognize Spotify, YouTube, Apple Music and generic URLs in messages. Store URL/provider/title metadata where available. Do not scrape authenticated pages, download media or promise embedded playback. External links open via browser/provider app.

Done: parser fixtures cover URLs, malformed links and duplicates; link records retain source message and timestamp; no arbitrary URL fetch.

### WX-085 Memories experience

**P1 | Frontend + Data | WX-081, WX-083, WX-084, WX-047**

Implement media gallery by date/person/conversation, On This Day, people/period exploration, bookmarks for messages/media/time intervals and Memory Cards assembled from user-selected items.

Done: every memory navigates to its source message/conversation; historical coverage limitations are visible; no unsupported emotional inference.

### WX-086 Explainable chapter suggestions

**P2 | Storytelling + Data | WX-032, WX-081, WX-085**

Suggest candidate chapters using explainable signals: date boundaries, changes in activity, new/returning conversations and media clusters. Suggestions are never automatically finalized. User can rename, edit, reorder and delete chapters.

Done: each suggestion exposes its rationale; deterministic tests on synthetic data; no sentiment/personality/relationship diagnosis.

### WX-087 Guided Movie Studio project model and editor

**P1 | Storytelling + Frontend | WX-081, WX-083, WX-084, WX-085**

Create guided movie projects. User selects title, date range, aspect ratio, chapters, people/groups, media, message/stat cards, order, durations and transitions. Provide preview timeline and project save/resume.

Done: project survives restart; user controls all included content; no automatic publishing; chapter edits are persisted.

### WX-088 Soundtrack and rights-aware audio workflow

**P1 | Media + Storytelling + Security | WX-084, WX-087**

Support shared music links as references, user-provided audio files and a future licensed music library. Preview supported local tracks; set rights status. Unknown-rights/shared commercial tracks are not embedded in distributable movie exports by default. Provide no-music/link-reference fallback.

Done: export manifest rejects unlicensed/unknown-rights embedded tracks; link references remain accessible; rights decision and UI copy tested.

### WX-089 Local movie rendering pipeline

**P2 | Storytelling + Desktop | WX-087, WX-088**

Evaluate and pin an FFmpeg build/codec set with distribution licensing review. Render locally in a supervised worker process using validated argument arrays and safe paths. Support progress, cancellation, failure recovery and preview before export.

Done: render does not block UI/main process; test fixture creates a playable sample movie; no shell-string execution; resource limits and cleanup verified.

### WX-090 Movie export, privacy and presets

**P2 | Storytelling + QA | WX-089**

Implement export presets (16:9 landscape first; 9:16 and 1:1 may follow), preview, metadata controls and privacy defaults. Exclude contact names and raw message text unless explicitly selected. Show rights notice and soundtrack eligibility.

Done: export contains only selected items; default output avoids identifying text; unlicensed music excluded; export is user initiated.

## 9. EPIC 6: Optional Baileys Connector

Connector is not a prerequisite for Archive Import or core product.

### WX-050 Baileys compatibility spike

**P1 \| Connector \| WX-003, WX-012**

Verify current package, migration guide, exact APIs/types/events,
pairing and history behavior. Pin exact version. Document technical and
legal risk. No production pairing implementation yet.

Done: tested compatibility note and explicit legal/release dependency.

### WX-051 Connector process host

**P1 \| Desktop + Connector \| WX-010, WX-050**

Supervised child process, typed command/event protocol, heartbeat, crash
recovery, graceful shutdown. No generic command execution.

Done: connector crash cannot crash renderer or corrupt imported data.

### WX-052 Auth and pairing

**P1 \| Connector + Security \| WX-013, WX-051**

QR/pairing, protected auth store, creds update, explicit logout/delete,
secret redaction.

Done: no secrets in renderer/log/DB; logout preserves archive datasets.

### WX-053 History sync

**P1 \| Connector + Data \| WX-031, WX-052**

Verified history event API, incremental persistence,
progress/coverage/warnings, idempotency/checkpointing.

Done: replayed history batch causes no duplicates; partial coverage
visible.

### WX-054 Live sync and reconnect

**P1 \| Connector + Data \| WX-053**

Live upserts, chat/contact/group updates, edit/delete/reaction if
supported, backoff+jitter, logged-out vs transient state, dedup after
reconnect.

Done: mocked reconnect passes; live event updates UI; no send API.

### WX-055 Connector UI

**P1 \| Frontend \| WX-052, WX-053, WX-054**

Pairing, connection state, progress, last event/sync, partial history
warnings, disconnect/logout.

Done: all connector states understandable.

## 10. EPIC 7: Commercial and packaging

### WX-060 Entitlement contract

**P1 \| Commercial + Architect \| WX-003**

Define Free/Personal/Professional features, dataset/import limits,
update policy, expiry and offline grace.

Done: versioned entitlement schema; expiry never locks data.

### WX-061 Licensing client/service

**P2 \| Commercial \| WX-060**

Activation, device registration, signed tokens, local verification,
deactivate/transfer, refresh, offline grace. Send no chat data.

Done: tampered token rejected; outage respects grace; data accessible
after expiry.

### WX-062 Payment integration

**P2 \| Commercial \| WX-061**

Select Merchant of Record after eligibility/terms review;
checkout/webhooks, license issuance, refunds/renewals, VAT
documentation.

Done: sandbox purchase-to-activation; webhook signature validation.

### WX-063 Windows packaging and signing

**P1 \| Desktop \| WX-010, WX-011, WX-012, WX-051**

Electron Builder installer; bundle connector/runtime; verify SQLite ABI;
signing; data persistence; stable/beta channels.

Done: clean Windows install works without Node installed; update
preserves DB/auth.

### WX-064 Auto-update

**P2 \| Desktop + QA \| WX-063**

Signed artifacts, stable/beta, release notes, rollback/error handling,
connector compatibility.

Done: update preserves data; unsigned/untrusted package rejected.

## 11. EPIC 8: Quality and launch

### WX-070 E2E suite

**P1 \| QA \| WX-025, WX-045, WX-047**

Onboarding, import/merge, Temporal Flow, static/playback, selection,
search, export, deletion.

Done: stable CI with synthetic data.

### WX-071 Security/privacy/legal review

**P1 before Beta, P2 before public \| Security \| WX-010, WX-013,
WX-025, WX-052, WX-061**

Electron threat review, IPC/local service, secrets/logs, ZIP/parser,
deletion, licensing minimization, GDPR and WhatsApp/Baileys legal
review.

Done: threat model; no critical/high open findings; documented legal
decision.

### WX-072 Performance benchmark

**P1 \| Three.js + QA \| WX-032, WX-043, WX-044**

Benchmark 1k/10k/50k/100k+; import throughput, memory, analytics time,
FPS/frame time/GPU memory; profile LOD/instancing.

Done: reproducible report and supported-size guidance.

### WX-073 Onboarding and docs

**P1 \| Product + Frontend \| WX-023, WX-055**

Explain import vs connector, privacy/data location, supported formats,
limitations, troubleshooting, backup/delete/logout.

Done: first-time user can import without external setup.

### WX-074 Commercial release readiness

**P2 \| Product + Commercial + QA \| WX-061, WX-062, WX-063, WX-071**

Pricing/entitlements, signed installer, privacy/terms/license/refund,
support/update process, purchase test, privacy-safe product analytics.

Done: release checklist signed and connector risk decision recorded.

## 12. Dependency waves

1. WX-001 → 002 → 003 → 004.
2. WX-010 → 011 → 012 → 013.
3. WX-020 → 021 → 022 → 023 → 024 → 025.
4. WX-030 + 031 → 032 → 033.
5. WX-040 → 041 → 042 → 043 → 044. Then 045, 046, 048; then 047.
6. Consumer shell: WX-080 after WX-033 and WX-048.
7. Media: WX-081 → WX-082 → WX-083; WX-084 can run after WX-081 and WX-021.
8. Memories: WX-085 after WX-083, WX-084 and WX-047.
9. Movie: WX-086 (optional suggestions) and WX-087 → WX-088 → WX-089 → WX-090.
10. Connector: WX-050 → 051 → 052 → 053 → 054 → 055. Independent of consumer media/story work.
11. Commercial: WX-060 → 061 → 062; packaging 063 → 064.
12. Release: WX-070/071/072/073 → 074, with media/story security and rights checks included.

Do not parallelize shared contracts, migrations, or scene ownership
without explicit integration agreement.

## 13. Mandatory vertical slices

### Slice A: Import to visualization (first)

1.  Launch Electron.
2.  Import synthetic TXT.
3.  Preview parse.
4.  Confirm.
5.  Persist canonical records to SQLite.
6.  Build temporal read model.
7.  Render contact/group lanes and events.
8.  Select entity and show panel.

This validates the product without a WhatsApp account.

### Slice B: Live connector

1.  Start connector.
2.  Pair using authorized development account.
3.  Receive history batch.
4.  Persist idempotently.
5.  Receive live event.
6.  Update analytics/read model.
7.  Update scene without reload.
8.  Logout independently from dataset deletion.

Slice B must not block Slice A.

### Slice C: Media to guided movie

1. Import synthetic ZIP containing TXT plus photos, video and audio.
2. Discover and catalogue media with provenance and availability.
3. Open a conversation and navigate from message to media.
4. Create a guided Movie Project.
5. Add and reorder two chapters with selected photos/video.
6. Preview with a user-provided or licensed soundtrack.
7. Render locally with a no-music fallback.
8. Verify export contains only selected assets and no unlicensed music.

This slice must use synthetic media fixtures and must not require a real WhatsApp account.

## 14. First Codex prompt

> Read `docs/definitive-tds.md` and `docs/codex-tasks.md` fully. Inspect
> the current repository without changing code. Report current
> structure, reusable modules, obsolete assumptions, dependencies and
> risks. Propose a safe migration plan and the first three bounded
> tasks. Do not implement until the plan is approved.

## 15. Task prompt template

> Implement only \[WX-XXX\] according to the definitive TDS and task
> plan. Respect module ownership and dependencies. Do not expand scope
> or silently decide unresolved product questions. Add tests, run
> relevant typecheck/lint/build/test commands, update documentation, and
> report files changed, commands/results, assumptions, limitations and
> tasks unblocked.

## 16. Commercial sequencing

1.  Internal Alpha: archive import + temporal visualization.
2.  Closed Beta: multiple imports, analytics, selection, playback,
    Windows installer.
3.  Connector Beta: optional Baileys behind feature flag and explicit
    risk notice.
4.  Personal 1.0: Free + Personal.
5.  Professional 1.1: advanced reports, annotations, multi-dataset
    workflow and Professional license.

## 17. Completion report template

``` text
Task:
Status: Done / Partial / Blocked
Summary:
Files changed:
Contracts or migrations changed:
Tests added:
Commands executed:
Results:
Assumptions:
Risks / limitations:
Next tasks unblocked:
```
