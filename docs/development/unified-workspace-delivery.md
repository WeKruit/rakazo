# Unified recruiting workspace — development review handoff

> Current continuation: [scheduling interaction and exact drilldown increment](scheduling-plan-increment.md). The sections below preserve the immutable `96a45a0a` checkpoint; its missing-plan, missing-confirmation-link and missing-week-filter statements are historical and superseded by that increment. Current per-item state is in [the 59-item matrix](unified-workspace-final-status.md).

This is an independent-review handoff, **not a claim that all 59 acceptance items or live acceptance are complete**. The current production owner retains its existing hold. This development batch has not been pushed, merged, deployed, granted new access, synchronized production data, sent email or created calendar events. No Docker was used.

## Source and ownership

Integration branch: `codex/unified-workspace-review`. Preserved remote main: `94a706a089710cea083192a126ab77a8f577e91c`, rechecked with no open PRs during final review. Final production-code checkpoint: `98545e370263efb55dbb7c92b9b254e520d340d4` (includes extracted UI catalogs). Combined regression/browser checkpoint: `436bd4ac6c382e78c1c168bb78938c5d52a2d986`. Subsequent document-only head is pinned in the artifact manifest. No new PR exists for this batch under the current publication hold. The final artifact contains the exact head/base and a reviewable patch; it does not authorize applying changes to production.

All six profile increments were integrated: backend/components/tab integration, visual refinement, browser tests, and the final hidden-tab profile-view retry. The retry preserves the original visit ID. Existing main changes were merged rather than overwritten. The CI/CD work remains separate; this batch does not change workflows or settings.

## Implemented and locally verified

- Legacy CRM roles open canonical native workspaces using exact owner, Space, source revision, organization and role identities. Existing verified workspaces are reused; ambiguous identity fails explicitly. No historical chat, approval, calibration progress or booking is fabricated.
- Role-scoped agent context and mail reads preserve the exact candidate, campaign, mailbox and provider thread. Unrelated bindings cannot silently rewrite the selected role. Denied required mail reads fail instead of advancing as an empty successful sync.
- Contacts, Sequence, Inbox, Interview and Overview use the unified routes. Inbox has a candidate rail, exact scoped conversation selection and Profile access. Native and CRM empty surfaces are not stacked. Unknown mailbox/thread provenance is not grouped by subject or sender.
- Sequence selects an existing campaign from its actual source page. Selection is checked again after provider reads; an ambiguous mapping requests selection rather than claiming the account is disconnected. Complete counts and incomplete lower bounds remain distinct. Candidate-wide outbox history is withheld where role provenance is unavailable.
- The calendar is the primary Interview surface. Only bookings with exact role-owned creation receipts or a verified replacement-UID lineage are projected. Failed/uncertain replies appear separately from calendar status, without inventing a booking-to-reply relationship or exposing bodies in operation summaries.
- Explicit-duration Cal.com booking approvals receive fresh availability checks before dispatch, using the current assigned source and discovered schema. Conflicts, changed grants/sources, missing duration or unsupported schemas block without changing the approved request. Original-thread confirmation tests use the existing Instantly reply adapter and verify the returned thread/mailbox; uncertain confirmation does not authorize resending or rebooking.
- Reschedule/cancel approvals bind a durable original-event snapshot and its hash to the genuine answer event. Replay verifies the unchanged original and, for reschedule, fresh exact availability. Successful, executing or uncertain mutations expire earlier booking-read caches; uncertain effects remain reconcile-only and cannot be resent. Legacy approval cards without evidence cannot be allowed.
- Observed Instantly unread, lead and step metadata is preserved without invented values; loaded All/Unread filtering is read-only. Sequence renders actual provider schedules/steps/variants. Overview links retain role/group/view and shows only proven future recorded bookings. Unknown weekday encoding is not guessed.
- Profile evidence, assets, skills and viewed-by activity preserve source provenance. Notes deep links restore after reload; profile view retries work after switching tabs. The responsive detail default is 600 pixels; mobile chat no longer overlays content. Viewed-by is neither a lock nor send permission.

## Executed checks and limits

