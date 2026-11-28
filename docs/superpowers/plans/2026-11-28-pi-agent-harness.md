# Pi AgentHarness Runtime (Harness Repair Step A) Implementation Plan

`PI` = `node_modules/.pnpm/@earendil-works+pi-agent-core@0.87.1_@modelcontextprotocol+sdk@1.30.0_@cfworker+json-schema@4_3vwj7fdzeqw2korgy7n3equcki/node_modules/@earendil-works/pi-agent-core/dist`. `ex` = `packages/adapters/src/executor.ts`, `pi` = `packages/adapters/src/pi-runtime.ts`, `ev` = `packages/db/src/events.ts`, `tt` = `apps/api/src/thread-target.ts`.
Line numbers are at stage 62da19287.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each agent in each conversation has one durable Pi `AgentHarness` lane. The lane owns the queue, stop, resume, the persisted transcript (tool calls and results included) and the one compaction. Our own run harness is deleted.

**Architecture:**
- One Pi `Session` per (threadId, botId), with one lane named `main`. It is stored in Postgres through a fenced implementation of Pi's `Storage` interface.
- One worker at a time owns a session through a 30 s lease. All input arrives through a durable `session_inputs` outbox plus a realtime notify. The owner turns each input into Pi `accept`/`steer`/`followUp`/`abort`.
- Harness events are projected into the existing `runs` / `messages` / `events` rows, so the web app is unchanged.

**Tech Stack:** TypeScript, `@earendil-works/pi-agent-core` 0.87.1 (`AgentHarness`, `StorageBackedSession`, `createStorageConformance`), `@earendil-works/pi-ai` 0.87.1 (`Models`, faux provider for tests), Prisma/Postgres, Graphile Worker (`serialKey`/`replaceKey`, packages/adapters/src/wakeup.ts:32-39), `PostgresRealtimeFanout` (apps/worker/src/index.ts:142).

**Spec:** /mnt/project-files/kruit/harness-audit-20261128/README.md (fix step A), 1-loop-queue-stop-priority.md, 4-memory-context-injected-text.md; docs/handoff/2026-10-23/workloop-prd-zh.md (§3.1 line 105 "lease(30s) 每会话单写者"; M1 §1.2-1.13; M1-R11 drain, line 188; §1.11 Coalesce, lines 480-512; M2 §2.1-2.11; M3 §3.1-3.2).

## Global Constraints

- Pin `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` at exactly `0.87.1`. The harness API is partly pre-release: `PI/harness/runtime/lane.js:760` says "Public exposure remains guarded until M8", `PI/harness/agent-harness.d.ts:13` also names M8, and `watchSession` throws `SliceNotImplemented` at `PI/harness/runtime/harness.js:229`. Do not call `watchSession`.
- One lane per (threadId, botId), lane name `"main"`. Session id = `conversationSessionId(threadId, botId)` (already used at pi:532).
- Session lease TTL is 30 000 ms, renewed every 10 000 ms (Workloop §3.1 line 105; §1.11 / M1-R11).
- Deploy drain gives live turns up to 45 000 ms to finish (Workloop M1-R11, line 188) before the lease is released.
- P10: no feature flag, and the old and new runtimes are never both switched on. The new path ships and the old path is deleted in the same merge to stage.
- P8 guardrails stay ours, implemented as Pi hooks, not inline branches:
  - send confirmation and approvals;
  - spend limits (P19);
  - data isolation (P20);
  - supplier hiding;
  - effect and receipt idempotency.
- Development standard 7: any new model-facing text written in code states facts only.
- Tests: only for shared mechanisms (storage, lease, queue, stop, recovery, projection). Agent behaviour is checked with journeys, never with unit tests that pin sentences.
- Postgres tests use the existing `*.postgres.test.ts` + `VERIFY_DATABASE` pattern (packages/db/src/billing.postgres.test.ts:14-16; vitest.config.ts:11).
- Files over 3,000 lines (ex, pi) take no new code. New code goes in `packages/adapters/src/agent-session/` and `packages/db/src/conversation-session*.ts`.

## Review Focus

1. **A message that lands between the run's last boundary and its `run_end` commit.** Expected: it is answered by the next run on the same lane. It is never lost and never answered twice. Pi's final boundary only takes steers (`PI/harness/runtime/drive/boundary.js:32-86`), so a steer that commits just after run_end stays in the inbox. Test: Task 4 `late steer after run_end starts the next run`.
2. **Worker killed during a non-replayable tool (an email send).** Expected: the new owner records the tool as interrupted (`PI/harness/runtime/drive/tools.js:7,103-109,355-357`) and does not send again. Test: Task 4 `crash mid effect: no replay for replay=never`.
3. **Two workers pick up `session.drive` for the same session at once.** Expected: exactly one acquires the lease. A writer with a stale fence cannot commit. Test: Task 2 `stale fence commit rejects`.
4. **Stop pressed while the lane is idle, or while a card is open.** Expected: nothing is aborted, the queued inputs stay queued, and there is no error. Test: Task 8 `stop on idle lane is a no-op`.
5. **A legacy thread whose seeded history is larger than the context window.** Expected: the first run compacts once (threshold path, `PI/harness/runtime/drive/checkpoint.js:60`; `PI/harness/runtime/drive/structural.js:836-870`) and then answers. Test: Task 7 `seed beyond context window compacts once then answers`.

---

## 1. What Pi's AgentHarness provides (evidence)

