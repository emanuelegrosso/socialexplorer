# WhatsApp Explorer \| Definitive Technical Specification

**Version 3.0 \| 12 November 2026 \| Implementation baseline**

## 1. Product definition

WhatsApp Explorer is a Windows-first, local-first desktop application that transforms a person's WhatsApp archive into an interactive personal-history experience.

The product promise is **“The Movie of Your Life”**: explore the social universe, move through a timeline, rediscover media and conversations, and compose a guided personal film from selected chapters.

The product has one shared data and visualization foundation with two complementary consumer journeys:
- **Discovery:** understand activity, relationships, patterns and changes over time.
- **Memories:** rediscover people, periods, conversations, photos, videos, audio and shared music links.

The central visualization remains **Temporal Interaction Flow**. It is the entry point to the story, not a replacement for the timeline, media browser or guided movie composer.

Two independent acquisition paths feed one canonical domain model:
1. **Archive Import:** WhatsApp TXT exports and recognized ZIP archives, including media when available and selected by the user.
2. **Baileys Connector:** optional linked-device connector with initial history and live sync, isolated behind a feature flag.

Both paths persist locally in SQLite. Analytics, media cataloguing, timeline, memories and movie composition never depend on the source adapter. Archive Import must be commercially useful without Baileys.

### Product principles

-   Desktop standalone, local-first, read-only.
-   No message sending, chat mutation, or automation.
-   No cloud backend required for core functionality.
-   No guarantee of complete WhatsApp history.
-   Archive Import must remain independently useful if Baileys is
    unavailable.
-   Shared participation, temporal overlap, and direct interaction are
    distinct concepts.
-   No chat content or media sent to licensing, telemetry, or update services.
-   One consumer product with Discovery and Memories journeys.
-   Guided movie composition: the user chooses chapters, people, date ranges, media and soundtrack; the app does not silently publish or automatically infer a person's life story.
-   Photos, videos, voice notes/audio and external music/video links are first-class media references when present in the source archive.
-   Media files are not assumed to be included in every WhatsApp export; missing media is represented honestly.
-   Copyright-protected media is not automatically embedded into shareable movie exports without appropriate rights.

## 2. Approved stack

  Layer              Technology
  ------------------ ------------------------------------------------
  Desktop            Electron
  UI                 React + TypeScript + Vite
  State              Zustand
  3D                 Three.js puro, no React Three Fiber
  Runtime            Node.js bundled with Electron
  Connector          Baileys behind adapter
  Persistence        SQLite
  Heavy processing   Node worker threads / Web Workers
  Media processing   Local metadata extraction + thumbnail/transcode pipeline
  Movie rendering    Local FFmpeg-based rendering adapter (evaluate licensing/build distribution)
  Audio playback     Local media playback with explicit user controls
  Validation         Zod or equivalent
  Tests              Vitest + Playwright
  Packaging          Electron Builder
  Initial OS         Windows 10/11
  Commercial         Free + Personal lifetime + Professional annual

## 3. Architecture

``` mermaid
flowchart TB
  subgraph Desktop["Electron Desktop"]
    Main["Electron Main"]
    UI["React Renderer<br/>Zustand + Three.js"]
    Import["Import Service / Worker"]
    Connector["Connector Process<br/>Baileys Adapter"]
    Main <--> UI
    Main <--> Import
    Main <--> Connector
  end
  Import --> Domain["Canonical Domain"]
  Connector --> Domain
  Domain --> DB[("SQLite")]
  DB --> Analytics["Analytics / Read Models"]
  Analytics --> UI
  Auth[("Protected Auth Store")] <--> Connector
```

**Electron Main:** lifecycle, windows, typed IPC, child process
supervision, OS paths, licensing and update orchestration.

**Renderer:** React, Zustand and Three.js only. No Node integration,
direct filesystem/database access, or credential access.

**Import Service:** format detection, parsing, validation, preview,
duplicate review and transactional commit.

