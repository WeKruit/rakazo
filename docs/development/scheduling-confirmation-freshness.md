# Scheduling confirmation freshness correction

This corrects a confirmed blocker in the immutable `eb21618279f9f69e793ec1c2962b588f8487c057` review artifact. That artifact's claim that an old plan cannot confirm a changed booking was too broad: an accepted booking read taken before a later cancellation or reschedule could still authorize confirmation. Do not release that checkpoint without this correction.

Independent native PostgreSQL tests reproduced six failures: cancellation and rescheduling, each completed, executing or uncertain, incorrectly allowed the old accepted read. Linked execution tests also reproduced confirmation dispatch after approval resumed following a separate approved calendar mutation. These were local synthetic reproductions, not live sends.

The correction checks the exact owner's calendar source, source revision and booking UID across threads. Unresolved mutations require reconciliation. Verified cancellation or supersession invalidates the immutable original plan. Other relevant attempted changes require a strictly later accepted read of that same booking, with the original interval and actual host/attendee still matching. Another source, revision or UID cannot invalidate or authorize this booking. Incomplete retained history fails closed.

The native execution path revalidates the association on approval replay and before connector execution. The final dispatch correction also checks scheduling confirmation evidence after the connector's asynchronous original-message checks and immediately before its mail POST. This does not invent provider-side atomicity: an external calendar change after the final local check cannot be made transactional with an unrelated mail provider. No new automatic resend, calendar mutation, table, migration or dependency is introduced.

Final commit, test results and transferable artifact hashes are recorded in the accompanying manifest. Live source activation, exact caller grants, actual provider readback and original-session acceptance remain pending. This correction performs no publication, deployment, grant, live synchronization, email or calendar operation.

The supported plan confirmation wrapper resolves to the existing native Instantly reply operation. The final check uses a trusted in-process reference to the actual stored effect, rather than a computed idempotency key that might differ after legacy-effect reconciliation. Missing or mismatched evidence fails closed; ordinary replies are unchanged. Independent static review caught and verified correction of that key mismatch.

## Final local validation

Code checkpoint: `861dba93ef8b5d50b46bc247e5d818bbb2241782`. The following documentation-only commit does not change the tested code.

- Native PostgreSQL: **49 passed**, including 37 scheduling-plan and 12 calendar-approval cases. The new cases cover exact-source mutations across threads, successful cancellation/supersession, executing/uncertain outcomes, strictly newer readback after a known failed change, supported confirmation/attendee writes, and unrelated source/revision/UID controls.
- Combined native mail connector, linked scheduling workflow, scheduling adapter and executor idempotency: **402 passed across four files**. The linked suite includes 16 scenarios; its three new approval-pause cases each reproduced an unwanted send before the fix and zero sends afterward. The connector suite includes nine targeted final-dispatch cases. These are subsets, not additional unique counts.
- API TypeScript and `git diff --check`: passed. The preexisting PostgreSQL client-query deprecation warning remains.
- No UI source changed in this correction; prior targeted visual evidence remains applicable only to the captured states.

```sh
VERIFY_DATABASE=1 DATABASE_URL='<isolated-local-postgres-url>' pnpm exec vitest run packages/db/src/recruiting-scheduling.postgres.test.ts packages/db/src/calendar-approval.postgres.test.ts
pnpm exec vitest run packages/adapters/src/mcp-connector.test.ts apps/api/src/scheduling-linked-offline.test.ts packages/adapters/src/recruiting-scheduling.test.ts packages/adapters/src/executor-effect-idempotency.test.ts
pnpm exec tsc --noEmit -p apps/api/tsconfig.json
```

Independent static review covered the mutation query and final dispatch patch, including the reconciled-effect identity issue. The reviewer did not independently rerun the tests; implementation workers and the integration checkout ran the recorded suites. This is development validation, not provider or production acceptance.
