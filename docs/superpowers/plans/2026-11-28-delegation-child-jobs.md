# Harness repair step D: delegation as child jobs

Root cause 5 of the 11-28 harness audit: delegation is our own multi-tool layer. The nightly case
(11-28 09:36, new account): 「帮我写一封面试后跟进邮件的模板」 opened a role titled 「面试后跟进邮件模板」,
because the main chat's only hand-off unit is a role conversation and its instruction sent "a
template, or an email to someone in no role" to `start_role`. The maintainer's rule (11-28,
「就是主聊天不自己做」): the main chat never does work itself; it hands each ask to the agent that owns
it, and opens a role only when the ask is a role.

## What the references do

- Workloop PRD (`docs/handoff/2026-10-23/workloop-prd-zh.md`) §1.6: a child agent is a job; its
  result is the child's last assistant text (`child.go:540-558`), delivered once as one steer "Job X
  ended (status)." (`deliver.go:43-106`). §1.12: done is `IsIdle` (no run, no running job, every
  child idle; `idle.go:14`); the parent model decides what to do with the result. §1.14: the parent
  is never pinged while the child runs; the child's end wakes it once.
- Claude Code sub-agents (code.claude.com/docs/en/sub-agents) and Agent SDK subagents
  (code.claude.com/docs/en/agent-sdk/subagents): the parent names a subagent type and a prompt; "only
  its final message returns to the parent"; a background subagent's result arrives once as a
  completion notification; its permission prompts surface in the main session.
- Claude Code agent teams: when a teammate finishes it notifies the lead once, with its final answer;
  there are no periodic progress pings.

## Before: seven delegation tools

| Tool | Who calls it | Return path |
|---|---|---|
| `start_role` | main chat | opens a role, `message_bot` to its lead, returns when the role is idle |
| `delegate_to_role` | main chat | `message_bot` to a role's lead or a named teammate, same return |
| `handoff_to_bot` | role members in a role conversation | stage report texts + 10-minute check-ins (`watchOpenStages`), four suppressions |
| `message_bot` | bots outside groups (generic platform) | idle return (#1897) |
| `run_subagent` | any run (in-turn helpers) | in-turn, delivered once |
| `spawn_bot` with `prompt` | generic platform; off for recruiting | — |
| `message_agent` | another person's agent (generic platform) | — |

## After

**One tool for the main chat: `delegate_work`**, replacing `start_role` and `delegate_to_role`.
Arguments, per the 11-27 rule "hand-offs pass the recruiter's own words + which people, nothing
narrower":

- `agent`: the specialist who owns the work (Main, Sourcer, Outreach, Scheduling); left out, a role's
  lead.
- `role_id` or `group_id`: the role the work belongs to, when it belongs to one.
- `new_role`: the title of a new role, only when the ask is a new role; with `earlier_messages`.
- `people`, `round`: the saved people and round the recruiter's words refer to.

The model writes no words. Code hands over the recruiter's own newest words, and the files of their
latest message by saved id; `start_role`'s free `message` argument (audit A14: Kruit's words labelled
as the recruiter's) is gone.

**Where a child job runs.** A role's work runs in that role's conversation (unchanged). Work in no
role runs in the named specialist's own conversation: the bot's existing private thread
(`Thread.botId`, created with every bot). No new table: `message_bot` already addresses a bot's own
thread; it only needed to accept it as a cross-conversation target, so `returnThreadId` is set and
the idle return of #1897 (`settledTeamResult`, `returnSettledDelegations`) works for it as it does for
a role. The specialist's tools there are its own (a private thread is not the account-wide group),
which is the Claude Code rule that a subagent gets its own tool list.

**How the result and cards reach the recruiter.** The child's end comes back once, when its
conversation is idle, as a `bot_message` turn in the main chat, which shows it (a template in full).
A card the child waits on is copied into the main chat with `showDelegatedTeamCard`, now for a
private thread too; a failure is reported once with `reportDelegatedTeamBlocked`, named after the
specialist instead of a group. The main chat shows a role's card only for a role; a no-role job has
no card of its own (the recruiter's next sight is the result or the child's card), and the "Message
from" chip stays hidden because its source is not a group.

**Wake texts state facts.** `buildBotMessageWakePrompt` said "Relay it to the user now… include the
real names" (audit B4, which contradicts "never list people again") and "Your final written response
is automatically returned" (B5, untrue since #1897). Both become facts: whose work it is, that it is
delivered once when that work ended, and what is returned. What to do with it lives in the main
chat's instruction.

**In-role hand-off (`handoff_to_bot`).** Kept as the one in-room tool until step A lands lanes (one
live turn per agent per conversation), then merged into `delegate_work` with the role implied. In this
change its end becomes a child job's end:

- deleted: `watchOpenStages` (10-minute check-ins), its scan in the reconciler, the
  `COMPLETION_EMAIL_OFFER` ride-along and the reconciler's `completionEmail` option; the `progress`
  report;
- deleted suppressions: `roundDelivered`, `confirmedSend`, `cardWaitsOnRecruiter` (audit D10-D12): a
  stage's end is always delivered once;
- the report text states facts only: who ended the stage, how (completed, failed, nothing posted),
  the verified mail outcome, the cards still waiting (from their records), and a question closed by
  chat. The "reply NO_RESPONSE" and "check it against the Goal" instructions go;
- `handoff_to_bot`'s description loses "check it against the Goal … hand a correction" (D9/D22).

Out of this change (step A owns the turn loop): `handedOff`/`takesBackHandoff`,
`teammateAnsweredHandoff`, `handbackSuperseded`, the `newerRequestElsewhere` refusal (D18-D21), and
steering a request into a running turn (B6, B8). They decide whose words count in one conversation,
which lanes replace.

## Measuring the in-role Sourcer hand-off

Static, from the product defaults (done here): Main's service assignments are a superset of
Sourcer's (people search and CRM reads are assigned to both; Sourcer has nothing Main lacks), and
both are the same base agent with a different instruction file. So the hand-off adds a hop, a second
turn and a report, and no capability.

Dynamic (not run: the staging database is not reachable from this session). For the last 14 days of
staging and production, per role: (1) rounds after the first ten recorded by Sourcer vs by Main;
(2) for a find-N request, wall time and model turns from the recruiter's message to N met, with and
without a Sourcer hand-off; (3) how often the stage report woke Main and Main wrote anything. If
Sourcer adds no rounds Main would not have run and costs turns, the next change removes the Sourcer
hand-off (Main runs scale-out itself) and the in-role hand-off is left for Outreach and Scheduling.

## Checks

- Unit: `bot-messages.test.ts` (a private thread as target and its return), `group-handoff.test.ts`
  (one facts-only end, no suppression, no check-in), `schedule-tools.test.ts` (main chat tool list),
  `executor-effect-idempotency.test.ts` (the delegate replay).
- Journey: `infra/acceptance/simulated-journeys.mjs` `template-no-role` (source: nightly
  2026-11-28): a new account asks for a follow-up template; pass = a template in the main chat and no
  new role.
- Eval: `--journeys template-no-role`, not run here; run with `pnpm sim:branch` before merge.
