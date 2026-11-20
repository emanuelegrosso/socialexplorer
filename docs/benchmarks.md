# Performance benchmarks (WX-072)

Reproducible Vitest benchmarks on **100% synthetic** message sets. No real exports or network I/O.

## Run

```bash
pnpm bench          # 1k + 10k (CI default)
BENCH_100K=1 pnpm bench   # optional 100k when memory allows
```

Implementation: `packages/visualization-model/src/wx-072.bench.test.ts`.

## What we measure

| Stage | Function | Notes |
| ----- | -------- | ----- |
| Temporal read model | `buildTemporalFlowReadModel` | Pure CPU; 5 contacts, 2 conversations, 7-day preset |
| Analytics rebuild | `rebuildAnalyticsTables` | SQLite in-memory + `ingestCanonicalBatch` seed |

## Soft upper bounds (Vitest assertions)

Generous limits to avoid CI flake; tests emit `console.warn` when runtime exceeds 50% of the limit.

| Messages | Temporal limit | Analytics rebuild limit |
| -------- | -------------- | ------------------------ |
| 1,000 | 8 s | 20 s |
| 10,000 | 30 s | 90 s |
| 100,000 (optional) | 120 s | 300 s |

## Recording results

After a local or CI run, note the Vitest timings in your release checklist. Example shape (fill with your machine):

| Messages | temporal_ms | analytics_ms | Host |
| -------- | ----------- | -------------- | ---- |
| 1,000 | _run `pnpm bench`_ | _idem_ | ubuntu-latest / dev laptop |
| 10,000 | | | |
| 100,000 | | | optional |

## GPU / FPS

Temporal Flow rendering uses instanced bucket geometry (`TemporalScene`). **FPS is not measured in CI** (no stable headless GPU). Manual method:

1. `pnpm --filter @social-explorer/desktop dev:renderer` or packaged app.
2. Open Timeline, 7-day window, reduced motion off.
3. Use browser/Electron performance tools; target ~60 FPS at ≤10k visible events on typical iGPU.

See also the historical notes in Project reference `performance.md` (legacy web MVP targets).