Commands use the pinned repository pnpm. Counts are per run, overlap, and must not be added as a unique total.

| Command / scope | Actual result |
| --- | --- |
| `pnpm exec vitest run apps/web/src/pages/recruiting apps/web/src/pages/RecruitingPanel.test.tsx apps/web/src/pages/RecruitingCorrespondence.test.tsx` | 512 passed, 28 files (final combined UI run) |
| Shell plus canonical Inbox worker run | 232 passed: 208 Shell and 24 Inbox tests |
| `pnpm exec vitest run apps/api/src/recruiting.test.ts apps/api/src/recruiting-reply-outcomes.test.ts apps/api/src/scheduling-linked-offline.test.ts packages/adapters/src/calendar-preflight.test.ts packages/adapters/src/mcp-crm-scope.test.ts` | 416 passed, 5 files; subsequent narrow campaign-setup regression independently passed |
| `pnpm exec vitest run apps/api/src/recruiting.test.ts apps/api/src/recruiting-reply-outcomes.test.ts packages/adapters/src/mcp-connector.test.ts packages/adapters/src/executor.test.ts` | 686 passed, 4 files (final combined API/connector/executor run) |
| `VERIFY_DATABASE=1 DATABASE_URL=<isolated-local-database> pnpm exec vitest run packages/db/src/calendar-approval.postgres.test.ts packages/db/src/recruiting-profile-activity.postgres.test.ts apps/api/src/recruiting-crm-sync.postgres.test.ts packages/db/src/recruiting-crm-workspace.postgres.test.ts` | 44 passed on native PostgreSQL (final four-file run); six profile cases enumerated in the integration checkpoint |
| `pnpm exec vitest run apps/api/src/scheduling-linked-offline.test.ts packages/adapters/src/calendar-approval.test.ts packages/adapters/src/calendar-preflight.test.ts packages/adapters/src/executor-effect-idempotency.test.ts packages/db/src/events.test.ts` | 373 passed, 5 files at the combined checkpoint; includes 13 linked scenarios, both timeout→fresh-read regressions |
| API/web TypeScript checks | Passed; final source integrations also checked by their owners |
| `pnpm --filter @rakazo/web intl:extract`, `intl:compile`, `build` | Passed; existing large-chunk build warning remains |
| Actual application route browser checks | 12 passed at desktop 1440×900 and mobile 390×844; 52 screenshots plus exact capture-head/hash manifest (`libfile_f14c9a776e70819184592df54b5ec437`). Synthetic intercepted provider responses only |

The first broad UI runs failed on missing translation mocks, stale coverage expectations and asynchronous hash-verified Artifact preview assertions. These were corrected without disabling verification; the final 512-test run passed. The broader PostgreSQL suite still has the separately reproduced [12 baseline failures](legacy-crm-postgres-baseline-2026-10-23.md). Targeted green runs do not erase that baseline. Catalogs retain pre-existing untranslated strings.

## Capability matrix and remaining work

The [current 59-item status](unified-workspace-final-status.md), [focused scheduling review](scheduling-recovery-review.md), [backend item-by-item audit](backend-checklist-audit.md), [profile evidence map](profile-workspace-review.md) and [canonical acceptance checklist](unified-workspace-acceptance.md) are the detailed matrix. None substitutes a component test for live acceptance.

