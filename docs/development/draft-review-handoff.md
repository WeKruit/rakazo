# Unified workspace draft review and original handoff reconciliation

This is the canonical review entry point for the proposed Draft PR. Development tests are not live acceptance. Publication update (2026-10-24): the user authorized this feature-branch push and Draft PR, accepting possible automatic preview deployment. Repository hook metadata returned HTTP 403; external deployment behavior remains unverified. Draft status and `[skip ci]` do not suppress GitHub Apps. No merge, deployment, grant, actual sync, mail send or booking is authorized by this document.

## Revisions and scope

- Preserved review baseline: `83597a60f55bb86d8902986f9bac52c3401709ce`; its tested application code is `11bc10727a1b1176db1a73ebb26fd6a961bc1b32`.
- Main rechecked: `5836c11ad6740e8328c9c19f71a70bdc6c113bf1`, merged [#83](https://github.com/WeKruit/rakazo/pull/83), head `a13c2faa08e47b695856b9419ad34bf8566a8c96`. No open PRs were returned at this check.
- Local integration: `98e7d490d864f3bc008d7d7a68e0938287f7417f`, branch `codex/unified-workspace-draft-review`. Main was merged without conflicts, preserving #83's read-only historical-stage derivation. No history was rewritten. Its 49-saved-candidate regression and recruiting API suite passed: **375 tests across two files**. Independent guard/playbook review passed 48/48; API TypeScript passed. Reviewer found no blocking semantic conflict; malformed persisted confirmation-object validation remains a narrow hardening gap, not a demonstrated approval bypass.
- Review the complete change with `git diff 5836c11ad6740e8328c9c19f71a70bdc6c113bf1...HEAD`. At the code integration checkpoint it spans 185 files, 37,622 insertions and 2,564 deletions, including tests, documentation and the separate source patch. Later documentation adds no product behavior.
- No workflow or dependency changes are included. Separate CI/CD delivery `b278c139ba99da2a1c04e4a8497d124eaeb83fa9` is **not integrated or production-ready**. Durable drain versus maintenance pause remains an explicit owner decision; its independent author must supply/review that diff separately.

## The original six execution lanes

The original [README](../handoff/2026-10-23/README.md) superseded the older overall PR table: #65 and #73 were already merged when development began; #72 and #74 were drafts. Current GitHub metadata confirms all four merged. These historical changes are ancestors, not new implementations duplicated in this Draft.

| Original lane / source | Delivered development and precise history | Remaining boundary |
| --- | --- | --- |
| CRM #72 — [handoff](../handoff/2026-10-23/crm-sync.md), [mapping](../handoff/2026-10-23/crm-sync-mapping.md) | Merge `fa2a2a0d29c57ebff9147c3467bb0d5c3bdaaa81`; head `371e94f463eaa3e45ea0da0a17b4c19ab4f2f5cb`. Scoped projections, cursor/concurrency/absence safety, transport and reads. This Draft adds canonical legacy workspace reuse, exact role/campaign context, required-mail failure semantics and source-mail v2 prerequisite. | Source patch publication/SQL/MCP, narrow caller grant, full dryRun then actual sync/readback remain owner-only. Periodic sync and unverified source education export are not claimed. |
| Core #65 — [core](../handoff/2026-10-23/core.md) | Merge `0aea24c202d4a44209f6047895be2b7302296a44`. Follow-up #77 `e133c3aa3c0d74b87e38c909e700af59b73f0c66`: internal continuation provenance, cumulative distinct counts, attention/nudge and terminal notification. #72 reconciled delivery-vs-save and budget summary; #78 calibration rounds preserved. #83 historical read recovery now included. | Existing saved people are not approval. Reuse native recovery/NO_RESPONSE/budgets; do not claim a newly implemented universal phase-2 crash/recovery system or autonomous live playbook proof. Real same-task Autumn acceptance remains pending. |
| Inbox #73 — [core Inbox findings](../handoff/2026-10-23/core.md) | Merge `729e7f2055dcd213bf6c43b35adceac9dfcdcad8`, head `fdcfd5878593b8eb16281e5a53e8409277de3c20`. Remote read projection plus #77 tombstone correction. Draft bridges legacy roles to exact existing campaign/mailbox/thread, single Inbox surface and scoped reply/plan context. | Read projection is not send acceptance. Provider auth, allowed role-mail tool and exact live message evidence must be checked independently; no assumption that reconnect fixes missing mapping. |
| Profile #74 — [handoff](../handoff/2026-10-23/juicebox-profile.md) | GitHub merged reference `4308a2ebf23883a966ae5cbf47a0b6b8a81853d4`, head `85ede9abb3d198ed74149632813f78a3e9a627dd`; completion ancestry in #72. Notes draft preservation, nullable historical shortlist time, reminders. Draft adds real viewed-by records, structured evidence/history, supplied assets and readable detail. | Viewed-by is not email opens or locking. Unknown historical dates stay unknown. Actual raw Autumn row/assets and native mobile parity remain unverified. |
| Frontend — [handoff](../handoff/2026-10-23/frontend.md), [acceptance](../handoff/2026-10-23/acceptance-report.md) | #77 safe progress, approval titles, duplicate-role date, deferred asset recovery. Existing paging reused. Draft corrects originally omitted B14 legacy/native unification across Contacts, Inbox, Sequence, Interview and Overview; exact shortlist drilldown, scheduling plan and chat/feedback presentation. | Only concise progress, never raw reasoning. All 59 code/test/live states are explicit below; unsupported metrics/links and full live journeys are not called complete. |
| Resizable panels — [handoff](../handoff/2026-10-23/resizable-panels.md) | #77 semantic integration `161bed7f`, `5d8037f8`, `ce8edcb3`; persisted widths, reactive bounds, RTL keyboard and drag cleanup. Formatter-heavy patch was not applied wholesale. Draft retains 600px responsive detail and 320px chat coverage. | Focused synthetic routes passed; original signup-dependent legacy browser journey remains a documented failure, not a passed full suite. |

The earlier [development delivery](../handoff/2026-10-23/development-delivery.md) preserves original commits, incidents and failures. Its “current” headings describe that historical batch. This entry and the [59-item matrix](unified-workspace-final-status.md) govern the newer review. Five overall shared-file references and one acceptance-report shared path were inaccessible and were not read.

## What this Draft adds and how to review it

1. [Unified functional delivery](unified-workspace-delivery.md): exact legacy identity, owner/source isolation, truthful mail failures, five route composition, activity and profile.
2. [Scheduling plan](scheduling-plan-increment.md) and [freshness correction](scheduling-confirmation-freshness.md): original conversation → explicit slot/two IANA zones → genuine native approval → exact booking → specific confirmation readback. Later executing/uncertain mutations fence old proof; verified superseding lineage retires stale upcoming bookings. Recorded freshness is not a live provider GET or cross-provider atomicity. No automatic resend or fabricated confirmation.
3. [Structured profile diagnosis and Autumn plan](profile-history-source-review.md): nested report retention and explicit work/degree rows; no speculative prose parser or upstream request change.
4. [Chat integration](chat-ui-integration.md): readable messages and compact composer, preserved draft/send/stop/approval/error behavior.
5. [Canonical acceptance](unified-workspace-acceptance.md) and [59-item state](unified-workspace-final-status.md): review every row; partial is not complete. Unsupported provider metadata/cohorts/deep links, automatic immutable-plan revision and outreach-pause policy remain explicitly limited.

Tests use synthetic intercepted providers and native local PostgreSQL, never production. Counts overlap and must not be summed. Exact commands and earlier failures are recorded in the linked notes:

| Validated code boundary | Commands / evidence | Result |
| --- | --- | --- |
| #83 reconciliation at `98e7d490` | `pnpm exec vitest run packages/adapters/src/turn-end-guard.test.ts apps/api/src/recruiting.test.ts` | 375 passed |
| Scheduling freshness `861dba93`, docs `19dfb3c3` | Native PG scheduling/approval plus linked workflow, connector, executor idempotency suites in freshness note | 49 PG and 402 affected checks passed; independent 13-case binder review passed |
| Structured profile `b4e82c35` | Eleven focused contract/projection/profile suites; web/API TypeScript; web build; actual App/Shell routes | 288 checks, 2 browser routes passed; six captures |
| Chat `11bc1072` | Shell, RecruitingPanel, RecruitingCorrespondence, recruiting-chat-context; web TypeScript/build; recruiting-chat browser spec | 475 checks, 8 browser routes passed; twelve captures |
| Earlier unified backend/profile | Four targeted native PG suites in functional delivery | 44 passed, including six profile cases; this is not the full DB suite |

Known limits: two baseline adapter schema failures, broader twelve DB baseline failures, legacy signup browser failure, existing build chunk warning and untranslated catalog entries remain recorded. Transient browser/server termination and initial test failures are disclosed in their increment notes. No CI success is claimed. Parent visually inspected targeted five-page, scheduling and structured-profile states; latest chat parent pixel review remains pending. No current CI screenshot URL exists at publication preparation; repo browser specs reproduce the synthetic routes.

## Ordered deployment prerequisites — instructions only

The local owner must recheck actual revision and FULL migration ledger. Historical deployed SHA/health/ledger reports do not establish this Draft is installed. Preserve active work and the existing deployment hold until its owner resolves it.

Product missing migrations, in lexical order (do not collapse equal prefixes):

1. `20261023000000_recruiting_occurrence_match_fields`
2. `20261023000000_recruiting_reminders`
3. `20261023000000_recruiting_role_archived_at`
4. `20261023000001_recruiting_group_title_backfill`
5. `20261023153000_recruiting_role_playbook_stage`
6. `20261023160000_recruiting_crm_sync`
7. `20261023170000_recruiting_candidate_notes`
8. `20261023171000_recruiting_candidate_shortlisted_at`
9. `20261023172000_recruiting_calibration_rounds`
10. `20261023172000_recruiting_crm_sync_progress`
11. `20261023190000_recruiting_crm_workspace`

Source: pinned merged base `11ca9c2df226782eee241fc5b36ba15600f4efcb`; separate unpublished role-mail patch head `34eca76027a932f5fb8ffac5f961a9debb291011`. The complete [source patch and procedure](legacy-crm-source-mail-prerequisite.md) are in this repository, not dependent on Library. Apply final source tree once; SQL `20261023180000_crm_candidate_presence.sql` → `20261023181000_crm_candidate_presence_secondary_roles.sql` → `20261023184734_crm_role_correspondence_pages.sql`, then update the existing MCP. Never apply the archival presence patch on top of its already merged base. Source publication can auto-deploy via Vercel and has no authorization in this Draft.

Product migrations precede corresponding API/worker activation. Scheduling/profile/chat increments add no new migrations. The exact pending read-only grant is `list_crm_role_correspondence` on the existing actual coordinating caller's CRM assignment, retaining `allowAllTools=false`; do not modify unrelated/customized/revoked assignments. Resolve caller from the actual thread, not its display name. See [grant proposal](crm-required-mail-2026-10-23.md). No grant was executed.

Owner acceptance sequence after separately authorized installation: verify role/workspace/source IDs, requested/effective args, existing campaign/mailbox, positive existing-message sample; run complete quiet-session `dryRun: true`, inspect all phase errors/skipped/totals; only then authorize a fresh-cursor `dryRun: false`; scoped readback and repeat-pass idempotency. Dry run may write temporary progress metadata, never source/projection rows; ordinary concurrent role reads can write incremental projections. Filtered source totals, not raw table counts, are the correct comparison, and role links may add contacts. Use [exact CRM procedure](crm-sync-delivery-2026-10-23.md). No real sending is required to validate existing mail. Live scheduling needs separate exact send/booking approvals and readback.

## Autumn requirements and asset investigation

No actual candidate raw row was inspected. Missing logos/avatars therefore have no established single cause. The original owner should inspect the exact already-saved artifact through the scoped report reader and report only anonymized field names/types/counts:

- **Source absent:** structured history or assets are absent in the exact source record; inspect existing rich output through the authorized read path before proposing enrichment.
- **Projection lost:** raw row has nested values but old report omitted them; this Draft retains nested observations and provenance.
- **Image URL fails:** supplied URL is expired, denied or invalid; verify its actual response locally. Synthetic successful-image/403 tests do not establish a real URL's status.
- **Unreleased code:** live revision predates this renderer; compare actual deployed SHA before diagnosing missing data.

Next Autumn work: verify actual supported serializer/read protocol; agree observed experience/education/assets mapping with stable identity and source provenance; preserve every job/degree, null unknowns and original date precision; validate source → artifact → report → actual route. Existing flat `candidate_output_v1` does not establish nested-object export support. Do not add unsupported list-of-object requests, paid search/enrichment, logo services, guessed images or degree inference. Existing same-task feedback/approval and matching remain Autumn-owned. This is a source verification/integration plan, not evidence that upstream already returns those fields.

## Original-session review and progress cleanup

- Check out this branch in a separate worktree; inspect the main-to-HEAD diff and retain all #83 changes. Do not overwrite production-owner or other developers' working files.
- Review the six rows above against original handoff and mark historical merged items closed only in development tracking. Keep live acceptance separate.
- Review exact legacy role binding, denied-mail failures, multi-role/campaign isolation, saved-plan approval scope, mutation freshness and uncertain-send reconciliation before enabling anything.
- Run linked commands as needed and inspect real App/Shell route screenshots; do not replace business acceptance with fixtures. Preserve known failures, unsupported capabilities and pending policies in the 59-item matrix.
- Confirm source release/SQL/MCP/permission prerequisites, then execute only separately authorized owner acceptance. Record exact deployed/readback evidence without public PII or secrets.
- Reconcile Autumn source/asset findings and the separate CI/CD drain decision into their owners' progress. Do not mix the CI/CD patch into this product PR merely to close a checklist.

## Publication audit and bounded authorization

Audited repository workflows at current main: production SSH and mobile OTA require main push; server-image publishing is main/tag/manual, with PR jobs build-only; workflow_run publishes test reports. This product branch does not alter workflows. External repository hooks/installed app behavior cannot be excluded: metadata read returned **HTTP 403 Resource not accessible by integration**. No denied read retry or settings change occurred.

The user explicitly authorized publishing `codex/unified-workspace-draft-review` and creating a Draft PR on 2026-10-24, accepting possible automatic preview deployment. This supersedes the earlier publication hold only for this product branch/PR. No main push, merge, source push, manual deployment, production migration, actual CRM sync, external email or permission expansion is authorized. Check actual PR/check/deployment metadata after publication; do not assume a Draft prevents deployment.

## Latest root-cause evidence and mail loop status

A definite product defect is proven independently of the reported person's data: before the structured-profile increment, `projectRecruitingCandidateReport` accepted only scalars/scalar arrays and omitted nested objects/record arrays. The new structured-value contract and direct timeline renderer fix that projection/display loss, with source-shaped fixture → serialized report → UI tests. This establishes a local defect and correction, not that the particular live row contains those fields. Supplied scalar avatar URLs already had a separate path and cannot be assumed to share this cause.

No corresponding real raw artifact was identified in the available repository handoffs or supplied review fixtures. A prior Notes deep-link identifies a candidate for a different refresh issue; it does not establish identity with the later history screenshot. No production artifact was read, no new research was run, and no secrets were requested. The missing evidence is the exact saved row plus its scoped API report and current deployed renderer revision. The existing owner can collect that through the read-only recipe in the profile source review without another search or synchronization.

| Mail / interview link | Latest evidence | Acceptance state |
| --- | --- | --- |
| Source contains historical correspondence | Owner reported existing mail across multiple roles, below the former member cap | Historical owner observation, not reverified here |
| Required caller permission | Owner reported four restricted bot assignments missing role-correspondence read; dry run stopped | No subsequent permission evidence received |
| Sync mail phase | Old code silently advanced unsupported mail; new code fails and retains progress | Regression passed; new production dryRun completion unverified |
| Canonical role → existing campaign/mailbox → Inbox | Exact scoped code and synthetic API/browser checks | Actual installed version and positive existing-message readback pending |
| Reply draft → real human approval → provider send → readback | Native approval/identity/retry fixtures pass; earlier handoff had partial real mail proof on older code | No current full provider-loop evidence; no real send here |
| Reply intent → available slot/two zones → approved booking → specific confirmation | Linked offline service/approval/receipt tests and mutation freshness fix pass | Autonomous interpretation and actual provider booking/confirmation loop unverified |

Therefore email and interview scheduling must not be reported as live closed-loop complete. The latest owner report remains the stopped dry run, not a successful synchronization. A past connected provider or successful send on another code/role does not establish this current chain.

## Independent frontend and historical mail verification

The following product defects are confirmed by comparing `e740fa44` with this branch, not inferred from unknown source data:

- `apps/web/src/pages/recruiting/DetailPanel.tsx`: old `PersonAvatar` accepted only name/size and rendered initials. It could not display a supplied photograph. Current `PersonAvatar` accepts `src` and renders `ProfileImage` with initials only as fallback.
- `apps/web/src/pages/recruiting/ProfileTimeline.tsx`: old `CompanyLogo` accepted a source host and constructed `/favicon.ico`; it did not consume an explicit company/school logo URL. Current component consumes the supplied `src` through `ProfileImage`.
- `packages/core/src/recruiting-candidates.ts`: old scalar-only projection dropped nested history/logo records. Scalar avatar URL fields could already pass the projection, so nested-value loss does **not** prove that avatar URLs were dropped. The old avatar renderer is a separate confirmed defect.

Thus this is not merely an unproven Autumn-data problem: concrete projection and rendering gaps existed in our code and are corrected locally. Their presence on the reported deployment and the exact candidate's available assets still require the scoped raw row, `latestSource.report`, deployed SHA and actual image `src`/network response. Do not substitute a different candidate's Notes URL or synthetic fixture for those identities.

Historical provider evidence is also more precise than a blanket “untested”: [acceptance handoff, sections 3–4](../handoff/2026-10-23/acceptance.md) records at 15:55 UTC that a controlled first email was sent and received, the recipient replied, and the product read the reply. It also records that the test-role Inbox projection and product-side same-thread reply confirmation/send remained open. This is partial real-provider evidence on the historical revision, not a completed current mail loop. No newer live interview-booking/confirmation chain was supplied. Later stopped CRM dryRun evidence concerns historical-mail ingestion and must not erase or overextend that earlier controlled-mail proof.
