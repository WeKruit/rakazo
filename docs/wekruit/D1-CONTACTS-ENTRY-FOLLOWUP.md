# D1 cold contacts entry follow-up

D1 remains **in progress**. The independent chat-entry release at `999058b8f` measured
325,964 gzip bytes in Chinese, but that is not a measurement of every authenticated route.
The contacts entry is a separate cold load with the real synthetic directory visible.
The first-stage ceiling is 350,000 bytes; 250 KB remains the later goal.

## Review boundaries

This local branch starts at the frozen independent release `999058b8f`. It does not
change that release branch or publish/merge anything. Commits in order:

| Commit | Change |
| --- | --- |
| `2c9a920fd` | Defer unopened candidate evidence dialog and inactive role/source views; add explicit-locale cold contacts measurement. |
| `309e0cf93` | Transplant `43d4490f5`: separate the visible CompanyLogo from the unused OrgBadge tooltip module. |
| `55cbf3175` | Move unchanged canonical employment schemas and pure candidate-source helpers into leaf modules; retain existing public exports and schema identity. |
| `6a48e6d9c` | Load summary and auxiliary dashboard/missing/memory/activity views when visible; keep the existing workspace model, reads, authorization, and translation variables. |
| `cf443216b` | Add production cold contacts directory/detail/focus regression coverage. |

These changes depend on the release's separately reviewed D4, D2 and D3 prerequisites;
the prerequisite merge must not be presented as D1-only changes.

## Actual production loads

Same `zh-CN` saved preference, build configuration, synthetic contacts, visible directory,
Chromium and response-body gzip accounting. No request filtering by elapsed time or
artificial delays to avoid counting visible content. The existing settling interval is
500 ms after the first fixture candidate is visible. All RPCs are mocked; unknown RPCs fail.

| Build | JS gzip bytes | JS requests | All requests | RPCs | Duplicate recruiting reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| Frozen release baseline | 469,995 | 81 | 110 | 17 | 0 |
| Deferred detail/views | 434,138 | 70 | 99 | 17 | 0 |
| + CompanyLogo leaf | 403,582 | 66 | 95 | 17 | 0 |
| + canonical schema/text leaves | 391,890 | 66 | 95 | 17 | 0 |
| + auxiliary views | 389,578 | 66 | 95 | 17 | 0 |

The older 468,544-byte contacts result used English and must not be compared directly
with these Chinese results. At 389,578 bytes the current contacts entry is still 39,578
bytes over the first-stage ceiling. Do not mark D1 complete from the chat result.

Largest actually requested chunks at this checkpoint: entry 95,835 bytes; Shell 72,084;
validation schemas 34,188; Chinese messages 31,448; RecruitingPanel 22,844;
shared avatar/tool-preference chunk 13,997; profile projection 11,544; virtualizer 9,908;
RPC 9,775; utility styles 8,600; recruiting query/cache 7,461; ContactsTab 7,338.
These are compressed chunk sizes, not additive attribution to individual source modules.
The directory needs its visible profile/assessment projections and current authentication
and validation; they have not been removed to improve the metric.

## Reproduction and validation

```sh
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build --manifest
RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-contacts-load.ts dist
pnpm --filter @rakazo/contracts check
pnpm --filter @rakazo/web check
pnpm exec vitest run packages/contracts
pnpm exec vitest run apps/web/src
pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5202
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5202 pnpm --filter @rakazo/web exec playwright test e2e/recruiting-contacts-cold.spec.ts --workers=1
```

Installed local Chromium was selected with `PLAYWRIGHT_BROWSERS_PATH`; no production
service was contacted. Contracts: 336/336 pass. Full web: 1,676/1,676 in 144 files,
33.77 s. Both package type checks and production build pass. Cold contacts browser:
1/1 pass, 2.2 s; table/cards/table, keyboard opening, actual assessment text, Escape,
restored trigger focus and no unknown RPCs. The source translation coverage includes
all extracted views. One summary test explicitly waits for the newly lazy module;
its content and unrelated-read assertions are unchanged.

## Unresolved checks

The existing broader `recruiting-app-routes.spec.ts` 1440px test fails in both development
and production: it expects the `Collapse role chat` button on the initial contacts route,
but it is absent while the candidate directory is visible. That assertion has not been
removed or weakened. Separate investigation is checking the prior release and bootstrap
lifecycle. If the missing chat is a regression, contacts byte measurements must be repeated
after its correction, since visible content can change the loaded dependencies.

Deployed Fast4G LCP has not been measured. The earlier local Lighthouse attempt with the
real persistent SSE lifecycle timed out and is not an acceptance result. There is no
production deployment, cloud configuration change, CI enablement or publication here.
