# Recruiting delivery plan

Deliver the [approved goal](GOAL.md) through P6. Each phase must leave a runnable
check and a reviewable result; stop dependent work when its contract is unproved.
The local pilot is not cloud deployment or live recruitment-loop proof.

## Current delivery checkpoint — 2026-10-15

User direction: unchanged upstream executable code, Supabase database, cloud
hosting. Retire the custom local no-computer path; do not extend it. Preserve the
local pilot's credentials and messages while preparing the supported deployment.

Codex OAuth completed in the pilot and one actual model response was saved.
Instantly's native encrypted API source verified three GET tools (accounts,
campaigns, emails), all HTTP 200. No sending acceptance is claimed.

The existing Supabase database is reachable, but the supplied role cannot create
tables and the CRM already owns an incompatible `threads` table. Do not apply the
upstream public-schema migrations over it. Use an appropriate existing database
or resolve the target before migration. No newly paid project may be created.
The current Supabase project does not have Compute access; inspect the existing
cloud account for a usable host and native computer provider before deployment.

## Reuse before adding code

| Responsibility | Existing boundary |
| --- | --- |
| Web, API, worker | [web](../../apps/web), [router](../../apps/api/src/router.ts), [worker](../../apps/worker/src/index.ts) |
| Agent runtime and connections | [Pi](../../packages/adapters/src/pi-runtime.ts), [OAuth](../../packages/adapters/src/pi-oauth.ts), [model providers](../../packages/core/src/model-providers.ts) |
| Tool/result and event contracts | [contracts](../../packages/contracts/src), [adapter interfaces](../../packages/adapter-kit/src/interfaces.ts) |
| Crew and bot handoffs | [groups](../../packages/db/src/groups.ts), [handoffs](../../packages/adapters/src/group-handoff.ts) |
| Choices, approval, secrets | [Pi choice checks](../../packages/adapters/src/pi-runtime-choice.test.ts), [approval](../../packages/core/src/action-approval.ts), [secret boundary](../bot-secrets.md) |
| Memory and continued context | [memory](../../packages/memory/src/index.ts), [history](../../packages/db/src/history-retrieval.ts) |
| Routines and jobs | [schedule tools](../../packages/adapters/src/schedule-tools.ts), [routine runs](../../apps/api/src/routine-runs.ts), [jobs](../../packages/adapter-kit/src/background-jobs.ts) |

Read each real call chain from Web intent through API authorization, persisted
state, worker/Pi/tool execution, and the rendered result before changing it.
Autumn, Supabase, and Instantly adapters reuse those boundaries and protected
server-side connections. No second harness, gateway, or parallel credential store.

## A — Baseline, Codex, Crew, cards, and memory (P0–P2)

**P0: unchanged upstream cloud deployment.** Preserve upstream revision `7d5e64c`
for all executable source. Use native Web/API/worker/Pi with Supabase PostgreSQL,
a supported cloud computer provider, and durable application storage. Verify
migration privileges and table-name compatibility before writing. Reuse existing
authorized resources; no local Docker, new purchases, or new subscriptions.
Deliver the actual HTTPS product URL and record the running revision. Keep local
pilot evidence distinct from acceptance of this cloud deployment.

**P1: existing Codex OAuth.** Connect the available subscription through the saved
model-connection flow. Verify a real Pi response, saved connection reuse after a
restart, and the existing expiry/reconnect behavior. Protect tokens throughout.
Additional models/providers are later work; native Codex App-session preservation
is not required to adopt Rakazo.

**P2: Main/Sourcer Crew.** Use a real group and existing bot handoffs. Main owns
scope, human calibration, and approval; Sourcer returns evidence to that task.
Verify choices with custom text, cancellation, and once-only approval using real
persisted cards. Duplicate, stale, or wrong-user submissions cannot run effects.
Explicitly save a preference, open a fresh chat, recall it, and verify that an
unrelated user or organization cannot retrieve it. A transcript mention is not
proof of a saved memory. No fake cards or automatic approval.

