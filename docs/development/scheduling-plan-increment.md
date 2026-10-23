# Scheduling interaction and exact drilldown increment

This increment continues the immutable `96a45a0a643b07595ff23fc5211b4016162fb201` review checkpoint. It implements the three explicitly requested code gaps for the supported existing native capabilities. It is not a claim that all 59 requirements or live acceptance are complete. No push, PR, merge, deployment, production access, permission grant, real synchronization, email or calendar action was performed.

Code checkpoint: `91e85d2dc17d048e9da53f80ce5d59fa263e1495`. The later documentation-only commit is pinned separately in the transfer manifest.

## What now works in code

1. **Original conversation → reviewable plan.** Both the legacy CRM Inbox and native Inbox can select the exact candidate, original message, observed availability interval and explicit participant time zones. The form shows start/end, duration, each local date and daylight-saving offset, original subject and sending mailbox. Save creates an internal draft, not approval. The selected plan travels to the existing role chat through bounded structured context; internal IDs are not inserted in ordinary user text. The agent can draft/read the same plan through the existing builtin tool boundary. Unsupported or incomplete availability remains explicit.
2. **Plan → booking → specific confirmation.** Web and agent tools share one scoped database service using existing external-effect records; there is no new table or migration. Exact source/revision, role, candidate, original message/thread/account/campaign and actual read proofs are retained. Legacy CRM provenance remains separate from its uniquely verified native mail source. Native LinkedIn candidates can use the existing role-campaign candidate-to-lead/email receipt without requiring a CRM import. Actual native approval cards bind the complete plan and exact action to the genuine answer event. Booking and confirmation are durably associated with specific effect IDs. Confirmation requires an accepted exact booking readback, real host/attendee and interval. A POST acknowledgement alone remains unknown; an exact sent-message readback establishes the sent record, never delivery/opening. Unknown outcomes are reconcile-only, including across cosmetic duplicate plans.
3. **Overview → supported exact filter.** Weekly shortlist navigation retains the exact role, source, exclusive date boundary and observation cutoff in the route. Contacts applies it to actual recorded shortlist dates; pagination never claims a complete total before completion. Clear, Back and reload preserve the intended navigation. Metrics without an exact supported candidate/date cohort are visibly general role navigation, not a falsely exact filtered result.

Independent review also found and repaired two existing calendar projection defects: verified replacement UID lineage marks the original observation superseded (not invented cancellation), and both individual and list booking reads refresh after scoped successful, executing or uncertain calendar mutations. Uncertain mutation records do not establish ownership or permit resend.

## Verification

All providers and users in tests are synthetic. Native PostgreSQL is a local isolated database, without Docker. Counts below overlap and must not be summed as unique coverage.

| Check | Result |
| --- | --- |
| Web recruiting modules, RecruitingPanel, correspondence, Shell and structured chat context | 733 passed across 33 files |
| API recruiting/plan, linked workflow, plan adapter, executor idempotency, DB answer events and recruiting instructions | 750 passed across 7 files |
| Final plan UI refinements, including incomplete history visibility | 10 passed |
| Native PostgreSQL plan and calendar approval suites | 33 passed (21 plan + 12 approval) |
| API and web TypeScript; final translation extraction/compile and web build | Passed; existing large-chunk warning |
| Actual routes: supported metric filter plus legacy/native scheduling | 5 passed, desktop 1440×900 and mobile 390×844 |
| Final scheduling presentation after explicit duration/plain time-zone labels | 3 passed |
| Linked plan workflow within the server suite | 13 passed using real create/load/bind services, native approval answers, execution and retained sent-mail readback |

The exact commands, final native PostgreSQL count, code/test/document SHAs and artifact hashes are recorded in the transfer manifest and final validation section. The implementation tests do not prove autonomous real-world candidate interpretation or provider availability/authorization. No real calendar event or email is required or permitted for this cloud review.

Independent source review found no remaining blocker in the reviewed plan wrapper, immutable approval evidence, replay, exact source/campaign checks, association locking and no-resend paths. The linked fixture independently exercises distinct New York/Tokyo zones, daylight-saving folds, wrong-plan/mail rejection, changed bookings/slots, duplicate input, provider timeout and partial confirmation failure.

## Remaining capability and activation boundaries

