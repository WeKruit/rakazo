# Integration hunks for branch `codex/wl-c-background-security`

Files below are owned by other agents; apply these hunks when integrating. Everything else on
the branch is self-contained and tested. Line numbers refer to `codex/workloop-all` @ 2a732359.

## S1 — scope bot command variables to the command text (`packages/adapters/src/executor.ts` ~6726)

```diff
             const commandEnvironment = await shellCommandEnvironment({
               prisma: deps.prisma,
               secretStore: deps.secretStore,
               scope: run,
               spaceEnvironment: agentEnvironment,
               registerRedactions: registerRunSecrets,
+              command,
             });
```

Without `command` the helper keeps the old behaviour (all variables), so the hunk is optional
for compilation but required for the tightening to take effect.

## S2 — refuse irreversible tools on external-text runs (`packages/adapters/src/executor.ts` ~5392)

Import `externalTextTriggerToolRefusal` from `@rakazo/core` next to
`unattendedTriggerToolRequiresApproval`, then right after `requiresExplicitApproval` is computed
(before the approval decision):

```diff
           const requiresExplicitApproval = toolRequiresExplicitApproval(
             policyToolName,
             connectorCall.route,
             args,
             nativeMcpWriteServer?.endpoint,
           );
+          // A run opened by external text may read and draft but never send or change records.
+          if (!verifiedInternalWrite && !researchMutation) {
+            const refusal = externalTextTriggerToolRefusal(
+              run.trigger,
+              researchAdmission?.kind === "read" ? name : policyToolName,
+              viaConnector,
+              connectorCall.route,
+              args,
+              nativeMcpWriteServer?.endpoint,
+              declaredReadOnly,
+            );
+            if (refusal) return { error: refusal };
+          }
```

`verifiedInternalWrite` and `researchMutation` are declared a few lines later today
(~5452–5461); move this block below them, or hoist those two declarations. `declaredReadOnly`
is declared at ~5423; place the block after it.

## L3 — hand still-working research to the poll job (`packages/adapters/src/executor.ts` ~5279)

```diff
           const researchResult = async (
             admission: RecruitingResearchCallAdmission,
             result: unknown,
             receipt?: { id: string; request: unknown; historicalBackfill?: boolean },
           ) => {
             if (!deps.artifacts) throw new Error("Recruiting research requires artifact storage");
             return redactConnectorPayload(
               await completeRecruitingResearchCall(
-                { prisma: deps.prisma, artifacts: deps.artifacts },
+                { prisma: deps.prisma, artifacts: deps.artifacts, jobs: deps.jobs },
                 researchActor,
```

The tool result then carries `background: "<notice>"` whenever the provider is still working after
the (now 10 s) foreground status wait; the model is told results arrive automatically.

## L3 — give the job handlers the MCP connector

`apps/worker/src/index.ts` ~264 and `apps/api/src/app.ts` ~517, in `createBackgroundJobHandlers({ ... })`:

```diff
     messaging,
     cloudAgent,
+    connector: stack.connector,
     shutdownSignal: shutdown.signal,
   });
```

Without it `recruiting_research.poll` runs but skips the provider probe (no wake, no error).

## Job registry

`recruiting_research.poll` is already registered in `@rakazo/adapter-kit` (types, payload schema,
`recruitingResearchPollJob`) and in `createBackgroundJobHandlers`, which is what the graphile task
list is built from (`packages/adapters/src/wakeup.ts`). No executor change is needed for the wake
run: it is an ordinary queued run with `trigger: "recruiting_research"` continued by `run.continue`.
