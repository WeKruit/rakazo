# WeKruit recruiting workspace

Give a recruiter one working workspace to direct Main and Sourcer, review candidate
evidence, calibrate an ongoing search, and approve outreach that is confirmed by
the sending service. Adopt Rakazo's Web, API, worker, and Pi runtime as a whole.

## Approved journey

1. Connect the existing Codex subscription through Rakazo's OAuth connection.
2. Open a Crew group with Main and Sourcer. Main owns the task and human decisions;
   Sourcer gathers evidence and continues the scoped search.
3. Answer real choice cards, including custom text, and approve one specific action
   once. Explicitly save a preference and recall it from a fresh chat.
4. Start an actual Autumn sourcing task, inspect candidate evidence, and provide
   human calibration. Continue the **same external task**, retaining its identifier,
   feedback, status, and receipts across chats and restarts.
5. Resolve the existing Supabase user and organization, then read and write the
   existing CRM under its Auth/RLS permissions. Persist candidate evidence and the
   human decision without changing the candidate's stage implicitly.
6. Review an outreach draft, explicitly approve its exact recipient and content,
   send through Instantly, and retain the service's confirmation. A reply stops
   subsequent follow-ups, including queued or retried work.
7. Run authorized routines through the same persisted task, approvals, permissions,
   and send boundaries. Complete the acceptance checks through P6 in [PLAN](PLAN.md).

## Product boundaries

- Reuse Rakazo's contracts, providers, tools, groups, memory, and scheduler. Add
  service adapters at existing boundaries; no second harness or redundant gateway.
- Existing Codex OAuth is first. More model/provider connections come later;
  preserving a native Codex App session is not an adoption prerequisite.
- No Slack, Docker, purchases, or new subscriptions in this scope. Computer use is
  disabled. Live service work uses already available, authorized accounts.
- Keep credentials in protected backend storage. Models and browser-visible state
  receive references and permitted results, never stored secrets. Use the existing
  Supabase identity and organization; a service credential cannot replace user RLS.
- Multi-human groups, multiple chats per bot, and explicit per-bot credential
  bindings remain product gaps to verify and resolve before claiming those flows.
  One successful Crew session does not establish those capabilities.

## Current checkpoint — 2026-10-15

The immediate delivery is the existing Rakazo Web product for review. Main,
Sourcer, and their Recruiting Crew are created. Defer further business schemas
and connector code until that review; retain the journey through P6 below.
Instantly is required alongside Autumn and the existing CRM. Its native API
installation has an encrypted credential and three GET tools (accounts,
campaigns, emails), each verified through the installed connector with HTTP 200.
This is read connectivity, not agent-chat or approved-send acceptance. No campaign
was edited or activated, no email was sent, and no purchase was made.

Codex OAuth is not complete: the official authorization page returned an error.
No connected-model, Crew conversation, memory, card, or P6 result is claimed.

## What is established

The Apache-2.0 fork starts from upstream revision `7d5e64c`. Local infrastructure
is available at `http://127.0.0.1:5187` with an isolated local database; no model is
connected. A selected set of 192 tests passed. These observations establish a
baseline, not a live recruiting result or completion of the approved journey.

Completion requires both deterministic implementation checks and live, redacted
provider receipts. Missing credentials or unavailable providers mean **not run**.
Keep real candidate/contact data and all private evidence out of public docs.
