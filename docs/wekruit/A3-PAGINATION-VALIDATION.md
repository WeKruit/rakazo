# A3 local pagination validation

Status: implementation validated locally; online acceptance and integration remain pending. Initial Draft PR: https://github.com/WeKruit/rakazo/pull/277 (base `claude/project-thread-f1cbzk`, never `main`). Adam claim: `6540579bf`. Initial implementation: `8a5764a4622c753516caac575ef93d0a435c6557`.

## Scope

Bot/group reads use database `take <= 200`, stable ordering and explicit continuation. Navigation/bootstrap preserve selected threads outside the first page and sparse group pages. Contacts query only observed LinkedIn identities in scoped batches of at most 200 instead of materializing the role's complete candidate-key list; contact output has cursor continuation.

The shared `ARRAY_LIST_RPC_PATHS` inventory covers 31 configuration/catalog read lists, with offset input validation and authenticated response pagination. Five structured reads paginate their named arrays: research questions, research tasks/actions/observations, scheduling plans/slots, runs, and tickets. Web and mobile collect all pages for existing full-list consumers; explicit offsets request a single page. Mutation receipts are untouched. Configuration queries may still materialize the user's complete configuration collection before response slicing; this is a response-size bound, not a claim that every database query is bounded.

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
- Adapter request comparison with 1,000 synthetic list records: previous full-list API contract used one unbounded response; updated array-list adapter uses six bounded requests (five full pages plus the terminal empty page). Existing screens receive all 1,000 records. These are adapter/mock request counts, **not measured browser page-load counts**. No first-load JS bundle measurement was performed for this API-only adapter change.
- No pool configuration changes. The synthetic PostgreSQL test uses maximum 2 connections. Production per-container session count, `DATABASE_URL` transaction-pooler port 6543, and `REALTIME_DATABASE_URL` direct port 5432 were not changed or measured by A3.

## Remaining acceptance

Online 1,000-candidate contacts-view RPC p95 < 300 ms is **not tested**. No deployment, live provider call, real candidate/job test, cloud configuration change, or CI enablement was performed. Final integration tests must run on the combined #263 branch; this worktree's results do not substitute for that run.
