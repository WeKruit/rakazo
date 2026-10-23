# PR-driven staging and production releases

This change prepares a release path; it does not activate a hosted staging
environment or authorize a deployment. Keep the existing deployment and Autumn
holds until the assigned deployment owner verifies and lifts them. Creating a PR,
passing a test or supplying workflow inputs is not that authorization.

Read the [development delivery](../handoff/2026-10-23/development-delivery.md),
[CRM delivery](crm-sync-delivery-2026-10-23.md) and
[Modal runtime instructions](../../infra/modal/README.md) before activation.

## Release path

1. Review product changes through a PR. Existing broad CI continues to cover lint,
   typechecking, builds, unit tests, database journeys and Web E2E. This release
   change adds focused checks; it does not describe skipped CI as passed.
2. The explicit ephemeral [`staging.yml`](../../.github/workflows/staging.yml)
   workflow runs for PRs and after completed `ci` runs. It uses a native
   disposable PostgreSQL instance, the existing Pi emulator and synthetic
   CRM fixtures. It receives no production database, CRM, model, mail, sandbox or
   deployment credentials. It does not copy production data, run Docker, call the
   real CRM, send email or create a hosted staging URL.
3. After successful CI for a push to `main`, staging can produce the release
   candidate: an immutable source archive and manifest tied to that exact tested
   SHA. A PR staging result alone is not eligible for production promotion.
4. The separate
   [`promote-production.yml`](../../.github/workflows/promote-production.yml)
   workflow is manually dispatched with `staging_run_id` and `expected_sha`. It
   consumes the successful staging run and verifies the repository, workflow,
   event, commit, successful CI
   and staging jobs, artifact identity and checksums before using the archive.
   Missing, expired, ambiguous or mismatched evidence fails closed. It must never
   substitute the latest branch head or another run's artifact.
5. Once separately activated and authorized, production serializes the existing
   Modal `recreate` deployment. It retains one container and one file-store writer,
   the existing app/Secret/Volume and the established provider boundaries. No
   rolling strategy, extra replica, new resource or platform is introduced.

