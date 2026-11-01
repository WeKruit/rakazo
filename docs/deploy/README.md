# Production deploy notes

Working notes for the hosted headhunter deployment (Modal app behind a Cloudflare Worker), moved here from the project's shared folder so release work can read them from the repo.

| File | What it is |
|---|---|
| [release-cloud.sh](./release-cloud.sh) | Current release script: `check`, `test`, `deploy` (recreate strategy, single container), auto-rollback, and `watch` (pre-tests and prebuilds the image for each new main head in the background). Tests reuse one checkout and run only affected tests after a tested ancestor; `RELEASE_FULL_TESTS=1` forces the whole suite, the Modal image is built while tests run (`RELEASE_PREBUILD=0` turns it off). Needs `RAKAZO_URL` (the Modal app URL) and Modal token env vars. |
| [ROLLING-DEPLOY-PROPOSAL.md](./ROLLING-DEPLOY-PROPOSAL.md) | 2026-10-23 proposal: rolling deploy with a Postgres writer lock, and what blocks zero downtime. |
| [DB-POOL-ARCHITECTURE-20261027.md](./DB-POOL-ARCHITECTURE-20261027.md) | Connection budget: transaction pooler (6543) for queries, session pooler (5432) only for LISTEN, queue and locks. |
| [secret_split.py](./secret_split.py) | The one-off script that split `DATABASE_URL` / `REALTIME_DATABASE_URL`. Never prints values. |
| [MULTI-CONTAINER-PLAN-20261027.md](./MULTI-CONTAINER-PLAN-20261027.md) | State that still pins production to one container, and the steps to remove it. |
| [ARCHITECTURE-GAPS-ITEM1.md](./ARCHITECTURE-GAPS-ITEM1.md) | Items 0 and 1 of the 2026-10-27 architecture gap audit. |

## Test environment

A full copy of production for development and test runs, so they never block production users. It lives in the Modal environment `test`: App `wekruit-recruiting-test`, Volume `wekruit-recruiting-test-files`, Secret `wekruit-recruiting-test-config`, and Secret `wekruit-recruiting-test-db` holding `DATABASE_URL` for its own database. It has its own sign-in and encryption keys and no mail or outreach credentials, so it cannot send real email or outreach.

- `RELEASE_TARGET=test RAKAZO_TEST_URL=<test app URL> release-cloud.sh <SHA|branch> deploy` deploys any pushed commit; no unit tests or idle wait. A pass is recorded in `RELEASE_TEST_PASSED_DIR` (default `$RELEASE_WORK/test-passed`; keep it on durable storage).
- `RAKAZO_TEST_URL=<test app URL> sync-test-data.sh` replaces the test database with a copy of production (production is only read), pauses routines, cancels unfinished runs, empties the job queue, removes sessions and push tokens, then redeploys the test app. Connections stay encrypted with the production key, which the test environment does not have, so they cannot send anything.
- A test deploy passes only after the staging journeys (`regression.mjs --suite staging`) pass on it: the recruiter's real path with sign-in, the left-nav pages, the first question within 4 s, searches with a countdown and its progress report, a progress question, a mid-search requirement, a bare "再来点", Kruit memory recalled in a role chat, and a server restart mid-search that the search survives. It takes about 20 minutes and a few dollars of capped searches, needs `RELEASE_CASES` and the test account (`RAKAZO_EMAIL`/`RAKAZO_PASSWORD`), and sends nothing. `RELEASE_TARGET=test release-cloud.sh <SHA> journeys` reruns them on the build already deployed there. The test environment cannot open production's CRM and calendar connections, so Sequence, Inbox and Interview, and the booking-card check (`--only approval`), wait until it has connections of its own; production's post-deploy page check still covers those pages.
- A production deploy refuses a commit whose code (outside `docs/`) has not passed on the test environment. Rollbacks are exempt; `RELEASE_SKIP_TEST_ENV=<short SHA>` is the explicit emergency override.

Later work on split services and worker slots is tracked as C5 in [../wekruit/ARCHITECTURE-WORKPLAN.md](../wekruit/ARCHITECTURE-WORKPLAN.md) and the `../wekruit/C5-*.md` notes.
