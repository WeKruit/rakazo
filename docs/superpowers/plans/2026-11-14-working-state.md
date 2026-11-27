# Working state: one record of what the agents know, read every turn

## Problem

Tonight's simulated-customer failures (eval FINDINGS mechanisms `state-claims`, `reference`,
`language`) share one cause: what Kruit knows each turn is pieced together from chat text, not read
from state the host keeps.

- What a role team did: Kruit reads the last six messages of each role, 180 characters each
  (`cross-role-digest.ts`). It says "still in progress", mixes two roles' facts, and hands work to
  the wrong role.
- What was done: the turn's tool receipts live only in `TurnReportLedger` for that attempt. The
  next turn, and Kruit reading a role, see the model's own prose ("saved", "1 sent").
- Which language: each path guesses from the messages in its own thread. A role thread that only
  holds Kruit's English brief defaults to English.
- Which role: nothing records the role in focus; it is guessed again on every handoff.

The edge checks of #1265 (language per line), #1270 (claim vs receipt regex, role resolver) catch
these after the model has written them.

## Practice adopted

DeepSeek Harness's dsh-superagent (MIT): the main Session only routes; each piece of work (a
Ticket) has host-stored state, and its Executor reports only through a structured Report (progress,
waiting, ready, blocked, failed, plus a summary of at most 600 characters). The main Session reads
compact cards of Tickets built from the store, never the Executors' chat, and its docs reject
"inferring waiting on a person from a report's free text". Dynamic sections are regenerated on
every model request and placed last so the prompt prefix stays cached. The same idea is
"structured note-taking" in Anthropic's context-engineering guidance and dialogue state tracking.

Mapping: Kruit is the router, each role is a Ticket, the role team is its Executor, a role run's
status is its Report.

## Design

One module, `working-state.ts` (it replaces `loadCrossRoleDigest`), builds a compact card from
records only (runs, events, roles, the recruiter's own messages), never from model prose:

1. **Recruiter**: the language of their newest clear message across all their conversations.
2. **Focus role**: the role the recruiter's own words name (`referredRole`), else the role this
   conversation last handed work to, else the conversation's own role.
3. **Roles** (Kruit only): per role title, id, stage, people saved, the team's state from its latest
   run (working / waiting on the recruiter / finished / failed, with age), pending questions, and
   what its tools did lately (from receipts).
4. **Done lately** in this conversation: each successful work receipt (saved, sent, drafted,
   booked…) and each failed one, with age.

Receipts become durable: the `agent.tool.completed` audit event gains `work` (the ledger's
`TurnWork` for that call). The card is injected through the existing `userTurnContext` slot (last
history entry, cache-friendly), for Kruit and for role conversations. A role thread with no native
recruiter message takes the language from the card.

Large accounts (hundreds of roles, thousands of people): the card states the account's role total
and that names and counts not on it come only from a read this turn; it never lists the pool.

Next, same card: per-role requirements written only from the recruiter's own words with the source
message (a model-invented criterion, such as an unstated "not Samsung", must never become a filter),
and relayed recruiter words updating it.

Not in scope: the search's requirement filtering (#1264) and send-count data (#1268) are data
fixes the card reads; seen people stay in #1263's record.

## Steps

1. Persist `work` on tool completion audits (`turn-report.ts` `workFor`, executor `onToolCompleted`).
2. `working-state.ts` with the card; replace the digest call in the executor; extend its existing
   test file for the branching (team state, focus role, receipts).
3. Turn language falls back to the account's newest clear language.
4. Eval: `simulated-customer.mjs --ui --mechanism reference`, `state-claims`, `language` on staging
   after deploy; before = round-12 results in FINDINGS.
5. Once those pass twice, remove the edge checks the card makes redundant (the claim regex first
   drops to a log line).
