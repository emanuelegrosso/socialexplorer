# Playwright E2E (WX-070)

CI-safe end-to-end tests for the **Vite renderer preview** with the built-in mock IPC (`createMockApi` in `renderer/src/ipc-client.ts`). No real WhatsApp exports, accounts, or Electron GPU dependencies.

## Prerequisites

- Node.js ≥ 22.12, pnpm ≥ 10
- Install browsers once: `pnpm exec playwright install chromium`

## Run locally

From the repository root:

```bash
pnpm build
pnpm --filter @social-explorer/desktop test:e2e
```

Or from `apps/desktop/`:

```bash
pnpm build
pnpm test:e2e
```

The config starts `vite preview` on `http://127.0.0.1:4173` after a renderer build.

## Projects

| Project | Scope |
| ------- | ----- |
| `renderer-smoke` | Home demo, synthetic import, Timeline/Analytics/Memories navigation |
| `temporal-webgl` | Optional `.temporal-canvas` mount when WebGL exists (skipped otherwise) |

Full Electron + native-module tests remain in Vitest (`apps/desktop/electron/**/*.test.ts`).