**Connector Process:** sole owner of Baileys, pairing, history/live
sync, reconnect and logout.

**Database:** migrations, repositories, transactions and provenance.

**Analytics:** rebuildable aggregates and visualization read models.

Use a narrow typed preload bridge. If a local HTTP/WebSocket API is
retained, bind only to `127.0.0.1`, use a random per-launch token,
validate Origin, and never expose it to the LAN.

## 4. Repository target

``` text
apps/desktop/
  electron/{main,preload,connector-host}/
  renderer/src/{app,components,features,state,api,visualization}/
packages/
  contracts/ domain/ database/ importers/
  connector-core/ baileys-adapter/ analytics/
  media-core/ media-importers/ story-engine/ movie-composer/
  visualization-model/ licensing-client/ shared/
services/licensing-api/       # commercial metadata only, no chat data
docs/
fixtures/synthetic/
tests/
```

Use pnpm workspaces unless the existing repository already has an
established package manager. First inspect and preserve reusable code.

## 5. Canonical domain model

Domain contracts must not contain Baileys or parser-specific types.

``` ts
type EntityKind = "contact" | "group";
type ChatKind = "private" | "group" | "other";

interface Dataset {
  id: string; name: string; createdAt: string;
  timezone: string; sourceIds: string[];
  coverageStart?: string; coverageEnd?: string;
}
interface Contact {
  id: string; displayName: string; aliases: string[];
  identifiers: ContactIdentifier[]; isSelf: boolean; colorKey: string;
}
interface ContactIdentifier {
  type: "phone" | "jid" | "lid" | "export-name" | "other";
  value: string; sourceId?: string;
  confidence: "confirmed" | "probable" | "unknown";
}
interface Conversation {
  id: string; datasetId: string; sourceConversationId?: string;
  title: string; kind: ChatKind; groupEntityId?: string;
}
interface ConversationParticipant {
  conversationId: string; contactId: string;
  firstSeenAt?: string; lastSeenAt?: string;
  confidence: "confirmed" | "probable" | "unknown";
}
interface Message {
  id: string; datasetId: string; conversationId: string;
  sourceMessageId?: string; senderContactId?: string;
  timestampUtc?: string; timestampLocal: string; timezone: string;
  direction: "incoming" | "outgoing" | "unknown";
  kind: "text" | "image" | "video" | "audio" | "voice" | "document" | "link" | "system" | "call" | "unknown";
  text?: string; hasAttachment: boolean;
  isEdited?: boolean; isDeleted?: boolean;
  sourceKind: "archive-import" | "baileys-history" | "baileys-live";
  parseStatus: "complete" | "partial" | "unparsed";
  provenanceId: string;
}
```

A group is a first-class visual entity. A group post creates an impulse
on the sender's contact lane and a directional arc sender → group. Never
synthesize arcs to every member.

### SQLite tables

`datasets`, `data_sources`, `conversations`, `contacts`,
`contact_identifiers`, `conversation_participants`, `messages`,
`message_reactions`, `provenance_records`, `import_batches`,
`sync_state`, `sync_checkpoints`, `app_settings`, `annotations`,
`analytics_daily`, `analytics_hourly`, `media_assets`,
`media_references`, `external_media_links`, `story_projects`,
`story_chapters`, `story_chapter_items`, `soundtrack_tracks`,
`movie_exports`.

Derived analytics and thumbnails are rebuildable where possible. Keep connector auth separate from SQLite.

### Media and storytelling domain

