# A2 first-batch RLS pilot

This is an opt-in, locally tested first batch, not a completed deployment or whole-schema RLS rollout. The protected tables are `artifacts`, `messages` and `recruiting_roles`. Other tables retain their existing application-level filters.

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

Results: six real-PostgreSQL RLS tests pass; DB/API/testkit typechecks pass; DB unit suite 1,216 pass / 362 skip; API 1,322 pass / 50 skip. The six database tests cover missing owner filters, foreign writes, membership revocation, missing identity, privileged-role and permissive-policy rejection, batch/callback transactions, rollback cleanup, concurrent actors and deferred iterator pulls. Their actor pool has one connection and is idle while streams wait.

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