| Capability | Current boundary |
| --- | --- |
| Historical CRM mail | Product requires the separately delivered role-mail v2 source tool/SQL and explicit current read permission. No source publication or grant was performed in this batch. |
| Mail metadata | Observed unread tri-state, lead/step IDs and observation time are transported; loaded All/Unread filtering is implemented. Mark-read actions, absent tracking telemetry and authoritative provider deep links are not invented. |
| Scheduling | Explicit verified Cal.com create path and exact Instantly reply are tested offline. Complete slot discovery/proposal UI, both-party zone identity, and end-to-end autonomous candidate-reply comprehension remain incomplete. |
| Reschedule/cancel | Supported native paths now require a durable original snapshot bound to approval; changed original/slot, duplicate answers, provider timeout and confirmation failure are covered offline. Unknown schemas/durations and recurring cancellation are unavailable. No live mutation was performed. |
| Booking plus confirmation | Actual failed/uncertain reply outcomes are separate. Existing receipts do not establish a durable event-to-confirmation join. The UI does not claim a particular booking was confirmed from timing, subject or recipient. |
| Retry | Unknown send is reconcile-only; no automatic resend, new execution ID or rebooking. A complete confirmation-specific retry workflow is not implemented. |
| Cross-page totals and policies | Exact available data and incomplete coverage are represented honestly. Upcoming recorded bookings and role/view drilldowns are implemented. Full date-window conversion cohorts and automatic outreach pause policy are not complete; a new automatic pause policy requires an explicit business rule. |
| Visual review | Parent pixel review passed targeted major-layout checks across Contacts/profile, Inbox, Sequence, Interview and Overview. Inbox retains a top-heavy heading/toolbar density limitation; no pixel-copy claim is made. The captures use synthetic asset placeholders, not production avatar/logo coverage. Full V01–V12 and live-data acceptance remain separate. |
| Production | Deployment, migrations, grants, source update, dryRun and actual sync/readback remain with the local owner under separate authorization. All live states remain pending. |

## Local-owner prerequisites and read-only acceptance

Follow the corrected [CRM sync procedure](crm-sync-delivery-2026-10-23.md) and [source-mail prerequisite](legacy-crm-source-mail-prerequisite.md). They pin source base/head/patch identity and the migration order, including both `172000` product migrations, the product `190000` workspace attachment migration, and source `180000` → `181000` → `184734`. Apply the final source patch tree before its final SQL once; do not apply intermediate function versions or repeat the already merged presence patch.

Do not use the old production target as proof that this new development batch is installed. Required mail permission is an explicit narrow read-only grant for the coordinating bot, not an automatic upgrade of customized/revoked assignments. Managed defaults preserve existing customized grants.

After separately authorized installation and grant review, the local owner should verify: exact original role/workspace/source IDs; requested versus effective role arguments; exact existing campaign/mailbox mapping; a known existing mail positive sample; all sync phases and terminal skipped/error/total state. A quiet isolated dryRun must write no CRM source or projection rows. It does create/rotate temporary server-owned progress metadata; that is not a zero-database-write claim. Ordinary role reads can independently update product projections, so concurrent activity must not be mistaken for a dryRun projection write. Only after successful `dryRun: true` review may the authorized owner choose `dryRun: false`, then read back contacts, role links and messages. Source raw table count is not the filtered `crm_list_candidates` projection total, and role-link traversal can introduce additional contacts. No real send is needed for this read-only acceptance.

The review artifact and this document do not authorize merge, production rollout, new permissions or external actions.

## Publication gate and exact next authorization

No remote branch or draft PR was published. The checked repository workflows publish production/OTA/images on eligible main pushes; this batch changes no workflow, lockfile or dependency manifest. Existing external GitHub App hooks cannot be fully established from the available read credential. A CI skip marker is not an external-hook suppression guarantee. The safe default delivery is the local bundle and patch. To publish a draft PR, first supply trusted metadata confirming that this feature-branch/PR route triggers no forbidden deployment, or explicitly authorize the identified external deployment side effect. Do not modify repository settings or silently reuse the historical HeadHunter Vercel exception. Merge remains forbidden for this batch.

The exact pending source grant is only `list_crm_role_correspondence` on the existing coordinating caller's current CRM assignment, preserving `allowAllTools=false` and all unrelated/customized/revoked assignments. Resolve caller identity from the actual thread target, not a bot display name. See [required-mail authorization proposal](crm-required-mail-2026-10-23.md); no grant was executed.

## Review transfer

The bundle is based on preserved main `94a706a089710cea083192a126ab77a8f577e91c`; the manifest gives full integration head, tree, per-file hashes and checksums. Inspect in a separate worktree. The patch is an alternative representation of the same change, not an additional patch to apply after importing the bundle. The embedded HeadHunter role-mail patch is separate and remains unpublished; apply only through its explicit source prerequisite procedure after authorization. Do not apply either artifact to the production owner's held checkout as part of code review.
