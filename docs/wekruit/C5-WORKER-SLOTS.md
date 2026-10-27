# C5: independent worker slots (local implementation)

This follow-up implements the selected API + worker-a + worker-b topology as three independent App definitions. It does not create or deploy Apps and does not connect the production release entry to them. C5's real rolling-release acceptance remains untested.

## Admission and replacement

A verified home cutover receipt is required. An operator must initialize an explicit external session reservation (at least one) and desired worker generations under a quiesced scope. There is no migrated boolean override. Each worker reserves five sessions before constructing its hard-capped pool of four and its single listener; each API reserves one listener. Query traffic remains on DATABASE_URL port 6543; session traffic uses REALTIME_DATABASE_URL port 5432. Normal stable service usage is 12; with one external reservation, API old-two/new-two overlap plus two workers reaches 15. Larger external reservations remain safe but can prevent API rollout progress; actual platform overlap ordering is untested.

Global reservations are serialized in PostgreSQL. Connection identity registration verifies PID, exact backend start, application_name, database, observer role and activity visibility. It supplements physical connection caps rather than pretending to prevent TCP creation after the fact. Missing visibility or altered labels fail closed. Neither reservations nor the global replacement claim expire automatically.

The operator entry is `apps/worker/src/replace-slot.ts`, bundled with `node scripts/bundle-server.mjs slot-control`. It accepts a plan and the Python executable with Modal 1.6.1. The plan binds each selected App ID, deployment name, environment, guarded entry, slot and generation. The adapter checks actual name-to-ID and container-to-App identity before mutations; deployment uses the same verified in-memory App object. It never substitutes absence/errors for a finished-container observation.

Replacement holds a global claim, samples a ready peer at each critical step, drains the selected worker without cancellation, closes physical sessions, rotates its desired generation, stops the identified container, confirms that original process finished and PostgreSQL sessions disappeared, and only then recreates that slot. A replacement's admission still passes the same global cap. A timeout postpones replacement; it does not kill a busy worker. Slow platform observations occur outside short database transactions, while generation/lease/status checks remain atomic inside them. Peer readiness is sampled, not a continuous availability guarantee.

Concurrent shutdown callers share completion/failure. Pool shutdown waits for physical client end events; release additionally checks actual PostgreSQL state. Failed close, unexpected tagged sessions, a live old process, stale generation, missing observation or a crashed controller retain admission/claim for attended recovery. Normal worker exit without a generation rotation also retains its reservation. Recovery must inspect the exact old process, sessions, desired generation and any uncertain deployment before exact-token release or continuation; there is no blind retry, TTL takeover or automatic reversal to an old generation.

## Build identity

API/worker bundling writes a source revision, entry SHA-256 and admission protocol to `dist/build-manifest.json`. Release archives already carry the verified `.wekruit-source-revision`; clean local builds use Git HEAD, while dirty/unknown builds cannot start a slot. The serialized Python lifecycle checks the actual image files before constructing a runtime or spawning Node, so an old image without the new Node guard is also rejected. Node checks again before reserving sessions. Runtime environment variables cannot replace this manifest. Offline tests do not prove the identity of an image actually deployed remotely.

## Local verification

Run with the repository's Node 24/pnpm runtime and only an isolated synthetic PostgreSQL database:

```sh
SESSION_ADMISSION_TEST_DATABASE_URL="$LOCAL_TEST_DATABASE_URL" pnpm exec vitest run packages/db/src/session-admission.postgres.test.ts packages/adapters/src/session-admission-runtime.postgres.test.ts packages/adapters/src/slot-replacement.postgres.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker check
python -m unittest discover -s infra/modal -p 'test_*.py'
node scripts/bundle-server.mjs api worker slot-control
```

The three dedicated PostgreSQL suites passed 23/23 (5.43 seconds): concurrent global budget, actor isolation, exact backend identity, physical shutdown races, failed close, actual child-process death, generation fencing, slow platform observations, and replacement with two real local Node workers and loopback health endpoints. Their work is synthetic tick work, not a real provider job. The separate earlier C5 drain suite tests actual Graphile jobs. Final migration source was deployed from empty into the isolated database; no production migration ran. Schema diff has no new admission-table difference; four pre-existing FK onUpdate differences remain outside this change.

Python tests passed 29/29, including real SDK 1.6.1 offline registration and negative App/entry/container/build-manifest binding. The realtime/drain/manifest/operator-plan focused suites passed 14/14. Four relevant package typechecks passed. Full regression and final committed-build evidence are recorded in the PR.

## Remaining external acceptance

The SDK adapter uses pinned private client/protobuf/import APIs; local tests assert their 1.6.1 contracts, but no remote call was made. Initial Apps, resource bindings, verified storage migration/stopped-writer window, exact external-session allocation and bootstrap generations still require an approved release procedure. Actual container stop/deploy behavior, pooler label/observer compatibility, crash recovery in that environment, 1 Hz homepage/RPC availability and uninterrupted live conversations have not been tested. No production configuration, Secret, resource or deployment was changed.
