# Production maintenance proposal

This is a design proposal, not an implemented drain or release authorization.
The inspected baseline is `e570b93f5b1083a84d6495ed2448041a7d8e3b74`. Preserve its
saved delivery artifacts. Production cutover remains blocked, including the
legacy Compose path, until the boundaries below are implemented and verified.
No production connection, migration, deployment, CRM sync, email, credential or
resource change was performed to prepare this proposal.

The recommendation is a small, durable maintenance gate in the existing product
Postgres database, with records of admitted asynchronous work. Use existing
Prisma, `pg`, service composition and job handlers. This is moderate cross-cutting
product work, not a workflow-only flag, a new scheduler or a control platform.

Read this with the [release instructions](pr-driven-releases.md),
[delivery safety record](../handoff/2026-10-23/development-delivery.md),
[CRM procedure](crm-sync-delivery-2026-10-23.md) and
[Modal runtime instructions](../../infra/modal/README.md).

## Why the current checks cannot establish an idle deployment

The common execution claim is `continueRun` in
[`executor.ts`](../../packages/adapters/src/executor.ts), around lines 3387–3425.
Its conditional update covers queued work, takeover continuation and expired
leases. It is a useful additional guard, but is not a deployment-wide boundary.

Run admission is distributed across ordinary messages and group messages
(`apps/api/src/thread-target.ts:882,1043`), bot introductions and follow-ups
(`apps/api/src/router.ts:777,2756`), call completion and routine test runs
(`router.ts:2849,4032`), skill tests (`taught-skills.ts:508`), shared message
delivery (`packages/db/src/events.ts:627`), scheduled routines
(`packages/adapters/src/executor.ts:3291`) and research poll completion
(`packages/adapters/src/recruiting-research-poll.ts:150`). Answers requeue waiting
runs (`events.ts:969`); takeover release resumes them (`events.ts:1493`);
finalization can create pending steering runs (`events.ts:1809`). Executor
shutdown and setup failures can requeue work (`executor.ts:11197`). Line numbers
refer to the inspected baseline and are navigation aids, not protocol identifiers.

There are also two important completion races:

- The executor marks a run terminal at `executor.ts:9974`, then may create another
  continuation, return a delegated result, send a push notification and release
  sandbox resources. Cleanup continues through `executor.ts:10176`. A zero count
  of active runs does not mean its handler has finished.
- Password-reset delivery is intentionally detached at
  `packages/auth/src/index.ts:271`. The HTTP response can finish before the email
  promise. Only the normal application shutdown currently drains accepted email
  at `apps/api/src/app.ts:1060`.

CRM sync can execute directly from an API request without a Run
(`apps/api/src/recruiting-crm-sync.ts:84`). Messaging delivery, cloud/research
polling, compaction and computer jobs also operate outside run execution.
Reconciliation and polling ingress can start more work without an HTTP request.

The existing reconciler advisory lock elects one reconciler; it does not exclude
API requests or workers. Stopping queue publication misses already queued jobs,
retries and reconciler repair. Process shutdown is not proof of idle state:
TeamChat uses a bounded wait (`apps/api/src/team-chat-bridge.ts:193`), and Modal
kills remaining processes after the shared eight-second deadline
(`infra/modal/app.py:185`). A timeout must not be interpreted as successful drain.

## Persistence and coordination

Extend the existing `DeploymentSettings` singleton, rather than adding a second
deployment configuration system. Proposed fields represent maintenance state,
a monotonically increasing generation, the exact approved candidate and previous
source revisions, and the owning release identity. Use an additive migration;
do not rewrite existing owner, authentication or model configuration.

Add one small admitted-operation table with an operation ID, generation, process
instance identity, source revision, operation category and start time. These are
coordination records, not a second job queue. Do not store request bodies,
provider responses, customer identifiers, URLs or credentials in them. The
singleton primary key and operation-generation lookup support the gate queries.

Both admission and maintenance acquisition take a row lock on the same singleton
in a short transaction. No network call, model execution, long job, image build
or polling wait runs inside that transaction. Use the existing bounded database
operations and consistent lock order: acquire the maintenance gate before any
business locks when both are required.

The proposed rules are:

1. **Admit:** lock the singleton, verify the schema/capability and open state,
   insert the operation record for that generation, and commit. Begin the work
   only after successful commit. Missing state or uncertain commit means no work.
2. **Complete:** remove only that operation's matching ID, generation and process
   identity after its entire asynchronous lifetime and cleanup have settled.
   Parent registration must cover nested work; anything detached must receive its
   own durable registration before the parent can complete. Registration failure
   must prevent detaching or performing the operation.
3. **Acquire maintenance:** lock the singleton, require no unresolved operations
   and no runs in any `ACTIVE_RUN_STATUSES`, then atomically advance the generation
   and persist the held state bound to the exact release. Admission racing with
   this transaction either registers first and makes acquisition busy, or observes
   the hold and is rejected. There is no count-then-set interval.