Modal supports `--strategy recreate`; it terminates the previous containers at
cutover and can retry their in-flight inputs on the replacement. The quiet-session
and single-writer prerequisites therefore remain necessary. See the
[deploy CLI](https://modal.com/docs/cli/latest/deploy) and
[deployment strategy documentation](https://modal.com/docs/guide/managing-deployments).

Release packaging, retrieval and promotion live in
[`infra/release/release.py`](../../infra/release/release.py) (`package`, `fetch`
and `promote`). The isolated native database checks live in
[`infra/release/staging.py`](../../infra/release/staging.py). To run the staging
checks locally against the current full SHA, with dependencies installed, native
PostgreSQL binaries available, and a clean checkout without dotenv files:

```sh
python3 infra/release/staging.py --sha "$(git rev-parse HEAD)"
# If native PostgreSQL binaries are outside PATH, add --pg-bin <binary-directory>.
```

The release candidate is pinned source plus lockfile and migration evidence. It
is not a previously built Modal image, and rebuilding it is not a claim of
byte-for-byte image reproducibility. Record the resulting platform deployment
revision alongside the source manifest in the owner's private release record.

## Release evidence and prerequisites

The manifest records the full Rakazo commit SHA, archive checksum, originating CI
and staging runs, the source dependency SHA, and every product migration's full
directory name and SQL checksum in lexical order. The current headhunter source
dependency is `11ca9c2df226782eee241fc5b36ba15600f4efcb`. Recording that value does
not prove the source SQL or MCP service has been deployed.

Before each production promotion, the authorized owner must establish all of the
following for that candidate:

- CI and isolated staging passed for the exact source revision; the downloaded
  artifact matches the manifest and is still available.
- Production activation and the separate release approval are explicit. Verify
  the repository's actual environment controls and plan capabilities; an
  `environment: production` declaration is not a required-reviewer gate by itself.
  No branch-protection or dashboard setting is changed by this PR.
- The active sourcing run has ended, Autumn's pause/hold is respected, outreach is
  stopped, and no run or file-store writer will be interrupted. Check current
  state immediately before replacement; a prior quiet-session report can expire.
- The actual source revision, ordered source migrations and existing MCP protocol
  version meet the CRM delivery requirements. Source migrations
  `20261023180000_crm_candidate_presence` and
  `20261023181000_crm_candidate_presence_secondary_roles` precede any later real
  CRM sync. Vercel deployment success is not source SQL/MCP evidence.
- The actual product migration ledger is compared with the manifest by full
  name and checksum, and the candidate's schema changes and backup/recovery plan
  are approved. A date-prefix match is insufficient. In particular,
  `20261023172000_recruiting_calibration_rounds` and
  `20261023172000_recruiting_crm_sync_progress` are two distinct migrations, in
  that order. Earlier same-prefix migrations also remain distinct.
- The exact previous release artifact and its migration compatibility are
  recorded, with a tested recovery procedure and an owner responsible for it.

The production job uses the `production` environment and `production` concurrency
group, with `cancel-in-progress: false`. It requires
`MODAL_PROMOTION_ENABLED=true` and `PRODUCTION_DEPLOYMENT_HOLD=clear`; neither is
configured by this PR. A per-release `PRODUCTION_RELEASE_APPROVAL` repository or
environment variable must contain an owner-verified JSON record:

```json
{
  "sha": "<exact 40-character candidate SHA>",
  "staging_run_id": 123456789,
  "expires_at": "<UTC ISO timestamp ending in Z, at most 30 minutes ahead>",
  "previous_sha": "<exact 40-character previous accepted SHA>",
  "active_runs": 0,
  "autumn_paused": true,
  "source_sha": "11ca9c2df226782eee241fc5b36ba15600f4efcb",
  "source_migrations_verified": true,
  "product_migrations_approved": true,
  "rollback_compatible": true
}
```

The example run number and placeholders are not an approval; `staging_run_id`
must be the actual successful run ID as a JSON number. The authorized owner supplies current
evidence and a fresh record for the exact candidate/run. Expiry bounds stale
assertions but does not replace checking current run state. Configure approval
variable write access and workflow dispatch access as part of the separately
authorized activation review; a boolean or JSON document is not independent
enforcement of a human reviewer.

The existing Modal runtime applies product migrations during startup. Activating
the production workflow therefore authorizes a migration-capable release, not
just an HTTP restart. Workflow prerequisite variables record owner assertions;
they do not query production to prove that a run is quiet, a backup is usable or
a migration has been approved.

The local owner has separately reported `e740fa441b1db2d1bc64cb546a623f4f99982042`
healthy/ready, source migrations applied, existing MCP v11, and a dry run underway.
This is an attributed report, not validation performed by this CI/CD task, not a
completed real sync, and not permission to change the deployment hold. Obtain
current owner evidence before activation.

## Isolation and smoke coverage

Ephemeral staging is a deterministic integration environment. Its native local
database is newly initialized with synthetic identities; cleanup belongs to the
same runner. Test setup rejects dotenv files and builds a small allowlisted
subprocess environment, discarding inherited database URLs and live-service
credentials. It creates its own loopback database URL and temporary home instead
of accepting an existing database. It must never restore production data or
borrow the production Modal Secret.

The existing Pi emulator test covers a real executor persisting a file and a
completed run. The CRM tests cover scoped reads, dry-run separation,
failed/incomplete source reads, cursor integrity and isolation. Fake responses are test
fixtures, not real recruiting acceptance. A successful smoke cannot establish
live provider behavior, real two-user acceptance or a successful sourcing outcome.

After an authorized promotion, safe probes check `GET /ready`, its
`x-rakazo-revision` header against the manifest SHA, and the `GET /` document.
These checks do not start a run, perform CRM sync or send mail. `/health` remains
constant public liveness and is insufficient alone. `/ready` checks readiness
without disclosing database details. Its revision header exposes only the source
SHA; keep richer health details on the existing operator-only path. Readiness and
a document response are limited smoke evidence, not full signed-in acceptance.

CRM sync remains a separate, explicitly authorized operational step. Follow the
CRM delivery procedure for `dryRun: true`, inspect incomplete-read reports, then
start a fresh-cursor `false` pass only with the required authorization. No release
hook, smoke test, rollback or monitoring check may invoke either real sync mode
implicitly. Do not replay outreach, interview invitations or historical approvals.

## Monitoring with existing facilities

Use existing structured logs and native state before proposing a new service:

| Signal | Existing evidence and limit |
| --- | --- |
| Revision and readiness | Release manifest/platform metadata, `/ready` with `x-rakazo-revision`, and operator-only health details; public `/health` proves liveness only. |
| API errors and latency | Structured HTTP completion status/duration and RPC timing fields; compare failure rate and latency around the recorded release time. |
| Startup failure and latency | API/worker `boot.phase` and Modal startup/readiness phases; retain migration and process-exit failures. |
| Run status | Native run lifecycle events and persisted status, including waiting, failed and completed states; waiting on a person is not automatically a failure. |
| CRM failures and freshness | `crm.sync.failed` and `crm.sync.incomplete` events, `crm.sync.slice` progress and `crm.sync.completed` with `dry_run=false`; row `syncedAt` measures row freshness, not completion of an entire sync. |

Sync events reuse `@rakazo/logging` and the configured sink. They are emitted after
each transaction commits; rejected transactions emit only a failure event, without
the raw error. A final report emits `crm.sync.completed` only when `nextCursor` is
null and no reads were skipped. Filter on `dry_run=false` before treating it as a
successful real pass. The timestamp of the last such event supports full-sync
recency in the existing retained log sink, from activation onward. These aggregate
events establish service-wide recency, not a lag guarantee for every user,
connection or organization. There is no historical backfill or new durable
sync-history table.

Event bindings contain aggregate counts, flags and a duration capped at the
transaction's 125-second wait/execution budget. Counts are cumulative for the
pass, so do not sum them across slice events; `skipped_count` is the bounded
report count, capped at 50. No actor, provider, role or contact
ID, cursor, skipped reason, URL, contact data or raw error is added. Existing log
correlation and redaction still apply. Do not label the newest row timestamp, a
rotated cursor or a dry run as a successful full sync. Alert routing and thresholds
remain activation work; this PR does not install a monitoring backend or
periodically invoke CRM sync.

Keep credentials, cookies, tokens, candidate identities, addresses, message
bodies, connection strings and provider payloads out of public CI artifacts and
PRs. Reuse existing log redaction, and retain only aggregate outcomes and bounded
timings in release summaries. Monitoring production data requires its own
authorized access; staging never receives a copy of that data.

## Activation work that remains

- Verify external push/PR deployment integrations before publishing this branch.
  The current repository webhook read returned HTTP 403. Empty GitHub deployment
  and status lists do not establish that no external app can deploy a preview.
  Until that audit is possible, preserve local commits, patch and draft PR text.
- Review and merge this code only under separate merge authority. Run hosted CI
  and isolated staging, inspect their exact-SHA artifacts and retain a known-good
  previous release. Locally passing checks do not substitute for those runs.
- Verify the existing Modal account/app/Secret/Volume, billing, access and runtime
  configuration without creating replacements. Any new credential, CI secret,
  access grant, resource, subscription or cost setup needs separate confirmation.
  The workflow uses existing-resource variables `MODAL_APP_NAME`,
  `MODAL_SECRET_NAME`, `MODAL_VOLUME_NAME`, `MODAL_ENVIRONMENT` and
  `PRODUCTION_ORIGIN`, with `PRODUCTION_MODAL_TOKEN_ID` and
  `PRODUCTION_MODAL_TOKEN_SECRET` secrets. It pins the existing Modal CLI to
  `1.6.2` and refuses implicit resource creation (`create_if_missing=False`).
  Do not supply the existing production runtime Secret to staging.
- Configure production workflow activation, authorized dispatchers and real
  approval controls only after owner review. Do not assume GitHub required
  reviewers or branch protection are enabled. Keep all deploy holds in force
  until the assigned owner lifts them for the exact release.
- Validate the current source/product migration evidence, quiet session, recovery
  point and readiness checks. Perform the first production promotion and real
  business acceptance only under explicit deployment/data authorization.

No environment is operational merely because workflow files exist. Hosting a
persistent staging URL, adding production dashboards/alerts, and arranging real
provider acceptance are future activation decisions, not hidden side effects of
this change. Product bugs and recruiting workflow changes are outside this PR.

Only after all activation and per-release prerequisites are independently
verified, the authorized owner can use GitHub's manual workflow form or:

```sh
gh workflow run promote-production.yml --ref main \
  -f staging_run_id='<successful staging run ID>' \
  -f expected_sha='<exact 40-character candidate SHA>'
```

This command deploys; it is documented for the future owner procedure and was
not executed during development. Record the dispatch run, artifact identity,
exact head, checks and readiness result privately. An independent reviewer should
receive the proposed files, local test commands/results, unexecuted stages and
remaining setup blockers before activation.

## Legacy and external release boundaries

Legacy SSH/Compose deployment, mobile production OTA and server-image publication
have separate explicit opt-ins. Keep them disabled while the Modal promotion path
is being reviewed. Enabling one is a separate release decision; production
workflow approval does not authorize another publisher.

| Path | Explicit conditions |
| --- | --- |
| SSH/Compose | `LEGACY_COMPOSE_DEPLOY_ENABLED=true`, `PRODUCTION_DEPLOY_ENABLED=true`, `PRODUCTION_DEPLOYMENT_HOLD=clear`, `PRODUCTION_APPROVED_SHA` equal to the tested SHA, and Modal promotion not enabled. |
| Mobile production OTA | `MOBILE_OTA_PUBLISH_ENABLED=true` and Modal promotion not enabled; existing OTA compatibility checks still apply. |
| Server images | `SERVER_IMAGE_PUBLISH_ENABLED=true`; independent distribution, separately authorized because a published image can feed an updater. |

SSH, OTA and Modal promotion share the `production` concurrency group. The legacy
host script additionally requires `RAKAZO_LEGACY_COMPOSE_APPROVED_SHA` to match the
full SHA argument and `RAKAZO_DEPLOYMENT_HOLD=clear` in its existing host-owned
configuration. It refuses a moved `main` instead of fetching and deploying a
different head. No host configuration is changed by this PR. Image publication
and mutable tags are not evidence that the Modal artifact passed staging.

Desktop/tag and manually dispatched native releases remain separate deliverables
with their existing release procedures. Do not create tags, dispatch workflows
or publish OTA updates as part of this server promotion. Before later activation,
re-audit every enabled publisher and updater that can change a running version.

The headhunter repository's Vercel integration is unchanged. Do not push to that
repository or rely on `[skip ci]` to suppress Vercel; its earlier PR-specific
authorization does not carry over. Rakazo's marketing Vercel configuration also
does not establish whether an external preview integration is enabled. Auditing
Actions alone is insufficient. The existing Playwright report publication path
can write a report to external storage after PR CI; it is not a product staging
deployment and must be included in the publication audit.

## Failure and rollback

1. Stop further promotions if deployment, readiness, revision verification or a
   safe smoke fails. Preserve the failure report and exact attempted SHA. Do not
   claim success because Modal accepted a deployment command or a port opened.
2. Have the authorized owner inspect migration outcome and active run state.
   A failed rollout can leave successfully applied migrations behind. Keep
   Autumn/outreach pauses and the single-writer constraint in place.
3. Retrieve the exact previously accepted source archive and manifest. Verify its
   checksum and platform release record. Confirm that its code can run against
   the current schema and persisted state before considering replacement.
4. If compatible and separately authorized, recreate the existing app from that
   exact previous release, retaining the existing Secret and Volume. Run the
   same revision, readiness and safe smoke checks and record the outcome.
5. If schema or data compatibility is unknown, stop for the owner's migration
   recovery plan or a forward fix. There is no automatic down migration, database
   restore, Volume replacement or blind rollback after migration. Reverting Git
   does not revert database writes.

Do not run CRM sync, resume paused research or send mail as a rollback test.
Recovery success and permission to resume business operations are separate
decisions. This procedure does not rely on Modal's platform rollback feature,
which its [deployment documentation](https://modal.com/docs/guide/managing-deployments)
limits to Team and Enterprise plans. No plan upgrade or automatic platform
rollback is part of this release path.
