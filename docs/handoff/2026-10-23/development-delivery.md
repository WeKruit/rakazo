# Development delivery — 2026-10-23

Development validation is not live acceptance. This task has not deployed, connected to production, migrated production, run a real CRM sync (including dry run), or sent outreach. The deployment hold in the existing overall handoff remains in force. Only the assigned local deployment owner may verify and lift it under the user's instructions.

## First independently validated batch

Base main: `a5003a28` (handoff PR #76). GitHub confirmed #65 and #73 already merged; #72 and #74 were still draft/open at `461c496472edd53b1445ee47b2097134230cdba7` and `85ede9abb3d198ed74149632813f78a3e9a627dd`. They are not included in this first batch.

Code head: `214a7a9d`.

| Area | Integrated commits | Result |
| --- | --- | --- |
| Inbox | `8a3001ae30953712539fba955dcc3c7fa62bffdb` | Older unscoped observations cannot revive messages superseded by newer campaign observations; newer valid reads remain visible. |
| Authorization | `1e1d2fead1da25ac5bd3662fdb6293a46770d219` | Membership and deployment-owner authorization are checked afresh. This fixes all five historical recruiting API failures. |
| Panels | `161bed7f20bc545e6f6476834812c1d10d4e492a`, `5d8037f8f0fbad0cd0b43e26ae1368c80e96881a`, `ce8edcb373f06cfd17b4d4e9d5b873c314d819df` | Persistent navigation/chat widths, responsive pane bounds, RTL keyboard operation and drag cleanup. Original branch work preserved; formatter patch not applied wholesale. |
| Frontend | `44489460cd890dcb7e65a5815c280da117eb2875` | Approval titles, duplicate-role dates, and deferred asset reload during active work. |
| Core | `ee411749133442eb262fb54b7557a14d6acbb5a5`, `214a7a9d` | Durable system continuations cannot count as human approval; cumulative distinct calibration threshold; correct attention; one-time unread nudge; no false finished notification. Existing recovery, budget summaries and NO_RESPONSE are reused. |

No new migrations or dependencies in this batch. Raw reasoning exposure requested by legacy handoffs conflicts with the current instruction; only safe activity/progress summaries are retained. Existing first-page candidate pagination is already implemented; no speculative replacement was added.

## Validation

- Combined integration: `vitest run apps/api/src/recruiting.test.ts packages/db/src/scope.test.ts apps/api/src/actor-from-membership.test.ts apps/web/src/components/PaneResizeHandle.test.tsx apps/web/src/lib/preload-recovery.test.ts apps/web/src/pages/shell/RecruitingNavigation.test.tsx apps/web/src/components/AskCard.test.tsx apps/web/src/components/LiveWork.test.tsx packages/adapters/src/turn-end-guard.test.ts`: **327 passed**.
- Web TypeScript: `tsc --noEmit -p apps/web`: passed. Core/API checks passed in the core worktree.
- Independent Inbox/authorization suites: 385 passed. Frontend suites: 237 passed. Panel unit suites: 213 passed. These overlap and are not an additive total.
- Real local Chromium with synthetic fixtures: duplicate-role subtitle 1 passed; resize/persistence/RTL/breakpoints 2 passed. Browser screenshots were inspected locally.
- Full legacy resizable browser journey stops before panel actions because its signup-heading assertion is stale. Fixture browser coverage above is not a claim that the full journey passed.
- Existing adapter schema tests: 30 passed, 2 failed on the base as independently reproduced. DB/adapter full typechecks retain existing test-fixture errors; final batch will list exact remaining failures.

Native PostgreSQL is used for ongoing database validation. Before the historical no-Docker restriction was conveyed to this cloud task, workers used disposable local PostgreSQL containers with synthetic data; those owned containers were stopped and preserved. No production data or credentials were involved. Database checks are being repeated using native PostgreSQL.

## Publication/deployment boundary

All repository workflow triggers were audited before publication. Main pushes can invoke SSH production deployment, production mobile OTA and server-image publication. Reading repository Actions variables returned HTTP 403; no settings or security controls were changed. GitHub documents `[skip ci]` for push/pull_request workflow suppression: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs . Every integration merge must explicitly include this marker and be verified afterward. No pull_request_target deployment path exists; workflow_run only publishes test reports. Required checks must never be bypassed by changing branch protections. Skipped CI must be reported, not described as passing.

Do not deploy this partial batch independently while CRM completion is underway. The local owner should use the final ordered delivery and exact main revision. Historical live revision and ledger figures in the handoffs have not been reverified by this task. Inaccessible shared/Mac paths were not read.

## Pending final batch

CRM #72 cursor/concurrency/absence safety, upstream company/history transport and source migration; profile #74 notes/reminders/shortlist completion; final combined validation; ordered migration and deployment/sync/readback instructions. No live acceptance is claimed. Product decisions deferred in the handoff (new interview table, application rename, rolling-deployment resources) remain deferred.
