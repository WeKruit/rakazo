# Every round honours what the recruiter said

Feedback rounds kept failing on the same class of problem: the next round brought back people whose
profiles break something the recruiter had said. It might be a city ("Seattle only"), a level ("no
Staff/Principal"), or the reason they turned people down ("no production Spark/Kafka shown"). Each
was patched on its own: a location guard, a tenure guard, instruction sentences (#1183, #1236), and
a text match on the agent's notes (#1257). The same play still failed on the next trait. This plan
replaces the per-trait patches with one mechanism.

Adopted practice: structured LLM output validated against an explicit rubric (validator /
"guardrails" pattern, as in Pydantic-validated tool output and rubric-based LLM-as-judge). The model
judges, and the server only checks that the judgement is complete and consistent. There is no
server-side reading of profiles and no rules engine.

## Mechanism

1. **What the recruiter wants is the role's criteria.** Every stated constraint and every reason for
   turning people down is saved as a role criterion. The agent does this with the existing
   `recruiting_role` revise `criteria.upsert`, quoting the recruiter as its source.
   Gate: a later `calibration_round` is refused while a turn-down or constraint recorded since the
   last round (`recruiting_feedback`) has no role revision after it. That check is on state, not
   wording.
2. **Each pick gets a verdict per hard criterion.** `calibration_round` takes
   `checks: { candidateKey: { criterionId: "shown" | "unknown" | "fails" } }` and drops the
   free-text `unverified`. The server refuses:
   - a pick missing a verdict for any hard criterion (the refusal lists the criteria);
   - any `fails`;
   - `unknown` on a criterion added since the last round. This is asked once per person, the way the
     location check works. If too few people fit, the round goes through the existing short-of-ten
     path.
3. **One display.** "Not verified:" lines are built from the `unknown` verdicts as criterion
   statements. They no longer carry the agent's own prose, which produced lines like "Not verified:
   …are shown".
4. **One "seen" state.** Repeats, passes and the current round come from the shared reader the
   agent-steering thread is building. `calibrationRoundRepeats` (#1249) moves onto that reader.
5. **Remove the patches it replaces.** This covers #1257's `recruiting-raised-gaps.ts` and the
   instruction sentences about turned-down requirements. Location and tenure stay as data checks on
   saved fields. Their refusals become two more criteria verdicts in the same message.

## Files

- `packages/contracts/src/recruiting.ts`: the `calibration_round` `checks` schema.
- `packages/adapters/src/recruiting-round-check.ts` (new, focused): the verdict validation and the
  gate in step 1. Called from executor's calibration_round branch, which replaces the per-trait
  blocks there.
- `packages/adapters/src/turn-end-guard.ts`: `recruitingRoundListText` takes the verdicts.
- `packages/core/src/recruiting-defaults.ts`: merge the turned-down-requirement sentences into one
  rule saying that feedback becomes criteria. Merge them in place; don't append.

## Verification

- Eval: `--journeys us-recruiter-feedback-round` on staging, one play. The pass bar is the
  simulated-customer bar (8+, no repeats or false claims). Before: 4/10 and 3/10 on ed04706a.
- A unit test only for the validator's branches (missing verdict, fails, unknown on a new criterion,
  asked once).
