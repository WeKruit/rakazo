# C5: database-authoritative homes and offline split-service preparation

This follow-up implements local prerequisites, not the online C5 acceptance. The existing production entry and release commands remain unchanged. No migration, storage copy, deployment, cloud resource, or secret change has been run against production.

## Publication and old writers

`Computer.homeRevision` is the authoritative pointer. A committed revision is `v2:<generation>:<sha256>`. Snapshot bytes live in the independent `home-snapshots-v2/` namespace. Upload and digest-checked readback happen before a short transaction locks the Computer and compares the expected revision. The same existing query pool serves these transactions; there is no extra persistent connection. Readers check the database and digest; a missing or corrupt committed object is an error, never an empty home or legacy fallback.

Checkpointing captures the expected revision before sandbox export. Publication validates the current maintenance operation, run execution fence, or exact existing lifecycle claim. Team access checks current Space membership rather than the first creator's user ID; dedicated access keeps its owner boundary. Stored bot-folder cleanup is the separate existing `editStored` path, not permission for an unowned checkpoint. All three post-checkpoint database recording paths verify the already committed revision instead of writing it again.

Database triggers reject old or same-value explicit revision writes, skipped generations, malformed revisions, and identity/scope changes after activation. Ordinary heartbeat and legitimate Computer/Space deletion still work. An internal SHA256 home-key tombstone survives deletion and prevents a later legacy recreation from resetting authority. A narrow fixed-search-path SECURITY DEFINER helper reveals only retirement existence so restricted actors can create normal computers without reading or modifying internal metadata. Publication remains system-only. Database-owner DDL, disabling triggers, and TRUNCATE privileges are outside this application-old-writer boundary; ordinary actors must not receive those privileges.

## Complete migration and new homes

`inspectHomeMigration` inventories every legacy Computer and its actual object pointer, byte length, and SHA256. Missing pointers are errors: a missing legacy snapshot is not assumed empty. `activateHomeMigration` requires an injected deployment driver that keeps **all** old API and worker writers stopped, and prevents admission/restart, for the entire copy and transaction. It must keep them stopped after success or failure. A stopped Computer row, a transient process probe, or a database lock alone cannot supply that guarantee. There is no production driver or operator CLI wired to this source.

The activation procedure re-reads every source object, validates the portable archive, copies into the independent namespace, verifies readback, and atomically checks a complete unchanged database inventory with no live runs/maintenance/execution leases. The transaction records a system-only receipt containing the verified manifest digest and activation time. This is written by successful verification, not a configuration boolean.

After that receipt exists, the INSERT trigger reserves new computers as `v2:pending`; existing legacy rows cannot be updated into that sentinel. Only that reservation may be initialized with a verified empty snapshot, and concurrent initializers use the same first-generation CAS. Storage failure leaves the reservation retryable. No existing committed snapshot is replaced with empty data. Current actor creation remains supported; the system home adapter initializes the reservation on first access. Removing object-storage configuration after any activation/receipt fails startup closed.

Docker and desktop local-directory computers are not a supported migration input for this shared remote fleet. Inventory rejects them, and an activated database rejects creation/switching to those kinds. A database containing such computers needs its separate migration/design resolved before this cutover; the code does not silently convert mounted paths or drop data.

## Split services and replacement

See [C5-REPLACEMENT.md](./C5-REPLACEMENT.md). `create_split_services` registers actual API and worker server definitions against Modal SDK 1.6.1 without resolving resources or making cloud calls. Image and existing secrets are injected. Each container gets disposable DATA_DIR storage, no shared writable volume, and a mandatory real preflight callback before startup. It is not imported by the production entry.

API max 2 at 1 session each plus worker max 2 at 5 each is 12 sessions. An extra worker would be 17 and whole-generation overlap 24, exceeding the existing 15-session total. The replacement policy therefore drains one worker, confirms process stop **and zero sessions**, then starts a replacement while another worker stays ready. Its driver must provide a fleet-wide lease and atomic capacity reservation, including API/other sessions. A timeout postpones replacement rather than killing an active task. The fake driver proves policy, not a live Modal replacement implementation.

## Local validation

Commands run from the repository root with Node 24.19.0 and pnpm 9.15.0. `$C5_TEST_DATABASE_URL` denotes a dedicated loopback synthetic database, never a production URL. Tests explicitly reject unrelated database names.

```sh
pnpm --filter @rakazo/db generate
DATABASE_URL="$C5_TEST_DATABASE_URL" pnpm --filter @rakazo/db migrate
VERIFY_DATABASE=1 DATABASE_URL="$C5_TEST_DATABASE_URL" pnpm exec vitest run packages/adapters/src/home-authority.postgres.test.ts
HOME_AUTHORITY_TEST_DATABASE_URL="$C5_TEST_DATABASE_URL" pnpm exec vitest run packages/db/src/home-authority-rls.postgres.test.ts
pnpm exec vitest run packages/adapters/src --maxWorkers=2
pnpm --filter @rakazo/db --filter @rakazo/adapter-kit --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker check
python -m unittest discover -s infra/modal -p 'test_*.py'
node scripts/bundle-server.mjs api
node scripts/bundle-server.mjs worker
```

Final source replay from an empty isolated PostgreSQL database passed. Authority tests: 14/14; restricted-role tests: 6/6; adapters: 5,118 passed / 73 skipped; API/worker/db: 2,616 passed / 437 skipped; five package checks, API/worker bundles, 25 Python tests, Biome and diff checks passed. Prisma diff contains no new C5-model differences; four pre-existing foreign-key onUpdate differences remain outside this change. The first sandboxed full run was stopped after network-fixture timeouts; the final full runs passed with loopback access. An earlier scratch database was manually synchronized while the migration was under development; it is not the fresh-replay proof.

Not measured: real storage inventory/copy/readback, actual writer quiescence/admission fencing, cloud driver lease/capacity enforcement, deployed split-service readiness, session high-water under real traffic, every-second homepage/RPC probes during a release, and uninterrupted real conversations. No online completion is claimed.
