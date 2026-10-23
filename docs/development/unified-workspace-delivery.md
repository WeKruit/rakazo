# Unified recruiting workspace — development review handoff

This is an independent-review handoff, **not a claim that all 59 acceptance items or live acceptance are complete**. The current production owner retains its existing hold. This development batch has not been pushed, merged, deployed, granted new access, synchronized production data, sent email or created calendar events. No Docker was used.

## Source and ownership

Integration branch: `codex/unified-workspace-review`. Preserved remote main: `94a706a089710cea083192a126ab77a8f577e91c`, rechecked with no open PRs during final review. Tested code checkpoint: `7ae2342b34bf2bbe2ac373c9324e22a00abdcedd`; later browser-test/document commits must be distinguished from that code checkpoint in the accompanying manifest. No new PR exists for this batch under the current publication hold. The final artifact contains the exact head/base and a reviewable patch; it does not authorize applying changes to production.

All six profile increments were integrated: backend/components/tab integration, visual refinement, browser tests, and the final hidden-tab profile-view retry. The retry preserves the original visit ID. Existing main changes were merged rather than overwritten. The CI/CD work remains separate; this batch does not change workflows or settings.

## Implemented and locally verified

- Legacy CRM roles open canonical native workspaces using exact owner, Space, source revision, organization and role identities. Existing verified workspaces are reused; ambiguous identity fails explicitly. No historical chat, approval, calibration progress or booking is fabricated.
- Role-scoped agent context and mail reads preserve the exact candidate, campaign, mailbox and provider thread. Unrelated bindings cannot silently rewrite the selected role. Denied required mail reads fail instead of advancing as an empty successful sync.
- Contacts, Sequence, Inbox, Interview and Overview use the unified routes. Inbox has a candidate rail, exact scoped conversation selection and Profile access. Native and CRM empty surfaces are not stacked. Unknown mailbox/thread provenance is not grouped by subject or sender.
- Sequence selects an existing campaign from its actual source page. Selection is checked again after provider reads; an ambiguous mapping requests selection rather than claiming the account is disconnected. Complete counts and incomplete lower bounds remain distinct. Candidate-wide outbox history is withheld where role provenance is unavailable.
- The calendar is the primary Interview surface. Only bookings with exact role-owned creation receipts are projected. Failed/uncertain replies appear separately from calendar status, without inventing a booking-to-reply relationship or exposing bodies in operation summaries.
- Explicit-duration Cal.com booking approvals receive fresh availability checks before dispatch, using the current assigned source and discovered schema. Conflicts, changed grants/sources, missing duration or unsupported schemas block without changing the approved request. Original-thread confirmation tests use the existing Instantly reply adapter and verify the returned thread/mailbox; uncertain confirmation does not authorize resending or rebooking.
- Profile evidence, assets, skills and viewed-by activity preserve source provenance. Notes deep links restore after reload; profile view retries work after switching tabs. The responsive detail default is 600 pixels; mobile chat no longer overlays content. Viewed-by is neither a lock nor send permission.

## Executed checks and limits

Commands use the pinned repository pnpm. Counts are per run, overlap, and must not be added as a unique total.

| Command / scope | Actual result |
| --- | --- |
| `pnpm exec vitest run apps/web/src/pages/recruiting apps/web/src/pages/RecruitingPanel.test.tsx apps/web/src/pages/RecruitingCorrespondence.test.tsx` | 502 passed, 27 files |
| Shell plus canonical Inbox worker run | 232 passed: 208 Shell and 24 Inbox tests |
| `pnpm exec vitest run apps/api/src/recruiting.test.ts apps/api/src/recruiting-reply-outcomes.test.ts apps/api/src/scheduling-linked-offline.test.ts packages/adapters/src/calendar-preflight.test.ts packages/adapters/src/mcp-crm-scope.test.ts` | 416 passed, 5 files; subsequent narrow campaign-setup regression independently passed |
| Calendar helper/executor independent review | 194 passed; linked scheduling separately 6 passed |
| `VERIFY_DATABASE=1 DATABASE_URL=<isolated-local-database> pnpm exec vitest run packages/db/src/recruiting-profile-activity.postgres.test.ts apps/api/src/recruiting-crm-sync.postgres.test.ts packages/db/src/recruiting-crm-workspace.postgres.test.ts` | 32 passed on native PostgreSQL; six profile cases enumerated in the integration checkpoint |
| API/web TypeScript checks | Passed; final source integrations also checked by their owners |
| `pnpm --filter @rakazo/web intl:extract`, `intl:compile`, `build` | Passed; existing large-chunk build warning remains |
| Actual application route browser checks | 9 passed at desktop 1440×900 and mobile 390×844; 46 screenshots plus exact capture-head/hash manifest. Synthetic intercepted provider responses only |

