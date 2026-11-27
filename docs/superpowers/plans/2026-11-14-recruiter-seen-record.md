# One record of what the recruiter has seen

**Goal:** every reply and list that talks about a role's people reads the same facts about what the recruiter already saw, instead of each path guessing.

**Why:** in the feedback-round journey on staging, the global chat listed the saved pool while the team was still searching. That list brought back people from round one and people the recruiter had turned down. Page 2 repeated page 1. "Where are they?" got "still in progress" with nothing to say. These came from separate paths, each with its own idea of who had been shown.

**Approach (event-sourced read model, the pattern most CRMs use for a candidate's status per pipeline):**

1. `readRecruiterSeen` in `packages/db/src/recruiting-search-quality.ts` derives, for each person, the round that showed them, whether they were returned before the latest round (the same rule as `calibrationRoundRepeats`), and the recruiter's latest verdict (`latestVerdictsSql`). It also gives the latest round. No new table.
2. `recruiting_candidates list` marks every person from it (`shownInRound`, `alreadySeen`, `recruiterVerdict`) and carries `latestRound`. This applies in role and global conversations alike.
3. `teamProgress` in `bot-messages.ts` gives what the role team is doing on this conversation's request: who, for how long, and how many people found so far. The delegation note, the global round read and the global pool page all use it.
4. The global pool page drops people the recruiter turned down. While the team prepares a round, it also drops anyone already seen. This replaces the ad-hoc round-key filter.
5. The search thread moves the round guard onto the same reader.

**Evals:** `--journeys us-recruiter-feedback-round` (repeats, turned-down people, progress while waiting), and `--story "recruiter asks where the next ten are while the search is still running"`.
