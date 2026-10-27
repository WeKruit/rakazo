# Architecture local acceptance and remaining gates

This records the original 21-item scope. F2 was subsequently added by another owner and was preserved without taking it over. All new work uses synthetic local data. No deployment, cloud configuration, Secret/resource change, real recruiting record test, outbound message, CI enablement, force push, or merge of #263 into main was performed.

The integration branch is `adam/architecture-local-validation`; it is local only. The last verified remote #263 head is `claude/project-thread-f1cbzk` at `9b2705c66fe952aa90c1a011dcb51ed22c82ef82`. Local implementation, a published small PR, and completion of online acceptance are separate states.

## Original 21 items

| Item | Local implementation / evidence | Remaining gate |
|---|---|---|
| A1 | Existing query/session pool split; worker/API regression and typechecks pass. | Authorized deployed 50-conversation test; actual 6543/5432 configuration and session/wait metrics not measured. |
| A2 | Opt-in actor client, transaction-local identity, 29-table first batch, fail-closed startup; 12 real PostgreSQL tests pass. API isolation: 144 OK, 0 leaks, 98 owner-empty cases unexercised. | Local latency comparison is not consistently below +10%; online p95, production roles/grants/configuration and rollout are untested. Implementation publication paused. |
| A3 | Bounded navigation/contacts plus 36 read endpoints: 28 database-paged, 8 bounded catalogs/provider responses. Integrated 1,000-contact HTTP RPC p95 22.47 ms; 5 × 200 retrieves all 1,000. | Online p95 untested; latest implementation remains local beyond Draft #277. |
| A4 | All existing migrations replayed locally. Four constraints exist; drift is ON UPDATE behavior, not missing constraints. Audit #268 merged. | Metadata from the actual `rakazo` database is missing; the connected tool targets `postgres`. Do not guess production constraint behavior. |
| B1 | Existing background slot/chat-priority regressions pass. | Deployed burst test proving `readyChats=0` untested. |
| B2 | Existing 60-second queue reporter retained and tested. | Deployed minute-by-minute log observation untested. |
| C1 | Existing object-store artifact adapter regression passes. | Existing storage configuration and migration authorization required; cross-container reads untested. |
| C2 | Existing object-store computer workspace adapter regression passes. | Shared storage configuration and migration authorization required; cross-container workspace verification untested. |
| C3 | UTC expiry comparison corrected after actual PostgreSQL failure; #272 merged. Final integrated push-token PostgreSQL cases pass. | Deployed push/session behavior untested. |
| C4 | Durable encrypted OAuth input/status/credential-free receipt, existing realtime reuse, exactly-once save fence; 12 PostgreSQL plus 108 existing OAuth tests passed. | #274 remains unmerged; actual provider/multi-container routing and deployment untested. |
| C5 | C6 public API serving and local C4 implementation provide prerequisites. Service split/multi-container rollout itself has not been implemented or executed. | Shared storage, deployment service configuration, multi-container rollout and uninterrupted-dialogue measurement are outside current authorization. |
| C6 | #265/#267 merged. Public API static/proxy serving replaces Modal Vite process; browser 12/12, local p95 TTFB 7.49 ms, cold page requests 23→23. | Actual image/deployment/region/TLS and online TTFB untested. |
| D1 | Lazy route/panel/rendering dependencies, narrow unchanged schema exports, voice engine loaded by actual interaction; final Chinese authenticated fixture: 626,677→338,715 gzip bytes (first-stage <350,000 gate passed). | Cold contacts remains above350KB; the250KB final target and deployed Fast-4G LCP remain unverified. Chat-only success does not complete D1. |
| D2 | QueryClient, scoped invalidation, fresh read-view authorization; research continuation also bounded and each page revalidated. Production-build fixture: repeated 3 times with 0 duplicate requests, 17 total RPC, 8 recruiting RPC. | Local implementation unmerged; final combined production fixture repeated three times: all gates retained. |
| D3 | Candidate table/cards and actual transcript virtualized, including variable height, focus, streaming, prepend and scroll restoration. Max 19 table rows / 36 cards / 24 transcript messages; no >50 ms scroll tasks in measured fixture. | Local follow-up beyond Draft #276 is unpublished; deployed/other-engine behavior untested. |
| D4 | Components/controllers split without minification; full Web production TS/TSX scan has no file over 1,500 lines. Model extraction preserves existing translation IDs. | Final combined scan and regressions passed locally; no remote merge claim. |
| E1 | Existing metric sources and six-alert specification retained. | Creating cloud alerts and triggering delivery requires configuration/notification authority; not attempted. |
| E2 | Local regression evidence is separate from provider-backed load testing. | Approved isolated deployment, test-copy roles/internal accounts and service-call scope needed for 20/50 conversations; not attempted. |
| E3 | No claim of a restore drill. | Latest backup access and an approved isolated restore destination are required for actual RTO/RPO; not attempted. |
| E4 | Existing per-bot model connection/fallback boundary retained. | Authorized backup connection setup and primary-connection disablement test required; not attempted. |
| F1 | Removed executor geography evaluator and clarification sequencing overrides; native skills retain guidance. Actor/source/approval and ten-person calibration submission checks remain. References 482→477; executor 14,351→14,231 lines. | Latest cleanup beyond Draft #269 remains local; provider-backed test-copy workflow acceptance untested. |