```ts
type MediaKind = "image" | "video" | "audio" | "voice" | "document" | "unknown";
type MediaAvailability = "available-local" | "external-link" | "missing" | "unsupported" | "not-imported";

interface MediaAsset {
  id: string;
  datasetId: string;
  kind: MediaKind;
  originalName?: string;
  mimeType?: string;
  byteSize?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  contentHash?: string;
  storageRelativePath?: string;
  availability: MediaAvailability;
  importedAt: string;
  provenanceId: string;
}
interface MediaReference {
  id: string;
  mediaAssetId?: string;
  messageId?: string;
  conversationId: string;
  timestampUtc?: string;
  timestampLocal: string;
  caption?: string;
  availability: MediaAvailability;
}
interface ExternalMediaLink {
  id: string;
  messageId: string;
  url: string;
  provider?: "spotify" | "youtube" | "apple-music" | "other";
  title?: string;
  creator?: string;
  linkKind: "music" | "video" | "other";
  resolvedMetadataAt?: string;
}
interface StoryProject {
  id: string;
  datasetId: string;
  title: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  status: "draft" | "rendering" | "ready" | "failed";
  aspectRatio: "16:9" | "9:16" | "1:1";
  createdAt: string;
  updatedAt: string;
}
interface StoryChapter {
  id: string;
  projectId: string;
  title: string;
  narrativeText?: string;
  startAt?: string;
  endAt?: string;
  sortOrder: number;
  transition: "cut" | "fade" | "crossfade";
  durationSeconds: number;
}
interface StoryChapterItem {
  id: string;
  chapterId: string;
  itemKind: "photo" | "video" | "audio" | "message-card" | "stat-card" | "title-card";
  mediaAssetId?: string;
  messageId?: string;
  sortOrder: number;
  startOffsetMs?: number;
  endOffsetMs?: number;
}
interface SoundtrackTrack {
  id: string;
  projectId: string;
  sourceKind: "shared-link" | "user-file" | "licensed-library";
  externalUrl?: string;
  localAssetId?: string;
  title?: string;
  artist?: string;
  startOffsetMs: number;
  durationMs?: number;
  rightsStatus: "unknown" | "user-confirmed" | "licensed" | "not-for-export";
}
```

Rules:
- A media asset is distinct from each message reference to it; the same file can be referenced more than once.
- Preserve the original message and provenance. Media processing must never rewrite source messages.
- Store media under the app's user data directory using generated safe names; preserve original filenames as metadata only.
- Hash files to detect duplicates, but never silently merge different references or delete source files.
- External links are references, not downloaded media. Do not scrape or bypass provider access controls.
- Do not assume WhatsApp TXT export contains media binaries. ZIP/media support must be based on actual archive contents and report missing files.
- Voice notes and audio files may be played locally. Transcription is a separate optional feature, disabled unless explicitly enabled by the user.
- Media indexing must be cancellable, incremental and recoverable.

### Identity and duplicates

-   Never merge identities based only on display name.
-   Keep JID and LID distinct; support manual merge/unmerge.
-   Preserve source identity, confidence and provenance.
-   Support multiple imports into one dataset.
-   Preview new, exact duplicate and ambiguous records before merge.
-   Never silently discard ambiguous possible duplicates.
-   For exports without stable IDs, use conservative fingerprints and
    retain provenance.

## 6. Archive Import

### MVP scope

-   WhatsApp TXT exports.
-   ZIP archives where recognized and safely handled.
-   Separate Android/iOS parser adapters.
-   Import and index photos, videos, audio and voice notes when included in the selected archive.
-   Recognize external music/video links in message text.
-   Media copy into the app-managed archive is opt-in, with a clear estimate of storage required.
-   If media binaries are absent, preserve a missing/not-imported reference where the message indicates an attachment.

### Workflow

1.  Select files via native picker.
2.  Detect format and encoding.
3.  Select/create dataset.
4.  Parse incrementally in worker/service.
5.  Preview title, format, coverage, authors, counts, warnings and parse
    quality.
6.  Confirm timezone and self identity where needed.
7.  Review duplicate/merge summary.
8.  Commit in chunks and transactions.
9.  Show media inventory, missing-media count and estimated storage.
10. Confirm whether to copy media into app-managed storage or reference original locations.
11. Commit in chunks and transactions; rebuild/invalidate analytics and media indexes.

Parser handles date variants, 12/24-hour clocks, locale, multiline
messages, Unicode/emoji, system messages, media placeholders, malformed
lines and truncated exports. Avoid one monolithic regex.

