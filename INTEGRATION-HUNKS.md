# Integration hunks for codex/wl-b-interject-transient

Files below are owned by another agent, so the changes are written here instead of
applied. Line numbers refer to the `codex/workloop-all` base (2a732359).

## 1. `packages/adapters/src/executor.ts` — streaming progress is transient (A1)

`ThreadEvents` now has `publishTransient(input: AppendEventInput): Promise<void>`
(same input shape as `append`). It sends the event over the pg_notify topic with
`seq: 0`, falls back to `append` when the signal would exceed the NOTIFY limit or no
push fanout exists, and `followThreadEvents` yields it to subscribers stamped with
their current cursor. Nothing about the `thread.progress` payload changes. Replace the
three `thread.progress` appends:

```diff
@@ flushProgress (≈4325)
         const flushProgress = async () => {
           if (scripted || !pendingProgress || isBackgroundRunTrigger(run.trigger)) return;
-          await deps.events.append({
+          await deps.events.publishTransient({
             spaceId: run.spaceId,
             threadId: thread.id,
             botId: bot.id,
             type: "thread.progress",
             runId,
@@ runtime "progress" event (≈9024)
             } else if (event.type === "progress") {
               toolCallStreak = { key: undefined, count: 0 };
               if (isBackgroundRunTrigger(run.trigger)) continue;
               // Flush batched text deltas first so an activity line cannot land
               // ahead of text the model streamed before the tool call.
               if (pendingProgress) {
-                await deps.events.append({
+                await deps.events.publishTransient({
                   spaceId: run.spaceId,
                   threadId: thread.id,
                   botId: bot.id,
                   type: "thread.progress",
                   runId,
                   payload: { delta: pendingProgress, streaming: true },
                 });
                 pendingProgress = "";
                 lastProgressAt = Date.now();
               }
-              await deps.events.append({
+              await deps.events.publishTransient({
                 spaceId: run.spaceId,
                 threadId: thread.id,
                 botId: bot.id,
                 type: "thread.progress",
                 runId,
                 payload: {
                   text: redactSecrets(event.text, runSecrets),
                   ...(event.activity ? { activity: true } : {}),
+                  ...(event.phase ? { phase: event.phase } : {}),
                 },
               });
```

The `phase` pass-through is the compaction tail status: pi-runtime pushes
`{ type: "progress", text: "", activity: true, phase: "compacting" }` when native
compaction starts; the frontend branch adds the optional `phase` field to the
contracts progress block.

Keep the existing `thread.progress` deletes at run end (`finalizeRun`,
`pauseRunFor*`, stop, expire): they still clean up the rows written by the >8 KB /
no-fanout fallback. Durable catch-up after a reconnect is unchanged: the mid-turn
`message_user` messages and the final message are stored as today; only the live
deltas are no longer in Postgres. The `priorProgress` rehydration at ≈4254 reads
messages, not events, so it is unaffected.

Test doubles that build a `ThreadEvents` for the executor need a
`publishTransient: vi.fn()` next to `append`.

## 2. `packages/adapters/src/executor.ts` — pass the interject flag to the runtime (L4)

`ClaimedSteeringMessage` now carries `interrupt?: true` (read from
`SteeringMessage.originTrigger === "interrupt"`). Forward it on the
`AgentSteeringMessage` the runtime polls for:

```diff
@@ claimSteering mapping (≈8959)
                         return {
                           id: item.id,
                           messageId: item.messageId,
                           historyText: item.text,
+                          ...(item.interrupt ? { interrupt: true as const } : {}),
                           text: [
```

## 3. `apps/api/src/thread-target.ts` — persist the interject flag on send (L4)

`threads.send` input now accepts `interrupt?: boolean`. The thread-target writes the
steering row directly, so it must store the marker the same way `sendUserMessage`
does: `originTrigger: "interrupt"`, and only when the row is attached to a live
conversational run (`runId` set). Pending rows (`runId: null`) must not carry it, so
the pending filters in `claimSteering` (`originTrigger: null | "messaging"`) keep
matching. `finalizeRun` clears the marker when a row reverts to pending.

```diff
@@ sendThreadMessage input type (≈632)
   input: {
     text?: string;
     correspondenceReference?: RecruitingCorrespondenceReference;
     artifactIds?: string[];
     addressing?: "coordinator" | "mentions";
     mentions?: MentionTargetInput[];
     replyToMessageId?: string;
     replyQuote?: string;
     clientNonce?: string;
+    /** Interject: interrupt the bot's live reply with this message. */
+    interrupt?: boolean;
   },
@@ direct bot target (≈817)
           const active = activeRuns.find(steersUserMessage) ?? activeRuns[0];
           if (active) {
+            const steers = steersUserMessage(active);
             await tx.steeringMessage.create({
               data: {
                 messageId: message.id,
                 botId: target.botId,
                 userId: actor.userId,
-                runId: steersUserMessage(active) ? active.id : null,
+                runId: steers ? active.id : null,
+                ...(steers && input.interrupt ? { originTrigger: "interrupt" } : {}),
               },
             });
@@ group target, per bot (≈994)
           const active = activeByBotId.get(botId);
           if (active) {
+            const steers = steersUserMessage(active);
             await tx.steeringMessage.create({
               data: {
                 messageId: message.id,
                 botId,
                 userId: actor.userId,
-                runId: steersUserMessage(active) ? active.id : null,
+                runId: steers ? active.id : null,
+                ...(steers && input.interrupt ? { originTrigger: "interrupt" } : {}),
               },
             });
```

`apps/api/src/router.ts` needs no edit: `threads.send` already passes the parsed
input through to `sendThreadMessage`.

## Storage note (no migration)

`SteeringMessage` has no JSON/metadata column. The flag lives in the existing nullable
`originTrigger` column (today only `null` or `"messaging"`), as the value
`"interrupt"`. It is set only on rows bound to a live conversational run, it is
cleared by `finalizeRun` before rows can revert to pending, and `steeringOrigin()`
already treats any non-`"messaging"` value as the app origin. A dedicated boolean
column would be cleaner; if that is preferred it is a one-column Prisma migration
(`interrupt Boolean @default(false)` on `steering_messages`).
