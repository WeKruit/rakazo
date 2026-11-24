# "Find N" completion loop

Goal: an ask for N people ends in the same conversation with N people shown, or with the people who
fit, how many are missing and which requirement rules out the most, plus one question. It never
ends on "later" or on a count without a list.

Design: the agent owns the ask. Its short-round rule (bot instructions) says when to search again
and when to stop, and it keeps the ask's state in its own memory note (`work.md`). Server code holds
no work state: it is for timeouts, deadlocks, agent hand-offs and hooks only (the maintainer's rule,
11-24, after a server-held progress line and end-of-turn check lowered completion). Prior art read
for this: the Workloop spec (`headhunter-agent/docs/workloop/WORKLOOP-PRD.md`): no todo tool and no
keep-going prompt, rules in an `AGENTS.md` the agent edits, open work in the agent's own files,
bounded `wait` that returns what ended and what still runs, a child's result steered to its parent.

Metric: per-ask completion from the simulated customer and list time p50/p90, not the judge's
average score.

## Steps (each is merged on its own after its eval)

1. **Done:** up to four Reviewer batches at once in the Reviewer's own lane; the Reviewer grades
   from the saved profile and opens no page; a run that may end silent is nudged once, not three
   times; the search returns a "Why recommended" sentence in the same request.
2. **Done:** the short-round rule and the `work.md` note replace the server's progress line and
   end-of-turn check. Grading rules count described, dated work for years and leave the job's own
   terms out.
3. **Next:** the Reviewer's check becomes an ordinary awaited child call whose result returns to
   the caller's turn; remove the grading run type, the held-round re-show path, the 4-minute waits
   and the guessing branches in `returnDelegatedTeamOutcome`.
4. **Then:** a large ask ("find 200") is split by the lead across `run_subagent` helpers that only
   search and save (shared audit, section I).

Each step: `sim:branch` feedback-on-some-people, us-recruiter-feedback-round and
five-asks-one-role.