Preserve original timestamp text. Store local wall-clock and timezone;
store UTC only when interpretation is known. Ask when ambiguity could
shift date/time.

Protect against ZIP bombs, path traversal, unsafe extraction and
oversized files. Cancellation must not leave a partially committed
dataset.

## 7. Baileys Connector

Baileys is unofficial, not an official WhatsApp API. It may break,
disconnect, or provide incomplete history. Commercial distribution
requires legal/product review against current WhatsApp terms and
applicable law.

-   Connector optional and isolated.
-   Pin exact tested version; deliberate updates only.
-   Verify event names/types against installed version and migration
    guide.
-   Only `packages/baileys-adapter` imports Baileys.
-   Map version-specific payloads into stable application events.
-   History and live use the same canonical ingestion pipeline.
-   Batch persistence, idempotency, deduplication and checkpoints.
-   Report actual coverage and partial sync warnings.
-   Reconnect with exponential backoff and jitter.
-   Explicit logout; transient disconnect must not delete data.
-   Never expose send-message or mutation methods.

Auth state is separate from SQLite, protected using OS
keychain/credential manager where feasible, with restricted file
permissions. Never log QR, pairing code, credentials, key material, full
JIDs or message bodies.

## 8. Local persistence

Use Electron `app.getPath("userData")` or deliberate OS-specific user
data location, not installation directory.

``` text
WhatsAppExplorer/
  database/explorer.sqlite
  connector-auth/
  logs/
  exports/
  backups/
  settings/
```

SQLite: migrations, WAL where appropriate, foreign keys, prepared
statements, transaction batches, indexes by
dataset/conversation/timestamp/sender, integrity checks and backup
strategy.

Message text may be retained locally for search, but disclose this
during onboarding, offer metadata-only mode where practical, never
transmit it to telemetry/licensing, and support dataset deletion.
AI/cloud processing requires separate explicit consent.

Dataset deletion, connector logout, auth deletion and export are
separate operations.

## 9. Analytics semantics

Global metrics: total messages, contacts/groups, daily average, busiest
days/hours, dataset coverage.

Contact: message count, conversations/groups, first/last observed
message, daily activity, preferred hours and frequency over time.

Group: participants, message count, daily/hourly activity, participant
activity. Participant-to-participant interactions only where directly
documented.

Relation types: 1. Shared participant: same identity occurs in multiple
conversations. 2. Temporal overlap: conversations active in the same
time interval. 3. Cross-chat activity: same author posts in different
chats within a configured window. 4. Direct message: documented private
sender/recipient. 5. Group post: sender → group.

Never represent shared membership or temporal overlap as direct
communication.

## 10. Temporal Interaction Flow

This section supersedes older horizontal chat-lane/day-plane designs.

### Spatial grammar

-   One vertical lane per contact and one per group.
-   Contacts and groups coexist in the same spatial field.
-   Nearby placement may reflect documented interaction frequency.
-   Layout is deterministic and stable when date range changes.
-   Past at top, present/recent at bottom.
-   Continuous time axis, daily separators/date labels, hours as
    secondary references.
-   Fixed perspective camera; no orbit/rotation.
-   Pan and zoom horizontally/vertically; reset camera.

### Colors

-   Stable, distinguishable deterministic color per contact.
-   Groups use neutral desaturated blue-gray.
-   Group arc uses sender color.
-   Selected entity gains highlight without changing base identity
    color.
-   Suggested base: background `#071321`, surface `#102338`, text
    `#FFFFFF`, secondary `#9FB3C8`, group neutral `#8FA6BC`.

### Events and arcs

-   Message creates luminous impulse on sender lane.
-   Private A → B: impulse on A, curved bridge arc A → B, directional
    pulse. No required receive impulse on B.
-   Group post by Mario: impulse on Mario, curved arc Mario → Group. No
    synthetic arcs to all group members.