| Capability | Pi location | Notes |
|---|---|---|
| Construction | `PI/harness/agent-harness.d.ts:617-635` (`AgentHarnessOptions`: `session`, `models`, `model`, `tools`, `toolContext`, `systemPrompt` as a string or a function, `resources`, `streamOptions`, `retry`, `compaction`, `steeringMode`, `followUpMode`, `toolExecution`, `toProviderMessages`, `entryProjectors`); `AgentHarness.create` at `:713-715` → `PI/harness/runtime/harness.js:279-310` | `create` restores every lane and returns `open` (the operations still active). It has no side effects. |
| Lanes, one active operation each | `PI/harness/runtime/lane.js:396` (`LaneBusy` when `state.operation !== null`); `accept` at `:313`; the `AgentLane` API at `agent-harness.d.ts:636-675` | `accept({kind:"prompt", operationId, prompt})` lets us pick the operation id. We use it as `runs.id`. |
| Durable inbox: steer, followUp, nextRun | `lane.js:1086-1163` (`enqueue` writes `pendingEntry` + `laneState.inbox` in one commit); `cancelQueued` at `:1165` | Durable in session values (`PI/harness/session/values.d.ts:206,216`). |
| Steer at each turn boundary; followUp when nothing else triggers | `PI/harness/runtime/drive/boundary.js:32-86`; mode `"all"` is the default (`harness.js:44-45`) | Replaces our DB polling (pi:581-640). |
| A new run picks up the queued inbox | `lane.js:29-51` (`selectAcceptedInbox`), `:420-430` | A prompt with zero messages is accepted when the inbox holds a message. That is how an idle lane drains late input. |
| Abort | `lane.js:1050-1084` (`abort`), `:761-851` (durable `cancel_requested`, `PI/harness/session/types.d.ts:81-86`) | Returns the steer and followUp items that were still queued (`agent-harness.d.ts:35-39`). |
| Resume after crash or restart | `harness.js:290` → `PI/harness/runtime/restore.js:48-72`; `lane.resume` at `lane.js:1014-1048` | Assistant output cut off mid-stream is settled from its committed frames as an interrupted message (`PI/harness/runtime/drive/recovery.js:12-55`). A tool left in `effect_pending` is replayed only if both the call and the tool are `replay:"safe"` (`tools.js:345-353`); otherwise it gets the interruption marker as its result (`tools.js:7,103-109`). The transcript states the facts, so no resume brief is needed. |
| Tool interface | `PI/harness/types.d.ts:67-81` (`execute(toolCallId, params, onUpdate, toolContext, invocation, context)`; `invocation.invocationId` is stable across replay; durable `getMemo`/`setMemo`); `replay?: "never" \| "safe"` at `PI/types.d.ts:397-398` | `invocationId` becomes our effect idempotency key. |
| Hooks | `agent-harness.d.ts:485-604`: `before_run`, `before_run_end` (may return `followUp`), `transform_context`, `before_request`, `before_payload`, `after_response`, `before_tool` (`block`), `after_tool` (`terminate`), `before_compaction` (decline or replace), `before_navigation` | Guardrails go in `before_tool` and `after_tool`. |
| Events | `agent-harness.d.ts:206-420` (`run_start`, `run_end` with status, `turn_*`, `message_*`, `tool_*`, `queue_update`, `usage`, `compaction_*`) | Source for the UI projection. |
| Context building from the session | `PI/harness/session/context.js:2-48` (`buildSessionContext`: last compaction entry + retained tail + later entries; error/aborted assistant messages dropped; custom entries through `entryProjectors`) | Tool calls and results persist across runs. |
| System prompt | Resolved on every generation step (`PI/harness/runtime/drive/generation.js:20-26`); `transform_context` hook at `:120`; model call `models.streamSimple` at `:134` | We supply `Models`, not a `streamFn`. |
| Compaction | Defaults `{enabled:true, reserveTokens:16384, keepRecentTokens:20000}` (`PI/harness/compaction/compaction.js:75-79`); threshold check (`checkpoint.js:60`, `structural.js:836-870`); overflow compacts once and retries once (`PI/harness/runtime/drive/response.js:111-160`) | One compactor. |
| Storage contract we implement | `Storage` at `PI/harness/session/types.d.ts:387-399` (`commit`, `getEntries`, `getValue`, `scanValues`, `readList`, `scanBranch`, `scanBranchStructure`, `scanEntries`, `scanUsage`, `getStats`, `close`); wrapped by `StorageBackedSession(metadata, storage, options)` (`PI/harness/session/session.d.ts:36-46`); commit helpers `prepareStorageCommit` / `validateCommittedWrites` (`PI/harness/session/commit.d.ts:314-319`, exported from `session/index`) | Conformance suite: `createStorageConformance(factory)` in `@earendil-works/pi-agent-core/harness/session/testing`. |
| Lane state lives in one process | `lane.js:186-235` (`this.state`); in-process mutation line (`session.d.ts:3,7`) | Cross-worker exclusion is ours: lease plus fenced commit. |

**What Pi does not provide:**
- No cross-process ownership.
- No background-job promotion of a slow tool (Workloop §1.6 BackgroundPromote).
- No "parked waiting for a human" state. The only suspension is provider-deferred (`agent-harness.d.ts:14-18,213-218`).
- No subagent primitive.
- No backup-model failover.

## 2. How our runtime maps onto it

