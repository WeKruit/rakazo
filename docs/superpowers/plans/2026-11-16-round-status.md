# One owner and one state for a calibration round

Rounds after feedback are held for the Reviewer's check and shown once. Staging 11-15/16 kept
losing or repeating them: a later turn recorded round 3 over a held round 2, the lead handed the
held round to the Reviewer as a chat turn, the check gave up behind other turns, and a message
already answered by a shown round built another. Each case got a guard (#1424, #1430, #1438,
#1449, #1462). They keep recurring because the round's state is never stored. It is inferred from
which run's nonce recorded the round, `approvedAt`, grade timestamps and a 15-minute window, and
every run in the role conversation (teammate message, background tool, follow-up, grading, review)
can record a round or hand off, all in the same per-thread lane.

Adopted practice: durable workflows with an explicit step state and one owner per step (Temporal
workflows and activities; LangGraph's checkpointed state graph, where a node runs only from the
state the graph is in; the superagent harness's work-state card, 11-14). Tools request a
transition; the server accepts or refuses it from the stored state. No new engine: the state is a
column on the existing round row, and the steps are the existing grading and review runs.

## State (S2 of the 11-16 reliability plan)

`recruiting_calibration_rounds` gains `status` (`checking`, `checked` or `shown`, default `shown`),
`ownerBotId`, `version` and `statusAt`. Every change is a conditional update on the version it read.
A `checking` or `checked` round older than 15 minutes counts as `shown`, so a lost check never
wedges a role.

| From | Event | To | Who |
|---|---|---|---|
| (none) | round recorded after a shown round, team has the Reviewer | checking | recording run; its bot is the owner |
| (none) | any other round | shown | recording run |
| checking | every person in it graded with the feedback in view | checked | the grading start (the Reviewer's step) |
| checked | owner records `calibration_round` with `corrects: true` | shown, same row, fresh `createdAt` | owner only |

While a round is `checking`, every `calibration_round` is refused; while `checked`, everything but
the owner's correction is refused. The save enforces it; the executor refuses the same earlier, before
the turn spends a search. A shown round is never corrected again.

## What goes away

- `roundHeldForReview` and every inference from the recording run's nonce: the save, the next-step
  card, the held-round reply, `reviewed` in the round check and the people-listing hold read the
  stored state.
- The executor's separate corrects refusal (the save owns it).

`roundAwaitingReview(prisma, {threadId, roleId})` keeps its signature and return (held round number
or null), now `status !== "shown"`; `roundState(prisma, roleId)` exposes the record for S3's lane
change. Lanes, the review run and the hand-back stay as they are: S1 and S3 (steering thread)
replace them.

## Files

- `packages/db/prisma/schema.prisma`, migration `20261116040000_calibration_round_status`.
- `packages/db/src/recruiting.ts`: `calibrationRoundStatus`, `markCalibrationRoundChecked`, the save.
- `packages/adapters/src/recruiting-grading.ts`: `roundState`, `nextRoundHeld`,
  `roundAwaitingReview`, the checked transition.
- `packages/adapters/src/executor.ts`: callers read the state.

## Eval

`us-recruiter-feedback-round` on staging, two plays: every round after feedback shown exactly once,
round-2 wait and candidate quality (blind full-profile judge, all hard conditions) per round.
Before (513124e9): 3/10 and 3/10, round 2 lost in play 2, 336 s in play 1, checked rounds 9/10 and
4/10.
