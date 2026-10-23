# Calibration feedback loop (after the first ten)

The recruiter chose on 2026-10-23: a round panel, and **every round shows only new people**. Built in one PR. It is not deployed: deploys stay held until the role 「分拣仓运营主管/经理 — New Jersey」 finishes its calibration run.

## What was wrong
- No one could tell which ten people were "the round". The first page returned 44 people, and the Results view listed them all.
- Feedback was expensive. Each person needed its own form with one of six options, a required reason and a recipient picker. Every submit started its own agent run and its own Autumn reply.
- The instructions contradicted each other:
  - Main and Sourcer said "turn each comment into a rule and rerun a fresh 10".
  - The stage prompt asked for 逐个反馈.
  - The skills said any subset is fine and evaluation-only feedback asks for no new people.
- There was no exit. The stage only ever reached `feedback`; nothing moved it to `scale`. The native ten-profile approval also needs a documents approval, and that rarely exists.

## What changed
- **Round record**: new table `recruiting_calibration_rounds`, migration `20261023172000_recruiting_calibration_rounds`, new table only. Each row stores the round number and the exact ten candidateKeys, plus who accepted the round, when, and how (`control` or `message`). Feedback itself stays on the native messages.
- **Agent tools**, all through the existing tool boundary:
  - `recruiting_research {operation:"calibration_round", expectedRoleRevision, candidateKeys[10]}` records a round. It is internal record keeping, with no approval. From round 2 on it refuses anyone already shown, and anyone whose first saved page is not newer than the previous round. It also refuses once a round has been accepted.
  - `recruiting_candidates {operation:"round"}` reads the latest round.
  - `recruiting_feedback {target:"round", operation:"approve", intent:{basis:"direct", quote}}` records acceptance from the recruiter's own words. The quote is verified against the run's current human message, the same way as other direct decisions.
- **Stage**: recording a round moves the role to `feedback`. Accepting a round moves it to `scale`. So does the existing native ten-profile approval.
- **Instructions**:
  - `recruiting-defaults.ts` and the stage prompts in `recruiting-playbook.ts` now say:
    - Record and present the ten.
    - Ask for feedback once; never ask for a rating of every person.
    - Merge the round's feedback into ONE reply on the same Autumn task, asking for ten new people that exclude everyone already returned.
    - Scale only after a round is accepted.
  - The tool descriptions were updated to match.
- **UI**: `apps/web/src/pages/recruiting/CalibrationRound.tsx` sits at the top of Results and in the Client feedback view. It shows 「第 N 轮 · N 人」. Each person gets 👍/👎 and an optional reason, and there is an overall-direction box.
  - 「发送反馈」 sends one plain message to the role conversation; the coordinator routes it.
  - 「可以，开始扩大搜索」 calls `recruiting.approveCalibrationRound`, then sends the recruiter's text 「第 N 轮这批人可以，开始扩大搜索。」.
  - RPCs: `recruiting.calibrationRound(threadTarget)` and `recruiting.approveCalibrationRound(threadTarget + round)`.

## Not done / next
- Not deployed. After deploy, run acceptance on 「分拣仓运营主管/经理 — New Jersey」 only (never Dyna):
  1. The agent records round 1 from its saved people. Results shows the panel.
  2. Give 👍/👎 on 2–3 people plus a direction, then send. That should produce one message and one Autumn reply.
  3. Round 2 has ten people who were not returned before.
  4. Press 「可以，开始扩大搜索」. The stage becomes 规模化搜寻 and the agent starts scaling.
- That role already has 44 saved people from before this change. Its round 1 can be any ten of them; strict "new only" starts at round 2.
- The per-person "Give feedback" form in the detail panel is unchanged, including its recipient picker.