| Ours today | Replaced by |
|---|---|
| A new Pi `Agent` per DB run, with history re-read from rows (pi:531-603; ex:2446-2452 `loadRunHistoryMessages`; db/src/messages.ts:296) | A long-lived lane on the persisted session (`buildSessionContext`) |
| Run lease with fence and 5-minute TTL (ex:2184-2205), 60 s heartbeat `renewRunLease` (ex:14169 and ~15 call sites), reconciler sweep of expired run leases (packages/adapters/src/job-reconciler.ts:316-330) | A **session lease** (`conversation_sessions.leaseOwner/leaseFence/leaseExpiresAt`, 30 s) plus fenced `Storage.commit`, and a reconciler sweep of expired session leases that have undelivered input or an open operation |
| Automation lane advisory lock + `threadLaneBusy` + 5 s retry (ex:2207-2254, 15375, 15392-15531) | `LaneBusy` → steer (`lane.js:396`) |
| `steering_messages`, `claimSteering` (ev:870), interject poll (pi:609-640), `prepareNextTurnWithContext` (pi:581-603) | `session_inputs` outbox → `lane.steer` / `followUp` |
| Continuation runs: `finalizeRun` continuation (ev:2190-2217), `createPendingSteeringRun` (ev:2264-2341), `discardAnsweredSteering` (ev:2223-2262) | The inbox carried into the next `accept` (`lane.js:29-51,420-430`) |
| Two admission paths: `sendUserMessage` (ev:517-850) and `sendThreadMessage` (tt:866-1430) | Both call one `submitSessionInput` |
| Stop: DB status flip, worker notices on its next event or the 60 s heartbeat (ex:12942-12961) | `stop` input + notify → `lane.abort()` |
| Resume brief / stopped notice (ex:14695-14850), approval resume prompt (ev:303-311) | Pi recovery facts in the transcript |
| SIGTERM aborts and requeues every turn (apps/worker/src/index.ts:450-466) | Quiesce: stop admitting work, `waitForIdle` up to 45 s, release the lease; the next owner calls `resume` |
| Our compactor and context layers (history-compaction.ts:304-695, runtime-context.ts, context-selection.ts:395-520, `activeCompaction` pi:1347-1590) | Pi compaction plus a `before_compaction` hook carrying the anchored template |
| UI rows `runs` / `messages` / `events` | Kept. Written by a projection of harness events. `runs.id` = Pi `operationId`. |

**One lane per agent per conversation across workers.** The guarantee has four layers:
1. **Lease on the session, not the run.** `acquireSessionLease` is an `updateMany` on `conversation_sessions` where `leaseExpiresAt <= now OR leaseOwner = me`, which increments `leaseFence`.
2. **Every Pi commit is fenced.** `PostgresSessionStorage.commit` runs inside one transaction that first does `UPDATE conversation_sessions SET nextSeq = nextSeq + $n WHERE id = $id AND leaseFence = $fence RETURNING nextSeq`. Zero rows means the commit throws `SessionFenceLost`, and the host closes the harness.
3. **Inside the owning process, Pi's lane allows one operation** (`lane.js:396`).
4. **Database belt.** A partial unique index `runs_one_active_per_agent ON runs("threadId","botId") WHERE status IN ('queued','leased','running','waiting_input','waiting_takeover')` makes a second live turn impossible even if a bug slips through.

**Getting input to the owner.** The API and worker write a `session_inputs` row in the same transaction as the `messages` row, so `clearThread` locking stays as it is (ev:649-653). They then:
- enqueue Graphile `session.drive` with `replaceKey = serialKey = "session:<sessionId>"`;
- publish realtime `session:<sessionId>`.

A worker running `session.drive` either acquires the lease and runs the host loop, or finds a live owner and exits; the owner hears the notify. If the owner is dead, the reconciler re-enqueues once the lease has expired (at most 30 s).

**UI model kept.**
- `run_start` inserts `tasks` + `runs` rows (status `running`, trigger and source message from the input that started it).
- Assistant text and tool events go through the existing runtime-event consumer, adapted with `harnessEventToRuntimeEvents`.
- `run_end` writes the terminal status in one transaction, as `finalizeRun` does today (ev:2004-2221), minus the continuation and steering logic.
- `queue_update` drives the "queued messages" display (db/src/queued-messages.ts) from `session_inputs` rows not yet delivered plus Pi's inbox.

## 3. What gets deleted, and what stays

**Deleted** (every item listed here is deleted, in Tasks 9-10):
- Run lease, heartbeat and fence: ex:2184-2205, `renewRunLease` ex:14169 and its call sites (2352, 3406, 3424, 4096, 7369, 7382, 10306, 12891, 13026, 13161, 13578, 13591); `takeoverContinuePlan` / `continueRunClaimFence` uses in `continueRun` (ex:2156-2260); the run-lease sweep in job-reconciler.ts:316-330.
- Lanes: ex:2207-2254, `THREAD_LANE_RETRY_MS` ex:15375, `threadLaneAncestors` ex:15392-15493, `threadLaneBusy` ex:15495-15531; the routine-wake priority special case in wakeup.ts:15-60.
- Steering and continuations:
  - `steering_messages` table and model (schema.prisma:799-821);
  - `claimSteering` ev:870, `hasUnclaimedSteering` ev:850, `discardAnsweredSteering` ev:2223, `createPendingSteeringRun` ev:2264, the continuation in `finalizeRun` ev:2190-2217;
  - the run and steering creation in `sendUserMessage` ev:670-760 and in tt:1000-1340;
  - callers of the continuation helpers in db/src/expire-stuck-run.ts:142-150 and db/src/queued-messages.ts:179;
  - `STEERING_ACK` / `EARLIER_STEERING` ex:1299-1303;
  - the interject poll pi:609-640, `prepareNextTurnWithContext` pi:581-603, the outer re-drive loop pi:874-893.
