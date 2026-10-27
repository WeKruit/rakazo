# A3 local pagination validation

Status: implementation validated locally; online acceptance and integration remain pending. Draft PR: https://github.com/WeKruit/rakazo/pull/277 (base `claude/project-thread-f1cbzk`, never `main`). Adam claim: `6540579bf`. Initial implementation: `8a5764a4622c753516caac575ef93d0a435c6557`.

## Scope

Bot/group reads use database `take <= 200`, stable ordering and explicit continuation. Navigation/bootstrap preserve selected threads outside the first page and sparse group pages. Contacts query only observed LinkedIn identities in scoped batches of at most 200 instead of materializing the role's complete candidate-key list; contact output has cursor continuation.

The shared `ARRAY_LIST_RPC_PATHS` inventory covers 31 configuration/catalog read lists, with offset input validation and authenticated response pagination. Five structured reads paginate their named arrays: research questions, research tasks/actions/observations, scheduling plans/slots, runs, and tickets. Web and mobile collect all pages for existing full-list consumers; explicit offsets request a single page. Mutation receipts are untouched. Pagination is now pushed into the query layer for 28 of these 36 read endpoints (the explicit `DATABASE_PAGED_LIST_RPC_PATHS` inventory), using `take/skip` or SQL `LIMIT/OFFSET` and deterministic ordering. The response middleware leaves those pages intact. Latest candidate assessments use SQL `DISTINCT ON` before the page limit; research tasks/actions are paged independently. Filtered computer updates and saved research observations scan bounded chunks so filtered records cannot terminate continuation early. Internal service calls without an explicit offset retain their prior semantics.

The remaining eight endpoints deliberately use response pagination:

- `models/list` and `voice/catalog` enumerate generated/static catalogs; existing credential/authorization lookups remain in place.
- `connections/catalog`, `connections/tools`, and `voice/voices` consume complete provider-array interfaces that expose no shared offset contract. Their responses are bounded, but repeated pages can repeat provider/catalog reads; no new authorization cache or provider cursor is invented.
- `models/backups` has a configured maximum of 10; `botSecrets/list` already reads at most 100 metadata rows.
- `recruiting/schedulingPlans` already reads at most 100 retained effects and expands their saved slots; plans and expanded slots are separately response-paged. This does not claim the expanded provider payload is a database row list.

These distinctions prevent treating a response cap as proof of bounded database work. No configuration-list RPC backed by an unbounded primary collection is left using full-collection response slicing.

Previously bounded reads retain their existing limits: candidate/feedback/source/note/reminder/profile pages, search (25), usage (100), computer command history, artifact-space and routine-run cursors. Interview correspondence already bounds events to 200 and marks partial results. Detail/state/export endpoints and mutation receipts are not treated as list endpoints.

## Commands and outcomes

Use the repository's Node 24 runtime. The repository script is `check` (TypeScript); there is no root `typecheck` script.

```sh
pnpm --filter @rakazo/api --filter @rakazo/db --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile check
pnpm --filter @rakazo/api --filter @rakazo/db --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile test
VERIFY_DATABASE=1 DATABASE_URL="$A3_TEST_DATABASE_URL" pnpm test packages/db/src/list-pagination.postgres.test.ts
pnpm --filter @rakazo/api --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile check
pnpm --filter @rakazo/api --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile test
```

Initial implementation: all five checks passed; package tests 6,432 passed / 413 skipped. Dedicated local synthetic PostgreSQL suite: 2 passed. Database URL in the command is a placeholder for a dedicated local synthetic database, never production.

Follow-up checks passed for API/contracts/core/web/mobile. Follow-up package suites: API 1,373 passed / 50 skipped; contracts 296 passed; core 1,238 passed / 5 skipped; web 1,654 passed; mobile 1,004 passed. The final focused contract inventory and pagination run passed 99 tests across 5 files, including all 36 added offset contracts. A first sandboxed core run failed two terminal-server tests because temporary PTY sockets were unavailable; rerunning with authorized local socket access passed. Mobile dependency version checking ran offline and reported its reliability limitation; TypeScript itself passed.

