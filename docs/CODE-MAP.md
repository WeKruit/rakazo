# Code map

Where to change things. Paths are relative to the repository root. Tests sit next to their
source as `*.test.ts`; `*.postgres.test.ts` needs a database.

## What the recruiting agents read

| To change | Edit |
| --- | --- |
| Main, Sourcer, Scheduling and Reviewer instructions, recruiting skills, and shared prompt notes (language, intake, calibration, brief template) | `packages/core/src/recruiting-defaults.ts` |
| How those defaults reach new and existing accounts | `packages/db/src/recruiting-bootstrap.ts` |
| Which prompt notes a recruiting turn gets | `packages/adapters/src/recruiting-context.ts` |
| Playbook stages and their labels | `packages/core/src/recruiting-playbook.ts` |
| Candidate output columns the search returns | `packages/core/src/recruiting-candidates.ts` |
| A built-in tool's name, description or arguments | `packages/adapters/src/builtin-tools.ts` (names listed in `packages/contracts/src/builtin-tools.ts`) |
| Rules applied while a turn runs (approvals, retries, voice, turn guards) | `packages/adapters/src/executor.ts`, `turn-end-guard.ts`, `turn-report.ts` |

## Search and grading

| To change | Edit |
| --- | --- |
| Required-language check: ranking and wording | `packages/adapters/src/recruiting-language.ts` |
| Required-language check: model call and provider settings | `packages/adapters/src/judge.ts`, `infra/cloudflare/language-judge.js` |
| Location matching (US place names live in `packages/adapters/src/datasets/`) | `packages/adapters/src/recruiting-location.ts` |
| Must-haves and tenure checks | `packages/adapters/src/recruiting-must-haves.ts`, `recruiting-tenure.ts` |
| Starting and polling a search | `packages/adapters/src/recruiting-research.ts`, `recruiting-research-poll.ts` |
| Reviewer grading | `packages/adapters/src/recruiting-grading.ts`, `recruiting-assessment.ts` |
| Saving feedback | `packages/adapters/src/recruiting-feedback.ts` |
| Matching the same person across sources (LinkedIn identity) | `linkedinIdentity` in `packages/core/src/recruiting-candidates.ts` |

## Email, sequences and scheduling

| To change | Edit |
| --- | --- |
| Instantly campaigns, leads and senders | `packages/adapters/src/instantly-native-writes.ts`, `instantly-senders.ts`, `instantly-reply.ts` |
| Replies and reply check-ins | `packages/adapters/src/recruiting-reply.ts`, `recruiting-checkin.ts`, `recruiting-live-correspondence.ts` |
| Sequences | `packages/adapters/src/recruiting-sequences.ts` |
| Calendar and interviews | `packages/adapters/src/recruiting-scheduling.ts`, `calendar-approval.ts`, `calendar-preflight.ts` |

## Data, API and screens

| To change | Edit |
| --- | --- |
| Recruiting tables (schema) | `packages/db/prisma/schema.prisma` |
| Recruiting reads and writes | `packages/db/src/recruiting.ts` |
| Recruiting read tools and role candidate lists | `packages/adapters/src/recruiting-reads.ts` |
| Shared request and response shapes | `packages/contracts/src/recruiting.ts` |
| API routes | `apps/api/src/router.ts` |
| Web recruiting screens | `apps/web/src/pages/recruiting/` |
| Mobile screens | `apps/mobile/app/` |

## Checks and releases

| To change | Edit |
| --- | --- |
| Real-user acceptance scenarios | `infra/acceptance/real-user-scenarios.mjs`, `real-user-checks.mjs` |
| Deploy and release scripts | `docs/deploy/` |
