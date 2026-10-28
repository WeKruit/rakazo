# D4 independent component extraction

This local branch separates the D4 refactor from the final combined architecture checkout. It is prepared for review only, not pushed or merged. Adam's original D4 claim is `5e99915aa`. The prerequisite is D1 first-stage lazy loading (`57a037621`), refreshed onto the current architecture base through D1 branch `d852c664e`. That prerequisite has not yet merged into #263; a D4 PR against #263 would currently show its D1 ancestor changes as well. Wait for D1 integration, then ordinarily merge the updated base and rerun gates before publishing D4.

The branch includes the latest A3/D3 candidate integration baseline `8188c88f3`. Its D4 delta changes only Web component/controller organization and relevant test-source coverage. Database, adapters, contracts, API, worker, the existing read cache, CandidateDirectory and CandidateWindow are unchanged relative to the prerequisite. A3 bounded reads remain in that baseline. No D2 Query implementation, D2 combined read-view changes, legacy D3 window changes or TranscriptWindow implementation were imported.

## Commit extraction order

The original D4 commits were replayed in this order; the local hashes identify this review branch:

| Original | Local | Change |
| --- | --- | --- |
| ab19ee90f | fbb129712 | Transcript, Composer and shared constants |
| 829d59d7a | 36a8af747 | Recruiting feedback, presentation, criteria, CRM and documents |
| 53e7dc5fe | 4a737be6a | Recruiting state and focused tabs |
| 1338fec84 | 7c3f0361e | Shell view/controller boundary |
| a908b15cb | 393c83b1a | Computer lifecycle |
| 1b198a62b | 913535286 | Bootstrap, roster and navigation |
| e0f337120 | c0c1f9122 | Message actions and their click-time validation module |
| e6155bd90 | a456891d5 | Thread reads, history and subscriptions |
| 481cc15d5 | 78115e589 | Recruiting scope and actions |
| 70d2727fa | 970e69931 | Desktop and translated-source coverage follows moved UI |
| 33b6414ca | 4fd001a26 | Bounded creation, notification, agent-action and refresh hooks |
| 35fc3e448 | faaeb93f8 | Coverage for the final controller domain hooks |
| 815c903ef | ce2fc9ca1 | Model settings controls and source coverage |
| d5b6dbad9 | de20a53cb | Preserve `disconnectName` translation identity |
| b80e600da | 9c1d62f8f | Remove unused extracted timeout constants |
| bb8cf7e07 | c2510497c | Reproducible source-size audit |

Merge `cdcfb789c` retains D1's latest `d852c664e` test synchronization and evidence. The two extraction conflicts were Contacts imports: preserve the current `LazyViews` boundary when moving it into `RecruitingRoleTab`. No fetch or pagination behavior was changed to resolve them. Late D1 optimization commit `efc70da89` and its successors were deliberately excluded; D4 does not require those payload optimizations to meet its source-size target.

## Local gates

The initial gates below did not catch a real Lingui macro-binding regression in extracted views. The follow-up [Lingui correction and production browser evidence](./D4-LINGUI-REGRESSION.md) supersedes any implication that mocked unit tests alone established translated UI behavior.

- Expanded size script checks every production `.ts` and `.tsx` under `apps/web/src`, excluding test/spec files and generated locale catalogs. **242 files, zero above1,500 lines**. Largest is ModelSettingsOverlay1,499; Shell1,135, useShellController1,479, RecruitingPanel1,122, CrmWorkbench1,368. This includes hooks, so oversized components were not merely renamed to hooks.
- Complete Web regression: **142 files / 1,655 tests passed**,26.09s. The initial run found three lazy-render timing failures. D1's shared click helper now waits for its target; two additional tests wait for the Interview view and dynamic imports before taking the no-extra-read baseline. Identity, nonce, same-thread and zero-extra-read assertions remain unchanged.
- Web typecheck and Chinese production build passed. Targeted Biome and diff checks passed.
- Source coverage still checks moved UI strings and desktop chrome. The ModelSettings extraction retains its original translation interpolation rather than changing catalogs or weakening assertions.

Commands:

```sh
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
node apps/web/scripts/check-component-size.mjs
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest
pnpm exec biome check apps/web/scripts/check-component-size.mjs apps/web/src/pages/Shell.test.tsx apps/web/src/pages/RecruitingPanel.tsx apps/web/src/pages/recruiting/RecruitingRoleTab.tsx
git diff --check
```

## Actual cold-load comparison

The same existing `measure-first-load.ts` synthetic browser fixture measured the prerequisite D1 build and this D4 build, both built with the Chinese default locale. Fresh contexts use the fixture's existing browser/locale behavior; no saved locale override was added. These are actual requested script gzip sums and request counts, not static manifest estimates or scroll sample counts:

| Scenario | D1 prerequisite gzip JS | D4 gzip JS | Total requests before→after | JS requests before→after |
| --- | ---: | ---: | ---: | ---: |
| Sign-in | 268,915 B | 246,061 B | 48→46 | 40→38 |
| One-message synthetic authenticated chat | 501,396 B | 451,160 B | 97→94 | 65→62 |

```sh
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts <saved-D1-production-dist> dist
```

The two distributions were measured separately with this same script and the existing local Chromium cache. This is a partial-stage comparison; it excludes subsequent D1 optimizations. It does not claim the350KB first-stage budget,250KB final target or deployed LCP passes. Existing fixture mocks and its finite observation interval do not demonstrate production backend/streaming performance. There is no additional visible user copy in the refactor.

## Integration limits

D1's first-stage dependency is necessary for `lazyPanel` and `ShellMessage` imports. Publish D4 only after that dependency is merged and the PR diff is demonstrably D4-only. Do not substitute the combined local integration branch as an item PR.

D3 follow-up can then target `recruiting/CrmWorkbench.tsx`, `RecruitingEvidenceTab.tsx` and `shell/Transcript.tsx`, preserving its shared window primitives. D2 can subsequently adapt the focused recruiting/state hooks to its scoped Query/read-view contracts. Those follow-ups require their own regression and measured acceptance; they are not included here.

Only synthetic local UI was used. No deployment, production interactions, cloud configuration, real roles/candidates, live-provider validation or remote publication occurred. This document does not claim D1's final payload/LCP target or the entire architecture plan is complete.

## Publication refresh

After D1 prerequisite PR295 merged, ordinary merge of integration8016114c0 changed only documentation. Re-ran `pnpm --filter @rakazo/web check` and `pnpm --filter @rakazo/web test`:1,655/1,655 tests,142 files,19.99s. `node apps/web/scripts/check-component-size.mjs`:242production files,max1,499,zero violations; `git diff --check` passed. Earlier production build and24browser cases remain applicable to the unchanged product tree.