## Measurements

- Synthetic PostgreSQL: 1,000 candidates, 10 warmups and 100 samples per query. Original whole-role query: 1,000 returned rows, p95 **0.88 ms**. Scoped observed-identity query: 20 returned rows, p95 **0.49 ms**. Cross-scope query returns zero rows. This measures database query latency, **not complete contacts RPC latency**.
- Synthetic PostgreSQL: all 1,000 bots returned uniquely across page sizes `200,200,200,200,200,0`.
- Contacts implementation test: 1,000 saved provider observations produce a 200-contact first response and cursor `200`; candidate membership reads are five batches of 200 scoped identities.
- Adapter request comparison with 1,000 synthetic list records: previous full-list API contract used one unbounded response; updated array-list adapter uses six bounded requests (five full pages plus the terminal empty page). Existing screens receive all 1,000 records. These are adapter/mock request counts, **not measured browser page-load counts**. Actual browser/build measurements are recorded below.
- No pool configuration changes. The synthetic PostgreSQL test uses maximum 2 connections. Production per-container session count, `DATABASE_URL` transaction-pooler port 6543, and `REALTIME_DATABASE_URL` direct port 5432 were not changed or measured by A3.

## Actual loopback HTTP RPC and browser measurements

A dedicated synthetic PostgreSQL role contains 1,000 candidate rows and one saved FullEnrich result with 1,000 matching synthetic contacts. The test starts the real ORPC router on a temporary loopback HTTP server and performs real HTTP requests and database reads, including thread/role authorization and response serialization. Only session authentication is replaced with a fixed synthetic actor. No provider request occurs; no credentials or real people are used. Pool maximum: 2.

- First HTTP run: 10 warmups, 100 samples, p50 **26.75 ms**, p95 **32.44 ms**, max **35.78 ms**.
- Final HTTP rerun after query pagination: 10 warmups, 100 samples, p50 **24.26 ms**, p95 **26.37 ms**, max **27.02 ms**. Five HTTP requests returned all 1,000 unique contacts, 200 per response.
- Final joint PostgreSQL/HTTP run: **3 passed** in two files. Its separate database-query p95 values were **8.52 ms** (1,000 returned rows) and **4.05 ms** (20 returned rows). This run overlaps the HTTP benchmark and has different load from the earlier isolated **0.88/0.49 ms** query run; neither replaces the HTTP measurement.

The real production web builds were measured with headless Chromium against blocked-external-network App/Shell fixtures, with 1,000 synthetic contact rows. Baseline commit: `e6b8446de`; after build includes `84b31f362` and the A3 adapters. Both read the same fixture and route. The after fixture asserts the candidate screen is visible; the baseline measurement establishes requests/JS bytes, not a passed UI correctness assertion.

| Metric | Before | After |
| --- | ---: | ---: |
| Contact HTTP responses | 1 × 1,000 rows | 5 × 200 rows |
| Total contacts delivered | 1,000 | 1,000 |
| JS requests on initial route | 15 | 15 |
| Loaded JS raw bytes | 2,060,327 | 2,066,452 |
| Loaded JS gzip bytes | 625,224 | 626,840 |
| All RPC requests observed in the bounded idle window | 16 | 25 |

JS increases by **6,125 raw bytes / 1,616 gzip bytes** for the continuation adapters. Overall RPC totals include unrelated screen queries and are timing-sensitive; only the contact-specific 1→5 request change is attributed to this pagination. The fixture uses a bounded two-second idle observation because event subscriptions remain open. Both browser cases passed. These are actual browser responses; they are separate from the earlier adapter-only six-request bot-list test (that endpoint needs an empty terminal page).

Additional commands (local paths represented by purpose-specific placeholders):