-   Repeated arcs aggregate by temporal window at zoom-out; split at mid
    zoom; individual when legible at zoom-in.
-   Density/intensity represents volume, with numeric counts available.

### Static

All events in selected period appear at actual timestamps. Only
connections with interactions in the selected period are visible.

### Playback

Chronological progressive appearance and pulses along arcs. Play/Pause,
1x/2x/5x/10x, seek, step forward/back, current timestamp and resume from
any point. Lane positions remain fixed. Respect reduced motion.

### Date presets

Today, Yesterday, Last 7 days, Last 30 days, Last 90 days, Custom range.
Dataset timezone governs date boundaries. Lane positions do not change
with range.

### Selection and search

Contact selection highlights lane/arcs, dims others without hiding, and
opens analytics panel. Group selection shows participants, activity and
only documented relations. Participant click highlights their lane.
Normal/Selected/Isolated modes.

Search contacts/groups/aliases locally. Selecting result pans/zooms,
highlights lane and opens panel.

### Analytics page

Separate page sharing date range: total messages, contacts/groups, daily
average, busiest days/hours. Advanced rankings and period comparisons
are post-MVP.

## 11. Visualization contracts and state

Zustand contains serializable UI state only: dataset, date range,
playback, selection, filters, search, camera target/zoom and reduced
motion. Never store Three.js objects in Zustand.

``` ts
interface TemporalFlowReadModel {
  datasetId: string;
  range: { start: string; end: string; timezone: string };
  entities: TemporalEntityViewModel[];
  events: TemporalEventViewModel[];
  arcs: TemporalArcViewModel[];
  dailyMarkers: DailyMarkerViewModel[];
  coverage: CoverageViewModel;
}
interface TemporalEntityViewModel {
  entityId: string; kind: "contact" | "group"; label: string;
  color: string; stableX: number; stableZ: number;
}
interface TemporalArcViewModel {
  id: string; sourceEntityId: string; targetEntityId: string;
  timestamp: string; direction: "source-to-target"; count: number;
  relationKind: "private-message" | "group-post"; sourceColor: string;
}
```

Layout service calculates deterministic positions. Renderer receives
read models, not raw messages or Baileys objects.

## 12. Consumer experience: Discovery, Memories and The Movie of Your Life

### Product structure

One application, one dataset model, one licensing model and one shared Temporal Interaction Flow. Do not fork the codebase or create separate products for Discovery and Memories.

Primary navigation:
- Home / Your Story
- Discovery
- Memories
- Timeline
- Analytics
- Archive & Import
- Movie Studio

The Home screen introduces two entry paths:
- **Discovery:** activity, social universe, top conversations, peaks and relationship evolution.
- **Memories:** people and periods, On This Day, media gallery, bookmarks and saved moments.

Both paths open the same entities, conversations, date ranges and timeline. Selection and filters should be shareable between views.

### Discovery MVP

- Activity timeline and daily/hourly patterns.
- Social Universe / Temporal Interaction Flow.
- Top conversations and groups.
- Activity peaks (statistical description only).
- Relationship evolution based on documented message activity.
- Date, contact and group filters.

### Memories MVP

- Search and browse conversations by person/group/date.
- Media gallery linked to original messages and timestamps.
- On This Day / same-date historical browsing where coverage supports it.
- Save/unsave bookmarks for messages, media and time intervals.
- Memory cards assembled from user-selected content.
- Missing-media indicators and direct navigation to source message.

Do not label a message as emotionally significant based solely on message frequency. Any suggested chapter or highlight must be explainable by observable signals and editable by the user.

### Guided Movie Studio

The first movie experience is **guided, not fully automatic**. The app may suggest candidate periods or chapters, but the user controls the final story.

Guided workflow:
1. Create a Movie Project and choose title, date range and output aspect ratio.
2. Add, remove and reorder chapters.
3. For each chapter, select a period, people/groups and optional title/narrative.
4. Choose photos, video clips, audio/voice-note excerpts and message/stat cards.
5. Choose a soundtrack: a referenced shared music link for personal rediscovery, a user-provided audio file, or an appropriately licensed library track.
6. Preview chapter order, durations, transitions and audio levels.
7. Render locally and review before export.

