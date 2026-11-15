# The Reviewer checks each round and swaps out who doesn't fit

Feedback rounds on staging (11-15, six runs) kept scoring 3/10 after the turn-down. In those runs
the picker's own `checks` verdicts marked core duties, years and location as `unknown` for nearly
everyone, so the server's round check (#1330, #1353) had nothing to refuse. The Reviewer's grades
on the same people had real evidence ("6–10 years not_met: Total Experience: 10 years and 10
months"). The judge that reads full profiles already exists. It just grades the round's people
late, newest pages first, against the brief alone.

Adopted practice: generator–critic (an evaluator agent checks the generator's output and sends it
back for revision; LLM-as-judge with a rubric). Reviewer is our existing critic, and the existing
calibration correction (`corrects: true`, #1338) is our revision step. There is no new evaluator,
workflow engine or schema.

## Mechanism

1. **The round's people are graded first.** When the latest round is not yet approved,
   `startRecruitingGrading` puts its people at the front of the next batch. A grade counts for the
   round only if it was saved after the previous round was recorded, so it was made with the
   recruiter's feedback in view.
2. **The grade sees what the recruiter said.** The Reviewer's grading prompt lists the
   `roundCriteria` statements (brief fields in the recruiter's words, hard criteria, turn-down
   reasons), so a turned-down title or company counts as a requirement.
3. **Not-fit people are swapped in place.** Once every person in the round has such a grade, any
   person the Reviewer graded `Partial` triggers one lead run in the role's conversation. It runs
   once per recruiter message (nonce keyed by the latest human message), so a correction never
   triggers another correction. The run swaps those people out with a small quick search and
   `calibration_round corrects: true`, and tells the recruiter in one line who was replaced and why.
   The recruiter sees the round at once and the correction within a few minutes. This is the
   recommended option on the 11-15 decision card.

## Files

- `packages/adapters/src/recruiting-grading.ts`: round-first ordering, criteria in the self-grade
  prompt, and the review start (modelled on `reportGradedRole`).
- `packages/adapters/src/recruiting-grading.test.ts`: round-first ordering, swap started once, no
  swap while a round person is ungraded or all fit.

## Eval

`us-recruiter-feedback-round` on staging: round 2 had 3/10 fit before. After the deploy, the
corrected round should contain no one the Reviewer grades Partial.

## Update: rounds after feedback wait for the check

The 6868a8bf and 95185659 runs showed that a swap after the round is shown comes too late: the
recruiter has already acted on the wrong people. A round recorded after feedback (round 2 on, not
a `corrects` correction) is therefore held when the team has the Reviewer:

- `calibration_round` records it, but does not post the list or the next-step card. It schedules
  grading, and its `next` tells the team to save the brief and say in one line that the checked
  people come in a few minutes.
- Once every person in the round has a grade made with the feedback, the lead run either swaps
  the misfits or, when everyone fits, records the same people with `corrects: true`. That
  recording posts the list and the next-step card through the existing path.
- Round 1 still shows at once, and a correction (`corrects`) is the checked round itself.

## Update: one showing, checked fast

The recruiter should see each round once. A list followed a few minutes later by a revised list is
confusing, so a round that is already shown is never swapped afterwards. The hold stays for rounds
after feedback, and the wait is cut instead:

- The held round's grading starts with no settle delay, and a busy conversation is retried every
  3 seconds instead of 30 while a round is held.
- The Reviewer's grading prompt asks for short grades and no other calls between the profile
  reads and the save. In the eec6adf0 run, about 90 of the check's ~130 seconds went to writing
  long grades and to lookups between the reads and the save.
- Round 1 is still shown at once with the feedback question.

The 808f4f31 run still showed two lists: the round's first picks (`show_picks`) and the streamed
`calibration_round` arguments reached chat before the round was recorded and held. Neither now
posts in a turn whose round will be held (a round exists, unapproved, the team has the Reviewer,
and the turn is not the lead's run after the check).

## Update: later rounds may show saved people no round has shown

In the aceb80c9 feedback play, round 2 came back with 2 people. The Reviewer's swap then left 1,
because every person returned before the last round was refused as a repeat. Each wave of quick
searches returns about 40 rows, and only 10 of them are shown, so the role soon holds dozens of
people the recruiter has never seen. Later searches return mostly those same people. A repeat is
now someone a round showed or someone the recruiter turned down. Saved people that no round has
shown count as new, which also follows "reuse saved findings instead of repeating paid research".