4. **Verify:** require the same held generation and release identity, compatible
   API and worker revisions, zero unresolved operations and zero active runs.
   Public readiness alone cannot establish these conditions.
5. **Release:** require an explicit authorized operation comparing the current
   held generation, release identity and verified deployed revision. A stale
   command cannot reopen a newer hold. A failed release attempt leaves the hold.

There is no TTL, automatic stale-record deletion or automatic release of the
hold. A process crash, failed completion write or unknown external outcome leaves
an unresolved operation and requires owner recovery. A disconnected lock client
must not make a still-running operation disappear. This avoids holding one
session/pool connection per long job, pool starvation, and the false-zero outcome
of relying solely on session advisory locks that disappear on disconnect.
Database unavailability denies admission and maintenance verification. Recovery
must not decrement an aggregate counter blindly or clear all records.

This mechanism governs participating application processes. It cannot constrain
an administrator writing directly to the database or an independently running
provider. Nor does a new table make older application code participate.

## First version: fail busy and preserve work

Implement quiet-window acquisition first. If any admitted operation or active
run exists, return busy and do not claim maintenance was acquired. Do not drain
an arbitrarily selected cohort, cancel work, discard jobs or manufacture a
terminal run state to obtain zero.

`ACTIVE_RUN_STATUSES` includes `queued`, `leased`, `running`, `waiting_input` and
`waiting_takeover` (`packages/core/src/run-state.ts:3`). Keep that definition.
A waiting question or human takeover remains active. Its resolution belongs to
the existing user workflow; release automation does not answer it or approve it.
An already-held maintenance generation also must not be reopened automatically
because acquisition or verification failed.

During a successful hold, reject business ingress with a generic maintenance
response and keep queued jobs deferred. A held job must not be acknowledged as
success, dropped, or repeatedly failed until its retry budget is exhausted.
Use the existing job host lifecycle and queue semantics; verify deliberate pause
and restart behavior for both Graphile and the in-memory host. Preserve due times,
deduplication keys, attempts and pending human decisions.

## Required application barriers

| Existing boundary | Required coverage |
| --- | --- |
| `apps/api/src/app.ts:615`, before route handlers | Gate HTTP business operations before authentication, RPC, voice, webhook, billing and local-settings side effects. Do not treat all GET requests as safe. Health/readiness and a strictly authorized maintenance-status path may be explicit exceptions. Track real streaming/background work beyond response construction. |
| `packages/adapters/src/background-job-handlers.ts:64` | Wrap the whole handler, including post-run mirroring/delivery, cleanup and fallback delivery. Cover all job types, not only `run.continue`. Graphile dispatch is in `wakeup.ts:124`; in-memory dispatch is around `wakeup.ts:350`. |
| `packages/adapters/src/executor.ts:3387` | Check participation and admission at the shared run claim as defense against an unguarded direct caller. Preserve existing lease fences, retries and checkpoints. Avoid nested registrations or locks that deadlock with the enclosing handler. |
| `packages/adapters/src/job-reconciler.ts:124` | Admit an entire reconciliation pass, including auxiliary cloud/computer reconciliation, stuck-work notices, delegated-result return and wakeup repair. Pause new passes while held. |
| `apps/api/src/app.ts:938,974`; `apps/api/src/team-chat-bridge.ts:156,614` | Cover polling-mode ingress, inbound callbacks, TeamChat startup recovery and periodic reconciliation. HTTP middleware does not cover these paths. Do not acknowledge provider messages as handled when their processing was denied. |
| `packages/auth/src/index.ts:271` and email adapter boundary | Register detached delivery until the send settles. Preserve existing email policy; maintenance release must never send a diagnostic email or replay old delivery. |
| API/worker composition and startup | Check held state before connector/secret-store/provider startup, job hosts, reconciliation or polling can have effects. Existing startup starts services before Hono middleware (`app.ts:213,397,536,548`). Replacements must start a minimal health/control surface and keep business services inactive while held. |

An implementation must inventory other detached callbacks and provider-owned
loops at these composition boundaries. Awaiting the top-level handler is
insufficient if its adapter has accepted work that continues after the promise
resolves. An uncertain external outcome retains an operation record until owner
reconciliation; cancellation or a local timeout is not proof of remote completion.

## Control path and release lifetime

The candidate control path is a bundled, narrowly scoped maintenance command
invoked inside the existing Modal deployment using existing container-exec
capability and credentials. This is a candidate to verify, not a confirmed access
path. Do not add a public administrative HTTP endpoint or a new credential merely
to implement this proposal.

Before relying on it, verify the installed Modal CLI/API supports selecting the
exact existing app, environment and current container; that existing authorized
access permits the operation; and that no ambiguous container selection, shell
interpolation or credential printing is possible. The bundled command must use
the existing database connection internally and expose only redacted counts,
capability/version, source revision and maintenance generation. It must not read
or export secrets. Missing access remains a separate owner decision, with no
automatic grant, new resource or token fallback.