- Code deciding whose words count:
  - `handbackSuperseded` ex:4477-4497, `newerMessageAnsweredElsewhere` ex:4535-4597 and its uses (4839, 12731, 13524-13545);
  - "not run: newer request elsewhere" ex:1284-1286, 4843;
  - ask gating `beforeAsk` (`askAfterNewerMessage`, `questionAlreadyWaiting`) ex:12723-12738, pi:1969-1990, pi:3327;
  - reply consolidation: `cardTakesLinesPlace` ex:3968, `postProgressLine` ex:4022, `replaceLatestReply` ex:3943 / 13561-13575, ex:2837-2910;
  - `withoutCardHeldRuns` tt:145, `yieldBackgroundWakes` tt:171, `cancelSupersededQueuedRuns` tt:369.
- Slow-tool promotion into a relabelled run: db/src/background-tool.ts (118 lines), pi:129 and pi:1931-1945.
- Resume and restart text: `resumeBriefForRun` ex:14757-14850, `stoppedPreviousRunNotice` ex:14695-14722, `resumePrompt` ev:303-311, the run-level model-outage requeue ex:1254-1270 and 13728-13776 (Pi retry covers it, `agent-harness.d.ts:261-280`), SIGTERM abort-and-requeue ex:2527-2530 and 13712-13723.
- Silent-tool continuation and missing-final-answer-as-failure: pi:189-201, 805-842, 971-988; `REPORT_BEFORE_END` use (turn-report.ts:249). Workloop §1.12/§1.15 has no such nudge.
- Context and compaction:
  - history-compaction.ts (695 lines) and its job in background-job-handlers.ts:24, 211;
  - `Thread.historyCompacted*` columns (schema.prisma:614-616);
  - runtime-context.ts (474);
  - the context-selection strategies in context-selection.ts:395-520 (keep its tool-result truncation at :314-325);
  - `activeCompaction` pi:1347-1590;
  - `loadRunHistoryMessages` (after the seeder, Task 7, takes over the one-time import);
  - the write-only JSONL recorder pi-session.ts (265) and pi:418-438.
- State re-injection, which exists only because tool results were lost between runs (Task 10, gated by the eval):
  - working-state.ts (625) and its uses ex:2979-2999, 899-922, 11949, 12758-12763;
  - per-steer role-context re-adoption ex:12825-12850;
  - per-turn semantic recall ex:2936-2952, 11891-11897;
  - routine prior runs ex:14857-14908;
  - the per-message source-instruction repeat on steers ex:12857-12861.
- `autocontinue:` readers (~20 sites; audit 1 row 69 and audit 4 row 66), because the writer was removed in #1619.

**Stays ours, as hooks:**
- **Send confirmation and approvals.** `before_tool` blocks an unapproved send and returns the card fact. The card tool ends the run with `after_tool` `terminate:true`, and the card's answer arrives as a new input. The approved-send replay by code (ex:12010-12100) stays, keyed by `invocationId`.
- **Spend limits (P19).**
  - Paid tool limits go in `before_tool`.
  - Model cost and time per run (core/run-state.ts:126-152): on the `usage` event, `lane.abort()` plus a fact note.
- **Data isolation.** A session row carries spaceId and userId. Storage queries are always by sessionId. `Models` is built per session from that account's credentials. The unattended-memory guard (ex:6130-6140) stays.
- **Supplier hiding.** Text from tools and the model is redacted where it is projected to `messages` (same function as today).
- **Effect and receipt idempotency.** `ExternalEffect` is keyed by `invocationId`. Every tool with side effects is `replay:"never"`; only read-only tools are `"safe"`.
- **Send idempotency.** `clientNonce` (ev:522-560) stays.
- **Silence watch.** silence-watch.ts stays, now as `lane.abort()`.
- **Automation rate limit.** automation-rate.ts stays.

## 4. Migration path

- **No flag.**
  1. Build on one branch: `claude/pi-agent-harness`, one commit per task.
  2. Play it with `pnpm sim:branch` before and after.
  3. Merge to stage as one PR, with the old path deleted in the same PR (P10).
  4. Soak on staging for at least one nightly playtest.
  5. The release thread deploys to production.
- **Schema.** Migration A (Task 1) is additive: the session tables and `session_inputs`. Migration B (Task 9) drops `steering_messages` and the `historyCompacted*` columns and adds the partial unique index. B ships in the same release but runs after the cutover job.
- **Existing threads.** Sessions are seeded lazily from current history: the first `session.drive` for a (thread, bot) with no session row seeds it (Task 7). Seed content:
  - `Thread.historyCompactionSummary` as the first user-role fact message, if present;
  - then messages with `seq` below the first undelivered input, rendered as today.

  Pi then compacts if needed. Seeding runs once per session; it is the import path, not a second context builder.
- **Cutover job.** Graphile task `session.cutover`, idempotent, run once by the release. For each non-terminal run:
  - mark it `cancelled` with `error = "upgraded"`;
  - turn its unclaimed `steering_messages`, and its source message when that message has no bot reply after it, into `session_inputs` in seq order;
  - enqueue `session.drive`.
- **Deploy order:**
  1. Migration A.
  2. Deploy API and worker together. The old worker drains on SIGTERM as today.
  3. Run `session.cutover`.
  4. Migration B.
- **Rollback.** Redeploy the previous release. The new tables are ignored, and `messages` / `runs` / `events` keep the old shape, so old code rebuilds history from `messages`. Migration B cannot be rolled back, so restore `steering_messages` empty from its old migration.

  Inputs not yet delivered at rollback are not answered automatically. The runbook query `SELECT "threadId" FROM session_inputs WHERE "deliveredAt" IS NULL` lists those threads. No user text is lost; it stays in `messages`.

