# A2 first-batch RLS pilot

This is an opt-in, locally tested first batch, not a completed deployment or whole-schema RLS rollout. The first batch protects all 22 recruiting tables, messages/artifacts, and the thread/task/run/event/effect ownership dependencies (29 tables). See [the precise batch boundary and full-schema inventory](A2-RLS-COVERAGE.md). General assistant data, shared collaboration, auth and system tables are separate later batches or authority boundaries; they retain existing application authorization.

## Identity and transaction boundary

`ACTOR_DATABASE_URL` selects a separate non-owner, non-superuser, non-BYPASSRLS login for authenticated RPC database access. The API's RPC Prisma client, thread events and memory services use that connection. Auth/session resolution, webhooks, workers and migrations retain the explicit system client. The protected client fails if actor context is absent; it cannot fall back to the system connection. On startup it rejects privileged roles, membership in privileged/owner roles, missing first-batch policies and additional permissive policies.

The native Prisma driver-adapter boundary preserves callback and batch transaction semantics. Standalone queries get a short transaction. Every transaction sets `app.user_id` and `app.space_id` with transaction-local `set_config(..., true)`. Native transaction commit/rollback releases that identity. Async iterators restore the original verified actor on each `next`, `return` or `throw`; waiting for stream events does not hold an open database transaction.

The policies require matching user, Space and current Space membership. Message ownership is resolved through its thread. Application authorization remains in place. Database-level checks supplement those filters; they do not replace consent, membership, external-send or agent tool authorization.

## Local validation

Use Node 24.19.0 and pnpm 9.15.0. All database URLs below point to a newly created synthetic loopback PostgreSQL 16 cluster. Never substitute a production database. `actor-db.postgres.test.ts` rejects non-loopback targets and database names outside its dedicated prefix. It creates and drops its own temporary restricted role, seeds two fake users and applies the checked-in policy script.

```sh
createdb -h 127.0.0.1 -p 55434 -U postgres rakazo_a2_rls
psql postgres://postgres@127.0.0.1:55434/postgres -c "ALTER DATABASE rakazo_a2_rls SET timezone='UTC';"
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @rakazo/db generate
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2_rls pnpm --filter @rakazo/db exec prisma migrate deploy
RLS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2_rls pnpm test packages/db/src/actor-db.postgres.test.ts
pnpm --filter @rakazo/db --filter @rakazo/api --filter @rakazo/testkit check
pnpm --filter @rakazo/db test
pnpm --filter @rakazo/api test
```

Original three-table results (before the follow-up below): six real-PostgreSQL RLS tests pass; DB/API/testkit typechecks pass; DB unit suite 1,216 pass / 362 skip; API 1,322 pass / 50 skip. The six database tests cover missing owner filters, foreign writes, membership revocation, missing identity, privileged-role and permissive-policy rejection, batch/callback transactions, rollback cleanup, concurrent actors and deferred iterator pulls. Their actor pool has one connection and is idle while streams wait.

The unchanged integration baseline's broader recruiting/membership PostgreSQL suites had 12 failures (271 passed), including after local timezone was changed to UTC. Those are recorded in the main work plan and require their own fixes plus integrated regression; the six RLS tests do not erase them.

## Local API fixture and latency reproduction

Create a second empty local database. The following role exists only in the throwaway local cluster. Applying this SQL is deliberately separate from automatic Prisma migrations.