- Only actual retained availability intervals in the supported discovered schema are selectable. Unknown busy ranges, buffer semantics, default duration, unsupported schemas and missing provider fields are unavailable; the application does not invent coverage.
- The requested interviewer is not asserted to be the calendar host before booking. Confirmation requires actual host/participant readback. A different host blocks confirmation rather than silently changing the plan.
- Plans are immutable historical reviews. Existing verified native reschedule/cancel paths remain available, and current calendar projections refresh correctly. This increment does not automatically revise a plan or associate a changed interval with an old confirmation; an old plan cannot confirm a changed booking. No automatic resend or invented provider reconciliation is added.
- Exact weekly shortlist filtering reflects currently shortlisted records with recorded dates, not a fabricated historical membership ledger. Full cross-source conversion cohorts, unsupported provider deep links and authoritative mark-read mutations are not supplied by this increment.
- Automatic outreach pause policy still needs its own agreed business rule; no new automatic provider mutation was added.
- Source tools, current assignments and production readback remain unverified here. The source role-mail patch, ordered migrations and narrow coordinating-bot `list_crm_role_correspondence` grant remain governed by the prior delivery procedures. No grant is automatically expanded. Calendar and native mail tools also require the actual caller's existing assignments; a configured connection is not proof of usable permission.
- Existing broader PostgreSQL baseline failures and two independently reproduced prior runtime-schema assertions remain recorded, not hidden by focused passing runs. One worker typecheck was killed by resource pressure; final integration checks use the actual combined checkout. Existing large web bundle and PostgreSQL client-query deprecation warnings remain.

## Independent reviewer route

Read the exact original message, select a recorded interval and distinct participant zones, review/save, then inspect the role-chat context and actual native approval. Verify that save or chat drafting sends nothing. Follow actual booking readback and original-thread confirmation through their separate approvals. Check a POST-only result, exact sent readback, duplicate input, timeout, changed source/role, and mismatched host. Check both a legacy role without prior chat and a native LinkedIn candidate with existing campaign evidence. Finally follow the dated shortlist chart to Contacts, clear it, go Back and refresh. Use only synthetic/local providers for this review; the production owner retains live acceptance.

The prior bundle is immutable. This increment is delivered as both a new full bundle from preserved main `94a706a089710cea083192a126ab77a8f577e91c` and a delta from `96a45a0a`. Use one representation, not both. External-hook publication remains held; no PR exists.

## Reproducible local checks

Run with the repository toolchain and a disposable local PostgreSQL database; substitute its connection string for the placeholder. No production connection is needed.

```sh
pnpm exec vitest run apps/web/src/pages/recruiting apps/web/src/pages/RecruitingPanel.test.tsx apps/web/src/pages/RecruitingCorrespondence.test.tsx apps/web/src/pages/Shell.test.tsx apps/web/src/pages/shell/recruiting-chat-context.test.tsx
pnpm exec vitest run apps/api/src/recruiting.test.ts apps/api/src/recruiting-scheduling.test.ts apps/api/src/scheduling-linked-offline.test.ts packages/adapters/src/recruiting-scheduling.test.ts packages/adapters/src/executor-effect-idempotency.test.ts packages/db/src/events.test.ts packages/core/src/recruiting-defaults.test.ts
VERIFY_DATABASE=1 DATABASE_URL='<isolated-local-postgres-url>' pnpm exec vitest run packages/db/src/recruiting-scheduling.postgres.test.ts packages/db/src/calendar-approval.postgres.test.ts
```

The broad web run preceded the final duration/history-only presentation refinements; the final ten plan checks and final build cover those refinements. Server and native database checks include the final service and receipt changes. Existing baseline failures elsewhere are not counted as passes.

Browser evidence: combined metric/scheduling routes at `d0d31fba` are Library `libfile_4c31ed7722b48191b30637f611745a1d` (SHA-256 `b8860bafcc1986208f066d8b9d02029729331766317556ea32d53f5102882fb2`). Final duration/time-zone presentation at `deefc6de` is Library `libfile_e0783198390481919ddecdb4ce49e3b7` (SHA-256 `7134a8aeb6a210f2c3ef5b81a8bd698ffecfa88ef0c4c09707f82d08dd798ff7`). The later incomplete-history notice has focused unit coverage; populated screenshots do not exercise that notice. All screenshots use synthetic fixtures.

Parent independently inspected final desktop/mobile plan captures: readable form, explicit 30-minute duration, both dated zone offsets through the daylight-saving fold, draft-versus-approval distinction and retained role-chat context passed targeted visual checks. These images do not prove calendar host identity, exhaustive availability or live freshness; backend source, duration, zone and readback checks remain necessary.
