# Explicit scheduling plan development delivery

The native `recruiting_scheduling` tool shares the verified plan service with the API. `draft` records an internal plan and `read` inspects it; neither authorizes an invitation or message. `book` and `confirm` carry an explicit plan ID through existing native Cal.com and Instantly dispatch, approval, duplicate protection and uncertainty handling. Provider arguments and retained provider request shapes remain unchanged.

The immutable plan identifies the role, candidate, original message/thread/campaign/mailbox, verified native sending source/read, independent participant IANA timezones and an actual retained availability interval. A legacy CRM reference stays CRM provenance; it is not rewritten into a native receipt. A verified native read without an originating human message retains a null message ID.

The native card displays role, candidate, mailbox, exact UTC interval and both independently calculated local times with date-specific offsets. The interviewer is explicitly requested, not claimed to be the verified calendar host before booking. Confirmation requires the shared service to verify the actual booking and readback, including the real host and attendee, and binds that booking effect to one specific confirmation effect. The complete immutable plan, exact native request and booking association are hash-bound to the original card and genuine answer event. Source/role proof is checked again immediately before dispatch. Uncertain or existing operations are reconciled, never resent merely because a model repeats the wrapper call.

No new table, migration, dependency, provider connection or execution subsystem is introduced. No live calendar or email call was performed. The implementation checks below are development evidence, not live acceptance or proof that all workspace requirements are complete.

Local checks:

- `vitest run packages/adapters/src/recruiting-scheduling.test.ts packages/db/src/events.test.ts packages/adapters/src/executor-effect-idempotency.test.ts`: 345 passed at the initial adapter implementation.
- API TypeScript validation passed against the shared service draft.
- Builtin tool tests passed. Broader `pi-runtime-tool-schema.test.ts` retains two unrelated failures concerning candidate source input and an older role-description assertion; these are outside scheduling changes.
- Linked workflow and native PostgreSQL plan tests are owned by independent reviewers and must be integrated and run with the final service and adapter together before acceptance. No synthetic plan row, approval, send receipt or provider booking substitutes for that workflow.

Contracts: `03c659d3`, nullable native mail-origin correction `32526cf1`. Integrate with the shared DB/API service, native approval changes, hidden chat-context handoff and linked tests; the contract commit alone does not implement scheduling. Existing deployment pause and local-owner live acceptance restrictions remain unchanged.
