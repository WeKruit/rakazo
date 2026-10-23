# Handoff: Juicebox-level candidate profile + Home dashboard (WeKruit/rakazo)

Paste this whole file as the prompt for the next session.

## Goal (user ask, 2026-10-23 15:16 UTC)
User compared our recruiting UI with Juicebox / Metix and wants the same completeness: structured profile drawer
(experience/education with logos, tenure stats, actions), per-requirement agent assessment (✅/❌/⚖️ + evidence),
right-side tabs Notes / Activity / Tasks (reminders), Home dashboard ("Hello, <name>", weekly shortlisted bar chart,
outreach funnel Shortlisted → Contacted → Replied → Interested, recents, tasks). Chinese + English UI copy.
Rules: follow AGENTS.md; never show vendor names (Instantly, Cal.com, Gmail) or internal IDs in UI; always show loading
states; never re-judge/re-rank Autumn's candidates; merge ourselves after local tests (no CI wait); PRs from branch
`claude/project-thread-3xoryr` (restart from origin/main after each merge); report PR numbers + merge SHAs to the coordinator.

## Merged to main (frontend only; live after the next deploy)
- #57 f572fb1d — Autumn "Requirement assessment" (R1: Fact/Gap …) parsed into match/gap/partial rows with verbatim evidence,
  sources cited once, ranking scope under the recommendation, Resume button. Files: apps/web/src/pages/recruiting/profile.ts
  (requirementRows, candidateSections), AssessmentCard.tsx, profile.test.ts.
- #59 a520a942 — Experience/education timeline with logo tiles (initials; favicon only from the field's own source host,
  no third-party logo service), dates, durations, Avg/Current/Total tenure tiles. Files: profileTimeline.ts, ProfileTimeline.tsx.
- #64 7f135b8b — Activity tab (CRM mail/outbox, saved mailbox reads, workflow status changes, review decisions, badges)
  and Tasks tab on core's reminders #55. Files: activity.ts, ActivityTab.tsx, TasksTab.tsx, ActivityTasks.test.tsx;
  DetailPanel.tsx tab list; detail.ts view union; SequenceTab.tsx exports existing hooks.
- #69 ea595508 — Home dashboard at `?view=home`, now the landing route for users with roles; brand button opens it.
  Files: dashboard.ts, HomeDashboard.tsx, Shell.tsx (9 lines), shell/RecruitingNavigation.tsx, Shell.test.tsx.
Not yet verified live in a browser: do that first after the next deploy (profile drawer on a Simulation candidate with an
R1..Rn assessment; Activity/Tasks tabs; Home after sign-in; phone width 390px).

## In flight: draft PR #74 (https://github.com/WeKruit/rakazo/pull/74, branch claude/project-thread-3xoryr, head 85ede9a); its description lists exactly what is not done (Postgres tests, apps/api recruiting.test.ts report fixtures, adapters pi-runtime-tool-schema 2 failures, browser check)
1. shortlistedAt: nullable column set by setCandidateShortlist (now() on true, null on false), backfilled, exposed in
   listCandidates / roleCandidates autumn items; Home chart buckets by shortlistedAt (fallback firstDiscoveredAt).
   Migration 20261023171000_recruiting_candidate_shortlisted_at.
2. recruiting.reminders.list accepts candidateKeys[] (OR); Tasks tab lists both `autumn:<candidateKey>` and `crm:<candidateId>`
   for one person, creates under the primary key.
3. Candidate notes: table recruiting_candidate_notes (spaceId + ownerUserId scoping like reminders, candidateKey,
   roleId?, body, createdByBotId?, soft delete), RPC recruiting.notes.list/create/update/delete, agent tool
   `recruiting_notes` (internal, no approval) wired like `recruiting_reminders` (commit 85715bc is the template),
   NotesTab.tsx in DetailPanel. Migration 20261023170000_recruiting_candidate_notes.
Next steps: finish whatever the PR description lists as not done, run db/contracts/api/adapters checks + web recruiting
tests, extract lingui catalogs (zh-CN translations), merge, report SHAs. Migrations need the release thread's normal
"migrations before new API/worker" deploy order.

## Remaining Juicebox gaps (not started)
- Email open / profile view events, sequence step ("Step 1 of 2") and campaign per message in Activity: needs provider
  event ingestion + storage. Assigned to core later — do not start without the coordinator.
- "Contacted" in the funnel counts campaign leads (may include not-yet-emailed); Replied comes from CRM, so stages can be
  non-monotonic. Better: per-lead sent status from the campaign provider.
- Real company/school logos (currently initials). Any logo service must be optional and provider-neutral (AGENTS.md).
- Reminder rows on Home don't show the candidate name (needs a name lookup by candidateKey).
- Profile header like Juicebox (status dropdown, tags, "Add to sequence" split button, Unlock phone) not built.
- CRM sync thread adds optional interest/reviewed/lastReplyAt/resumeReceived to crmData "candidates" items — can feed
  profile badges and the Interested funnel stage.

## File ownership / do-not-touch
- Ours: DetailPanel.tsx contact body + tab wiring, profile.ts, profileTimeline.ts, AssessmentCard/ProfileTimeline/
  ActivityTab/TasksTab/NotesTab, activity.ts, dashboard.ts, HomeDashboard.tsx.
- Workloop frontend thread owns: roleCandidates.ts, useRoleCandidates.ts, list sorting, SequenceTab, RoleSetup,
  detail.ts (?detail= sync), RecruitingPanel.tsx, Shell.tsx (keep our diffs there tiny), lib/right-panel-state.ts.
- Core owns: resolveRecruitingReply/replyContext in packages/db/src/recruiting.ts, the executor (only add tool cases),
  crmData "inbox" view, roleSetup/group listing, RecruitingRole.playbookStage.
- CRM sync thread owns: recruiting_crm_* tables, crm() source in getRecruitingRoleCandidates (apps/api/src/recruiting.ts),
  migration 20261023160000_recruiting_crm_sync.
- Migration prefixes for this line: ≥ 20261023170000 (coordinator rule; 170000 notes, 171000 shortlistedAt; next free 20261023172000). CRM sync #72 owns 20261023160000.

## Known pre-existing failures on main (not ours)
apps/web i18n-catalog.test.ts (2: "Saved assessments", pool wording); lib/desktop.test.ts header class;
RecruitingPanel.test.tsx artifact tests flaky under load (pass alone).

## How to work
pnpm install --frozen-lockfile --config.engine-strict=false (node 22.22.0 in the container);
web: cd apps/web && pnpm run check && pnpm exec vitest run --root ../.. apps/web/src/pages/recruiting;
catalogs: pnpm run intl:extract, fill zh-CN, revert unrelated churn; biome: pnpm exec biome check <files>.
Commit trailer + PR attribution block as in previous PRs (#57 body is a good template).
