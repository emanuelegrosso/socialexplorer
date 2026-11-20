# User onboarding (WX-073)

Welcome to **SocialExplorer** — a local, read-only desktop app that turns WhatsApp **archives** into Discovery, Timeline (Temporal Interaction Flow), Memories, and Analytics. Your messages never leave this device unless **you** export them.

## First launch

1. Open **Home**. On first run you can:
   - **Load demo** — synthetic dataset from `fixtures/synthetic` (no account).
   - **Skip for now** — explore empty shell; import later.
2. Pick a **dataset** from the header dropdown when more than one exists.

Preview / web-only builds use the same UI with a mock dataset (`Synthetic demo`).

## Import your archive (recommended path)

1. Export a chat from WhatsApp (Android `.txt` or `.zip`, iOS `.txt` or `.zip`).
2. Open **Archive Import** → **Choose file** (desktop) or **Load synthetic sample** (demo/CI).
3. Confirm **time zone** and **self participant** (who is “you” in the export).
4. Review the merge plan, resolve any ambiguous contacts, then **Commit import**.
5. Progress is chunked; interrupted imports show a resume banner on Home/Import.

**Privacy:** parsing runs in the Electron main process. Files stay under your user data folder (see below).

## Temporal Interaction Flow (Timeline)

- **Past at the top, present at the bottom** — drag to pan, scroll to zoom.
- Use **Static** vs **Playback** for time animation.
- **Search** and entity filters narrow lanes (contacts vs groups).

## Discovery and Analytics

- **Discovery** — activity peaks and conversation highlights before diving into Timeline.
- **Analytics** — derived tables (`analytics_daily` / `analytics_hourly`); rebuild is local and idempotent.

## Memories

- **Gallery** of media references (missing files still listed with availability status).
- **On This Day**, bookmarks, and **memory cards** for curated sets.

## Optional live connector (future / flag)

Archive import is the **primary** path. An optional Baileys-based connector may appear behind a feature flag in a later wave — it is **not** required for Timeline or Memories. Using unofficial clients may violate WhatsApp terms; see `docs/security-privacy-legal.md`.

## Where your data lives (Windows)

Under `%APPDATA%\SocialExplorer\` (see `docs/windows-packaging.md` when packaging is enabled):

| Folder | Purpose |
| ------ | ------- |
| `database/` | SQLite chat database |
| `connector-auth/` | Encrypted connector credentials (separate from DB) |
| `logs/` | Redacted logs |
| `exports/`, `backups/`, `media/`, `thumbnails/` | User content |

**Delete data:** remove dataset from the app (when exposed in UI) or delete the folders above. Logout of a connector does **not** delete imported archives.

## Troubleshooting

| Issue | What to try |
| ----- | ----------- |
| Import fails on ZIP | Check size; ZIP bombs are rejected by design |
| Timeline empty | Confirm date range and dataset selection |
| WebGL unavailable | Timeline still loads controls; canvas may be limited in VM |
| Resume banner stuck | Re-stage the same export file and commit remaining chunks |

## Developers

See root `README.md` for `pnpm install`, `typecheck`, `test`, `test:e2e`, and `bench`.