## Integrated backend gates

At local integration commit `967d869befe250ffbc6034a4446e159e3e01c2ee`, the following completed successfully. Counts across separate runs overlap and must not be added as unique tests.

| Suite | Passed | Skipped |
|---|---:|---:|
| contracts | 332 | 0 |
| core | 1,239 | 5 |
| db default suite | 1,216 | 373 |
| adapters default suite | 5,118 | 59 |
| API default suite | 1,393 | 51 |
| mobile | 1,004 | 0 |
| worker, explicitly run from repository root | 4 | 0 |
| Recruiting + membership + durable OAuth + push PostgreSQL | 307 | 0 |
| Restricted-role RLS, separate fresh database | 12 | 0 |
| Database and actual HTTP pagination | 3 | 0 |

All eight relevant backend/shared/mobile package typechecks passed. Mobile's dependency version check used its offline mapping; the remote version index was not verified. The worker package script reports no tests, so its two actual test files were explicitly run from the repository root instead of treating the empty run as coverage.

The independent RLS integration database replayed all **130 migrations** successfully before testing. Final HTTP pagination sample: 10 warmups, 100 requests, p50/p95/max **21.27/22.47/23.72 ms**, 200 contacts per response, pool maximum 2. The session actor is a synthetic fixture; routing, authorization and database reads are real. This is not online acceptance. Earlier measurements and their different load conditions remain in [A3 evidence](./A3-PAGINATION-VALIDATION.md).

The final read-only Prisma comparison still reports exactly four foreign-key replacements for ON UPDATE behavior (Prisma exit 2; wrapper exits nonzero). A4's empty-diff gate remains failed; no generated SQL was executed. C4's new migration did not add another drift item.

