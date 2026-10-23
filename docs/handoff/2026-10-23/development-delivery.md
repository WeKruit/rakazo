# Development delivery — 2026-10-23

Development validation is not live acceptance. This task has not manually deployed, connected to production data, migrated production, run a real CRM sync (including dry run), or sent outreach. Source publication caused an initial unintended Vercel deployment and a later explicitly authorized Vercel deployment; see the incident below. The deployment hold in the existing overall handoff remains in force. Only the assigned local deployment owner may verify and lift it under the user's instructions.


## Current canonical delivery and takeover

- Rakazo main code delivery: **`fa2a2a0d29c57ebff9147c3467bb0d5c3bdaaa81`**, [PR #72](https://github.com/WeKruit/rakazo/pull/72), PR head `371e94f463eaa3e45ea0da0a17b4c19ab4f2f5cb`. Tested code head `1566cb013dbbdcf9dbd5ead62fc0a7cbc8f8d4aa` has identical apps/packages trees to that merge.
- Documentation-only publication: `bb2a23c66a6891ce9380827282807d4ef8c562a0` ([PR #79](https://github.com/WeKruit/rakazo/pull/79)); this cleanup amends only the two delivery documents. The application code revision remains `fa2a2a0d29c57ebff9147c3467bb0d5c3bdaaa81`.
- [PR #74](https://github.com/WeKruit/rakazo/pull/74) is marked merged through included ancestry, GitHub merge reference `4308a2ebf23883a966ae5cbf47a0b6b8a81853d4`; final profile fixes are included in #72. Concurrent [PR #78](https://github.com/WeKruit/rakazo/pull/78) is preserved.
- Source correction: **`11ca9c2df226782eee241fc5b36ba15600f4efcb`**, [PR #67](https://github.com/WeKruit/headhunter-agent/pull/67), PR head `2676b3fb058c3d3730dbc96af5fc7821197718a9`, tested source `b77f88cd51cb7760ab8fa08e987d48dfe86d9523`. Authorized Vercel reports success at deployment `GdrdVeAuUtCri6PsFS5VDBMXKS7C`; environment not verified, and this is not proof of SQL/MCP deployment.
- Rakazo merge metadata check: zero Actions runs, zero commit statuses, zero GitHub deployment records at check time. Actions were intentionally skipped, not passed. No settings changed.
- Required owner actions: confirm/lift the existing sourcing hold; inspect actual live revisions and full-name migration ledger; apply ordered source migrations and update existing MCP; apply product migrations including both distinct 172000 names; deploy product through the assigned local session; dryRun true then fresh-cursor false; scoped readback, repeat-pass, cross-user and UI acceptance. See the operational document below. None of those production/data actions was performed here.
- Known limits: legacy browser signup journey and baseline adapter/DB fixture failures remain documented below. Education/periodic sync/new interview storage and deferred product decisions are not implemented. No claim of live acceptance.

The 16:51 target was exceeded because concurrent calibration-round work required reconciliation and actual regression validation. Work was preserved, validated, and then merged; no force push.

## Current ordered migration prerequisites

Ordered deployment prerequisites remain owner-only. Inspect actual ledgers by FULL migration name, including all three `20261023000000_recruiting_occurrence_match_fields`, `20261023000000_recruiting_reminders`, `20261023000000_recruiting_role_archived_at`, then `20261023000001_recruiting_group_title_backfill`; do not infer completeness from date prefixes. Apply missing product migrations in lexical order: `20261023153000_recruiting_role_playbook_stage`, `20261023160000_recruiting_crm_sync`, `20261023170000_recruiting_candidate_notes`, `20261023171000_recruiting_candidate_shortlisted_at`, `20261023172000_recruiting_calibration_rounds`, `20261023172000_recruiting_crm_sync_progress`. Source migrations `20261023180000_crm_candidate_presence` then `20261023181000_crm_candidate_presence_secondary_roles` and updated existing MCP function MUST precede CRM sync. Source protocol version 2 is mandatory; old deployments fail closed.

## Historical checkpoint: first independently validated batch

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

## Historical checkpoint: first-batch validation

- Combined integration: `vitest run apps/api/src/recruiting.test.ts packages/db/src/scope.test.ts apps/api/src/actor-from-membership.test.ts apps/web/src/components/PaneResizeHandle.test.tsx apps/web/src/lib/preload-recovery.test.ts apps/web/src/pages/shell/RecruitingNavigation.test.tsx apps/web/src/components/AskCard.test.tsx apps/web/src/components/LiveWork.test.tsx packages/adapters/src/turn-end-guard.test.ts`: **327 passed**.
- Web TypeScript: `tsc --noEmit -p apps/web`: passed. Core/API checks passed in the core worktree.
- Independent Inbox/authorization suites: 385 passed. Frontend suites: 237 passed. Panel unit suites: 213 passed. These overlap and are not an additive total.
- Real local Chromium with synthetic fixtures: duplicate-role subtitle 1 passed; resize/persistence/RTL/breakpoints 2 passed. Browser screenshots were inspected locally.
- Full legacy resizable browser journey stops before panel actions because its signup-heading assertion is stale. Fixture browser coverage above is not a claim that the full journey passed.
- Existing adapter schema tests: 30 passed, 2 failed on the base as independently reproduced. DB/adapter full typechecks retain existing test-fixture errors; limits are retained in the validation record below.

Final database validation used native PostgreSQL. Before the historical no-Docker restriction was conveyed to this cloud task, workers used disposable local PostgreSQL containers with synthetic data; those owned containers were stopped and preserved. No production data or credentials were involved. The expanded database checks were repeated using native PostgreSQL.

## Current publication/deployment boundary

All repository workflow triggers were audited before publication. Main pushes can invoke SSH production deployment, production mobile OTA and server-image publication. Reading repository Actions variables returned HTTP 403; no settings or security controls were changed. GitHub documents `[skip ci]` for push/pull_request workflow suppression: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs . Every integration merge must explicitly include this marker and be verified afterward. No pull_request_target deployment path exists; workflow_run only publishes test reports. Required checks must never be bypassed by changing branch protections. Skipped CI must be reported, not described as passing.

For takeover, use the current canonical delivery above and the ordered local-owner procedure; earlier batch revisions are historical evidence only. Historical live revision and ledger figures in the handoffs have not been reverified by this task. Inaccessible shared/Mac paths were not read.

## External deployment incident (metadata checked 16:33 UTC)

The upstream CRM branch push at source commit `f4fba4964acb50e78a1811a4d293bf852384dcf5` automatically triggered a Vercel preview, reported Ready at 16:29:55 UTC in headhunter-agent PR #66 comment 6369686726. PR #66 merged at 16:30:32 UTC as `b29368dfdfe417d9883613fa7200d59c29c54861`, before the external deployment integration was reported to this task. That merge commit also has a successful Vercel status (“Deployment has completed”). Its target/environment could not be verified: the GitHub deployments API returned HTTP 403. Treat the merge deployment as potentially production until the local owner verifies it.

The Actions-only audit missed the external Vercel app. `[skip ci]` does not suppress that app. At that checkpoint, further headhunter-agent publication was stopped; no app preview was opened, settings changed, deployment deleted, production migration run, or CRM sync performed. That pause ended only for the correction explicitly authorized at 16:43 UTC; PR #67 subsequently merged as recorded above. Any further publication or release still requires the applicable owner authorization and deployment-metadata review. Rakazo merge `e133c3aa3c0d74b87e38c909e700af59b73f0c66` had zero deployment records and zero Actions runs when checked.

## Historical checkpoint: CRM integration

CRM implementation `ca264a0f7ac0a0e7c6e432fbac7a9da2970c776d` was integrated as `b930e70b`; stored projection consumption is `89e6d3f9` plus `2b55239b`. At code checkpoint `9fd087e5`, the combined recruiting API and CRM PostgreSQL suites passed **286/286**, and API typecheck passed. This includes the previous five API failures, now fixed by fresh authorization checks. CRM's fourteen PostgreSQL regressions also passed independently in a separate native PostgreSQL database.

The upstream source PR #66 is merged, not merely available: source code head `f4fba4964acb50e78a1811a4d293bf852384dcf5`, merge `b29368dfdfe417d9883613fa7200d59c29c54861`. Its migration and MCP deployment were NOT executed by this task. Vercel's external deployment incident remains as disclosed above; opening its management metadata URL was unavailable through the tool, and production environment verification remains with the owner.

Operational CRM instructions are in `docs/development/crm-sync-delivery-2026-10-23.md`. Product roleCandidates now reads authorized stored projections; ordinary Contacts retains its existing live-source read. There is no fallback or promise of offline access. Unsynced projections are empty, so the owner must complete dry run and real sync before evaluating stored role candidates. Dry run writes only temporary cursor metadata, no projection rows or CRM source data.

## Historical checkpoint: development integration at 16:45 UTC

The first batch is PR #77: tested code `214a7a9d`, PR head `1345896e86d3f6dfdf16018fa4c47c3180d4ab11`, merge `e133c3aa3c0d74b87e38c909e700af59b73f0c66`. These are distinct revisions.

Final product code checkpoint `2098e315` includes CRM #72, the original #74 ancestry plus profile completion `32e9bfaf01c667959eea82f653cd909f833728de`, CRM profile display `7df2c565`, presence protocol fence `143f6ace`, and guard/budget correction `7503addf`. Saving ten profiles is not delivery: calibration/feedback requires an actual pending native feedback/approval or handoff. Budget exhaustion reports persisted candidate count and next playbook step. It does not restart to evade the budget. The current canonical summary at the top supersedes this checkpoint; later reconciliation also recognizes the verified calibration Results panel.

Completed: owner-scoped CRM projections and reads, cursor/concurrency/archive safety, lossless stored company/history/summary/skills transport, recognized profile display, notes draft preservation, unknown historical shortlist dates left null, all shortlist pages included in Home, Inbox tombstones, safe frontend progress, role subtitles, responsive pane persistence, internal continuation provenance and guard terminal behavior.

Validation at final integration:

- Recruiting API + profile/Home/Notes UI + guard: **306 passed**.
- CRM PostgreSQL: **14 passed** with `VERIFY_DATABASE=1 DATABASE_URL='<local fixture>' pnpm exec vitest run apps/api/src/recruiting-crm-sync.postgres.test.ts`.
- Web and API `tsc --noEmit -p apps/{web,api}/tsconfig.json`: passed.
- Source: `deno test --config supabase/functions/mcp/deno.json --allow-env supabase/functions/mcp/tools/crm.test.ts`: **76 passed**. Native PostgreSQL `psql -v ON_ERROR_STOP=1 -f supabase/tests/crm-candidate-presence.sql`: passed. No source data connection.
- Profile worker: **556** focused tests; **117** migrations on fresh native PostgreSQL plus targeted domain checks; desktop/phone Chromium Notes/Tasks passed. Counts overlap other batches.
- A broader six-case legacy CRM-import database selection passed assertions but failed teardown on `recruiting_crm_imports_bindingEffectId_fkey`; this is not reported as a passing suite. Scoped new feature suites are recorded separately. Full database/adapter typechecks retain previously identified fixture failures; two adapter schema failures were reproduced on main. Full legacy browser signup journey remains blocked as described above.



At 16:43 UTC the user explicitly approved publishing/merging only the corrected headhunter source, accepting its existing Vercel automatic deployment. This does not authorize production migrations, CRM sync or manual deployments. The earlier unapproved Vercel side effect remains an incident, not retroactively authorized. Main deployment status timestamp was 16:31:30 UTC; its environment is unknown and requires owner verification.

The source patch is also preserved at `docs/development/patches/crm-presence-v2.patch`, based on source merge `b29368dfdfe417d9883613fa7200d59c29c54861`. Patch authorship headers use a placeholder for public-repository privacy. Follow `docs/development/crm-sync-delivery-2026-10-23.md` for quiet-session dryRun true, fresh-cursor false, aggregate/readback and isolation acceptance. Temporary cursor metadata writes are intentional even during dry run; no source/projection writes are permitted by that mode. Live acceptance, actual deployment revision/ledger, provider data and the Autumn hold are unverified here.

Not implemented: absent source education storage, periodic CRM sync, new interview tables, speculative latency business changes, application rename or new release infrastructure. Deferred product decisions remain with the owner. Inaccessible shared handoff files were not read. Development delivery is not a claim of production readiness or completed live acceptance.

Final guard/budget/executor integration: **40/40 passed**. Actual PostgreSQL save-nine/save-ten/feedback-guard, private notes and shortlist domain regressions: **3/3 passed**. Source canonical fallback regression failed on old code and passed on corrected `b77f88cd51cb7760ab8fa08e987d48dfe86d9523`; source **76/76** and SQL suite passed again afterward.

Publication update: source PR #67 merged at `11ca9c2df226782eee241fc5b36ba15600f4efcb` from PR head `2676b3fb058c3d3730dbc96af5fc7821197718a9` (tested source code `b77f88cd51cb7760ab8fa08e987d48dfe86d9523`). Its user-authorized Vercel status reports success; this does not prove the MCP edge function or SQL migrations were deployed. Environment remains metadata-unverified. Concurrent main PR #78 arrived as `018ddd50ee338939b10c96e9b21b8405d8eaf7f5` and is preserved during final integration. Its `20261023172000_recruiting_calibration_rounds` migration must also be applied, before the distinct same-prefix `20261023172000_recruiting_crm_sync_progress`; do not collapse them by timestamp.

Final reconciled code head: `1566cb013dbbdcf9dbd5ead62fc0a7cbc8f8d4aa`. Combined API/UI/guard/playbook and real PostgreSQL CRM/calibration suites: **357/357 passed**, API/web typechecks passed. The calibration panel is accepted only when its latest unapproved ten-distinct-profile round is backed by this run's completed native effect; a stale round from another run cannot terminate the current feedback turn. PostgreSQL regression verifies actual round persistence and guard behavior. Independent review found no lost concurrent schema/contracts/API additions. Both distinct full-name 172000 migrations are intentionally preserved, superseding the earlier distinct-prefix guideline after concurrent publication; Prisma lexical order is documented above.
