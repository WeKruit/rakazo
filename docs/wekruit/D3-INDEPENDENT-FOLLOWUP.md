# D3 independent follow-up

Base: D4 `e0eb80130b7c64b5c3cb55ff23925dd1c071678b`. Local only; publication and integration are serialized by the parent task.

Ports the previously reviewed TranscriptWindow and measured transcript rows, plus the legacy results view now extracted to RecruitingEvidenceTab. Candidate actions and full loaded count remain available; cards use their actual container grid columns. Focused and selected transcript rows remain mounted; distant jumps, dynamic streaming heights, tail following and earlier-message loading retain their existing policies. No D1 lazyLiveWork/windowinglazy or D2 changes are included.

## Measured results

All data is synthetic, Chromium on the local fixture server. The comparison substitutes only the base Transcript module in the same fixture build; bundle sizes are fixture assets, not production initial-page budgets.

| Measurement | Base | Follow-up |
| --- | ---: | ---: |
| Transcript initial rows, 1,000 messages | 1,000 | 17 |
| Transcript max mounted rows over 30 scroll steps | 1,030 | 24 |
| Transcript scroll long tasks | 259 ms, 177 ms | none |
| Transcript total / JS requests | 9 / 4 | 9 / 4 |
| Transcript fixture JS raw bytes | 1,510,469 | 1,510,836 |
| Transcript fixture JS gzip bytes | 486,183 | 486,741 |

The baseline max includes automatic prepend of 30 synthetic older messages. Current candidate fixture mounts 14 initial rows, maximum 19 table rows / 36 cards, with no scroll long tasks, 5 total / 1 JS request, 429,304 raw / 145,206 gzip JS bytes. Candidate browser checks include keyboard and selection. Transcript checks include distant jump, retained focus and text selection after scrolling, streaming growth with tail gap 0 px, automatic prepend and return to latest, and append. Legacy results view has a 1,000-candidate unit regression bounding mounted rows/cards while preserving the full count; it has not received a separate browser-level route fixture.

## Commands and results

Use the repository's pinned pnpm and Node runtime; browser binaries were already installed locally. No cloud resources or real records were used.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
pnpm --filter @rakazo/web build
pnpm --filter @rakazo/web exec playwright test --config playwright.candidates.config.ts
D3_TRANSCRIPT_BASE_REF=e0eb80130 pnpm --filter @rakazo/web exec playwright test --config playwright.candidates.config.ts transcript-virtualization --grep 'real Transcript'
git diff --check
```

Typecheck passed. Web unit tests: **1,656 passed, 142 files**. Production build passed. Current browser run: **3 passed**; baseline comparison: **1 passed**. An initial extra prepend assertion clicked a button that automatic scrolling had already consumed; the corrected test explicitly exercises the automatic scroll path and verifies older rows plus return to latest. No product failure was hidden by that correction.

Not tested: deployment/online environment, real API/page integration, other browsers, CPU throttling, manual assistive technology, and pixel-stable anchor location across all prepend/image-resize combinations. CI remains disabled. This local follow-up does not claim whole-plan completion.

## D4 translation fix integration

Normal merge `06c4fae7659a32293d7a7c91e7d60981ccb3ed4d` brings D4's independent `d564a9268c05abd96b92c9c8963f2a0b1667951e` translation fix into this follow-up without later D1/D2 product work. Evidence retains both virtual card/table renderers and its local `useLingui` macro binding. Existing route readiness waits and assertions were retained unchanged.

After merging, web check and production build passed. Candidate/transcript Chromium fixtures passed **3/3**: max 19 candidate rows / 36 cards / 24 transcript messages, no observed scroll long tasks; streaming tail gap 0 px. Full web tests initially had one intermittent keyboard-diagnostics request-count assertion (3 versus 2); a complete unchanged rerun passed **1,656/1,656** across 142 files. The initial failure is retained here rather than reported as an uninterrupted pass.

Production route command (own local preview port, synthetic fixture only):

```sh
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5212
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5212 pnpm --filter @rakazo/web exec playwright test e2e/recruiting-app-routes.spec.ts e2e/recruiting-lingui.spec.ts --workers=1
```

Production route regression passed **12/12**, including both desktop/mobile route interactions and English/Chinese accessible names plus translated export-error feedback. No publication was attempted.

## Integration refresh before Draft publication

Ordinary merge `8a5e3b570` incorporated #263 through D4 merge `916401f65` and C4. The sole work-plan conflict retained both D3 and C4 evidence. No new functionality or shortcut-timer fix was added. Web check and production build passed; Web tests **1,656/1,656**, 142 files, 32.51 s. Existing Chromium virtualization suite **3/3**, 9.8 s: candidates initial/max 14/19 rows, max36 cards; transcript initial/max17/24 rows, zero observed scroll long tasks, tail gap0. Requests and fixture JS sizes match the earlier follow-up measurements.

Commands: `pnpm --filter @rakazo/web check`, `pnpm --filter @rakazo/web test`, `pnpm --filter @rakazo/web build`, and `PLAYWRIGHT_BROWSERS_PATH=<existing-local-cache> pnpm --filter @rakazo/web exec playwright test --config playwright.candidates.config.ts`. The first browser attempt failed before launch because its default cache lacked the required browser; the unchanged suite passed using the existing matching cache. Historical baseline and route checks above were not rerun in this refresh. CI remains disabled; no online acceptance is claimed.
