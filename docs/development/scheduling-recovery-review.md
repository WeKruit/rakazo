# Scheduling approval and recovery — focused review

Production-code checkpoint: `98545e370263efb55dbb7c92b9b254e520d340d4`. This is offline implementation evidence, not live scheduling acceptance. No real email, booking, reschedule or cancellation was performed.

## Implementation delta

- `9665837a` and `3571fd6b`: supported explicit-duration Cal.com create approval receives a fresh exact availability check using the assigned source and discovered schema.
- `c542126d`: API ownership follows only an exact successful reschedule receipt from an already role-owned creation UID to its returned replacement UID. Failed/uncertain effects cannot establish ownership.
- `9a9ad370`: original event snapshot is read before a reschedule/cancel approval; immutable evidence is stored in the existing intended effect, with request/source/revision/UID fingerprint. The displayed card and real approval answer share its hash. Replay reads the original again and rejects changed identity, time, participants or other approved content. Reschedule additionally checks the exact available interval excluding the original booking.
- `fbc2f542`: optional catalog display labels do not change source identity; the full actual request remains hash-bound.
- `9b6ff051`: completed, executing or uncertain exact matching mutations invalidate prior booking-read cache entries. The durable effect ID and status form the read epoch. Provider arguments are unchanged. This does not authorize retry, imply success or establish ownership.

## Files to inspect

| File | Review focus |
| --- | --- |
| `packages/adapters/src/calendar-approval.ts` | Typed original evidence, request fingerprint, source and snapshot equality |
| `packages/adapters/src/calendar-preflight.ts` | Exact schema/interval validation, unsupported cases fail closed |
| `packages/adapters/src/executor.ts` | Approval evidence persistence, replay checks, mutation/read cache epoch, no resend |
| `packages/contracts/src/events.ts` | Approval evidence hash contract |
| `packages/db/src/events.ts` | Hash verification under effect row lock before real answer event |
| `apps/api/src/recruiting.ts` | Exact creation/reschedule UID lineage and role/source projection |
| `packages/db/src/calendar-approval.postgres.test.ts` | Concurrent duplicate approval and tamper/legacy rejection against native PostgreSQL |
| `apps/api/src/scheduling-linked-offline.test.ts` | Real production approval/executor/native Instantly/readback functions with synthetic providers |

## Reviewer checks

1. A changed source, original event, approval hash or proposed interval cannot dispatch.
2. A legacy approval without evidence can be denied but cannot be allowed.
3. Duplicate answers/replay dispatch at most once; an uncertain mutation is never automatically resent.
4. A later read after a successful or uncertain change reaches the provider instead of reusing the pre-change receipt; failed/uncertain mutation records never prove role ownership.
5. Native Instantly confirmations retain the exact original reply anchor and mailbox; confirmation failure preserves the actual booking result.
6. Unsupported schemas, missing explicit duration and recurring cancellation are clearly unavailable, not guessed.

## Limits

The deterministic fixture scripts candidate intent and slot selection. It does not prove autonomous intent comprehension, a complete two-party timezone/slot planner, or a durable booking-to-specific-confirmation relationship. Reply failure/uncertainty is displayed separately, never inferred as a particular booking confirmation state. Final combined test counts and transferable artifact hashes are in the main delivery handoff.
