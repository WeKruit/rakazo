# D1 cold entry follow-up

**Local first-stage code budget passes for the measured Chinese chat and contacts entries.**
D1 remains **in progress** overall: the later 250 KB goal is not met and deployed Fast4G
LCP has not been measured. This is not a claim that every route or every conversation
payload fits the budget.

## Frozen result and scope

Product head: `510c3247bb491525de5a8a713cb5203721f0af7a`, on the local contacts follow-up
branch. No publication, merge, deployment, secret, cloud configuration or CI change was
performed here. The independent release at `999058b8f` remains unchanged. Root independently
reproduced the final numbers after integration at `18cf8502b`.

Same `zh-CN` saved preference, production build, synthetic data and response-body gzip
accounting throughout. Contacts opens directly at `/app/g/fixture-group?view=contacts`,
with the real fixture directory and role chat present. All RPCs are mocked; unknown RPCs
fail. Counting settles 500 ms after the first fixture candidate is visible; no feature
load was delayed past that interval to change the metric. The chat fixture is a cold
synthetic authenticated conversation. These are bytes, with a conservative 350,000-byte
first-stage ceiling, not 350 KiB.

| Entry | Frozen-release baseline gzip | Final gzip | Final JS requests | Final all requests |
| --- | ---: | ---: | ---: | ---: |
| Chinese contacts | 469,995 | **348,047** | 7 | 35 |
| Chinese chat | 325,964 | **310,768** | 8 | 39 |
| Chinese signed-out sign-in | 210,257 | **203,485** | 7 | 15 |

Contacts RPCs remain **17**, with **0 duplicate recruiting reads**. The contacts margin is
only **1,953 bytes**; future integrated frontend changes must be measured again. The older
468,544-byte contacts result used English and must not be mixed with this Chinese series.
The contacts baseline had a separate extracted-view accessibility-label bug; the final
result includes its fix and the original route assertions pass.

## Changes and ordered commit map

The branch begins at `999058b8f`. Its earlier D4/D2/D3 prerequisites must remain separately
reviewable; do not publish their prerequisite merge as a D1-only change.

| Commit | Change |
| --- | --- |
| `2c9a920fd` | Defer unopened candidate evidence dialog and inactive role/source views; explicit-locale measurement. |
| `309e0cf93` | CompanyLogo leaf, transplanted from `43d4490f5`; retain OrgBadge export and tooltip behavior. |
| `55cbf3175` | Canonical employment schemas and candidate-source text helpers; unchanged validation and export identity. |
| `6a48e6d9c` | Summary and dashboard/missing/memory/activity views load when visible; existing model and reads stay mounted. |
| `cf443216b` | Cold contacts keyboard/detail/focus browser coverage. |
| `ad536953d` | Intermediate evidence checkpoint. |
| `05009c8fd` | Local Lingui bindings in the four newly extracted recruiting views. |
| `b1f54d801` | Candidate virtualizer loads only above the existing 80-row threshold; transplanted from `3dfd64e44`. |
| `0187f968b` | D4 Lingui regression fix dependency, transplanted from `fb9c4c3ce`; keep separate from D1 scope if already integrated. |
| `5177c034b` | Pagination test waits for threshold-triggered module loading; original bounded-DOM and pagination assertions retained. |
| `18c8e2f7a` | Legacy result cards/table defer outside contacts; offset refs remain in the original parent. |
| `53361d487` | CRM history/outbox defer outside bound-role contacts; transplanted from `a8622c92e`, preserving guarded focus reveal. |
| `63e39b4be` | Canonical criteria-draft helpers separated from editor UI, with existing exports retained. |
| `0552cbc61` | Canonical routine-draft helpers separated from closed routine controls. |
| `e9594434b` | Workflow test waits for the newly lazy history module; content assertions retained. |
| `cb1bcc763` | Initial static dependency grouping experiment; **not the final configuration alone**. |
| `b8a37edb9` | Intermediate anonymous-safe grouping. |
| `1c0885094` | Desktop update provider loads only with the desktop update bridge; preserves first child mount/context. |
| `26bd6d45e` | Speech engine loads only on a speech action; synchronous state/stop and cancellation preserved. |
| `510c3247b` | Final four-group configuration isolates shared Input/Lucide controls so sign-in does not load Shell. |

## Validation

Local installed Chromium was selected with `PLAYWRIGHT_BROWSERS_PATH`. Commands ran from
the repository root with the configured Node/pnpm toolchain. Preview is local only.

