# Commercial release readiness (WX-074)

Consolidated checklist tying licensing, packaging, quality gates, and open product decisions. Update status as waves land.

## Quality gates (this branch)

| Gate | Task | Status | Notes |
| ---- | ---- | ------ | ----- |
| Unit + integration tests | `pnpm test` | ☐ CI | Synthetic fixtures only |
| Typecheck / lint / build | `pnpm typecheck`, `lint`, `build` | ☐ CI | Monorepo workspace |
| Playwright E2E | `pnpm test:e2e` | ☐ CI | `apps/desktop/e2e` — mock IPC |
| Performance | `pnpm bench` | ☐ CI | 1k + 10k in Vitest |
| Security checklist | `docs/security-privacy-legal.md` | ☑ drafted | Manual legal rows open |

## Licensing and entitlements (WX-060–062)

| Item | Status | Reference |
| ---- | ------ | --------- |
| Plan tiers (Free / Personal / Professional) | **On packaging branch** | `docs/commercial-licensing.md` |
| Metadata-only licensing API | **On packaging branch** | `services/licensing-api` (not merged here) |
| Offline grace + local data access invariant | Documented | commercial-licensing.md |
| MoR choice (Paddle vs Lemon Squeezy) | **Manual pending** | WX-062 |
| Purchase E2E against sandbox | **Manual pending** | After API deploy |

## Packaging and distribution (WX-063–064)

| Item | Status | Reference |
| ---- | ------ | --------- |
| electron-builder NSIS + portable | **On packaging branch** | `docs/windows-packaging.md` |
| `better-sqlite3` Electron rebuild | Documented | `rebuild:native` script on packaging branch |
| Authenticode signing | **Manual pending** | `CSC_LINK` / `WIN_CSC_LINK` |
| Auto-update channels stable/beta | **On packaging branch** | WX-064 |
| Codec / FFmpeg redistribution | **Manual pending** | Wave 9 export |

## Legal and connector

| Item | Status | Reference |
| ---- | ------ | --------- |
| Security / privacy checklist | ☑ | `docs/security-privacy-legal.md` |
| Baileys ToS risk decision | **Manual pending** | Optional connector |
| Public privacy policy + EULA | **Manual pending** | |
| GDPR local-first statement | ☑ | onboarding + security doc |

## Documentation

| Doc | Status |
| --- | ------ |
| `docs/onboarding.md` | ☑ |
| `docs/benchmarks.md` | ☑ |
| Root `README.md` architecture map | ☑ updated in Wave 12 |
| Packaging / licensing copy-from-remote | ☑ `commercial-licensing.md`, `windows-packaging.md` |

## Release sign-off

- [ ] Engineering: CI green on `cursor/wave-12-launch-gates-dd82` stacked on consumer journeys PR #16
- [ ] QA: Playwright smoke + manual Timeline on signed Windows build
- [ ] Commercial: MoR live, entitlements webhook tested
- [ ] Legal: connector stance + policies published
- [ ] Security: no open Critical/High from WX-071 manual review

**Merge note:** Full licensing/packaging code lives on `origin/cursor/wx-063-064-packaging-1db5`. This wave adds launch docs and CI gates on top of consumer journeys without forcing a large merge; integrate packaging branch before shipping installers.