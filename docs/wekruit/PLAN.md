# Recruiting delivery plan

Deliver the [approved goal](GOAL.md) through P6. Each phase must leave a runnable
check and a reviewable result; stop dependent work when its contract is unproved.
The local pilot is not cloud deployment or live recruitment-loop proof.

## Active iteration — deploy login and continuous Crew chat

Current user direction: Modal hosting, Supabase Postgres, and a native cloud
sandbox to preserve the upstream executor and avoid the optional-computer refactor.
Do not build recruiting integrations in this iteration. Keep the later P0–P6
journey below as deferred scope, not as acceptance for this first delivery.

### Work order

1. Resolve deployment prerequisites first: use the project-specific Modal SDK,
   verify its authenticated workspace and spending controls, and obtain approval
   to create a dedicated database in the existing Supabase cluster. Its runtime
   role owns this new database; no CRM permissions or tables change. Upstream's
   historical migrations cannot initialize a custom schema unchanged. Do not run
   migrations over the CRM or create a newly paid Supabase project.
2. Configure an existing native cloud sandbox adapter; prefer E2B Hobby if its
   account has usable credit. Verify the real template size and tier restrictions.
   Do not implement a Modal sandbox adapter or change the executor to bypass its
   computer dependency. Do not upgrade a subscription or create billable usage.
3. Use native Team Computer for Main/Sourcer and retain the existing 10-minute
   idle sleep. Verify actual pause and resume with persisted workspace data; include
   running idle time in costs. Browser workflows and recruiting scripts are not
   acceptance for this iteration. Do not add business credentials to the computer.
4. Deploy original Web/API/worker/Pi via a Modal deployment entrypoint, with one
   initial service instance and shared native file storage. Preserve necessary
   backend activity without relying on an open browser. Store keys as server-side
   secrets and verify volume persistence across container replacement. Do not
   publish a webpage as functional if its agent requests still cannot execute.
5. Complete native owner sign-in and Codex OAuth on the deployed product, create
   Main/Sourcer and a native Crew, and run a short real two-round conversation.
   Verify refresh, logout/login, and one controlled restart. No business API calls,
   outreach, business scripts, or out-of-pocket charges are part of this check.

### Deliverables and acceptance

- A working HTTPS URL with native sign-in; no local-only or bypass login page.
- A saved Codex subscription connection and an actual streamed model response.
- Main and Sourcer visible in Crew; normal @ selection and two-round context work.
- Reload/reopen/restart retain the same persisted chat, messages, and connection;
  reopening does not resend an earlier message.
- One native Team Computer provisions, pauses when idle, and resumes without
  losing a small public test file; no browser workflow is required.
- Screenshots of login, model connection, and Crew replies, plus exact deployed
  revision and a short pass/fail receipt. Reuse existing checks for any changed boundary;
  no additional testing harness is introduced.

Native memory and interaction implementations remain in use; exhaustive card,
permission, memory, and recruiting-loop acceptance comes after this baseline.
The cloud Web/API/worker deployment is running and native readiness is HTTP 200.
All 102 original migrations completed in the independent database, Graphile's
schema exists, and the CRM table schema fingerprint is unchanged. The actual
owner has signed up, connected Codex through official device OAuth, and used
Main/Sourcer in a native Crew. Normal @ selection, two-turn shared context,
refresh, actual service-container replacement and a subsequent natural-chat
reply have passed. Original group/thread/connection/message/run identities were
preserved; the final continuation added exactly one user message, one reply and
one completed run. A shared two-second frontend snapshot deadline was corrected
because it cancelled valid remote history reads before they completed.
File pause/resume, separate logout/login, and the later full card/business tests
remain pending; earlier local pilot results are separate evidence.

### Persistence and capacity, checked 2026-10-15

Use Supabase Postgres for native users, sessions, conversations, runs, cards, and
MarkdownMemoryStore documents. Keep encrypted connection records in the database
and their encryption key in server secrets. Mount the native DATA_DIR on a Modal
Volume for artifacts and LocalAgentHomeStore checkpoints; the sandbox filesystem
is a working copy, not the only durable copy. Reuse upstream checkpoint/export
and restore paths. Verify the Volume commit and replacement-container restore;
an abrupt sandbox loss can lose changes since its last successful checkpoint.
Do not add an S3 adapter or move recruiting state in this baseline iteration.

The existing Grok Crew was directly asked about timing, size, and restart needs.
All six members replied. Their timings and daily counts are estimates, not an
independent benchmark: sourcing 30–90 minutes per batch, enrichment 10–40 minutes,
Instantly and scheduling 1–3 minutes per ordinary task, executive assistant 3–10
minutes, and chief-of-staff daily check 5–10 minutes. They report predominantly
remote-service waiting and restartable scripts using saved job IDs and caches.
This does not prove our deployed runtime safely resumes those business effects.

They report measured shared workspace size 1.9 GB, including role folders 98 MB
and enrichment cache 21 MB. These overlap and must not be added as independent
totals. Start with a 5–10 GB planning allowance for workspace and checkpoint
staging; actual capacity and costs must be observed on our deployment.

The upstream executor provisions a computer even for plain chat, so billable
runtime includes model/API waits and the trailing idle interval. Frequent routines
may keep one shared computer running most of the workday. Do not budget only CPU
seconds, multiply one shared computer by bot count, or promise $5–10/month for the
entire existing Crew. E2B Hobby's one-hour continuous runtime limit needs checking
before later 90-minute sourcing runs; do not upgrade a subscription to bypass it.

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

## Deferred roadmap after the baseline: A — Codex, Crew, cards, and memory (P0–P2)

**P0: Modal baseline above.** Complete the current iteration before expanding
recruitment scope. Retain upstream Web/API/worker/Pi, with only the authorized
deployment scoping changes. Retain the native cloud sandbox. No local Docker or new paid
resources; no integration work in place of a working login and chat webpage.

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
