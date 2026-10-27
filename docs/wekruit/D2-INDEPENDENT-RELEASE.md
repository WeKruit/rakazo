# D2 independent release validation

This branch is based on the independent D4 release `e0eb80130`. Its changes are limited to D2: TanStack Query display-read caching, the scoped `recruiting.readView` RPC, and adapters for the extracted recruiting/Shell hooks. It preserves the existing A3 pagination and does not include the later D1 menu/schema/voice changes or D3 transcript follow-up.

The query cache is scoped by user, space and thread. Revisit/realtime events revalidate the workspace; changed scope clears cached reads. The combined read RPC checks authorization and fresh workspace binding around the read. Research pages default to offset zero with at most 200 entries per independent field, and the client discards accumulated pages if the binding or revision changes. Candidate reads retain their existing cursor. Mutations and approval checks remain outside the display cache.

## Production browser comparison

The same synthetic contacts fixture was run three times against a production build of the D4 base and three times against this D2 branch. Every run in each group returned the same measurements:

| Measurement | D4 baseline | D2 | Change |
| --- | ---: | ---: | ---: |
| Duplicate identical recruiting RPCs | 4 | 0 | -4 |
| All RPCs | 21 | 17 | -4 |
| Recruiting RPCs | 12 | 8 | -4 |
| JavaScript bytes | 1,576,643 | 1,611,644 | +35,001 |
| JavaScript gzip bytes | 515,958 | 526,190 | +10,232 |
| JavaScript requests | 70 | 70 | 0 |

This is the contacts page with its visible content, not D1's minimal-chat first-load measurement. Query's added JavaScript cost is reported rather than treated as a size improvement. The production-browser duplicate assertion passed 3/3 times. The baseline mode records duplication without asserting the optimized target. No live API, real candidate or external provider was used.

## Reproduction

Use Node 24 and the existing local Chromium runtime. Start separate production previews for the baseline and D2 build; set `PLAYWRIGHT_BASE_URL` to each corresponding loopback preview URL.

```sh
pnpm --filter @rakazo/web --filter @rakazo/api --filter @rakazo/contracts check
pnpm --filter @rakazo/web test
pnpm exec vitest run apps/api/src/recruiting-read-view.test.ts packages/contracts/src/recruiting.test.ts
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
RECRUITING_QUERY_BASELINE=1 pnpm --filter @rakazo/web exec playwright test --config playwright.d2.config.ts --repeat-each=3
pnpm --filter @rakazo/web exec playwright test --config playwright.d2.config.ts --repeat-each=3
```

The API/readView and recruiting-contract run passed 76/76. All three package type checks passed. Production builds passed for both revisions. Frozen-lockfile validation uses copied workspace package manifests and patch files in an isolated scratch directory, avoiding changes to other sessions' shared dependencies.

An initial full-web run passed 1,663 tests and failed one shortcut request-count assertion under concurrent load; the unchanged full rerun passed 1,664/1,664 and standalone Shell passed 209/209. The shortcut test now explicitly waits for the visible initial message before recording its request baseline; its exact request-count and owner/diagnostics restrictions remain intact.

Final full-web verification after the explicit initial-message wait passed **1,664/1,664 tests across 143 files** in 26.93 seconds.

Publication and merge are pending the parent task's authorization and serialized integration. Production deployment, real-provider latency and real-user session behavior are not tested here.