```sh
TZ=UTC VERIFY_DATABASE=1 DATABASE_URL="$A3_TEST_DATABASE_URL" pnpm test apps/api/src/list-pagination.postgres.test.ts packages/db/src/list-pagination.postgres.test.ts
TZ=UTC VERIFY_DATABASE=1 DATABASE_URL="$A3_TEST_DATABASE_URL" pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts -t 'pages latest distinct|pages research tasks|filters candidate questions'
pnpm --filter @rakazo/web build --outDir "$A3_BASELINE_DIST"
pnpm --filter @rakazo/web build --outDir "$A3_AFTER_DIST"
PLAYWRIGHT_BASE_URL="$A3_BASELINE_ORIGIN" A3_BASELINE=1 pnpm --filter @rakazo/web exec playwright test --config playwright.a3.config.ts
PLAYWRIGHT_BASE_URL="$A3_AFTER_ORIGIN" pnpm --filter @rakazo/web exec playwright test --config playwright.a3.config.ts
pnpm --filter @rakazo/api --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/contracts --filter @rakazo/core check
pnpm --filter @rakazo/api --filter @rakazo/adapters --filter @rakazo/contracts --filter @rakazo/core test
```

Final query-layer checks: API/DB/adapters/contracts/core all passed (including DB cross-package TypeScript). Final affected suites: API **1,376 passed / 51 skipped**, adapters **5,125 passed / 44 skipped**, core **1,238 passed / 5 skipped**, contracts **332 passed**. Earlier web **1,654** and mobile **1,004** passed; their production adapters did not change during the database-query follow-up. Local formatting and diff checks passed.

A subsequent attempted filtered recruiting PostgreSQL run used `pnpm test ... -t`; the package runner did not pass the filter through, and the complete file ran: **273 passed / 12 failed** against this branch before the separately developed recruiting fixture/source-receipt fixes were integrated. That run is not a passing gate. After integrating the separately validated source/receipt and fixture fixes, the **complete** file was deliberately rerun with `pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts`: **285 passed**, including all three new real-PostgreSQL pagination cases. DB TypeScript and cross-package checks then passed, and `pnpm exec vitest run packages/db/src/recruiting-candidates.test.ts` passed **425 tests**. The initial failed run is retained here as history rather than silently omitted. Final combined-branch regression remains required.

Publication preparation merged upstream `9b2705c66fe952aa90c1a011dcb51ed22c82ef82` normally. API/DB/adapters/contracts/core/web/mobile checks passed; web and mobile suites reran with **1,654 / 1,004 passed**.

After the ordinary merge of F1 base `168fcaacc088e063b8cd2d0dc3b52b414f7eb88a`, publication gates reran: API **1,376 passed / 51 skipped**, adapters **5,118 passed / 47 skipped**, core **1,239 passed / 5 skipped**, contracts **332 passed**; complete recruiting PostgreSQL **285 passed**; the two synthetic list/HTTP files **3 passed**. This HTTP run measured p50 **22.47 ms**, p95 **26.58 ms**, max **46.62 ms** (100 samples/10 warmups); its query-only p95 was **0.86/0.46 ms**. Earlier measurements above are retained, not overwritten.

The online Expo dependency-version advisory reported newly available patch versions and stopped the first combined check before mobile TypeScript. No lockfile/dependency upgrade was made. Repeating the seven-package check with `EXPO_OFFLINE=1` used the installed dependency map and passed all TypeScript checks; Expo explicitly notes that offline dependency-version advice is limited. This is separate from the passing mobile TypeScript and 1,004 unit tests.

## Remaining acceptance

Online 1,000-candidate contacts-view RPC p95 < 300 ms is **not tested**. PR #277 targets only the #263 integration branch; final merge status is tracked on that PR. No deployment, live provider call, real candidate/job test, cloud configuration change, or CI enablement was performed. Final integration tests must run on the combined #263 branch; this worktree's results do not substitute for that run.
