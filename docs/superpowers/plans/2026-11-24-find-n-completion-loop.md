# "Find N" completion loop

Goal: an ask for N people ends in the same conversation with N people shown, or with the people who
fit, how many are missing and which requirement rules out the most, plus one question. It never
ends on "later" or on a count without a list.

Design (approved 11-24): the shared audit `long-task-completion-plan-20261124.md`, sections A–H.
Prior art: the Claude Code subagent-as-tool and Stop hook; the Pi/OpenAI Agents SDK agent-as-tool;
the evaluator-optimizer loop (Anthropic, "Building effective agents"). The model drives the loop.
Code counts and enforces the limits. Only the Reviewer judges people.

Metric: per-ask completion from the simulated customer (the measurement thread adds it) and list
time p50/p90. Not the judge's average score.

## Steps (each is merged on its own after its eval)

1. **Grade in parallel, within the turn.** A held round's check starts up to four Reviewer
   batches at once instead of one after another. The lead's turn already waits inside the turn
   (`waitForRoundCheck`). With one batch every ~25 s, 20 people took ~2 minutes; with four at
   once they should take ~30 s. The wait limit stays for now.
2. **Progress on every result.** The round check's result (`roundReviewPrompt`) and the top-up
   searches' results state the ask's numbers from the records: asked, fit, re-search n of 3,
   missing, and the requirement that rules out the most. The `SHORT_OF_TEN` paragraph shrinks to
   "read the status and end only on the listed conditions".
3. **One check before the turn ends.** When a lead turn on a role ends while the ask is open
   (fewer fit than asked, under three re-searches, no question asked), the turn is sent back once
   with the record's numbers. The second time, the server states the numbers to the recruiter.
   This is the Stop-hook pattern.
4. **The Reviewer alone grades.** `save_grades` is refused in lead turns.
5. **Remove what the loop replaces.** The held-round re-show turn path, the 4-minute waits, and
   the guessing branches in `returnDelegatedTeamOutcome`. Kruit waits on the open delegation.

Each step: run the bare model on the same input first where code is removed, then `sim:branch`
fosp x3 + fr x3 (and the long-task journey once it lands).