For steady-state releases, the proposed sequence is:

1. Verify tested-source/hosted-staging evidence and all existing owner prerequisites.
   Confirm the current deployment implements the required maintenance protocol.
2. Acquire the quiet-window hold against the current deployment. Retain the
   returned exact generation and release identity. If busy or uncertain, stop.
3. Verify the same hold before build and cutover. Keep it persisted throughout
   Modal build, `recreate`, product migrations, startup and readiness checks.
   The control client exiting or losing a connection does not release it.
4. Replacement API and worker start held, prove compatible protocol and exact
   source identity, and allow only safe readiness/maintenance checks. Preserve
   the single DATA_DIR/Volume writer and existing `recreate` constraint.
5. After authorized verification, explicitly release this same generation.
   Deployment, migration, smoke or control failures retain maintenance. There is
   no automatic resume in a `finally` block and no automatic rollback.

External Autumn safety is unresolved. A local admission hold can stop new product
requests to Autumn and local polling, but cannot prove an already-started remote
Autumn task has stopped. The existing owner-controlled pause must remain in
force. An enforceable provider pause/status contract or separately verified owner
procedure is a prerequisite; an `autumn_paused: true` assertion alone does not
establish it. The same caution applies to independent remote agents/effects.

The control path, protocol capability and compatible rollback revision must be
verified before removing any current production stop. Legacy Compose's CI and
host-script stops must be reconciled independently: a direct script invocation
cannot bypass the gate merely because the workflow is guarded. Do not enable a
legacy path as a workaround. Mobile OTA and server-image publication remain
distinct opt-in distribution boundaries; this proposal does not claim they are
protected by the runtime drain or authorize their publication. Head-hunter/Vercel
integration and source deployment remain outside this mechanism.

## First bootstrap and migration

The first installation cannot authorize itself through the new gate. Current
production processes do not register operations or honor its held state, so
empty new tables would provide false assurance.

The owner must separately authorize and establish an actual maintenance window,
stop admission and independently verify existing API/worker/background activity
and external Autumn state. Only then can an additive migration and compatible
API **and** worker revision be installed together. New or missing gate state must
default to held/failure, never imply open. Preserve all existing runs, questions,
approvals, routines, files and application configuration. No live bootstrap is
performed or authorized by this document.

Record the first verified gate-aware revision and protocol version. Reject a
steady-state release when either process is older, capability is missing, or the
maintenance schema is incompatible. Rollback to pre-gate code needs a separately
controlled recovery procedure; it cannot inherit the normal gate guarantee.
The normal Modal startup runs product migrations before service spawn
(`infra/modal/app.py:139`), so the migration and held-startup ordering require an
explicit compatibility test and review.

## Implementation scope and local evidence required

The code-only follow-up would include an additive Prisma migration/model change,
one DB admission/maintenance helper, API/worker composition integration, job and
reconciler barriers, messaging/email lifecycle integration, a bundled control
command, release-protocol integration and focused tests. Likely existing files
are the boundaries linked above plus `packages/db/src/index.ts`,
`apps/api/src/index.ts`, `apps/worker/src/index.ts`, `infra/modal/app.py` and
`infra/release/release.py`. Final ownership and file selection should follow the
implementation review, not expand into product fixes or a new control framework.

Use disposable native PostgreSQL and fake providers. Required tests include:

- Admission versus acquisition in both concurrent orderings: either a registered
  operation prevents acquisition or the hold prevents any provider/model call.
- Concurrent release/acquisition, stale generation/process identity, duplicate
  completion and restart: old commands cannot clear newer holds or registrations.
- Every run create/resume/retry path listed above, with all five active statuses
  blocking acquisition and no mutation of waiting cards, approvals or checkpoints.
- Terminal Run state preceding delayed notification/sandbox cleanup: acquisition
  remains busy until the entire handler settles.
- Detached email and polling/TeamChat callbacks outliving their HTTP caller:
  unresolved work remains visible without any real mail or provider calls.
- Graphile and memory queue deferral: no handler effect, lost job, retry-budget
  consumption or accidental acknowledgement while held; deliberate resume uses
  existing queue semantics.
- Database loss before/after admission or completion, process crash, timeout and
  unknown remote completion: no false zero or automatic stale-record cleanup.
- Startup/replacement under a persisted hold: no provider initialization, polling,
  reconciliation or job processing; safe readiness still verifies exact source.
- Missing schema/capability, mixed API/worker versions, pre-gate rollback and
  unverified external pause all prevent production mutation.
- Offline release tests keep the exact generation across build/recreate/smoke,
  retain the hold on every failure, and cannot invoke legacy Compose to bypass it.

This document adds no implementation or live validation. Production remains
blocked until the code, local evidence, control access, first bootstrap and
external-pause prerequisites have each been reviewed and separately authorized
where required.