Movie Studio must support a useful first release without AI. AI chapter suggestions may be added later as an optional, separately consented capability.

### Movie export and media rights

- The user explicitly selects every message/media item included in an export.
- Default export excludes raw message text and identifiable contact names unless the user opts in.
- Shared commercial music links are displayed as links/references and are not downloaded or embedded automatically.
- A soundtrack track with unknown rights status is playable for personal reference where technically and legally permitted, but is not eligible for embedding in a distributable movie export by default.
- Export soundtrack choices must be `licensed`, `user-confirmed` or otherwise verified as permitted for the intended export. A confirmation checkbox alone does not grant rights.
- Provide a safe fallback: export the movie without protected music and optionally include a separate link/reference list.
- Never bypass DRM, provider restrictions or platform access controls.
- User-provided media ownership/permission remains the user's responsibility; explain this at export.
- Render locally. Do not upload chat content or media to a cloud renderer.

### Media playback and accessibility

- Photo viewer, video player and audio/voice-note player with timestamps and source-message navigation.
- External music/video links open through the user's browser or provider app; no promise of embedded playback.
- Keyboard-accessible controls, captions/transcripts only when available or explicitly generated, reduced motion and a non-3D timeline alternative.
- Respect media file size, codec and duration limits; show unsupported formats rather than failing silently.

### UX and privacy

- First-run demo uses synthetic data and requires no WhatsApp import.
- Onboarding explains what the export contains, what may be missing and where local files are stored.
- Media copy is opt-in and storage use is visible.
- User can remove a media copy without deleting the message reference, and delete a dataset independently.
- No automatic social sharing. Every export is user-initiated and previewable.

## 13. Media processing and Movie Composer architecture

Add the following local-only services:
- **Media Importer:** discover files in supported archives, validate MIME/type and size, safely extract, hash and stage.
- **Media Catalog:** persist metadata, thumbnails, duration, dimensions and message references.
- **Link Resolver:** parse known Spotify/YouTube/Apple Music URLs and extract only safe URL metadata. Do not fetch arbitrary URLs or scrape authenticated pages.
- **Story Engine:** generate explainable chapter suggestions from dates, activity shifts, new conversations and media clusters. Suggestions are optional and user-editable.
- **Movie Composer:** build a render manifest from user-selected chapter items, transitions, overlays and audio tracks.
- **Renderer Adapter:** local FFmpeg process or equivalent, isolated from renderer, invoked with validated arguments and safe file paths.
- **Audio Engine:** local preview playback and volume/fade controls.

FFmpeg packaging/licensing must be reviewed before distribution. Pin and document the selected build and codec set. Avoid invoking shell strings; use argument arrays, validate paths, limit resource use and support cancellation. Rendering must not block the Electron main or UI thread.

## 14. Commercial architecture

Indicative hypotheses to validate: - Free: €0, core exploration with
reasonable volume/export limits. - Personal: €49 lifetime. -
Professional: €149/year. - Optional Professional lifetime launch offer:
€299.

Entitlements: dataset limits, import volume, advanced analytics, report
export, annotations, professional features and future AI features.

Licensing flow: purchase → license key → activation → signed entitlement
token → local signature verification → periodic renewal with offline
grace period. Licensing service receives only license/device/account
metadata, never chat content, contact names, phone numbers, message IDs
or dataset metadata.

License expiry must never lock or delete user data. Free core works
offline. Personal activation can be cached. Professional has documented
offline grace. Evaluate Merchant of Record providers and their terms
before selection.

## 15. Packaging and Electron security

