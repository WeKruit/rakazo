# C5: local process split and safe worker drain foundation

C5 remains **in progress**. This change does not enable split deployment, multiple production containers or rolling publication. Claim `558f876037ae931f8a8a47508adf06d3075fe756` was pushed before implementation.

## Implemented

- `infra/modal/service_runtime.py` extracts the existing startup/supervision/shutdown implementation. It can start only API/Web or only worker; tests assert separate subprocess sets and readiness ports. The existing `infra/modal/app.py` still starts both, migrates first, uses the same resources, and commits the legacy Volume only after children are reaped.
- Worker `SIGUSR2` starts a single idempotent deployment drain. Existing Graphile `runner.stop()` stops taking new work and waits for active jobs. Reconciliation stops independently. The executor shutdown signal, pools and lease heartbeats remain alive during this drain. Normal SIGTERM remains the existing emergency cancellation path and must not substitute for completed pre-drain.
- Optional `WORKER_HEALTH_PORT` exposes read-only `/health`, `/ready`, `/drain`. Readiness turns 503 once draining starts; drain completion requires successful stop of both jobs and reconciliation. No HTTP method starts a drain. No new authentication credential is introduced.
- `infra/modal/drain_worker.py` runs inside one selected worker container, sends SIGUSR2 to its recorded PID and polls loopback. Timeout/failure raises and prohibits replacement; it never sends SIGTERM/SIGKILL. A timed-out worker remains draining; operators postpone cutover and recheck, rather than claiming admission resumed.
- `topology.py` validates the 6543 transaction / 5432 session URL boundary and whole-rollout session budget. API=1 and worker=5 permanent sessions. Two of each consume 12; adding one replacement worker consumes 17 and is rejected. Full overlap consumes 24 and is rejected. Two APIs plus one worker consume 7, full overlap plus one migration consumes 15. Reducing to one worker is not silently selected.
- No placeholder split deployment entrypoint is added. Actual two-service Modal definitions remain unimplemented until safe shared-home cutover and worker replacement are ready. The existing release scripts remain unchanged and retain their enforced production drain protection. The existing runtime now rejects distinct database URLs that do not satisfy the required 6543/5432 boundary.

## Actual local validation

Node 24.19.0, pnpm 9.15.0, PostgreSQL 16, synthetic local database only:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --filter @rakazo/db generate
DATABASE_URL="$LOCAL_TEST_DATABASE_URL" pnpm --filter @rakazo/db migrate
VERIFY_DATABASE=1 DATABASE_URL="$LOCAL_TEST_DATABASE_URL" pnpm exec vitest run apps/worker/src/drain.postgres.test.ts apps/worker/src/drain.test.ts packages/adapters/src/wakeup-graphile-host.test.ts
PYTHONPATH=infra/release python3 -m unittest infra.modal.test_topology infra.modal.test_service_runtime infra.release.test_modal_config infra.release.test_release
pnpm --filter @rakazo/worker check
node scripts/bundle-server.mjs api worker
pnpm exec biome check apps/worker/src/drain.ts apps/worker/src/drain.test.ts apps/worker/src/drain.postgres.test.ts apps/worker/src/health.ts apps/worker/src/index.ts
git diff --check
```

- TypeScript: **21/21** passed, including one actual PostgreSQL/Graphile two-worker test. A's active synthetic job finishes exactly once; B accepts/completes a new job while A is draining; A does not report drained before its active job completes. This is two queue hosts, not two Modal containers or an external-agent conversation.
- Python: **62/62** passed, including topology budgets, independent process plans, failed-migration no-spawn, legacy reap-before-commit, timeout without termination, existing runtime URL validation, and existing release/config regression tests.
- Worker typecheck and API/worker bundles pass. No production credentials, data, candidates, jobs, messages, cloud resources, Secret/config changes or deployment were used.

## Exact remaining gates

C1/C2's object `current` pointer is still the legacy authority. It is not safe to make ephemeral container caches authoritative until all existing snapshots have been inventoried and copied, their Computer `homeRevision` mappings verified, and publication/read paths atomically switched. Existing post-checkpoint revision writes must not overwrite a newer CAS publication. Initial cutover also must eliminate old uncoordinated writers; a flag asserting migration completed is insufficient. Experimental CAS work was deliberately excluded from this PR.

The safe follow-up should reuse existing Computer revision and maintenance fencing, immutable snapshot uploads and short DB transactions, without another queue/lock service or permanent connection. No migration to actual storage was attempted. Existing bucket/three server-only configuration fields and actual pooler availability remain unverified.

Multiple worker rolling requires serialized replacement **after** successful per-worker drain, with a live worker retained and total sessions bounded. App-level recreate of all workers is not equivalent. The release controller for this sequence is not enabled here; existing promotion protection remains closed. Long tasks exceeding the deadline postpone publication rather than canceling a conversation.

Not tested: actual Modal routing/replacement, cloud resource initialization, graceful process termination on the platform, reconnecting SSE/WebSockets, 1Hz online homepage/RPC zero failures, live conversation continuity, full aggregate connection high-water mark, or first shared-storage cutover. C5 cannot be marked complete from this local foundation.