## 5. File structure

- Create `packages/db/src/conversation-session.ts`: lease acquire, renew and release; `submitSessionInput`; list and mark inputs.
- Create `packages/db/src/conversation-session-storage.ts`: `PostgresSessionStorage implements Storage`.
- Create `packages/db/src/conversation-session.postgres.test.ts`: Pi storage conformance, fence, inputs.
- Create `packages/adapters/src/agent-session/`, with these files:
  - `session-host.ts`: lease, open, restore, delivery loop, quiesce.
  - `session-host.test.ts`: in-memory storage plus the faux provider.
  - `harness-tools.ts`: `AgentTool` → `AgentHarnessTool`, replay policy.
  - `harness-models.ts`: an account `Models` with backup failover.
  - `guardrails.ts`: `before_tool` / `after_tool` / `usage` hooks.
  - `run-projection.ts`: harness events → existing runtime-event consumer and finalize.
  - `session-config.ts`: system prompt, tools, model and compaction for a (thread, bot), extracted from `continueRun` setup.
  - `session-seed.ts`: the one-time import.
- Modify: `packages/db/prisma/schema.prisma`, ev, tt, ex, pi, job-reconciler.ts, background-job-handlers.ts, apps/worker/src/index.ts, apps/worker/src/drain.ts, db/src/cancel-runs.ts, db/src/queued-messages.ts, recruiting-agent-run-wait.ts, wakeup.ts.

## 6. Tasks

### Task 1: Session schema and Postgres `Storage`

**Files:** Modify `packages/db/prisma/schema.prisma`; create `packages/db/prisma/migrations/20261129100000_conversation_sessions/migration.sql`, `packages/db/src/conversation-session-storage.ts`, `packages/db/src/conversation-session.postgres.test.ts`.

**Interfaces:**
- Produces these models:
  - `ConversationSession {id, spaceId, userId, threadId, botId, storageVersion Int, nextSeq Int @default(0), leaseOwner String?, leaseFence Int @default(0), leaseExpiresAt DateTime?, createdAt; @@unique([threadId, botId])}`;
  - `SessionEntry {sessionId, id, parentId?, seq, timestamp BigInt, type, customType?, body Json; @@id([sessionId,id]); @@index([sessionId,seq])}`;
  - `SessionValue {sessionId, namespace, key, value Json, seq; @@id([sessionId,namespace,key])}`;
  - `SessionListElement {sessionId, namespace, key, seq, value Json; @@id([sessionId,namespace,key,seq])}`;
  - `SessionUsage {sessionId, id, seq, usage Json, entryId?, adjustment Boolean, details Json?; @@id([sessionId,id])}`.

  Every model cascades on Thread delete (P20).
- Produces `class PostgresSessionStorage implements Storage { constructor(db: PrismaClient, sessionId: string, fence: number) }` and `class SessionFenceLost extends Error`.

Steps:
- [ ] **Write the failing test.** In `conversation-session.postgres.test.ts`, register every case from `createStorageConformance(async () => ({ storage: new PostgresSessionStorage(prisma, freshSessionId(), 0), [Symbol.asyncDispose]: cleanup }))` as `it(case.group + " " + case.name, case.run)`.
- [ ] **Run it and see it fail.** Run `VERIFY_DATABASE=1 pnpm --filter @rakazo/db test -- conversation-session.postgres`. Expected: FAIL, module not found.
- [ ] **Implement `commit(writes, context)`.** In one `$transaction`:
  1. Reserve seqs with `UPDATE conversation_sessions SET "nextSeq"="nextSeq"+$n WHERE id=$1 AND "leaseFence"=$fence RETURNING "nextSeq"`. Zero rows means throw `SessionFenceLost`.
  2. `prepareStorageCommit(writes, firstSeq, Date.now())`.
  3. Apply each `CommittedWrite`: entry insert, usage insert, value upsert or delete, list append or delete.
  4. Return `{...result, stats}`, with stats computed from entry count and summed usage.

  Implement the reads as indexed queries. `scanBranch` walks `parentId` from `start` with a recursive CTE honouring `stopAtType`, `stopAtId`, `type`, `customType`, `order`, `limit` and `cursor`. `scanValues(prefix)` uses `namespace = prefix.namespace AND key LIKE prefix.key || '%'`.
- [ ] **Run it and see it pass.** Same command. Expected: all conformance cases PASS.
- [ ] **Commit.** `feat(db): Postgres storage for Pi sessions`.

### Task 2: Session lease and fenced writes

**Files:** Create `packages/db/src/conversation-session.ts`; extend `conversation-session.postgres.test.ts`.

**Interfaces:**
- Produces `interface SessionLease { sessionId: string; threadId: string; botId: string; workerId: string; fence: number }`.
- Produces `ensureConversationSession(db, key: {spaceId; userId; threadId; botId}): Promise<{id: string; created: boolean}>`.
- Produces `acquireSessionLease(db, sessionId, workerId, now?: Date): Promise<SessionLease | null>` (TTL `SESSION_LEASE_TTL_MS = 30_000`).
- Produces `renewSessionLease(db, lease): Promise<boolean>` and `releaseSessionLease(db, lease): Promise<void>`, where release sets `leaseExpiresAt = now()` only when the fence matches.

Steps:
- [ ] **Write the failing tests:**
  - `second acquire while live returns null`;
  - `acquire after expiry bumps fence`;
  - `stale fence commit rejects`: a storage built with the old fence, then `commit([...])`, rejects with `SessionFenceLost`, and no `SessionEntry` row is written;
  - `release lets the next worker acquire at once`.
