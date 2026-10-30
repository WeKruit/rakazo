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

Later work on split services and worker slots is tracked as C5 in [../wekruit/ARCHITECTURE-WORKPLAN.md](../wekruit/ARCHITECTURE-WORKPLAN.md) and the `../wekruit/C5-*.md` notes.