```sh
createdb -h 127.0.0.1 -p 55434 -U postgres rakazo_a2_api_rls
psql postgres://postgres@127.0.0.1:55434/postgres -c "ALTER DATABASE rakazo_a2_api_rls SET timezone='UTC';"
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2_api_rls pnpm --filter @rakazo/db exec prisma migrate deploy
psql postgres://postgres@127.0.0.1:55434/rakazo_a2_api_rls -v ON_ERROR_STOP=1 -f packages/db/prisma/rls/first-batch.sql
psql postgres://postgres@127.0.0.1:55434/rakazo_a2_api_rls -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE rakazo_a2_api_actor LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO rakazo_a2_api_actor;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rakazo_a2_api_actor;
SQL
# Reuse the existing isolation fixture and acceptance, replacing only Docker startup.
python3 - <<'PY'
from pathlib import Path
source = Path('packages/testkit/src/cli/account-isolation.ts').read_text()
source = source.replace('import { PostgreSqlContainer } from "@testcontainers/postgresql";\n', '')
source = source.replace('const container = await new PostgreSqlContainer("postgres:16-alpine").start();', 'const container = { getConnectionUri: () => "postgres://postgres@127.0.0.1:55434/rakazo_a2_api_rls", stop: async () => {} };')
Path('packages/testkit/src/cli/.a2-local-isolation.ts').write_text(source)
PY
API_PORT=3194 ACTOR_DATABASE_URL=postgres://rakazo_a2_api_actor@127.0.0.1:55434/rakazo_a2_api_rls pnpm exec tsx packages/testkit/src/cli/.a2-local-isolation.ts --out /tmp/rakazo-a2-rls-api-isolation.json
rm packages/testkit/src/cli/.a2-local-isolation.ts
RLS_BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2_api_rls RLS_BENCH_ACTOR_DATABASE_URL=postgres://rakazo_a2_api_actor@127.0.0.1:55434/rakazo_a2_api_rls pnpm exec tsx packages/testkit/src/cli/rls-benchmark.ts
```

The original API acceptance with RLS enabled returned 143 OK, zero leaks/warnings and 99 unexercised reads, matching the baseline fixture's coverage limits. Empty-owner scenarios are not verified isolation evidence.

The benchmark reads the same synthetic `artifacts/listSpace` RPC in both modes, with 20 warmups and 200 requests per mode at concurrency five. It requires exactly the two fixture users and a dedicated loopback database. Measured baseline p50/p95/max: 6.84/11.71/15.04 ms. RLS: 7.45/12.06/20.50 ms. Both had zero errors; local p95 increased 2.99%. This is not the required online p95 measurement.

## Deployment prerequisites — not executed

An authorized operator must provision a distinct restricted application login and review grants, while retaining separate system/background/migration authority. The restricted login must not own protected tables or be a member of a privileged/owner role. Policies must be applied explicitly before setting `ACTOR_DATABASE_URL`; startup fails if they are absent. Existing table ownership intentionally remains with the system/migration identity. The SQL does not create roles, credentials or cloud resources.

Production `ACTOR_DATABASE_URL` must use port 6543, as enforced by environment validation. `DATABASE_URL` remains on the transaction pooler; `REALTIME_DATABASE_URL` remains on 5432. Enabling the option adds an actor transaction pool with the same `DB_POOL_MAX`, so API transaction checkout capacity changes from N to 2N. It adds no LISTEN connection or session pool: the existing six-session-per-container budget is unchanged. Both API pools have bounded shutdown cleanup. Production backend concurrency, pool waits and p95 latency still need measurement; local PostgreSQL tests do not emulate a real transaction pooler.

Current authorization forbids production role/grant/credential changes, policy activation, cloud configuration and deployment. None was attempted. Production rollout, additional protected tables, real transaction-pooler execution and online latency are outstanding. Do not mark whole-plan A2 completed from this pilot alone.

## Local core-recruiting follow-up

The expanded six-table policy script passes eight real-PostgreSQL tests, including foreign revision parent insertion, foreign shortlist-message links, forged calibration approver, own revision transaction and organization membership revocation. DB/API/testkit typechecks pass. The original API isolation fixture was rerun against all six policies in a new synthetic database: 143 OK, zero leaks/warnings, 99 reads empty for the owner too. Latency figures above still describe the original three-table script and are not a six-table measurement. Parent integration separately fixed the original 12 recruiting failures and reports 283/283 on its integrated branch; that result is not claimed for this branch.

## Complete recruiting receipt batch

The final local first-batch policies cover 29 tables; 11/11 PostgreSQL tests pass. Every table has nonempty data for both synthetic accounts, with restricted-role insertion/update and omitted-filter reads. All 29 reject access after organization membership removal and enforce both user and active Space when a user belongs to both Spaces. The schema cascades removed organization membership to Space membership; prior “stale membership” phrasing did not reflect that constraint. Ten cross-parent mutation cases reject specifically through RLS. The enhanced original API isolation fixture returns 144 OK, zero leaks/warnings, and 98 owner-empty reads still unexercised.

First full-batch latency run: baseline p50/p95/max 7.02/9.32/19.44 ms; RLS 10.49/16.25/26.09 ms; zero errors, p95 **+74.36%**, exceeding the target. Earlier three-table +2.99% is historical and must not be used for this batch. Production performance remains untested, and local performance is not yet accepted.

