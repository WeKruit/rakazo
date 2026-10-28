# D1 independent follow-up: initial JavaScript

This local branch contains D1 performance changes on top of separately prepared D4, D2 and D3 dependencies. It does not publish or merge them. The authenticated synthetic chat passes the 350,000-byte first-stage target; the 250,000-byte final goal and online LCP acceptance remain unmet or untested.

## Dependency order and review boundary

1. D4 extraction: `e0eb80130`.
2. D2 scoped display reads and fresh authorization: `d8325e0f7`, descending from D4.
3. D3 transcript and legacy candidate virtualization: `c3b1744a3`, also descending from D4.
4. Ordinary merge of D2 and D3: `88b8ac426`. Only the plan's adjacent D2/D3 status rows conflicted; both independent evidence entries were preserved.
5. D1 commits below. Review `git diff 88b8ac426..HEAD` for this item's changes. A PR must wait until its D4/D2/D3 prerequisites are integrated into the #263 head branch; the integration branch as a whole must not be presented as a D1-only PR against an earlier base.

| Original local commit | D1 release commit | Change |
| --- | --- | --- |
| `efc70da89` | `8b45cc8cb` | Optional views and developer sidebar; literal text fast path; focused unchanged helper/schema modules |
| `edee543e6` | `9757df9b9` | Separate modal error UI from the initial error boundary |
| `979ef4f76` | `32a35bbf4` | Load work details only when visible |
| `1d475baf1` / `556611038` | `18fc47089` | Load voice engine on call action |
| `ac43f7592` / `3e3e79569` | `cc45e32e2` | Load original popup/menu and rich-content components when needed |
| `d2e633e8c` | `042edfe74` | Load account popup on interaction |
| `e181ae94c` | `0b119a417` | Load call card only during a call |
| `b624e46e9` | `25f41f651` | Extract canonical command/filter schemas without changing validation |
| `f8c54c373` | `16529623b` | Load virtualizer only above the existing 80-item threshold |
| `58cc3c2a3` | `42bf0e10c` | Defer closed side-panel rendering and actions |
| `08c9e9212` | `8732c9706` | Preserve immediate localized progress during cold work-detail loading |

Replay review retained the base's existing App route loading. The recruiting-schema conflict retained the complete D2 `ReadRecruitingViewInput`, including research offset and its fresh-binding-check semantics. The existing cold-stream test's wait before establishing its read-count baseline was already in the base; it was not duplicated or weakened. No D2 cache, authorization, pagination, or D3 selection/scroll contract was replaced.

## Actual local measurements

Node 24.19.0; production build; explicit saved `zh-CN` preference; cold Chromium; synthetic session/API responses only. JavaScript bytes are the sum of gzip-compressed files actually requested, not the static entry closure and not HTTP transfer bytes. Requests are recorded until target content appears plus one second. The same measurement script and workload were used for both builds.

| Workload | Before: `88b8ac426` | After: D1 release |
| --- | ---: | ---: |
| Authenticated chat, one text message: JS gzip bytes | 529,849 | 325,964 |
| Same chat: all requests / JS requests | 97 / 65 | 76 / 44 |
| Signed out: JS gzip bytes | 268,950 | 210,257 |
| Signed out: all requests / JS requests | 48 / 40 | 34 / 26 |

The chat saves 203,885 bytes. The separate D2 contacts-workbench fixture loads 468,544 JS gzip bytes across 81 JS requests; the chat result must not be generalized to every route. Long conversations and rich message blocks intentionally load their required renderers.

## Verification

- `pnpm --filter @rakazo/web --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/chat-ui --filter @rakazo/ui-web check`: all five passed.
- `pnpm --filter @rakazo/web test`: 1,676 passed in 144 files, 21.01 s.
- `pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/chat-ui test`: contracts 335 passed; core 1,239 passed with five existing skips; chat-ui 155 passed. Core's local PTY fixtures require permission to use local sockets.
- `pnpm exec vitest run apps/web/src/pages/Shell.test.tsx -t 'shows a sent message at once'`: isolated cold test passed, 208 unrelated tests skipped. Sending shows localized progress before the server answers; the no-extra-read assertion remains intact.
- D2 production-preview browser acceptance repeated three times: all passed, zero duplicate requests, 17 RPC requests and eight recruiting reads each time.
- D3 dedicated browser acceptance: three passed. For 1,000 candidates: 14 initial rows, at most 19 table rows or 36 cards; no recorded long tasks. For 1,000 messages: 17 initial rows, at most 24; no recorded long tasks. Selection, focus, distant jump, streaming tail and prepend checks passed.
- Deferred-popup browser tests: two passed; keyboard, focus restoration, selection and dismissal retained.
- Initial combined browser invocation used the generic development-server configuration and a different viewport: D2 duplicate counts and the candidate scroll-offset assertion failed. The documented production-preview D2 and fixed-viewport D3 configurations above passed without product or assertion changes. Those configurations are the acceptance commands.

```sh
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build --manifest
RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts "$BASELINE_DIST" dist
# Keep this local production preview running in a separate terminal for the D2 fixture:
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5200 --strictPort
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5200 pnpm --filter @rakazo/web exec playwright test --config playwright.d2.config.ts --repeat-each=3
pnpm --filter @rakazo/web exec playwright test --config playwright.candidates.config.ts --workers=1
WEB_PORT=5199 pnpm --filter @rakazo/web exec playwright test e2e/deferred-popup.spec.ts --workers=1
```

`BASELINE_DIST` is the production dist built from the dependency-only merge `88b8ac426`. Use an installed matching Chromium, with `PLAYWRIGHT_BROWSERS_PATH` set if it is outside the default location.

## Remaining limits

The 250,000-byte final goal is not met. Online Fast 4G LCP has not been tested. The prior local Lighthouse diagnostic timed out with an open SSE connection and was not accepted as a passing result; no artificial stream closure or delayed measurement was introduced. No deployment, cloud configuration, secret change, real candidate/job test, external message, or CI enablement occurred. Publication and merge verification remain for the coordinating task.