```sh
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build --manifest
RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-contacts-load.ts dist
RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts dist
pnpm --filter @rakazo/web --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/chat-ui --filter @rakazo/ui-web check
pnpm exec vitest run packages/contracts
pnpm exec vitest run packages/core/src
pnpm exec vitest run packages/core/src/node/terminal-server.test.ts
pnpm exec vitest run apps/web/src
pnpm exec vitest run apps/web/src/pages/Shell.test.tsx -t 'shows a sent message at once'
pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5202
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5202 pnpm --filter @rakazo/web exec playwright test e2e/recruiting-app-routes.spec.ts e2e/recruiting-lingui.spec.ts e2e/recruiting-contacts-cold.spec.ts --workers=1 --output=/tmp/d1-accepted-production-browser
WEB_PORT=5203 pnpm --filter @rakazo/web exec playwright test e2e/deferred-popup.spec.ts --workers=1 --output=/tmp/d1-accepted-popup
pnpm --filter @rakazo/web exec playwright test --config playwright.candidates.config.ts --workers=1 --output=/tmp/d1-accepted-virtualization
```

- Web: **1,686/1,686**, 147 files, 22.18 s. Five package type checks and production build pass.
- Contracts: **336/336**. Core: 1,237 passed on the first run, with two local PTY/socket
  failures and five skips; rerunning the only failed terminal file with local PTY permission
  passed its two executable tests, retaining its three platform skips. No implementation
  or assertion was changed to conceal those environmental failures.
- Cold send: **1 passed**, 208 filtered out, 1.85 s; immediate sent message/Starting feedback
  and no-extra-read assertions retained.
- Production routes: **13/13**, 32.9 s, including both viewport widths, original chat-collapse
  assertion, native details/evidence, sequence/inbox/overview, focus return and English/Chinese
  accessible names/error text. Synthetic cold contacts has no unknown RPCs.
- Popup fixture: **2/2**, 5.1 s; cold import, arrows/Enter/Escape/Tab/Shift+Tab, reopening and
  focus return. This fixture needs its development server; it is not a production route test.
- Virtualization: **3/3**, 11.1 s. 1,000 synthetic candidates retain 14 initial/19 maximum table rows and
  at most 36 cards; 1,000-message Transcript retains 17 initial/24 maximum rows. Selection,
  prepending, streaming tail, distant jumps, focus and offsets pass, with no observed long tasks.
- New provider/speech loading tests cover no desktop import in web mode, first child mount
  once on desktop, deferred speech cancellation, latest-action/space binding, retry and real
  engine subscription. Existing voice byte limits, timeouts and teardown tests remain intact.

Earlier failed runs are not acceptance evidence: the uncorrected Lingui binding produced
empty accessible labels; the source fix restored local macro bindings without weakening
route assertions. One combined browser attempt wrongly served the dev-only popup fixture
from production. Another parallel attempt shared Playwright's default output directory and
lost a trace during teardown. Final suites use the proper server and independent output
directories sequentially. Dynamic-import waits were added only where a newly deferred view
is expected; authorization, reads, pagination, content and focus assertions remain.

## Packaging tradeoffs and retained boundaries

Final grouping uses Rolldown's public `codeSplitting.groups`: `$initial`, shared Input/Lucide
controls, the static Shell entry and the static RecruitingPanel entry. There is no generated
module allowlist, whole recruiting-directory grouping, locale removal or validation bypass.

Compared with the smaller-module build, grouping also evaluates six BaseUI/FloatingUI helper
modules earlier (6,929 rendered source bytes): geometry functions, event classification,
string constants and read-only navigator/platform flags. Source inspection found no network
requests, timer/listener registration, DOM writes or feature activation in their initializers.
Larger shared chunks trade cache granularity for fewer requests and better compression.

The rejected three-group arrangement met contacts at 349,378 bytes but raised sign-in to
310,321 bytes by placing shared Input/Lucide exports in Shell. It was not retained. The final
shared-controls group restores sign-in to 203,485 bytes. An entry-aware alternative preserved
anonymous loading but measured contacts at 357,943 bytes before the last provider changes.
The earlier concatenation/gzip calculation was only a diagnostic estimate, not an acceptance
measurement or a mathematical bound on bundler behavior.

Manifest/request inspection confirms cold contacts does not request CandidateDetailDialog,
CrmHistory, RecruitingLegacyResults, RecruitingRoleTab, supplementary/summary views, model
settings, voice-call engine, speech engine, desktop updates, popup surfaces, or the candidate
and transcript virtualizers. Those paths remain available on their real activation conditions.

## Remaining 250 KB work: measured attribution, not a claim of impossibility

Contacts is **98,047 bytes** above 250,000; chat is **60,768 bytes** above it. Final contacts
actually requests these seven JS chunks:

| Chunk role | Gzip bytes |
| --- | ---: |
| Main/runtime/auth/shared dependencies | 163,968 |
| Shell static UI/controller dependencies | 105,491 |
| Recruiting static directory/model dependencies | 41,932 |
| Chinese catalog | 31,448 |
| Shared Input/Lucide controls | 4,267 |
| RoleSetup | 513 |
| Bundler runtime | 428 |

A separate local attribution build (same source/configuration, separate temporary output)
confirms the main chunk's largest source contributions include React DOM, React Router,
Zod schemas/JSON-schema support, tailwind-merge and authentication/fetch libraries. These
source `renderedLength` figures precede final compression and are **not additive gzip costs**.
The Shell chunk contains useShellController (41,134 rendered bytes), ShellConversation
(33,619), Composer (32,198), useShellRecruiting (31,505) and Transcript (21,558). Recruiting
contains useRecruitingWorkspace (32,451), CrmWorkbench (20,897), CandidateDirectory (18,717)
and profile/timeline projections needed by visible directory cells.