The first broad UI runs failed on missing translation mocks, stale coverage expectations and asynchronous hash-verified Artifact preview assertions. These were corrected without disabling verification; the final 502-test run passed. The broader PostgreSQL suite still has the separately reproduced [12 baseline failures](legacy-crm-postgres-baseline-2026-10-23.md). Targeted green runs do not erase that baseline. Catalogs retain pre-existing untranslated strings.

## Capability matrix and remaining work

The [backend item-by-item audit](backend-checklist-audit.md), [profile evidence map](profile-workspace-review.md) and [canonical acceptance checklist](unified-workspace-acceptance.md) are the detailed matrix. None substitutes a component test for live acceptance.

| Capability | Current boundary |
| --- | --- |
| Historical CRM mail | Product requires the separately delivered role-mail v2 source tool/SQL and explicit current read permission. No source publication or grant was performed in this batch. |
| Mail unread/open/click/step/owner metadata | Display only actual supported fields; absent provider telemetry is unknown, not zero. Authoritative unread actions and complete provider step/deep-link coverage are not implemented by this batch. |
| Scheduling | Explicit verified Cal.com create path and exact Instantly reply are tested offline. Complete slot discovery/proposal UI, both-party zone identity, and end-to-end autonomous candidate-reply comprehension remain incomplete. |
| Reschedule/cancel | Recovery remains blocked without a durable approved original-event snapshot; no current event is silently substituted for that approval. |
| Booking plus confirmation | Actual failed/uncertain reply outcomes are separate. Existing receipts do not establish a durable event-to-confirmation join. The UI does not claim a particular booking was confirmed from timing, subject or recipient. |
| Retry | Unknown send is reconcile-only; no automatic resend, new execution ID or rebooking. A complete confirmation-specific retry workflow is not implemented. |
| Cross-page totals and policies | Exact available data and incomplete coverage are represented honestly. Full date-window conversion cohorts, upcoming-booking drilldowns and automatic outreach pause policy are not complete; a new automatic pause policy requires an explicit business rule. |
| Visual review | Parent pixel review passed the targeted mobile Inbox and Contacts/profile layout checks (single heading, readable actions, 600-pixel detail, mobile navigation, criterion labels, evidence and activity hierarchy). The captures use synthetic asset placeholders, not production avatar/logo coverage. Remaining-page review and full V01–V12 comparison remain separate acceptance work. |
| Production | Deployment, migrations, grants, source update, dryRun and actual sync/readback remain with the local owner under separate authorization. All live states remain pending. |

## Local-owner prerequisites and read-only acceptance

Follow the corrected [CRM sync procedure](crm-sync-delivery-2026-10-23.md) and [source-mail prerequisite](legacy-crm-source-mail-prerequisite.md). They pin source base/head/patch identity and the migration order, including both `172000` product migrations, the product `190000` workspace attachment migration, and source `180000` → `181000` → `184734`. Apply the final source patch tree before its final SQL once; do not apply intermediate function versions or repeat the already merged presence patch.

Do not use the old production target as proof that this new development batch is installed. Required mail permission is an explicit narrow read-only grant for the coordinating bot, not an automatic upgrade of customized/revoked assignments. Managed defaults preserve existing customized grants.

After separately authorized installation and grant review, the local owner should verify: exact original role/workspace/source IDs; requested versus effective role arguments; exact existing campaign/mailbox mapping; a known existing mail positive sample; all sync phases and terminal skipped/error/total state. A quiet isolated dryRun must write nothing; ordinary role reads can independently update product projections, so concurrent activity must not be mistaken for a dryRun write. Only after successful `dryRun: true` review may the authorized owner choose `dryRun: false`, then read back contacts, role links and messages. Source raw table count is not the filtered `crm_list_candidates` projection total, and role-link traversal can introduce additional contacts. No real send is needed for this read-only acceptance.

The review artifact and this document do not authorize merge, production rollout, new permissions or external actions.