- [ ] **Run them and see them fail.**
- [ ] **Implement** with `updateMany` guards, the same shape as ex:2184-2205 but on `conversation_sessions`.
- [ ] **Run them and see them pass.**
- [ ] **Commit.**

### Task 3: Session input outbox (the one admission path)

**Files:** Modify `schema.prisma` + the Task 1 migration (add `SessionInput`); `conversation-session.ts`; test file.

**Interfaces:**
- Produces model `SessionInput {id cuid, sessionId, seq Int (per session), kind String, messageId String?, payload Json, trigger String, createdAt, deliveredAt DateTime?, piEntryId String?, operationId String?; @@index([sessionId, deliveredAt, seq])}`.
- Produces `type SessionInputKind = "message" | "followUp" | "stop" | "cardAnswer"`.
- Produces `submitSessionInput(tx, input: {sessionId; kind: SessionInputKind; trigger: string; messageId?: string; payload: JsonValue}): Promise<{inputId: string; seq: number}>`.
- Produces `pendingSessionInputs(db, sessionId): Promise<SessionInputRow[]>` (seq order) and `markSessionInputDelivered(db, lease, inputId, {piEntryId?; operationId?})`. Marking is fenced: it updates only while `conversation_sessions.leaseFence = lease.fence`.

Steps:
- [ ] **Write the failing tests:**
  - `inputs come back in submit order`;
  - `delivered inputs are not pending`;
  - `mark with stale fence is a no-op`.
- [ ] **Run them and see them fail.**
- [ ] **Implement.**
- [ ] **Run them and see them pass.**
- [ ] **Commit.**

### Task 4: Session host (lane ownership, delivery, stop, recovery)

**Files:** Create `packages/adapters/src/agent-session/session-host.ts` and `session-host.test.ts`.

**Interfaces:**
- Consumes Tasks 2-3.
- Consumes a `SessionHostDeps { db; realtime; openStorage(lease): Storage; buildConfig(key): Promise<SessionConfig>; projection: RunProjection; workerId: string }`.
- Produces `runSessionHost(deps: SessionHostDeps, sessionId: string, signal: AbortSignal): Promise<"released" | "not_owner">`.
- Produces `deliverInput(lane: AgentLane, input: SessionInputRow, context): Promise<{piEntryId?: string; operationId?: string}>`.

Algorithm (decided here):
1. Acquire the lease; on failure return `"not_owner"`.
2. Build `StorageBackedSession`, then `AgentHarness.create`, then `lane("main")`. For each `open` operation, start `lane.resume` in the background.
3. Subscribe realtime `session:<id>`. Renew the lease every 10 s; on renew failure or `SessionFenceLost`, call `harness.close` and return.
4. Delivery loop, on every notify, on `run_end`, and once at start:
   - Dedupe: skip any input whose id already appears as `rakazoInputId` on a message in `lane.watch().snapshot.queues` or among the last 50 branch entries. This covers a crash between the Pi commit and `markSessionInputDelivered`.
   - `message` / `cardAnswer`: try `lane.accept({kind:"prompt", operationId: uuidv7(), prompt: [msg]})`. On `LaneBusy`, call `lane.steer(msg)`. When accepted, run `lane.drive({operationId})` in the background.
   - `followUp`: `lane.followUp(msg)`.
   - `stop`: `lane.abort()` when an operation is active, otherwise a no-op. Mark the input delivered.
   - After `run_end`, if the inbox is not empty, `accept({kind:"prompt", prompt: []})` (`lane.js:420-430`).
   - `msg` is a Pi user message carrying an extra field `rakazoInputId`.
5. Idle eviction: lane idle, no pending input, and 10 minutes since the last activity → `harness.close`, `releaseSessionLease`, return `"released"`.
6. `signal` aborted (deploy quiesce): stop delivering, `Promise.race(lane.waitForIdle, 45 s)`, `harness.close`, release.

Steps:
- [ ] **Write the failing tests.** Use `MemoryStorage` from `@earendil-works/pi-agent-core/harness/session` and the pi-ai faux provider.
  - `message while idle starts one run`
  - `message while running is steered into the same run`: assert exactly one `run_start` and that both user messages are in the transcript.
  - `late steer after run_end starts the next run`: block the faux provider until after the first `run_end`, then submit. Assert two `run_start` events in sequence, never overlapping, and the message answered once.
  - `stop aborts the running operation and queued inputs stay queued`
  - `crash mid effect: no replay for replay=never`: the tool blocks; close the harness; reopen a new host on the same storage. Assert the tool's `execute` ran once and the tool result contains Pi's interruption marker (`tools.js:7`).
  - `safe tool replays after crash`
  - `duplicate delivery after crash is skipped by rakazoInputId`
- [ ] **Run them and see them fail.**
- [ ] **Implement.**
- [ ] **Run them and see them pass.** Run `pnpm --filter @rakazo/adapters test -- agent-session/session-host`.
- [ ] **Commit.**

### Task 5: Tools, models, hooks, compaction

**Files:** Create `harness-tools.ts`, `harness-models.ts`, `guardrails.ts`, `session-config.ts` (all in `packages/adapters/src/agent-session/`); extend `session-host.test.ts`.