Windows 10/11 first; macOS/Linux after validation. - Electron Builder,
signed `.exe` or `.msi`. - Bundle Node runtime and connector. - Verify
SQLite native module ABI. - Store data under user data directory. -
Stable and beta channels. - Signed update artifacts. -
`contextIsolation: true`, `nodeIntegration: false`, strict CSP, narrow
preload API, validated IPC, no arbitrary navigation/remote scripts. -
Logs redact message bodies, QR, pairing code, keys, full JIDs and phone
numbers. - Crash reporting disabled by default or opt-in and scrubbed.

## 16. Privacy, legal, quality gates

Before commercial release: - legal review of WhatsApp terms/Baileys
distribution; - GDPR review: roles, lawful basis, transparency, data
minimization, third-party data; - retention, deletion, backups and
security documentation; - ZIP/parser security review; - local processing
does not automatically make every use lawful; - AI/cloud requires
separate consent.

Benchmarks: 1k, 10k, 50k, 100k+ messages where feasible. Measure import
throughput, peak memory, analytics time, FPS/frame time and GPU memory.
Use InstancedMesh, LOD, shared geometry/materials and incremental
updates.

Accessibility: keyboard-accessible DOM controls, text alternative to
scene, color not sole encoding, reduced motion, analytics usable without
3D.

## 17. Test strategy

Unit: Android/iOS parser, multiline, timezone, identity, duplicate
detection, Baileys mapping, idempotency, analytics semantics,
deterministic layout, playback, license signature.

Integration: import preview/commit/cancel, archive merge, connector
history/live, reconnect, SQLite migration/recovery, IPC validation,
offline license.

E2E: first launch, synthetic import, Temporal Flow, static/playback,
contact/group selection, search/isolate, export, license activation,
mocked connector pairing, dataset deletion and separate logout.

CI never uses personal WhatsApp accounts or production auth state.

## 18. Release gates

**Alpha:** Electron shell, synthetic/archive import, SQLite, Temporal
Flow. Connector not required.

**Beta:** Windows installer, robust import/merge, connector isolated
behind feature flag, security review, performance report, licensing
sandbox.

**Commercial 1.0:** signed installer, supported-format matrix,
terms/privacy/license/refund policies, support/update process, purchase
activation test, documented Baileys legal/product decision.

## 19. Definition of Done

-   Install and launch Windows desktop app.
-   Import supported WhatsApp exports with preview, coverage, warnings
    and duplicate review.
-   Merge multiple archives explicitly.
-   Persist normalized records locally.
-   Render correct Temporal Interaction Flow semantics.
-   Discovery and Memories journeys share the same canonical data and navigation.
-   Import and catalogue available photo, video, audio and voice-note media with truthful missing/unsupported states.
-   External music/video links are recognized and stored without scraping or downloading protected content.
-   Guided Movie Studio lets users create, edit, preview and locally render a movie from selected chapters.
-   Soundtrack preview supports shared links as references and user-provided/licensed tracks subject to rights rules.
-   Export excludes unlicensed/unknown-rights music by default and has a no-music fallback.
-   Static and Playback work.
-   Contact/group lanes stable and colors deterministic.
-   Private and group arc direction correct.
-   Search, selection, isolation and analytics work.
-   Dataset deletion and connector logout independent.
-   Connector optional and isolated.
-   License expiry never locks data.
-   Automated tests and performance report available.
-   Privacy/security and legal release gates documented.

## 20. Implementation order

1.  Inspect existing repository and preserve useful code.
2.  Freeze domain/contracts and workspace.
3.  Electron shell and SQLite.
4.  Archive Import vertical slice, including media inventory and safe media copy.
5.  Temporal Interaction Flow with synthetic/imported data.
6.  Discovery and Memories journeys, analytics, search, selection, Static/Playback.
7.  Media catalog, media viewer and external music/video link handling.
8.  Guided Movie Studio, local preview/render and rights-safe soundtrack export.
9.  Baileys adapter and connector behind feature flag.
10. Packaging, licensing and updates.
11. Security, privacy, performance and commercial release gates.

**Critical:** Archive Import must be independently useful and
commercially viable before Baileys live sync becomes a release
dependency.