The smallest credible next investigation is feature-scoped catalogs loaded **before** their
corresponding lazy component renders, with atomic locale switches, English fallback, loading
failure and deferred error-label coverage for all supported languages. Merely deleting the
entire 31,448-byte Chinese catalog would still leave contacts at 316,599 bytes and chat at
279,320 bytes, and deletion would break visible UI. Therefore catalog splitting alone cannot
close this measured gap; its actual savings remain unmeasured.

A second, larger change would separate action-only Shell/controller work into deferred
engines while retaining synchronous optimistic sends/Starting feedback, current authorization
and space capture, cancellation, no-extra-read guarantees, and visible chat/navigation.
That needs behavioral redesign and cold-action regression coverage, not another file move.
Zod's runtime includes JSON-schema support, but changing its API, parser implementation or
validation semantics is outside this frozen improvement; any future packaging alternative
needs full contract parity. Replacing the rendering/router stack is substantially broader.
Changing the contacts page to hide its currently visible role chat would be a product decision
and is explicitly **not** used here to meet a byte target.

No assertion is made that the remaining graph is irreducible or that all safe opportunities
are exhausted. The validated first-stage result is frozen; the final 250 KB goal remains open.
Deployed Fast4G LCP is **not measured**. The earlier local Lighthouse attempt with the real
persistent SSE lifecycle timed out and is not an acceptance result.


## Follow-up investigation toward 250 KB

A subsequent canonical `RUN_TRIGGERS` constant-only module preserves the old export and
schema instance while keeping unused run-schema construction out of the reducer import.
With the same Chinese fixtures, contacts measured **347,873 bytes** (7 JS, 35 requests,
17 RPC, zero duplicate reads), chat **310,602 bytes**, and sign-in **203,472 bytes**.
The small net reductions include changed bundle-name compression; this is not a material
solution to the remaining 97,873-byte contacts gap.

Validation: `pnpm exec vitest run packages/core/src/thread-reducer.test.ts` passed 14/14;
`pnpm --filter @rakazo/contracts check` and the production build passed. Both measurement
commands above were rerun against this build. No unrelated feature or validation changed.

Inspection of installed Zod 4.6.2 establishes that classic schema constructors attach
`processJSONSchema`, and the base schema exposes `toJSONSchema` plus Standard Schema JSON
input/output methods. Its JSON-schema processors are therefore reachable through the
retained public instance API, not merely an accidentally imported barrel. Replacing imports
with named imports does not remove that dependency. Stripping these methods or aliasing
processors to stubs would change schema behavior and was not attempted.

The main bundle's only rendered contract modules are auth (937 source bytes), pagination
constants (1,027), and local settings (171); this is not evidence of a large collection of
unused contract schemas in the main bundle. Employment validation currently computes the
editor's invalid/disabled state synchronously; moving it only to submit would change visible
validation behavior. A functional Zod Mini migration would require canonical schema and
consumer API changes with parser/error/ORPC compatibility coverage. Its actual route savings
are unmeasured, so it is a design option rather than a claimed solution.

## Independent publication after prerequisites

Initial D1#295, D4#298, D2#301 and D3#300 were separately integrated before this follow-up. Ordinary merges retain fresh query reads, transcript virtualization and the causal echo-timer repair. After fixing only the new worktree's shared dependency links (Vite rejected a CSS import outside its workspace), private workspace links and generated Prisma sources are used; no test assertion or allowed-root rule was relaxed.

`pnpm --filter @rakazo/web check` passed. `pnpm exec vitest run apps/web/src packages/chat-ui/src packages/ui-web/src packages/contracts/src --maxWorkers=4`:2,216/2,216 across179files,49.55s. Chinese `vite build --manifest` passed. Real production browser original routes plus English/Chinese accessible names/error feedback12/12,33.0s; cold contacts directory/detail keyboard/return-focus1/1,1.9s. No actual auth/API service or real recruiting records used.

Cold Chromium measurements reproduce the tested integration: contacts347,938B gzip,7JS/35requests,17RPC/0duplicate; chat310,672B,8JS/39requests; sign-in203,469B,7JS/15requests. Compared with original Chinese chat626,677B/15JS/47requests and sign-in629,622B/16JS/26requests, both bytes and request counts fall. Contacts' saved intermediate baseline469,995B is not an original-project baseline. Final250KB remains unmet, deployed Fast4G LCP untested. The subsequently proposed language-catalog split is not included in this checkpoint.

Commands: `RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest`; `RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-contacts-load.ts dist`; same command with `measure-first-load.ts`; production loopback preview and `playwright test e2e/recruiting-app-routes.spec.ts e2e/recruiting-lingui.spec.ts --workers=1`, then `e2e/recruiting-contacts-cold.spec.ts`.