**Interfaces:**
- Produces `toHarnessTool<T>(tool: AgentTool, replay: "never" | "safe"): AgentHarnessTool<RakazoToolContext>`. It maps `context.abortSignal` to the old `signal` and passes `invocation.invocationId` as the effect key.
- Produces `SAFE_REPLAY_TOOLS: ReadonlySet<string>` (read-only builtins only).
- Produces `createAccountModels(targets: ModelTarget[]): Models`. It is a `MutableModels` from `builtinModels` with a delegating Provider that fails over to the next target on a provider outage, moving `fallbackAwareModelStream` (pi) here.
- Produces `installGuardrails(harness: AgentHarness, deps): void`. It registers `before_tool` (approval or send block, paid-spend limit, unattended memory write) and `after_tool` (`terminate` for ask and approval cards), and listens to `usage` (run cost/time limit → `lane.abort()`).
- Produces `buildSessionConfig(deps, key): Promise<SessionConfig>` returning `{systemPrompt: (ctx) => string; tools; model; thinkingLevel; compaction: {enabled: true, reserveTokens: 16384, keepRecentTokens: 20000}}`. The system prompt comes from the existing `userTurnInstructions` (ex:14576-14656), moved unchanged; step B rewrites it.
- `transform_context` hook: the existing tool-result, page-state and screenshot pruning (pi:547-553, 2750-2880).
- `before_compaction` hook: passes the existing anchored 8-section template (history-compaction.ts:25-35) as `customInstructions`.

Steps:
- [ ] **Write the failing tests:**
  - `unapproved send is blocked before execute`;
  - `card tool terminates the run and its answer starts the next`;
  - `spend over limit aborts the lane`;
  - `backup model takes over on outage`.
- [ ] **Run them and see them fail.**
- [ ] **Implement.**
- [ ] **Run them and see them pass.**
- [ ] **Commit.**

### Task 6: Run projection (UI rows unchanged)

**Files:** Create `run-projection.ts`; modify ex, moving the runtime-event consumer out into this module; extend existing executor tests where they cover message shapes.

**Interfaces:**
- Produces `harnessEventToRuntimeEvents(e: HarnessEvent): AgentRuntimeEvent[]` (types at packages/adapter-kit/src/types.ts:667-721).
- Produces `createRunProjection(deps, key): { onEvent(e: HarnessEvent, ctx): Promise<void> }`:
  - `run_start` → create `tasks` + `runs` (`id = runId`, `status: "running"`, `trigger` and `sourceMessageId` from the input that started it);
  - `message_end` assistant → the existing reply writer, with supplier redaction;
  - `tool_*` → the existing step and event writers;
  - `usage` → `UsageRecord`;
  - `run_end` → one transaction writing the terminal status, the finish notification and `run.completed` / `failed` / `cancelled` events.

Steps:
- [ ] **Write the failing tests:**
  - `one run row per Pi operation`;
  - `steered message gets runId of the live run`;
  - `aborted run ends cancelled with its partial text saved` (Workloop §2.9).
- [ ] **Run them and see them fail.**
- [ ] **Implement.**
- [ ] **Run them and see them pass.**
- [ ] **Commit.**

### Task 7: One-time import of existing threads

**Files:** Create `session-seed.ts`; extend `session-host.test.ts`.

**Interfaces:**
- Produces `seedSession(session: Session, db, key, beforeSeq: number): Promise<void>`. It runs `createBranch("main", null)` and then `appendMessage` per rendered message, and is called only when `ensureConversationSession` returns `created: true`.

Steps:
- [ ] **Write the failing tests:**
  - `seed excludes messages that are pending inputs`;
  - `seed beyond context window compacts once then answers` (faux model with a small `contextWindow`; expect one `compaction_end` with status `completed`, then a reply).
- [ ] **Run them and see them fail.**
- [ ] **Implement.**
- [ ] **Run them and see them pass.**
- [ ] **Commit.**

### Task 8: Wire every producer and the worker

**Files:** Modify:
- ev: `sendUserMessage`, ev:517-850;
- tt: `sendThreadMessage` (tt:866) and `stopThreadRuns` (tt:1615);
- db/src/cancel-runs.ts;
- the routine fire (ex:1991-2155) and the bot_message / delegated return (job-reconciler.ts:380-430);
- recruiting-agent-run-wait.ts: the wake becomes a `followUp` input;
- background-job-handlers.ts: register `session.drive` and `session.cutover`;
- job-reconciler.ts: the session-lease sweep replaces 316-330;
- apps/worker/src/index.ts:450-466 and drain.ts: SIGTERM aborts the host signal, which triggers quiesce.

**Interfaces:**
- Consumes `submitSessionInput` and `runSessionHost`.
- Produces job `session.drive {sessionId}` (`serialKey` and `replaceKey` = `session:<id>`).
- Produces `session.cutover {}`.

Steps:
- [ ] **Write the failing tests** in the existing ev and tt test files:
  - `person message creates one session input and no run`;
  - `stop on idle lane is a no-op`;
  - `routine fire is an input into the bound session`;
  - `SIGTERM quiesces: live turn finishes within 45 s then lease released` (worker drain test);
  - `cutover turns live runs into inputs once` (run it twice; assert inputs are not duplicated).
- [ ] **Run them and see them fail.**
- [ ] **Implement.**
- [ ] **Run them and see them pass.**
- [ ] **Commit.**

### Task 9: Delete the old harness

**Files:** Every item in §3 "Deleted" except the re-injection channels; migration B `20261129100100_drop_steering_one_active_run` (drop `steering_messages`, drop `threads.historyCompacted*`, `CREATE UNIQUE INDEX CONCURRENTLY runs_one_active_per_agent ...`).

Steps:
- [ ] **Delete the code and the tests that only protected it** (Development standard 3).
- [ ] **Check that nothing is left.** Run `rg "claimSteering|createPendingSteeringRun|handbackSuperseded|newerMessageAnsweredElsewhere|resumeBriefForRun|threadLaneBusy|compactHistory|autocontinue:" packages apps`. Expected: no matches.
- [ ] **Run the checks.** Run `pnpm typecheck && pnpm test && pnpm check:standard --base origin/stage`. Expected: all pass.
- [ ] **Commit.**

