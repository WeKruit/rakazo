# How the recruiting team runs work

Read this before changing how agents hand off, loop, retry or stop. It lists what already exists, so a fix reuses it instead of adding another layer. The model is Workloop's supervisor: Main breaks a request into stages, hands each to a teammate with a brief, watches it, checks the result and ends the request.

## Team

| Agent | Owns | Tools it is given |
|---|---|---|
| Main | The recruiter conversation, intake questions, calibration rounds (quick search), briefs, checking results, ending the request | Everything assigned to the crew's coordinator |
| Sourcer | Scale-out research through the research service, feedback relayed on the same task | Research service, people search, CRM reads |
| Reviewer | Grades every saved person through the research service, 50 at a time | Research start, status and rows only (`gradingTools`) |
| Outreach | Contact lookup, drafts, campaigns, replies | Contact lookup, mail service, people search (web only) |
| Scheduling | Availability, bookings, interview follow-through | Calendar service, mail service reads |

Defaults live in `packages/core/src/recruiting-defaults.ts` and reach every account through `packages/db/src/recruiting-bootstrap.ts` (new roles are added idempotently; a deleted one is never revived).

## A stage, start to end

1. **Brief.** Main calls `handoff_to_bot` with Goal (the user's words), Where (the role), Done when (a count or check), Context, Approach (which search mode) and Don't. A search handed to Sourcer before the conversation has a role is returned to Main to save the role first (`NO_ROLE_HANDOFF`, `group-handoff.ts`).
2. **Work.** The handed-in run gets `HANDOFF_OPENING_NOTE` (`executor.ts`): one line to the recruiter, work to Done when, end **done** (result) or **stopped** (what blocks it, what was tried, what would unblock it). A teammate's step is handed on, never a reason to stop. Tool calls after a handoff are allowed; the reply after one is not shown.
3. **Watch.** Every open stage checks in with Main once per ten-minute slot (`watchOpenStages`, run by the job reconciler). Skipped: stages waiting on the user, stages that handed on, finished turns whose research is no longer running, and slots where Main is already busy.
4. **Report.** Every stage Main hands out reports back exactly once, as completed or failed, including a mid-run failure and a stage stopped after waiting too long (`reportGroupStageOutcome`, `reportGroupHandoffOutcome`, `stuck-work.ts`).
5. **Check and end.** Main checks the result against Done when. At most two corrections for the same gap; then it tells the user the result so far and what blocks the rest.

## Search mode per step

From the 10-30 benchmark (`/mnt/project-files/exa-bench-20261030/REPORT.md`): the quick people search returns many more qualified people in seconds but only 30–72% qualify raw; the research service returns fewer, 69–92% qualified, almost entirely different people in 5–7 minutes.

- First look or calibration (10–20): quick search, four queries at once.
- Scale: quick-search waves, then the research service for the rest.
- Hard or technical role: read Reviewer's grades before calling the target met.
- A mode that worked for a role is kept in Main's bot memory.

## Limits that end loops

| Limit | Where |
|---|---|
| Same tool with the same input six times in a row stops the turn | `tool-loop.ts` |
| Handoff chains have a hop limit | `botMessageHopExhausted`, `packages/core/src/bot-messages.ts` |
| At most two corrections per gap, then report | finished-stage report text, `group-handoff.ts` |
| Grading turn: 60 tool calls, stopped at 180 | `recruiting-grading.ts` |
| Queued run or unanswered card: reminder at 4 h, stopped at 24 h | `stuck-work.ts`, `packages/core/src/stuck-work.ts` |
| Research with no result after two hours of checks reports failed | `reportStalledGroupStage` |
| Turn-end continuation (to be replaced by the stage reports above) | `turn-end-guard.ts` |

## Tool errors

- **Rate limits.** People search: a 429 in any wording is retried with Workloop's backoff (1 s doubling to 15 s, ±20%, two minutes in all), and search starts are spaced 125 ms apart (`mcp-connector.ts`). The model's own 429s are retried by the runtime.
- **Arguments.** Undeclared arguments are dropped before validation; known slips are repaired per tool in `prepareArguments` (`pi-runtime.ts`), for example over-long question text and options.
- **Tool names.** Catalog references in any common spelling resolve when they name one tool; a miss lists the exact IDs (`lazy-tool-catalog.ts`).
- **Learned fixes.** A failure followed by a changed call that works is saved to that bot's `tool-fixes.md` memory and offered the next time the same error appears (`tool-fixes.ts`).
- **Duplicates and paid lookups.** People are deduplicated by LinkedIn URL; a contact source is never charged twice for the same person (`find_emails`).

## Mid-task messages and agent messages

- A user message while an agent is working is queued as steering for the same task (`createPendingSteeringRun`).
- `handoff_to_bot` transfers a stage; `message_bot` sends a teammate a message without ending the sender's turn; `message_agent` reaches a connected agent in another account.
