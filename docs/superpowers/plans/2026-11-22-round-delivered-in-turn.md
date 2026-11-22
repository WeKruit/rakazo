# A promised round is delivered: in the turn that promised it, and back to Kruit

**Goal:** Fix the case where the recruiter asks Kruit for the next round and nothing ever comes back, even though people were found.

**Root cause (fosp, stage 352978a2):** the promise and the delivery live in different turns and sessions, connected by code that infers from state whether to deliver.

1. The role's lead ended its turn while the Reviewer was still checking the people it had found. Its answer to Kruit was marked "returned" first, and then dropped, because `returnDelegatedTeamOutcome` quits when the role conversation is busy. The Reviewer's background run counted as busy.
2. A held round is shown only by a later turn, which the grading scheduler starts. That turn never started for the request.

**Prior art:**
- Claude Code: a background task or subagent always wakes the session that started it, with its result. A foreground subagent is awaited.
- Pi, Workloop and the OpenAI Agents SDK ("agents as tools"): the parent awaits its child's result within the turn.
- Durable workflows: completion is delivered at least once, never inferred later from state.

## Changes

1. **Delivery to Kruit is at-least-once.**
   - `returnDelegatedTeamOutcome` reports `"later"` while the team chain, research or a held round is still going, and the run stays unreturned, so the existing reconciler offers it again every 30 s.
   - The Reviewer's background checks no longer count as the team being busy.
   - The delivery key per request already prevents doubles.
2. **Kruit reads the live state.** `teamProgress` treats a finished team turn whose answer has not come back yet as work in progress, so Kruit stops saying "0 new".
3. **The round comes back in the same turn.**
   - When `calibration_round` records a held round, the recording turn waits (`waitForRoundCheck`, at most 4 min, ending early on a new message) while the existing scheduler starts the checks, in parallel batches.
   - The scheduler hands the checked round to that waiting turn instead of starting a later turn.
   - Any other caller sees "owner waiting" and retries in 3 s.
   - When the wait times out, the old path, where a later turn shows the round, still applies.
4. **Unknowns are asked about.**
   - Each grade stores the requirements its profile says nothing about.
   - When at least half of the shown people's profiles are silent on one, the show step asks the recruiter about it once, beside the list.

## Tests

- Unit tests:
  - the "later" result is not marked returned;
  - background checks are left out of the busy check;
  - the checked round goes to the waiting recorder, and other callers retry;
  - the unknown requirement line.
- Eval: fosp, fr and ind journeys, x5 each, on a branch backend, against the baseline of 23, 30 and 9. Also the feedback to round 2 time.