### Task 10: Remove state re-injection (gated by eval)

**Files:** working-state.ts, the recruiting-context.ts re-adoption on steering and tool result, the recall injection, routine prior runs, and the steer source-instruction repeat (the line ranges are in §3).

Steps:
- [ ] **Delete them.** Facts the model still needs (Gmail or Calendar connected) must already be reachable through a tool. Name the tool in the PR.
- [ ] **Run the Eval plan** below (both arms) with these channels removed. If a journey regresses, keep that one channel for step B and record why in the PR.
- [ ] **Commit.**

## 7. Eval plan (before and after, same commands)

- **Before:** check out stage at 62da19287 and run `pnpm sim:branch -- --journeys <list> --samples 5`.
- **After:** the same command on `claude/pi-agent-harness`. Use `--search` for the feedback and long-search journeys.
- **Queue, steer, stop and recovery journeys:**
  - change-mind-mid-run
  - two-asks-one-message
  - same-ask-twice
  - progress-and-where
  - stop-after-approve
  - deny-then-change-and-send
  - send-through-blip (network blip)
  - did-you-really-send
  - team-stuck-tell-me
- **Long-context and compaction journeys:**
  - candidate-long-conversation
  - what-happened-since-yesterday
  - five-asks-one-role
  - long-search-finishes (`--search`)
  - us-recruiter-feedback-round (`--search`)
  - big-ask-split
- **Existing recovery checks:** infra/acceptance/failure-recovery.test.mjs, follow-up.mjs, workloop-task-controls.mjs, restart-test-app.mjs. Add one journey field `restart: {beforeTurn}` to simulated-journeys.mjs, beside the existing `blip`, so a deploy restart happens mid-turn (data in the existing harness, Development standard 2).
- **Measured, per sample:**
  - request-completion rate (request-completion.mjs);
  - count of (thread, bot) pairs with more than one live run at once; must be 0, and the index enforces it;
  - replies dropped or overwritten; must be 0;
  - duplicate answers to one message;
  - time from Stop to `run.cancelled`;
  - prompt tokens per call (`model.prompt_shape` log, pi:542);
  - turns cut by a deploy that resumed without a repeated paid or send effect.
- **Report line:** `Eval: <journeys>, <before> → <after>` with the report link. Say "not run" for anything not run.

## 8. Risks and open questions for the maintainer

1. **Size.** Roughly 6-8k lines deleted across ex (16,485 lines), pi (4,450), ev, tt and the context files, and about 2-2.5k lines added. This is several weeks of work, not a PR. The riskiest part is extracting the event consumer and setup out of `continueRun` (Tasks 5-6).
2. **Pi API maturity.** Parts are marked pre-M8 (`lane.js:760`, `agent-harness.d.ts:13`, `harness.js:229`). The pin plus the conformance suite catch drift, but a Pi upgrade may break the host. Nothing in the repo uses `AgentHarness` yet.
3. **Write volume.** Pi commits operation state, tool args and streamed assistant frames as values and lists (`values.d.ts:207-219`). Measure commits per streamed reply on staging before production. It is one Postgres transaction per commit.
4. **No background-job promotion.** A steer waits for a long foreground tool (Workloop §2.4 cancels or promotes it). Today's 10 s promotion (background-tool.ts) caused the parallel turns, so it goes. People search is already asynchronous (agent_run + wake). Decide whether a Workloop-style job primitive is step D or a follow-up.
5. **Interrupt semantics change.** The web sends every message with `interrupt:true` (apps/web/src/pages/shell/useShellMessages.ts:452,474). Pi has no "abort only the stream". Proposed: messages always steer (the Workloop composer default) and only Stop aborts. Confirm.
6. **Cards end the run.** A card ends the run instead of parking it (no Pi park state). Typed text while a card is open becomes a normal input that the model reads beside its own question. `chatReplyToAsk` / `answerWaitingRunWithTextInTransaction` (ev:268, ev:1504) are then deleted. Confirm the product behaviour.
7. **No nudge after a silent tool turn.** The silent-tool continuation is dropped (Workloop has no nudge). If a provider often ends silently after a tool, the fix is `before_run_end` `followUp` (`boundary.js:93-134`) with fact-only text, decided by the eval.
8. **Backup-model failover is a custom delegating Provider** inside `Models`. Pi retries one model only.
9. **In-process subagents** (the nested `Agent` at pi:2404) stay inside a tool for now. A crash loses them, which shows as an interrupted tool result. Step D replaces them.
10. **Memory per worker.** Each owned session holds a harness in memory. Idle eviction is at 10 minutes. Size the worker by the number of concurrent active sessions.
11. **Rollback is not lossless.** Undelivered inputs need a manual resend (runbook query in §4), and migration B is one-way.

### Critical Files for Implementation
- /home/user/rakazo/packages/adapters/src/executor.ts
- /home/user/rakazo/packages/db/src/events.ts
- /home/user/rakazo/apps/api/src/thread-target.ts
- /home/user/rakazo/packages/adapters/src/pi-runtime.ts
- /home/user/rakazo/node_modules/.pnpm/@earendil-works+pi-agent-core@0.87.1_@modelcontextprotocol+sdk@1.30.0_@cfworker+json-schema@4_3vwj7fdzeqw2korgy7n3equcki/node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts (plus `harness/session/types.d.ts` and `harness/runtime/lane.js`)
