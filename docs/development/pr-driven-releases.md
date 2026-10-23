# PR-driven validation, restricted staging and production eligibility

This change supplies synthetic release validation, an explicitly activated hosted
staging path, and production eligibility checks. **Production promotion always
stops before any Modal mutation:** no enforceable deployment pause/drain mechanism
has been found or implemented. A quiet-session snapshot cannot prevent a new run
from starting during the build or cutover. Keep all deployment and Autumn holds.

No workflow was deployed or activated by this development task. Read the
[development delivery](../handoff/2026-10-23/development-delivery.md),
[CRM delivery](crm-sync-delivery-2026-10-23.md) and
[Modal runtime instructions](../../infra/modal/README.md) before owner activation.

## Three distinct stages

| Stage | What it establishes | What it does not establish |
| --- | --- | --- |
| [Release validation](../../.github/workflows/release-validation.yml) | Disposable native PostgreSQL, existing Pi emulator and synthetic CRM tests; exact-source candidate archive after successful main CI. | A hosted environment, live provider behavior or business acceptance. |
| [Restricted hosted staging](../../.github/workflows/staging.yml) | Authorized deployment of the candidate to existing isolated Modal resources, database-backed readiness, source revision, web shell and rejected mutation requests. | Interactive product use, agent execution, real CRM sync, email or recruiting acceptance. |
| [Production eligibility](../../.github/workflows/promote-production.yml) | Validation/staging provenance, receipt and artifact identity, live read-only staging smoke, environment protections and release prerequisites. | Permission or an implementation to cut over production; the missing pause/drain mechanism remains a hard blocker. |

Existing broad PR CI retains lint, typechecks, builds, unit tests, database
journeys and Web E2E. `release-validation.yml` runs synthetic checks for PRs and
after completed CI. Only a successful CI push to `main` can produce a promotable
candidate; a PR result cannot. Skipped CI is never treated as passed.

Hosted staging is manual and disabled by default. Dispatch uses
`validation_run_id` and `expected_sha`; the workflow fetches that exact validation
artifact and uses the existing Modal `recreate` strategy. It uploads `staging.json`
only after its restricted smoke succeeds. Production takes `staging_run_id` and
`expected_sha`, verifies the hosted run and receipt against the original
validation artifact, and repeats a live read-only staging smoke. Missing, expired,
ambiguous or mismatched evidence fails closed. No step substitutes latest `main`.

The manifest records the full Rakazo SHA, archive checksum, CI/validation run
identity, pinned headhunter source and every product migration's full name and SQL
checksum in lexical order. The current source pin is
`11ca9c2df226782eee241fc5b36ba15600f4efcb`. This records a dependency; it does not
prove source SQL or MCP deployment. The candidate is an exact source archive,
not a promoted prebuilt Modal image. Modal rebuilds it using the pinned source and
lockfile; byte-identical images are not claimed.

[`release.py`](../../infra/release/release.py) implements `package`,
`fetch-validation`, `stage`, `fetch` and `promote`. Deployment entrypoints re-fetch
and verify trusted provenance before consuming the candidate; an arbitrary local
release directory is not accepted as trusted evidence.

## Synthetic validation and hosted isolation

Run synthetic validation locally with dependencies installed, native PostgreSQL
binaries available, and a clean checkout without dotenv files:

```sh
python3 infra/release/validate.py --sha "$(git rev-parse HEAD)"
# Add --pg-bin <binary-directory> if native PostgreSQL binaries are outside PATH.
```

The [validation runner](../../infra/release/validate.py) creates its own loopback
database and temporary home, rejects dotenv files and discards inherited live
credentials through an allowlisted subprocess environment. It uses no Docker,
production-data copy, deployment credentials or real CRM/provider connection.
The existing Pi test exercises a real executor persisting a file and completed
run. CRM fixtures cover scoped reads, dry-run separation, incomplete reads,
cursor integrity and isolation. These are implementation checks.

Hosted staging runs the native Web/API/worker entrypoints in a restricted mode.
The API permits only the health/readiness GET endpoints; product mutation routes
are denied. The worker does not start job processing or providers. The web shell
can load, but this is deliberately not an interactive recruiting environment.
The smoke checks `/ready`, database readiness, the exact `x-rakazo-revision`, the
web document and rejection of a mutation request. The denied probe must not create
an account, start a run, synchronize CRM data or send mail. Public `/health`
remains constant liveness and is insufficient on its own.

