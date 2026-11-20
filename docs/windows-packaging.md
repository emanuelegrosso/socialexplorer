# Windows packaging and auto-update (WX-063, WX-064)

## Targets

| Artifact | Builder target | Notes |
| -------- | -------------- | ----- |
| Setup installer | `nsis` x64 | Per-user install; does **not** delete app data on uninstall |
| Portable | `portable` x64 | Optional; same payload as NSIS without installer |

Configuration: `apps/desktop/electron-builder.yml`.

- **appId:** `com.socialexplorer.desktop`
- **productName:** `SocialExplorer` (window title and install folder name)

## User data paths (WX-011)

Electron `app.getPath("userData")` on Windows resolves under:

`%APPDATA%\SocialExplorer\`

The app then scopes durable data under `SocialExplorer/` beneath that root (see `apps/desktop/electron/main/paths.ts`):

| Subdirectory | Purpose |
| ------------ | ------- |
| `database/` | SQLite (`explorer.sqlite`) |
| `connector-auth/` | Protected connector credentials (outside SQLite) |
| `logs/` | Redacted file logs |
| `exports/`, `backups/`, `settings/`, `media/`, `thumbnails/` | User content and exports |

Install and update artifacts never overwrite these directories (`deleteAppDataOnUninstall: false`).

## Native modules (`better-sqlite3`)

`@social-explorer/database` uses `better-sqlite3`, which must match **Electron’s Node ABI**, not the system Node used for development.

| Step | Command |
| ---- | ------- |
| Rebuild for current Electron | `pnpm --filter @social-explorer/desktop rebuild:native` |
| Package (rebuild + build + builder) | `pnpm --filter @social-explorer/desktop package` |
| Unpacked dir only (CI-friendly on Linux) | `pnpm --filter @social-explorer/desktop package:dir` |

Pin Electron in `apps/desktop/package.json` and rebuild after every Electron bump. Native `.node` files are listed in `asarUnpack` so they load from disk inside the ASAR bundle.

## Code signing (placeholders)

Never commit certificates or passwords. Electron Builder reads signing material from the environment:

| Variable | Purpose |
| -------- | ------- |
| `CSC_LINK` or `WIN_CSC_LINK` | Path or base64 `.pfx` for Authenticode |
| `CSC_KEY_PASSWORD` | PFX password |
| `CSC_IDENTITY_AUTO_DISCOVERY` | Set `false` when supplying `CSC_LINK` explicitly |

Windows **update** verification uses Authenticode (`win.verifyUpdateCodeSignature: true` in `electron-builder.yml`). CI should sign on a Windows runner; Linux agents can still validate config and produce unsigned `--dir` output for smoke checks.

## Build commands

```bash
pnpm install
pnpm --filter @social-explorer/desktop build
pnpm --filter @social-explorer/desktop package:dir   # unpacked Windows dir on Linux when Wine/tooling available
pnpm --filter @social-explorer/desktop package       # full NSIS + portable (Windows signing host recommended)
```

Root shortcut:

```bash
pnpm package:desktop
```

## Auto-update (WX-064)

Implementation: `apps/desktop/electron/main/update/` + `electron-updater`.

| Concern | Behavior |
| ------- | -------- |
| Channels | `stable` / `beta` aligned with licensing `updateChannel` (`docs/commercial-licensing.md`) |
| Feed URLs | `SOCIAL_EXPLORER_UPDATE_FEED_STABLE`, `SOCIAL_EXPLORER_UPDATE_FEED_BETA` |
| Eligibility | `isUpdateEligible` / `updatesUntil` — expired licences keep running builds |
| Trust | SHA-512 digests required; optional `SOCIAL_EXPLORER_EXPECTED_PUBLISHER_ATTESTATION` |
| Release notes | Passed through `releaseNotes` on update metadata |
| Rollback | Coordinator records pre-update version; full reinstall flow stubbed |
| Connector ABI | Pin Baileys / connector runtime per release (`SOCIAL_EXPLORER_CONNECTOR_ABI` label in logs); **no blind automatic connector upgrades** (TDS §15 / codex global rule 12) |

Auto-update checks are skipped in unpackaged dev builds and when feeds are not configured.

## CI on Linux vs Windows

| Check | Linux VM | Windows agent |
| ----- | -------- | -------------- |
| `pnpm package:desktop:dir` → `release/win-unpacked/` | Yes (unsigned; `signAndEditExecutable: false`, `CSC_IDENTITY_AUTO_DISCOVERY=false`) | Yes |
| NSIS / portable installers + Authenticode | Requires Wine or skip; use Windows runner + `CSC_*` | Yes |
| `electron-updater` download smoke | No (network + signed host) | Optional staging |

On this repository’s Linux CI/VM, **`pnpm package:desktop:dir` successfully produced `apps/desktop/release/win-unpacked/SocialExplorer.exe`** (unsigned). Full installer signing remains Windows-only.

## Related

- `docs/commercial-licensing.md` — entitlement channels and `updatesUntil`
- `docs/definitive-tds.md` §15 — packaging and security requirements
- `docs/codex-tasks.md` — WX-063, WX-064 acceptance criteria