Exit: a live Codex-driven Crew completes these interactions and retains them
after restart; deterministic checks cover each state/authorization boundary.

## B — Autumn task, evidence, and calibration (P3)

**P3: one persisted sourcing task.** Trace the actual Autumn integration contract
before implementation. Create one authorized external task; persist its external
identifier with local task, user, organization, bot, and chat references. Read
service status and candidate evidence with provenance, separating facts,
inferences, and missing evidence. No inferred success from model narration.

Record the human's calibration as task feedback, submit it through Autumn's
supported continuation operation, and resume the **same external task**. A changed
external task identifier fails acceptance. Reopening a chat or restarting a worker
must retain the task, feedback, and provider receipts without duplicate creation.
Honor actual provider capability; a missing continuation contract blocks P3.

Exit: live creation, evidence retrieval, human feedback, and continuation receipts
show the same external task; offline checks cover scoping and duplicate requests.

## C — Existing CRM, approved outreach, and routines (P4–P5)

**P4: existing Supabase CRM.** Trace existing Auth, organization membership, CRM
schema, and RLS before adding the connection. Bind Rakazo's acting user to the
existing identity and selected organization on the backend; verify membership on
every operation. Use that user's authorized context for CRM reads/writes, without
service-role bypass or a replacement identity/CRM. Store evidence and review
decisions in existing semantics; do not silently change stage. Confirm a permitted
write by reading it back, and prove cross-user/cross-organization denial.

**P5: draft → approval → confirmed send.** Bind the draft to task, candidate,
recipient, sender, and content. Show an explicit once-only approval for that exact
payload; edits invalidate it. Only the backend executes the approved Instantly
request. Persist the existing outbox/job state and provider receipt so retries or
restarts cannot create a second send. Provider acceptance/queueing is not a sent
confirmation; do not label an email sent without the corresponding service proof.

Use existing routines to resume the scoped task and schedule authorized follow-ups.
Ingest replies, persist the stop decision, cancel pending follow-ups, and recheck
reply/approval state immediately before dispatch. A reply observed before dispatch
prevents sending even when a job was already queued or retried. Do not promise to
recall a request already accepted by the provider.

Exit: live CRM readback and an explicitly approved, service-confirmed Instantly
send; deterministic checks cover stale approvals, retries, and reply/send races.

## D — Complete permissions and recovery acceptance (P6)

**P6: exercise the full journey through P5.** Verify the following through the
product boundary, preserving task identity and authoritative external receipts:

| Acceptance | Required result |
| --- | --- |
| Read/switch permissions | User/org/bot/chat switches cannot reuse another scope's task, memory, credential, CRM row, or approval. |
| Cards | Choice/custom text survive reopening; cancel/deny have no effect; once approval cannot be replayed. |
| Restart | API/worker restart and a fresh chat restore task, memory, feedback, pending card, outbox, and routine state. |
| Reply stop | A confirmed reply stops scheduled and queued follow-ups; retry/restart cannot restart outreach. |
| Full live run | Codex → Crew → Autumn evidence → human calibration → same task → existing CRM → draft → approval → confirmed send → reply stop. |

Track multi-human groups, multiple chats per bot, and explicit per-bot credential
bindings as open capability gaps. Test authorized sharing and denied access before
claiming each supported; do not treat the initial single-user Crew as proof.

## Evidence and completion

Follow [agent verification](../agent-verification.md): implementation/test coverage
and live provider proof are separate columns in each phase's acceptance record.
Use existing deterministic suites with synthetic inputs; add one minimal runnable
regression check per new non-trivial contract. No new testing harness is needed.
Record phase, revision, scenario, expected/observed result, and redacted receipt
reference. Keep raw receipts, credentials, account identifiers, machine paths, and
candidate/contact data outside public repository content. Never cite private chats.
Mark unavailable live steps **not run**. Finish only when P0–P6 gates are evidenced;
passing tests alone cannot establish sourcing quality, delivery, or provider access.