### Quiet-window counterbalanced measurement

The final policies were applied to the existing synthetic fixture. Other agents paused heavy tests/builds for this run. The benchmark executes B/R/R/B/B/R, with 20 warmups and 200 measured requests at concurrency 5 per sample. All requests succeeded.

| Sample | Mode | p50 ms | p95 ms | Max ms | Errors |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 7.35 | 12.25 | 15.96 | 0 |
| 2 | RLS | 9.29 | 14.64 | 17.81 | 0 |
| 3 | RLS | 8.47 | 11.67 | 18.79 | 0 |
| 4 | Baseline | 5.43 | 7.27 | 10.56 | 0 |
| 5 | Baseline | 5.49 | 8.10 | 10.10 | 0 |
| 6 | RLS | 8.33 | 11.56 | 16.70 | 0 |

Paired p95 changes: **+19.51%, +60.52%, +42.72%**. None meets <10%. The mean of sample p95 values is 9.2067 ms baseline versus 12.6233 ms RLS (+37.11%); this is explicitly not a pooled 600-request p95. Sample medians are 8.10 versus 11.67 ms. The original +74.36% run remains above; these results do not replace it with a best case. **Local performance acceptance fails; production performance is untested.**

Native Prisma callback/batch transactions already bind identity once. Standalone operations still require BEGIN, transaction-local identity binding, business SQL and COMMIT. The policy membership lookup was changed to an uncorrelated actor-constant lookup, but no request-wide transaction, identity caching or privileged fallback was introduced. Further safe reduction requires a separately reviewed query/transaction boundary optimization and measurement; production permission would not itself fix this local overhead.

### Narrow policy-planning optimization

The artifact-list endpoint already executes one business SQL statement; there was no duplicated application query to batch. A corrected diagnostic instrument waited for completion for both node-postgres callback and Promise APIs (an initial callback timing experiment measured submission only and is discarded). On 200 sequential direct calls to the same `listSpaceArtifacts` implementation:

| State | SQL class | Calls | Mean ms | p95 ms |
| --- | --- | ---: | ---: | ---: |
| Before, baseline | Business | 200 | 0.6173 | 0.7720 |
| Before, RLS | BEGIN | 200 | 0.0808 | 0.1207 |
| Before, RLS | SET LOCAL | 200 | 0.1112 | 0.1445 |
| Before, RLS | Business | 200 | 2.2746 | 2.6086 |
| Before, RLS | COMMIT | 200 | 0.1297 | 0.2031 |
| After, baseline | Business | 200 | 0.5524 | 0.6262 |
| After, RLS | BEGIN | 200 | 0.0674 | 0.0788 |
| After, RLS | SET LOCAL | 200 | 0.0878 | 0.1021 |
| After, RLS | Business | 200 | 1.1078 | 1.1929 |
| After, RLS | COMMIT | 200 | 0.0804 | 0.0949 |