Exact commands, using Node 24.19.0 and pnpm 9.15.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/testkit --filter @rakazo/mobile check
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/mobile test
pnpm exec vitest run apps/worker/src
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_root VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts packages/db/src/space-membership.postgres.test.ts packages/adapters/src/pi-oauth-durable.postgres.test.ts packages/adapters/src/expo-push.postgres.test.ts
createdb -h 127.0.0.1 -p 55434 -U postgres rakazo_a2_rls_root
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2_rls_root pnpm --filter @rakazo/db migrate
RLS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2_rls_root pnpm exec vitest run packages/db/src/actor-db.postgres.test.ts
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_root VERIFY_DATABASE=1 pnpm exec vitest run apps/api/src/list-pagination.postgres.test.ts packages/db/src/list-pagination.postgres.test.ts
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_root pnpm --filter @rakazo/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code
```

The database URLs above are exclusively synthetic loopback fixtures. They must not be replaced with a production URL. No new runtime session listener was added by A2/C4; production constraints remain query URLs on port 6543, realtime on 5432 and at most six session connections per container. Those production settings were not measured.

## Publication checkpoint

Claims were committed and normally pushed to #263 before implementation. They remain distinct from the unpublished follow-up work:

| Item | Claim commit |
|---|---|
| C6 | `d1cdbb74d64fe289fa74b79b7ade010fe7f1ddbc` |
| A2 | `7fbaf515e096ca3d35878718d485f3ebf2429200` |
| A3 | `6540579bf4641a5767f829401c9fbe815729fc2c` |
| A4 | `45da1c8d1d06b1f5523a1f070e546c3255d9eaa9` |
| C4 | `995ec0ede736ec052ea63a45c1fe8e9fde02aa91` |
| D1 | `f28310991b10e04812631c89bd5114b303484858` |
| D2 | `da9a24ddf9b7e471a5dfaa5f0a26cdf7c7599532` |
| D3 | `09d5070b289f95136d87c17437446887c22d621c` |
| D4 | `5e99915aa21c05beffe4f449317c268e57553f5c` |
| F1 | `e6b8446deec8b177033019d91549f7e8ee23b048` |
| C3 follow-up | `9c967a3bbf59938a225b6693f44761b06a0192fb` |

C6 implementation was `f7c4ae4501f91cb2d96d5f3e011ad127b978ff94`, with original acceptance evidence `0c077818e3436b876664102264efdabd5dbf9855`. The recruiting fixture repair was `5ecdb59c9f1285641d19d3bf1b09d1b3aceae550`; bounded-run unit assertion correction was `319eaeb48`. Later local combined commits preserve the individual implementation history.

Ordinary pushes for A3/D3/F1/D1/A2 encountered automatic approval rejection: remote publication was treated as an external commitment without recognized explicit authorization. A3/D1/F1 retried once before the subsequent stop instruction arrived, using re-forwarded old transcript authorization, and succeeded. That retransmission was not new human authorization. Subsequent explicit human confirmation authorized publication and small-PR merging for A2/A3/D1/D3/F1. Each previously denied action may be retried once against that new evidence after checking remote state. Failed acceptance is not waived; the combined local branch is not a shortcut around per-item review. The table below is the pre-resumption checkpoint, not a claim that publication is still prohibited.

Verified remote states after fetch:

| Item | Branch / published head | PR state |
|---|---|---|
| A2 | `adam/architecture-a2-rls-pilot`: implementation not published | Audit [#270](https://github.com/WeKruit/rakazo/pull/270) merged; no implementation PR |
| A3 | `adam/architecture-a3-pagination` / `8a5764a4622c753516caac575ef93d0a435c6557` | [#277](https://github.com/WeKruit/rakazo/pull/277), Draft, open, unmerged |
| D1 | `adam/architecture-d1-lazy` / `94db0554c135781f1fc883a385cda06d1ce6201b` | No PR created |
| D3 | `adam/architecture-d3-virtualization` / `0950da29b0a89243a08665d1a247174cb109f80e` | [#276](https://github.com/WeKruit/rakazo/pull/276), Draft, open, unmerged; rejected follow-up `acd3faf287e124caef45f0e4287c4de83650b828` not pushed |
| F1 | `adam/architecture-f1-instructions` / `b9192e6000c618764607dc418dee935c17bd4529` | [#269](https://github.com/WeKruit/rakazo/pull/269), Draft, open, unmerged |
| C4 | `adam/architecture-c4-oauth` / `894f0634fb82c9ccabc713885098257f7fd212b4` | [#274](https://github.com/WeKruit/rakazo/pull/274), open, unmerged; earlier merge attempt reported conflicts |

The main workplan and item evidence contain the local follow-up commits. None of these open PRs has a verified merge SHA. Already completed small-PR merges into #263 are separate:

| PR | Purpose | Merge SHA |
|---|---|---|
| [#265](https://github.com/WeKruit/rakazo/pull/265) | C6 implementation | `a95b8d944aed3f31a9d9745d3e5ce7c24b91e283` |
| [#267](https://github.com/WeKruit/rakazo/pull/267) | C6 actual cold-page evidence | `b314a52da2103fb923f7475bbf81995a5df00c0d` |
| [#268](https://github.com/WeKruit/rakazo/pull/268) | A4 drift evidence, not schema completion | `cf48da330aada754a9e218ce40b0ca0ca051aaab` |
| [#270](https://github.com/WeKruit/rakazo/pull/270) | A2 initial audit, not RLS implementation | `72a736fd61f0f762a4b1a02479569df5ea8298a4` |
| [#272](https://github.com/WeKruit/rakazo/pull/272) | C3 UTC expiry correction | `074a24b0f08f6440c33e830a6c616677f0e24f39` |
| [#275](https://github.com/WeKruit/rakazo/pull/275) | Honest local/online acceptance ledger | `314895e282e100c6afabc00ccbb658ff77cb4013` |

RLS performance details, all failed and improved samples, and remaining rollout requirements are retained in [A2 evidence](./A2-RLS-PILOT.md). The locally successful code gates do not satisfy prohibited deployment, provider, backup or cloud configuration work.

## Final frozen integration verification

Product commit: `afbbf34ce` (canonical leaf schemas, preserving D2 bounded read-view contract). Subsequent edits are evidence only. The final combined run passed **694 files / 12,175 tests**, with **27 files / 488 tests skipped**, in 100.26 s. Skips are not passes. All 11 package typechecks passed. Chinese production build passed. The mobile dependency check uses the existing offline mapping, not a live package-index check.

Actual Chromium cold loads use the same saved `zh-CN` locale, production assets, fresh contexts and synthetic responses in both baseline and final build:

| Scenario | Baseline gzip JS bytes | Final gzip JS bytes | Total requests before→after | JS requests before→after |
|---|---:|---:|---:|---:|
| Sign-in | 629,622 | 210,189 | 26→34 | 16→26 |
| Authenticated one-text-message chat | 626,677 | 338,715 | 47→74 | 15→42 |

The first-stage 350,000-byte chat budget passes; the final 250 KB target does not. Chunking increases requests. These measurements are not a deployed LCP result or a claim about all routes. The richer recruiting role fixture loads 471,349 gzip JS bytes, 1,414,991 raw JS bytes and 78 JS requests. Its three production-browser repeats each passed with **0 duplicate requests / 17 total RPC / 8 recruiting RPC**, versus the earlier baseline 4 duplicates / 21 / 12.

Final D3 browser suite: **3/3 passed**. Candidate table initial/max rows 14/19; cards max36; no >50 ms measured scroll tasks; 5 requests/1 JS request; fixture gzip145,206. Real Transcript initial/max17/24, no measured long tasks; 18 requests/13 JS requests; fixture gzip492,456. The increased transcript chunk requests supersede earlier isolated fixture figures. Streaming tail gap0px; focus and distant jump passed. These fixtures are not complete-app payload measurements.

Final commands (Node24 PATH as above; browser binaries in a local test cache):

```sh
pnpm exec vitest run packages/contracts/src packages/core/src packages/db/src packages/adapters/src packages/chat-ui/src packages/ui-web/src apps/api/src apps/worker/src apps/mobile/lib apps/web/src --maxWorkers=4
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/testkit --filter @rakazo/mobile --filter @rakazo/web --filter @rakazo/ui-web --filter @rakazo/chat-ui check
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest
RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts /tmp/rakazo-d1-before-dist dist
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec playwright test -c playwright.candidates.config.ts
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec vite preview --host 127.0.0.1 --port 5197 --strictPort
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5197 pnpm --filter @rakazo/web exec playwright test -c playwright.d2.config.ts --repeat-each=3
```

The owned preview server was stopped after testing. Lighthouse's local SSE fixture produces a load-timeout/reconnection warning; its numbers are diagnostic only and do not satisfy acceptance. See [diagnostic limitations](ARCHITECTURE-D1-LIGHTHOUSE-LOCAL.md).

Final read-only fetch and GitHub metadata confirm #263 remains Draft/open/unmerged at `9b2705c66fe952aa90c1a011dcb51ed22c82ef82`. #269, #276 and #277 remain Draft/open/unmerged; #274 remains open/unmerged. All four target `claude/project-thread-f1cbzk`. No publication retry was made during this final verification.

After freezing the canonical schema extraction, the same four real PostgreSQL suites listed above were rerun: **307/307 passed in 23.62 s**. Final full Web production TS/TSX scan (excluding tests/locales): **253 files, maximum 1,499 lines, zero over 1,500**.

## Continued local investigation after the first final checkpoint

C5 is not blocked merely because deployment is prohibited: its two-service wiring is locally implementable. The [source-based feasibility audit](audits/C5-LOCAL-FEASIBILITY.md) identifies unresolved safe-rollout prerequisites: two API plus two worker containers need 12 steady session connections, 17 during even one overlapping worker replacement, and up to24 for two full generations, against the documented15 aggregate budget. Current stop aborts active work; home publication has only a process-local lock and no remote pointer CAS/fencing. A safe implementation must select a bounded rollout/drain contract and protect all home writers. Merely replacing `recreate` with `rolling` would be incorrect. C5 is unclaimed; claim-before-implementation still applies.

D1 original wording distinguishes the <=350KB first stage from the250KB final target. The first stage passes; final-target optimization continues without deleting visible content or changing measurement scope.

A2 follow-up `174878364` preserves SECURITY INVOKER/STABLE/search_path and every policy; it reuses PostgreSQL's static membership query plan via PL/pgSQL rather than caching permission results. Twelve safety scenarios pass. Measured200-query RLS total286.181→220.614ms (baseline129.081ms), execution0.566→0.181ms. HTTP paired verification is separate and still pending at this checkpoint.

### Publication resumed: F1

F1 [#269](https://github.com/WeKruit/rakazo/pull/269) was refreshed by ordinary merge, revalidated (adapters5,118 passed/47 skipped; recruiting PostgreSQL282/282; core/adapters/db checks), and merged only into #263. Published head `84a1572086a2a488a8e0946b01ec4dc63490020e`; merge `168fcaacc088e063b8cd2d0dc3b52b414f7eb88a`. The partial F1 acceptance status remains unchanged: provider-backed workflow was not tested.

### C5 workflow blocker

A fresh read of #263 confirmed C5 unowned. Ownership-only local commit `558f87603` was prepared on `adam/architecture-c5-claim`, based on F1 merge `168fcaacc`. Its ordinary push to `claude/project-thread-f1cbzk` was explicitly denied before execution: the new publication confirmation covered A2/A3/D1/D3/F1, not C5. No retry or alternate publication path was used. Because the original workflow requires a successfully pushed claim before implementation, C5 product edits remain blocked pending specific authorization for that claim/publication. The report's architecture audit remains available; no online action is authorized.

[A4 and E1–E4 release preflight](ARCHITECTURE-RELEASE-PREFLIGHT.md) now includes an isolated130-migration/1,000-row dump/restore with matching fingerprint (restore0.246s), temporary-schema proof of the four NoAction differences, exact operator prerequisites, and the distinction between retryable model outages and credential/auth failures. These are local preparation, not production RTO/RPO or alert delivery acceptance.

## Second integration checkpoint

After the initial combined acceptance, safe D1 refinements deferred virtual-window implementation below its existing80-message threshold and closed side-panel code. A cold isolated send test then exposed missing immediate progress while LiveWork loaded. Product fix `b00ebb797` supplies the same localized lightweight progress immediately; no test wait or assertion was weakened. A full frontend run initially failed; the isolated215-test fix suite passed, and the final combined JSON-reported run passed **1,676/1,676**. The final actor/pagination API run passed **1,393/51 skipped** in41.68s. Eleven package typechecks passed; API/DB/testkit checks were repeated after the actor middleware merge.

The final measured Chinese chat is **325,964 gzip bytes /76 requests /44 JS requests** (baseline626,677/47/15). Sign-in210,257B. This passes the explicitly named350KB first stage;250KB is the plan's subsequent final target and remains75,964B away. No schema validation API or language catalog semantics were removed. The final target and deployed LCP are not claimed complete.

A2 optimized HTTP verification still fails: paired p95+16.17%,+48.85%,+74.33%;600/600 raw-request pooled p95 8.183625→13.029083ms (+59.21%). Benchmarks began after other agents' heavy work ended. Microbenchmark improvement is not substituted for this failure. Ordinary pilot-branch push at05ccc8ac3 was again denied before execution; remote branch and PR remain absent after read-only verification. No alternate publisher was used.

D1 first-stage branch was independently refreshed and normally pushed as `d852c664ef7d0132c8659e259269b20b031fa9b1`. Its own chat payload is501,396B, not the325,964B final combined result. Draft creation was explicitly denied before execution. It has no PR; do not imply its initial branch independently meets the final combined budget.

Independent pending release branches are ready for review, not published:
- D4 `adam/architecture-d4-release@e0eb80130b7c64b5c3cb55ff23925dd1c071678b`:1,655 web tests;242 production TS/TSX all<=1,500lines. Depends on D1 first-stage branch. See [mapped commits](D4-INDEPENDENT-RELEASE.md).
- D2 `adam/architecture-d2-release@d8325e0f74149bc107923a5ff8828d69b97bbd91`:1,664 web tests,76 API/contracts checks,three package typechecks; three repeats before/after,duplicates4→0,totalRPC21→17,recruiting12→8. Independent gzip cost+10,232B,JS requests70→70. Depends on D4; [evidence](D2-INDEPENDENT-RELEASE.md).
- C4 refreshed local head `e50214acb`:120 OAuth tests,1,376 API tests/51skip,three package typechecks; #274 still unmerged.

Newly merged into #263: A3 #277 merge `299af876fea9d2577798c643bab0f404c35bdebc`; candidate-only D3 #276 merge `8188c88f3c58299030b8dbfb2ea128144c2a8755`. These supersede the earlier open-PR checkpoint, not the remaining online acceptance.

Final repeat on the combined branch after the cold-progress fix: production build and identical Chinese browser measurement confirmed325,964B chat/210,257B sign-in; 307/307 PostgreSQL cases passed in22.27s, and12/12 RLS cases passed in821ms. The11-package check command exited0; API/DB/testkit checks repeated after the latest actor merge also exited0. Final read-only GitHub verification confirms #263 remains open/unmerged at `8188c88f3c58299030b8dbfb2ea128144c2a8755`; #269/#277/#276 are actually merged, while #274 is open/unmerged (its generated merge preview is not an actual merge).

D3 independent follow-up is ready locally at `c3b1744a331ca3a41913c0030ff1e9f2ab0facab` on `adam/architecture-d3-followup-release`, based only on D4. It passed1,656 Web tests, typecheck/build and3 browser cases plus1 baseline comparison. [Scope and exact commands](D3-INDEPENDENT-FOLLOWUP.md). No publication occurred.

The combined branch then reran the strengthened3-case virtual-scroll suite with explicit text-selection/prepend assertions: all passed in10.6s; candidate14initial/19max rows,36cards,0 measuredlongtasks; Transcript17initial/24max,tailgap0px,selection/focus/jump/prepend passed,0longtasks. Transcript fixture now20requests/15JS and492,993gzipB, which supersedes earlier fixture chunk counts. Final combined D2 browser repeated3times:0duplicates,17RPC,8recruiting,468,544gzipJSB/81JSrequests. The own preview server was stopped afterward.

The independent D1 follow-up is also reviewable locally at `999058b8f77bba418f27bb92ee27d847304cd6b7`, with D1-only diff starting after dependency merge `88b8ac426` (D2+D3 on D4). Its own same-fixture Chinese chat baseline529,849→325,964B,requests97→76,JS65→44; sign-in268,950→210,257B. It passed1,676 Web,335 contracts,1,239 core/5skip,155chat tests,five package checks and dedicated browser/cold-feedback checks. [Mapped commits and commands](D1-INDEPENDENT-FOLLOWUP.md). No PR was created.

Scope correction: the D2 contacts fixture directly opens `?view=contacts`, so its468,544B is a **cold contacts screen**, not an after-interaction payload. That fixture selected English; explicit Chinese measurement is469,995B. The325,964B Chinese chat result does not prove the350KB first-stage budget for contacts or every route. A bounded unused-detail/inactive-tab dependency review continues; D1 is not marked complete.

## Continued local integration after the publication pause

The integrated branch now includes the A2 public pipeline implementation (`274a12c8e`) and full samples (`81a25a382`), D4 translation repair, D2/D3 independent follow-up evidence, and the contacts-entry extractions through `b8a37edb9`. Independent release heads remain separate; this integration branch is not a substitute PR for individual plan items.

At integrated `30b9ac630`, all 11 package checks passed with `EXPO_OFFLINE=1` (Expo's online dependency catalog was not validated). The four PostgreSQL suites from the command block above passed **307/307 in 39.80 s**. The restricted-role RLS suite passed **18/18 in 732 ms** against the dedicated synthetic RLS database. Its first sandboxed invocation could not connect to loopback (EPERM) and skipped all cases; the permitted local invocation is the successful evidence, not the failed invocation. Integration initially duplicated one local Lingui binding during cherry-pick; typecheck caught this, `30b9ac630` removes the duplicate, and the checks passed afterward.

The latest independent D2 head is `dc3d4d56efe58d3429cc453ce28a93a7cd59e59d`: 1,664 Web tests, three production duplicate-request cases (zero duplicates), two bilingual production cases and package checks pass. An intermittent Shell keyboard test observed three reads instead of two on earlier D2/D3 baselines. The exact assertion remains unchanged; diagnostic `d95a112ba` adds target/stack evidence on future failure. Repeated focused and complete runs passed without identifying its cause; this is **not a claimed fix**. The diagnostic is included locally as `b537d9c15`.

D3 follow-up head `1f5742a25c8df4e98bd135eb392feabe6c61d585` and D4 head `d564a9268c05abd96b92c9c8963f2a0b1667951e` include their translation repair. D4 production route/bilingual checks passed 24/24 over two runs. Integrated test readiness now waits for actual Sequence content and settled horizontal navigation before making the original assertions (`378f7d37f`); no assertion was relaxed.

Read-only remote verification still reports #263 open, draft and unmerged at `8188c88f3c58299030b8dbfb2ea128144c2a8755`. C5 ownership publication remains denied and its implementation has not started. A2 push and D1 PR creation remain denied; no retry has occurred without new authority. The parent is collecting one remaining-plan publication confirmation. No deployment, cloud configuration, secret or resource change was attempted.

The final integrated DB/API regression used `pnpm exec vitest run packages/db/src apps/api/src --maxWorkers=2 --reporter=verbose` with local test sockets permitted: **2,609 passed, 430 skipped; 97 files passed, 20 skipped; 47.12 s**. The earlier sandboxed run remained without a result and was stopped by its verified process ID; it is not counted as a pass, and its precise hang cause was not established. This supersedes the independent A2 branch's 2,593-test count for the combined code, not its individual evidence.

## Final contacts integration: phase-one budget and regression

Final product commit `18cf8502b` includes anonymous-safe shared-controls grouping, desktop-only update-provider loading and action-triggered speech-engine loading. The same Chinese production build was independently measured in this integration checkout. These are actual requested scripts (individual gzip byte counts summed), not static import-closure estimates:

| Cold route | Before gzip B | Final gzip B | Before → final total requests | Before → final JS requests |
| --- | ---: | ---: | --- | --- |
| Sign-in |629622|203485|26 →15|16 →7|
| One-message synthetic chat |626677|310768|47 →39|15 →8|
| Contacts (follow-up baseline after initial D1 work) |469995|348047|final35|final7|

All three measured entry points meet the **350,000 B first-stage** target; chat and contacts still exceed the **250,000 B final goal**, and online Fast-4G LCP remains unmeasured. This does not establish a budget for every possible route. Contacts has17 RPCs and0 duplicate recruiting reads. The separate English D2 fixture measures346596B,7 JS requests,17 RPCs/8 recruiting reads and0 duplicates in each of three runs; it must not be confused with the Chinese cold-contact result. Full entry request lists are stored under `evidence/d1-final-entry-requests.json` and `evidence/d1-final-contacts-requests.json`.

Final integrated verification:
- `pnpm exec vitest run apps/web/src packages/chat-ui/src packages/ui-web/src packages/contracts/src --maxWorkers=4`: **2213/2213**,179 files,30.35s.
- `pnpm --filter @rakazo/web --filter @rakazo/chat-ui --filter @rakazo/ui-web --filter @rakazo/contracts --filter @rakazo/core check`: all five passed after the last source changes. The11-package check earlier in this integration also passed; only frontend source/config changed afterward.
- `RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest`: passed.
- `RAKAZO_ALLOW_DEV_SECRETS=1 MEASURE_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts "$BASELINE_DIST" dist` and `... tsx scripts/measure-contacts-load.ts dist`: results above, mocked API/auth only.
- With a local production preview, `pnpm --filter @rakazo/web exec playwright test e2e/recruiting-app-routes.spec.ts e2e/recruiting-contacts-cold.spec.ts --workers=1 --output=/tmp/rakazo-final-production-routes`: **11/11**,31.0s; desktop/mobile routes and cold contacts/detail/focus.
- Same preview, `... playwright test e2e/recruiting-lingui.spec.ts --workers=1 --output=/tmp/rakazo-final-lingui`: **2/2**,1.8s; English/Chinese accessible names and error feedback.
- Same preview, `... playwright test -c playwright.d2.config.ts --repeat-each=3 --output=/tmp/rakazo-final-query-check`: **3/3**,5.5s, zero duplicate reads each run.
- `... playwright test -c playwright.candidates.config.ts --output=/tmp/rakazo-final-virtualization`: **3/3**,10.5s. Candidate fixture:14 initial/19 maximum rows,36 maximum cards,0 long tasks; actual Transcript:17 initial/24 maximum rows,0 long tasks, selection/focus/prepend/tail behaviors pass. Fixture JS includes newly separated virtualizer code: candidate146934B gzip,6 total/2 JS requests; Transcript489585B,10 total/5 JS requests. These fixture byte counts are not product-entry budgets.
- Production Web TS/TSX scan (excluding tests/locales): **268 files, maximum1499 lines, zero over1500**.

Browser commands used installed headless Chromium, unique output directories and only loopback services. The owned preview was shut down after verification. No deployment or online acceptance occurred. Historical intermittent shortcut read-count failure remains documented; the final2213-test run passed with the unchanged exact assertion and extra diagnostics.

## Continued final-budget investigation

After the parent requested continued work toward250KB, safe canonical constant extraction `d2ad4af8f` was integrated as `05d218cee`. It moves RUN_TRIGGERS to a constant-only leaf while preserving the original export and schema instances. Integrated `pnpm exec vitest run packages/contracts/src packages/core/src/thread-reducer.test.ts --maxWorkers=2` passed350/350 in1.81s; contracts/Web checks passed. A fresh Chinese production build and both actual cold-entry scripts independently reproduced contacts347873B (7 JS/35 requests/17 RPC/0 duplicates), chat310602B (8 JS/39 requests), sign-in203472B (7 JS/15 requests). Full request evidence is `evidence/d1-trigger-leaf-requests.json`; this supersedes the immediately previous byte totals, not the earlier historical baselines.

The remaining contacts gap is97873B and chat gap60602B. `D1-250KB-OPTIONS.md` records a concrete design decision with measured source attribution: feature catalogs have a25534B diagnostic saving estimate (337 initial-message entries of2006; not a production net result), action extraction offers only several KB to roughly10KB, and current Zod schemas expose JSON-schema methods that cannot safely be stripped. Official Mini migration changes canonical public APIs and requires ORPC/error/transform parity. No new registry, schema API replacement, hidden content or validation reduction was implemented. Larger options await a design decision; this is not a claim that250KB is impossible or all safe opportunities are exhausted.

## Shortcut investigation resolved with a deterministic lifecycle defect

A corrected, isolated D4 baseline run captured the extra RPC stack: `readThreadSnapshot -> refreshGroupThread -> useShellMessages.ts Timeout`. An earlier Shell instance had unmounted without cancelling its3000ms send-echo fallback. The same real3100ms test fails on the actual initial `f28310991` baseline with expected0/actual1, and on unpatched D4; no product changes were made to the initial baseline. This establishes a pre-existing lifecycle defect. Historical failures without RPC stacks cannot individually all be asserted to have this cause.

Portable fix `1b927fbae` and confirmed-event test `aee66a16e` are integrated as `bc0621928` and `52cfe7474`. The hook cancels its timers on unmount and avoids creating a timer if an accepted send receipt arrives after unmount. Mounted fallback still reads once; unmounted, late-receipt and durable-event-confirmed cases read zero. No shortcut assertion, mock queue, authorization, accepted-send or nonce semantics were weakened. The full investigation and controlled comparisons are in `SHELL-SHORTCUT-READ-INVESTIGATION.md`.

Final integrated `pnpm exec vitest run apps/web/src packages/chat-ui/src packages/ui-web/src packages/contracts/src --maxWorkers=4`: **2216/2216**,179 files,31.14s. Web check and production build exited0. The two actual Chinese cold-entry measurement scripts again exited0 on this exact product code: contacts**347938B**,7 JS/35 requests/17 RPC/0 duplicates; chat**310672B**,8 JS/39 requests; sign-in**203469B**,7 JS/15 requests. Request evidence: `evidence/d1-echo-fix-requests.json`. Final250KB remains unmet (contacts97938B, chat60672B above it), with the larger design options documented separately. No publication, deployment or cloud action occurred.

## Published integration backend gates (2026-10-27)

Execution revision4aaa64941c93ab05a172e95d9423a9952672ac8f, merged by#302; private workspace dependencies and generated Prisma client. Node24.19.0/pnpm9.15.0. No source or branch modifications during verification.

```sh
pnpm exec vitest run packages/db/src apps/api/src --maxWorkers=2
EXPO_OFFLINE=1 pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker --filter @rakazo/testkit --filter @rakazo/mobile --filter @rakazo/web --filter @rakazo/ui-web --filter @rakazo/chat-ui check
TZ=UTC DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_root VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts packages/db/src/space-membership.postgres.test.ts packages/adapters/src/pi-oauth-durable.postgres.test.ts packages/adapters/src/expo-push.postgres.test.ts
RLS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2_rls_root pnpm exec vitest run packages/db/src/actor-db.postgres.test.ts
```

DB/API2,609passed/430skipped,64.06s;11packagechecks passed (not separately timed); actual local PostgreSQL307/307,22.69s; independent RLS18/18,761ms.430skips are not passes. Expo offline validation does not validate the online dependency catalog. These numbers precede the separately tested C5 foundation; its worker/Python gates are recorded in C5-LOCAL-DRAIN.md.

F2 ownership remains Claude. Existing `job-reconciler.test.ts`, `turn-end-guard.test.ts`, `recruiting-question-nudge.test.ts`:59/59,1.24s. The first fresh-worktree attempt failed two imports because the generated Prisma client was absent; `pnpm --filter @rakazo/db generate` restored the normal prerequisite before this successful run. No F2 implementation was changed, no actual worker crash or online outcome was tested.