Staging's existing Modal runtime Secret must contain the distinct prefixed values
`STAGING_DATABASE_URL`, `STAGING_BETTER_AUTH_SECRET` and
`STAGING_ENCRYPTION_KEY`. The sanitizer maps only the approved staging values into
an allowlisted runtime environment; generic database/auth/provider credentials
are not forwarded. The database name and username must both be `rakazo_staging`,
and the connection must require TLS. The owner must verify the role cannot read
production databases, the database contains only synthetic data, and the dedicated
staging Volume is fresh and contains no production files or credentials. Naming
checks alone do not prove those access boundaries.

Use an existing isolated staging app, environment, Secret, database and Volume.
App, Secret and Volume names must each match
`^rakazo-staging(?:-[a-z0-9-]+)?$`; the Modal environment is fixed to `staging`.
No workflow creates the resources, copies production data or borrows the
production Secret. Staging startup can apply product schema migrations to its
isolated database; that future operation requires explicit staging activation.
If any resource or credential is absent, stop for separately authorized setup.

## Activation and approval controls

Both workflows verify a main-only deployment branch policy and environment-scoped
credential/approval names through GitHub's APIs. Production additionally verifies
a required-reviewer rule with `prevent_self_review=true`. Unsupported or unreadable
controls fail closed. The environment GET response does not expose the
administrator-bypass setting; the script does not verify it. The owner must
verify in GitHub's dashboard that administrators cannot bypass protection before
installing any environment-scoped credentials. See the
[environment API](https://docs.github.com/en/rest/deployments/environments#get-an-environment).

Verify those protections before credential installation: an in-job check runs
after job startup and cannot make a misconfigured environment safe for secrets.
An environment label or repository JSON variable is not an approval gate, and
private-repository plan support must not be assumed. This PR does not change
environment policies, branch protection or dashboard settings. Production's
unconditional cutover stop remains even if eligibility checks pass.

| Setting | Restricted staging | Production eligibility |
| --- | --- | --- |
| GitHub environment | `staging` | `production` |
| Activation/hold variables | `STAGING_DEPLOY_ENABLED=true`, `STAGING_DEPLOYMENT_HOLD=clear` | `MODAL_PROMOTION_ENABLED=true`, `PRODUCTION_DEPLOYMENT_HOLD=clear` |
| Existing Modal resource variables | `STAGING_MODAL_APP_NAME`, `STAGING_MODAL_SECRET_NAME`, `STAGING_MODAL_VOLUME_NAME`; Modal environment fixed to `staging` | `MODAL_APP_NAME`, `MODAL_SECRET_NAME`, `MODAL_VOLUME_NAME`, `MODAL_ENVIRONMENT` |
| Origin variable | `STAGING_ORIGIN` | `PRODUCTION_ORIGIN` |
| Environment-scoped Modal credential names | `STAGING_MODAL_TOKEN_ID`, `STAGING_MODAL_TOKEN_SECRET` | `PRODUCTION_MODAL_TOKEN_ID`, `PRODUCTION_MODAL_TOKEN_SECRET` (metadata checks only; values are not injected) |
| Environment-scoped approval secret | `STAGING_RELEASE_APPROVAL` | `PRODUCTION_RELEASE_APPROVAL` |
| Environment-scoped metadata-read secret | `ENVIRONMENT_AUDIT_TOKEN` | `ENVIRONMENT_AUDIT_TOKEN` |

Production also requires trusted copies of `STAGING_MODAL_APP_NAME`,
`STAGING_MODAL_SECRET_NAME`, `STAGING_MODAL_VOLUME_NAME` and `STAGING_ORIGIN` in its
environment variables to compare the hosted staging receipt with the expected
target. Its workflow neither installs Modal nor injects Modal credential values;
the eligibility check only verifies the required secret names exist.

Listing environment secret names requires repository `Environments: read`
permission, which the ordinary workflow `github.token` cannot be assumed to have.
The owner-supplied `ENVIRONMENT_AUDIT_TOKEN` is used only for that metadata API;
it reads no secret values. Missing access or HTTP 403 fails closed without a
broader-token fallback. See
[List environment secrets](https://docs.github.com/en/rest/actions/secrets#list-environment-secrets).
Creating or installing this token is a separate access/credential decision; it
has not been done here.

Staging pins the existing Modal CLI version `1.6.2`; missing resources must not
be created implicitly. Any credential installation, secret creation, access
change, resource, subscription or additional cost requires separate confirmation.
Keep both activation gates off until that review is complete.

Staging's approval secret contains the exact full `sha`, numeric
`validation_run_id`, `isolated_resources_verified: true`,
`synthetic_data_only: true` and `expires_at` as a UTC ISO timestamp ending in `Z`,
no more than 30 minutes ahead. The owner must establish those facts before setting
the secret; the record is not itself evidence that isolation has been tested.

Production's approval secret records the exact `sha`, numeric `staging_run_id`,
`previous_sha`, pinned `source_sha`, the same expiry bound, `active_runs: 0`,
`autumn_paused: true`, `source_migrations_verified: true`,
`product_migrations_approved: true` and `rollback_compatible: true`. These are
release assertions behind the verified environment gate. **They cannot unlock
production cutover in this implementation.** An `active_runs: 0` snapshot and an
expiring JSON record are not a lock or a deployment drain.

Before production can be implemented safely, a separately reviewed mechanism must
prevent new runs and provider/worker work throughout image build, replacement and
readiness verification, while preserving the real Autumn pause and active state.
It must fail safely if the drain cannot be maintained and retain one file-store
writer. Do not remove the unconditional production stop or enable a legacy path
to work around this blocker.

Modal's `recreate` strategy terminates old containers at cutover and can retry
in-flight inputs on replacements. See the [deploy CLI](https://modal.com/docs/cli/latest/deploy)
and [deployment strategy documentation](https://modal.com/docs/guide/managing-deployments).
The intended production concurrency group remains `production`, with cancellation
disabled; serialization between release jobs does not prevent application runs.

## Source, schema and business prerequisites

The authorized owner must inspect actual source and product migration ledgers by
full name and checksum. Source migrations
`20261023180000_crm_candidate_presence` and
`20261023181000_crm_candidate_presence_secondary_roles`, and the existing MCP's
corrected protocol, precede any later real CRM sync. Vercel success does not prove
SQL/MCP deployment. Product migrations
`20261023172000_recruiting_calibration_rounds` and
`20261023172000_recruiting_crm_sync_progress` are distinct, in that order; earlier
same-prefix names also remain distinct. Do not infer ledger completeness from a
date prefix.

The normal Modal runtime applies product migrations at startup, so any eventual
production cutover is a migration-capable release. Require schema review,
backup/recovery evidence, the exact previous accepted source and verified rollback
compatibility. Workflow assertions do not query production to establish these
facts or authorize database changes.

The owner separately reported `e740fa441b1db2d1bc64cb546a623f4f99982042` healthy and
ready, source migrations applied, existing MCP v11, and a dry run underway. This
is attributed evidence, not validation by this CI/CD task, a completed real sync
or permission to change the hold. Obtain current owner evidence before release.

CRM sync stays separate from release. Follow the CRM delivery procedure only with
its own authorization: `dryRun: true`, inspect incomplete-read reports, then a new
cursor for an approved `false` pass. No release, smoke, rollback or monitoring hook
invokes either mode against the real CRM. Do not replay outreach, invitations or
historical approvals. Restricted staging does not constitute business acceptance.

## Monitoring with existing facilities

| Signal | Evidence and limit |
| --- | --- |
| Revision/readiness | Manifest and deployment metadata, `/ready` and `x-rakazo-revision`; public `/health` proves liveness only. |
| API errors/latency | Existing structured HTTP status/duration and RPC timing fields around the release time. |
| Startup | API/worker `boot.phase`, Modal startup/readiness phases, migration failures and process exits. |
| Run status | Native lifecycle events and persisted status; waiting on a person is not automatically a failure. |
| CRM | `crm.sync.failed`, `crm.sync.incomplete`, `crm.sync.slice` and `crm.sync.completed` with `dry_run=false`. |

Sync events reuse `@rakazo/logging` and the configured sink. Success events follow
transaction commit; a rejected transaction emits a failure event without its raw
error. Completion requires `nextCursor=null` and no skipped reads. Only completion
with `dry_run=false` indicates a real successful pass. The latest such event
supports service-wide recency from activation onward, not a lag guarantee for
every user, connection or organization. No historical backfill or new durable
sync-history table is supplied; row `syncedAt` is not whole-sync completion.

Event fields contain aggregate counts, flags and duration capped at 125 seconds.
Counts are cumulative across slices; do not sum them. The skipped count is capped
at 50. No new IDs, cursors, skipped reasons, URLs, contacts or raw errors are added;
existing log correlation/redaction still applies. Keep credentials, candidate
identities and message/provider payloads out of public CI artifacts and PRs.
Alert thresholds and routing remain owner setup; no new monitoring platform,
production-data copy or periodic sync is introduced.

## Remaining delivery and setup blockers

- Publication: repository webhook reads returned HTTP 403. Empty deployment/status
  lists do not prove external preview apps absent. Preserve local commits, patch
  and draft PR text until the complete push/PR-trigger audit is possible.
- Hosted validation: publish/merge only with the relevant authority, then run CI,
  candidate validation and explicitly authorized restricted staging. Inspect the
  exact-SHA artifacts, receipt and smoke evidence. Local checks are not those runs.
- Staging activation: verify all existing isolated resources, runtime values,
  account/billing access, main-only environment controls, administrator-bypass
  settings and scoped secrets before installing credentials. Separately authorize
  the environment-metadata read token if absent; no missing resource, credential
  or access grant is created by this task.
- Production activation: verify enforceable environment approval controls and
  separately implement/review the real pause/drain boundary. Eligibility checks
  intentionally fail before deployment until that mechanism exists.
- Business acceptance: current source/schema evidence, authorized real-provider
  testing and eventual CRM acceptance remain separate owner work. Product bug
  fixes, full interactive staging and alert setup are outside this change.

An independent reviewer should receive changed files, exact head, local commands
and results, unexecuted stages and these blockers. Workflow files alone do not
make an environment operational. This is partial CI/CD delivery, not a completed
autonomous production release system.

## Legacy and external paths

Keep legacy SSH/Compose, mobile OTA and server-image publishers disabled during
review; their opt-ins do not bypass the production drain requirement.

| Path | Existing explicit conditions |
| --- | --- |
| SSH/Compose | `LEGACY_COMPOSE_DEPLOY_ENABLED=true`, `PRODUCTION_DEPLOY_ENABLED=true`, `PRODUCTION_DEPLOYMENT_HOLD=clear`, `PRODUCTION_APPROVED_SHA` equal to the tested SHA, and Modal promotion not enabled. |
| Mobile OTA | `MOBILE_OTA_PUBLISH_ENABLED=true`, Modal promotion not enabled, and existing OTA compatibility checks. |
| Server images | `SERVER_IMAGE_PUBLISH_ENABLED=true`; independent distribution that can feed an updater, requiring its own authorization. |

SSH, OTA and Modal promotion share the `production` concurrency group. The legacy
host script also requires `RAKAZO_LEGACY_COMPOSE_APPROVED_SHA` to match the full
SHA argument and `RAKAZO_DEPLOYMENT_HOLD=clear`; it refuses moved `main`. No host
configuration is changed. Mutable image tags do not establish Modal staging
acceptance. Desktop/tag and manual native releases remain separate; do not create
tags or dispatch them as part of this work.

Head-hunter Vercel integration is unchanged. Do not push to that repository or
assume `[skip ci]` suppresses Vercel; earlier PR-specific authorization does not
carry over. Rakazo's marketing configuration also does not prove whether previews
are enabled. Audit apps/webhooks as well as Actions, including the existing
Playwright report workflow's external-storage writes after PR CI.

## Failure and rollback

1. Stop on failed eligibility, deployment, readiness, revision or smoke checks.
   Preserve the attempted SHA and failure evidence; a successful deploy command
   or open port is not acceptance. Retain the deployment/Autumn holds.
2. The authorized owner checks migration outcome and active state. A failed
   rollout may already have applied migrations. Preserve the single writer and
   do not resume jobs, research or outreach as a diagnostic.
3. Retrieve the exact previously accepted source archive and manifest; verify
   checksums and private deployment evidence. Establish compatibility with the
   current schema and persisted state before any replacement.
4. Only through a separately authorized owner recovery procedure, and with the
   required drain maintained, recreate the existing app from compatible previous
   source, retaining its Secret and Volume. There is no automated production
   rollback or cutover in this implementation.
5. If schema/data compatibility is unknown, stop for migration recovery or a
   forward fix. Do not automatically run down migrations, restore a database,
   replace a Volume or assume a Git revert reverses data writes.

The bootstrap revision `e740fa441b1db2d1bc64cb546a623f4f99982042` predates the
`x-rakazo-revision` response header. It cannot satisfy the new automated smoke or
receipt contract. A first recovery to that version requires owner verification
of the exact prior SHA/file hashes and independent health/readiness evidence;
never weaken the normal smoke check or claim a new-style receipt for old code.

Do not invoke CRM sync or send mail to test recovery. Modal's platform rollback
feature is [plan-limited](https://modal.com/docs/guide/managing-deployments);
this procedure does not assume it is available or request a plan upgrade.