Before total operation time: baseline 144.999 ms, RLS 549.392 ms. After: baseline 128.858 ms, RLS 286.181 ms. These sequential diagnostic timings are not HTTP p95 or a controlled throughput test. `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the same synthetic artifact query gave before baseline planning/execution 0.229/0.101 ms and RLS 1.724/0.318 ms; after baseline 0.210/0.092 ms and RLS 0.411/0.566 ms. The principal excess was policy-plan expansion, not just three additional network round trips.

The wired `public.rakazo_actor_member()` is SQL STABLE, SECURITY INVOKER, has fixed `pg_catalog` search_path and fully qualified membership relations. The fixed configuration avoids SQL-function inlining. Policies invoke it through statement-local InitPlans; no actor/membership result is cached across requests. Message policies inherit the already-protected thread instead of repeating the same membership join. Startup rejects a SECURITY DEFINER, IMMUTABLE or incorrectly configured helper. The 29-table/15-cross-parent suite now passes **12/12**, including both unsafe function mutations, membership revocation, pooled actor switching and concurrent iterators. HTTP acceptance after this change still requires the second quiet-window run.

### Final quiet-window HTTP result after optimization

The same B/R/R/B/B/R procedure, same two synthetic fixture users, 20 warmups and 200 requests at concurrency five per sample was repeated after other agents paused heavy work.

| Sample | Mode | p50 ms | p95 ms | Max ms | Errors |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 6.43 | 8.89 | 18.50 | 0 |
| 2 | RLS | 7.54 | 14.06 | 17.85 | 0 |
| 3 | RLS | 7.27 | 10.19 | 11.56 | 0 |
| 4 | Baseline | 5.49 | 9.62 | 20.17 | 0 |
| 5 | Baseline | 5.44 | 8.05 | 9.59 | 0 |
| 6 | RLS | 6.67 | 9.38 | 13.29 | 0 |

Paired p95 changes are **+58.16%, +5.93%, +16.52%**. Only one pair is below 10%; the local comparison is **not consistently within target**. Mean sample p95 is 8.8533 versus 11.2100 ms (+26.62%), with sample medians 8.89 versus 10.19 ms. These summaries are not pooled-request percentiles. Both quiet-window runs and the earlier +74.36% result are retained; no best sample is selected as acceptance.

The work plan's formal p95 gate is an **online measurement**. Deployment is prohibited, so that formal gate remains **not measured**, independently of the observed local overhead. First-batch database isolation is locally validated; A2 is not complete or approved for activation. A performance review is needed before rollout.

### Remaining performance design options, not implemented

The measured endpoint has one business SQL statement. The restricted adapter executes exactly BEGIN + SET LOCAL + business SQL + COMMIT (200 of each in the diagnostic), while existing native callback/batch transactions already share one identity binding. There is no repeated application query to remove in this endpoint. A request-wide transaction would hold connections over external I/O or streams and was not introduced.

Further options require evidence and separate review: reduce policy parent expansion with explicit, integrity-constrained ownership columns on selected child tables; identify genuinely database-only multi-query services that can use one existing native transaction; and verify transaction-pooler behavior in the authorized staging/online environment. Prepared statements were not enabled because compatibility with the actual 6543 transaction pooler has not been verified. No SQL parameter concatenation, session identity reuse, membership cache or SECURITY DEFINER workaround is acceptable. No additional architecture change is justified by selecting one favorable local percentile.

Final post-function API isolation rerun on a new synthetic database: **144 OK, zero leaks/warnings, 98 owner-empty reads still unexercised**. The final DB/API/testkit typechecks pass. No production database, roles, cloud configuration, deployment, real candidate/job, or outbound service was used. Publication remains paused; the implementation branch has no new PR or remote merge.

### Continued diagnosis: static membership query plan

A narrow follow-up changes only the helper's implementation language from SQL to PL/pgSQL with a static `RETURN EXISTS` query. SECURITY INVOKER, STABLE, fixed `pg_catalog` search_path, fully qualified relations and the policy InitPlan calls remain unchanged. PostgreSQL may reuse the static query's plan; **neither membership results nor actor values are cached**. Current settings and membership rows are evaluated on every statement. This is internal server-side function planning, not named client prepared statements or session identity reuse. Existing 12 PostgreSQL safety tests pass, including one-connection actor switching, two-Space membership, all-table revocation and unsafe helper-attribute rejection.

Same diagnostic method, 20 warmups and 200 sequential direct `listSpaceArtifacts` calls:

| Mode / SQL | Calls | Mean ms | p95 ms |
| --- | ---: | ---: | ---: |
| Baseline business | 200 | 0.5429 | 0.6350 |
| RLS BEGIN | 200 | 0.0467 | 0.0702 |
| RLS SET LOCAL | 200 | 0.0697 | 0.0971 |
| RLS business | 200 | 0.8169 | 0.9299 |
| RLS COMMIT | 200 | 0.0634 | 0.0876 |

Total baseline 129.081 ms; RLS 220.614 ms. The prior SQL-helper sample had RLS business mean 1.1078 ms and total 286.181 ms. EXPLAIN planning/execution: baseline 0.237/0.096 ms; RLS 0.444/0.181 ms (prior SQL helper 0.411/0.566 ms). This supports reducing helper execution overhead, not declaring HTTP acceptance. A coordinated six-sample HTTP rerun is pending.

The explicit BEGIN/bound SET LOCAL/business/COMMIT sequence still adds three commands per standalone read. node-postgres processes queued commands after ReadyForQuery; merely submitting four Promises without awaiting is not a supported wire-protocol pipeline and complicates rollback/error safety. No protocol internals, concatenated identity values, dynamic SQL gateway, wider connection lifetime, or permission-result cache was introduced. Removing the remaining commands would require a separate transaction/driver architecture decision and end-to-end error, cancellation and pooler validation.

### Final static-plan HTTP measurement and remaining cost

The coordinated run's first request log is **2026-10-27 04:42:26.032 UTC**, after the other reported Web/Mobile tests ended at 04:42:08 UTC. The quiet window is valid; it was not rerun to select a better sample. Warmups, sample counts, concurrency and B/R/R/B/B/R order are unchanged. The benchmark now preserves all 1,200 raw request durations in `RLS_BENCH_TRACE`, emitted only after measurement.

| Sample | Mode | p50 ms | p95 ms | Max ms | Errors |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 6.47 | 8.66 | 15.77 | 0 |
| 2 | RLS | 7.04 | 10.06 | 14.12 | 0 |
| 3 | RLS | 6.68 | 11.64 | 18.53 | 0 |
| 4 | Baseline | 5.33 | 7.82 | 8.83 | 0 |
| 5 | Baseline | 5.16 | 8.22 | 8.58 | 0 |
| 6 | RLS | 7.11 | 14.33 | 17.86 | 0 |

Paired p95 changes: **+16.17%, +48.85%, +74.33%**. True pooled 600-request p95 per mode, computed from retained raw durations: **8.183625 → 13.029083 ms (+59.21%)**. All samples are included; no pair passes <10%. Sample-p95 means are 8.2333 → 12.0100 ms, a separate statistic. First-quarter and later-quarter tails both occur (RLS sample 6 quarter p95 values 14.378/12.443/11.897/17.137 ms), so this is not dismissed as only first-request warmup.

A separate concurrency-five diagnostic retained pool max four, matching the configured default rather than increasing connection budget. For 200 calls: baseline pool checkout mean/p95 0.2684/0.5642 ms; RLS 0.3312/1.2461 ms. Baseline business SQL mean/p95 0.7413/0.7377 ms; RLS 0.8736/1.0138 ms. RLS BEGIN/SET/COMMIT each ran 200 times, with means 0.0922/0.1009/0.0982 ms. Total concurrent workload elapsed 62.846 ms baseline versus 97.367 ms RLS. This supports longer checked-out transaction lifetime and queue-tail amplification in addition to remaining policy execution. It is not a replacement for the HTTP result.

No further unsupported architecture change was made. The standalone transaction boundary requires three extra commands with the current supported driver API; increasing pool capacity requires a connection-budget decision, and a protocol pipeline/new transactional gateway requires error/cancellation/pooler validation. Wider transactions around I/O, cross-request permission caching, parameter concatenation, definer privileges, and unverified named prepared statements remain excluded. The safe static-plan improvement is retained because direct SQL execution improved while all isolation tests pass, but **local HTTP target remains unmet; formal online gate remains unmeasured**.

## Final integration gates before Draft publication

Ordinary merges incorporated PR #263 head `168fcaacc088e063b8cd2d0dc3b52b414f7eb88a`, then `8188c88f3c58299030b8dbfb2ea128144c2a8755`. The two middleware conflicts preserve both actor binding and pagination: authenticated handlers execute inside `withDatabaseActor`, paginate their result, then retain iterator context.

On that final integrated code: DB/API/testkit typechecks passed; DB unit suite **1,216 passed / 373 skipped** (3.60 s); API unit suite **1,377 passed / 51 skipped** (44.31 s); PostgreSQL RLS/recruiting/membership **298 passed** (27.63 s). The PostgreSQL command was `TZ=UTC VERIFY_DATABASE=1 DATABASE_URL=<synthetic-db> RLS_TEST_DATABASE_URL=<synthetic-rls-db> pnpm test packages/db/src/actor-db.postgres.test.ts packages/db/src/recruiting.postgres.test.ts packages/db/src/space-membership.postgres.test.ts`. API used `pnpm exec vitest run apps/api/src --maxWorkers=2 --reporter=verbose` with local test sockets permitted.

The final real API fixture on a fresh synthetic database returned **144 OK / 0 leaks / 0 warnings / 98 owner-empty reads**. An intermediate integrated run returned 142/0/0/100 with zero synthetic usage rows, whereas the final run had two usage rows; both results are recorded rather than treating empty-owner cases as isolation passes. An old pre-integration API run was interrupted without a final result and is not counted as passing. No gate depends on CI.

Publication is authorized for review, but this remains a Draft with the formal online gate unmeasured and local performance not consistently within target. It must not be marked complete or activated from these results.
