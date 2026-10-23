# Candidate profile and workspace presentation review

This is implementation evidence for independent review, not production acceptance. The original handoff and the canonical [unified workspace acceptance checklist](unified-workspace-acceptance.md) govern the combined delivery. The CRM integration owner supplies that canonical file; this change does not maintain a competing copy.

## Change and ownership

Profiles previously showed initials even when explicit image fields existed, flattened source evidence, and offered inert skill tags. The detail now renders supplied photos and organization assets, keeps role/company/school hierarchy, highlights literal technical terms, and makes skills select their saved source context. Match, partial, concern/gap and unknown remain distinct. Matching and ranking remain owned by the source agent.

Contacts, Inbox, Sequence and Interview mount reusable presentation components. Home has project filtering, dated shortlist windows, source-role drilldown and explicit incomplete totals. These changes use current read contracts; canonical role routing, binding, campaign/thread adapters and provider actions remain with the CRM integration work.

| Component | Existing input contract | Caller responsibility |
| --- | --- | --- |
| `CandidateDirectory` | `RoleCandidate[]`, `selectedKey`, `onOpen(row,index,trigger)`, optional `renderActions` | Source reads, filters, pagination, selected role and existing actions |
| `EmailConversation` | Exact `RecruitingInboxEmail.email` objects, optional candidate ID, selected message, exact-message callbacks | Authoritative thread grouping, identity, source permissions and draft context |
| `InterviewCalendar` | Existing `RecruitingCorrespondence.events`, display timezone and optional initial date | Role/contact scope, source coverage, connection state and future booking workflow |
| `SequenceOverview` | Existing role campaign, complete CRM reply count or null, exact sent timestamps and their contact scope | Source completeness, scope and any future provider telemetry |

Shared integration hunks are limited to `ContactsTab.tsx`, `InboxTab.tsx`, `InterviewTab.tsx`, `SequenceTab.tsx`, and the existing `tabs.test.tsx`. The CRM owner should apply the new components first, then reconcile these rendering/callback hunks against its latest adapters. `HomeDashboard.tsx`/`dashboard.ts` and profile/detail modules belong to this presentation change. Shell, role creation/binding, MCP connectors, workflows and infrastructure are untouched. Two existing `RecruitingPanel.test.tsx` assertions now expect the honest “Status” column heading. [All added interface copy](profile-workspace-copy.md) is quoted separately for review.

## Source and identity rules

- Images and organization links come only from explicit retained report scalar fields. Supported labels include Profile photo URL, Avatar URL, Photo URL, Company logo URL, School/University logo URL, Company website/URL and School/University website/URL. The existing source projection already retains these columns. HTTPS URLs must have no embedded credentials. There is no new logo service, inferred favicon host, enrichment or generated portrait.
- An organization asset/link is paired with its source company/school identity and rendered only for an exact normalized organization match. Missing and broken images use honest initials. Name-only duplicate school fields may consolidate citations, but evidence, reasoning and provider status are retained.
- CRM history currently has no dedicated photo/logo fields. Its absent assets remain absent; the caller must supply existing trustworthy source fields to display real assets. Inbox's current CRM-only list therefore uses initials unless its adapter supplies richer supported data later.
- Skill selection filters literal mentions in saved profile/assessment context. A skill-list mention is labeled as a listed skill; absence of supporting context is explicit. Concern and counterevidence text remain visible. This is navigation, not a new evaluator.
- Email cards show saved Sent/Received direction. They do not infer a reply relationship, an unread flag or an email open from viewing a profile. Current mail projections do not provide all authoritative thread headers; final grouping belongs to the CRM adapter.
- Calendar cards use source instants with offsets and named display zones. Date-only/invalid starts are unplaced source records; missing ends remain markers, not invented durations. Cross-midnight and DST changes are tested. Available-time records are not proof that all possible slots were queried. Free/busy, booking and original-thread confirmation remain outside this presentation patch.
- Sequence Contacted/Opened/Clicked remain unreported when absent. Active and explicitly interested lead observations are lower bounds because the existing lead read is bounded and has no completeness signal. Replied is shown only after a complete CRM count. The chart uses exact sentAt timestamps for the selected contact and the last seven UTC dates, never queued/created timestamps.
- Home's chart uses currently shortlisted records with recorded shortlistedAt dates. It is not a historical stage ledger. Its date filter applies to that chart; the funnel visibly remains “Current totals · all dates” because its sources lack event timestamps and cohort linkage. No conversion percentage is fabricated.

## Real profile views

`recruiting.profileActivity.list` and `.recordView` use the existing event store. No schema or migration is added. The request identifies a native role, an existing `autumn:` or `crm:` candidate key, and a per-open UUID. Server code derives actor, role title and occurrence time from the authenticated action. Events begin only when the new UI records actual opens; no historical backfill occurs.

Authorization validates owner, space, role, current thread and candidate membership. CRM records additionally require the current binding and role-contact relationship. The existing thread row is locked for duplicate protection; repeated requests with the same view UUID return one record. CRM history is isolated by binding effect ID, including a rebind to the same external IDs. The UI retains the UUID across rerender, tab switches and retry, generates a new one after a true reopen, and ignores stale responses from a previous person. Activity refreshes when a delayed view write completes. There is no lock/occupancy feature.

Backend shared paths: `packages/db/src/recruiting.ts`, `apps/api/src/recruiting.ts`, `apps/api/src/router.ts`, `packages/contracts/src/{events,recruiting,rpc}.ts`. The narrow backend checkpoint is independently transferable so a native PostgreSQL environment can run its transaction tests. Do not replace the CRM owner's complete files with this branch's copies.

## Verification and visual evidence

Focused component, hook, API authorization and mocked transaction tests cover source fidelity, missing fields, exact-message drafting, keyboard behavior, stale reads and per-open idempotence. Separate native PostgreSQL tests cover concurrent writes and owner/space/role/binding isolation; those tests require actual PostgreSQL and must not be counted as run by mocks.

Browser specs use synthetic records and intercepted local reads. Component fixtures test difficult field/async states. The separate `recruiting-app-routes.spec.ts` opens the real application entry and Shell routes with synthetic auth/RPC responses; it verifies mounted pages without calling a provider. These layers are implementation checks, not real provider or business acceptance.

Required review viewports are 1440 × 900 and 390 × 844. Browser artifacts and exact commands are delivered in the review bundle, together with a source-file manifest and commit IDs. Screenshots contain invented people and addresses only.

The implementing executor could not download the supplied reference images through Library; supported materialization returned download failures. It inspected its own browser captures, and used the parent session's factual descriptions for preliminary layout work. It does not claim to have inspected reference pixels or passed side-by-side fidelity. The parent session has the originals and must compare V01–V12 against the delivered real-route screenshots and request revisions. The existing shared detail drawer defaults to 384 px and can be resized; this patch does not change Shell sizing or claim a simultaneous profile/activity split at that default width.

## Checklist evidence map

R01–R59 below are ordinal references to the 59 checkbox items in the canonical checklist, not replacement requirements. “Pending” means the whole requirement is not established by this patch, even where a local part is implemented. All live states remain **pending authorization/acceptance**. The code revision, local environment and exact executed commands are attached in the delivery manifest and apply to every row.

| ID | Owner | Implementation | Local test/evidence | Remaining acceptance |
| --- | --- | --- | --- | --- |
| R01 | Joint | Pending | Five mounted page integrations and real-route browser spec | Combined CRM identity/data flow |
| R02 | Joint | Implemented for this patch | This map and delivery manifest | Merge evidence from all owners |
| R03 | Joint | Implemented for this patch | Code/test/live statuses kept separate | Independent review |
| R04 | CRM | Pending | No routing changes here | Canonical legacy roles |
| R05 | CRM | Pending | Profile stale-response and scoped view tests | Combined contact identity/conflicts |
| R06 | CRM | Pending | Existing contracts reused | Full relationship chain |
| R07 | CRM | Pending | No guessed provider links | Exact campaign/member/step mapping |
| R08 | CRM | Pending | Exact stored-message selection tests | Authoritative mailbox/thread headers |
| R09 | CRM | Pending | Existing event identity preserved | Full booking/thread linkage |
| R10 | Joint | Pending | Calendar DST/offset and honest missing-time tests | All source ingest semantics |
| R11 | Joint | Pending | View retry/idempotence tests | Native DB and other sync mechanisms |
| R12 | Joint | Pending | New API/DB logic isolation tests | Native DB and combined integration |
| R13 | Joint | Pending | Directory table/cards, assets, action isolation | Canonical filters/tags/status completeness |
| R14 | Profile | Implemented for supplied fields | Asset/link unit and browser checks | Actual source asset coverage |
| R15 | Profile | Implemented | Detail hierarchy and clickable evidence checks | Parent visual acceptance |
| R16 | Profile | Implemented for supplied criteria | Unknown/partial/concern/highlight/source tests | Actual source evidence review |
| R17 | CRM | Pending | Existing detail callbacks retained | Exact cross-page context navigation |
| R18 | Joint | Pending | Mounted Inbox/card/profile behavior | Real unread contract and all UI states |
| R19 | Joint | Pending | Collapsible stored mail/exact older selection | Complete authoritative thread grouping |
| R20 | CRM | Pending | Existing draft request only; no new send control | Composer/provider state machine |
| R21 | CRM | Pending | No guessed links | Campaign/lead/step thread linkage |
| R22 | CRM | Pending | No provider action added | Thread-to-interview context |
| R23 | Profile | Implemented | Profile-view events separate from mail opens | Parent acceptance |
| R24 | Joint | Pending | Existing campaign list and status preserved | Owner/steps/search/archive source support |
| R25 | Profile/CRM | Pending | Unreported/observed/complete-count semantics tested | Complete provider metrics/definitions |
| R26 | CRM | Pending | Exact saved-send dates only | Real schedule/steps/provider deep links |
| R27 | CRM | Pending | No campaign mutation added | Provider pause/reply/booking policy |
| R28 | Joint | Pending | Week/day grid, clock, status/timezone/navigation/source states | Role filter and full activity context |
| R29 | CRM | Pending | Supplied timeblocks only, unknown coverage explicit | Query range/pagination/busy-buffer capability |
| R30 | Joint | Pending | Named-zone DST and cross-day tests | Both parties' configured timezone identities |
| R31 | CRM | Pending | No booking write added | Complete reviewable plan |
| R32 | CRM | Pending | No provider calls | Conflict recheck/idempotent booking readback |
| R33 | CRM | Pending | No send calls | Original-thread confirmation/retry |
| R34 | CRM | Pending | Source status preserved | Combined mutation/result propagation |
| R35 | Joint | Pending | Project filtering and dated shortlist chart | Dated funnel/cohort sources |
| R36 | Joint | Pending | Honest chart/totals/recents/tasks | Upcoming interview and full reply aggregation |
| R37 | Joint | Pending | Chart/funnel source-role drilldown | Exact page/filter deep links |
| R38 | Joint | Pending | Real views plus existing mail/update/status sources | Remaining source actors/times/links |
| R39 | Profile | Implemented | View semantics, no fake history/open tracking | Native DB and parent acceptance |
| R40 | Joint | Pending | Existing notes not relabeled provider actions | Cross-page manual/audit consistency |
| R41 | Joint | Pending | Semantic tokens/shared controls reused | Parent pixel comparison and combined Shell |
| R42 | Profile | Pending | Desktop browser captures and geometry checks | Parent reference comparison |
| R43 | Profile | Pending | Mobile overflow/focus/keyboard checks | Combined real-route review |
| R44 | Profile/parent | Pending | Actual browser captures delivered | Parent side-by-side with original pixels |
| R45 | Profile | Pending | Page/state screenshot manifest | Parent coverage review |
| R46 | Joint | Pending | Implemented controls exercised locally | Full combined cross-page interactions |
| R47 | Joint | Pending | Missing/error/partial/async checks | Remaining provider states |
| R48 | Joint | Pending | Synthetic actual-route Contacts/detail | Canonical CRM combined E2E |
| R49 | Joint | Pending | Presentation callbacks retained | Full multi-role/multi-campaign roundtrip |
| R50 | Joint | Pending | Local calendar DST/navigation | Original-thread scheduling context |
| R51 | CRM | Pending | No real approval/provider flow executed | Isolated state machine + authorized live readback |
| R52 | Joint | Pending | Source-role overview callbacks | Booking/update propagation |
| R53 | Joint | Pending | Profile refresh/reopen/async and API scope tests | Full deep-link/provider/pagination matrix |
| R54 | All | Pending (boundary respected) | No real email/campaign/calendar action executed | Separate authorization for future execution |
| R55 | All | Pending (boundary respected) | No new resource/provider/dependency or production action | Separate activation approval |
| R56 | All | Pending (boundary respected) | No paid unlock/enrichment/send feature added | Parent review |
| R57 | Joint | Pending | This map, code/test/visual bundle and limitations | Combined owners' full deliverable |
| R58 | Parent | Pending | Exact commits/patches/commands returned | Original handoff session independent review |
| R59 | All | Pending | Source/activation and rollback limits documented | Owner-approved enablement checks |

## Actual-route integration finding

The real Shell route exposes an existing composition issue in `RecruitingPanel.tsx`: `RoleAgentSection` renders native correspondence before the CRM pane. Inbox first shows a native service/empty-mail section, then the new CRM conversation below the fold; Interview likewise renders native records before the second CRM calendar. Both sections are real mounted components. The first-viewport and scrolled screenshots preserve this discrepancy. The CRM owner must reconcile the two sources into its canonical workspace before the combined page is visually accepted. This patch does not alter that routing/data-selection layer.

## Independent reviewer checklist and activation limits

- Apply only the additive backend hunks against the CRM branch, regenerate the existing Prisma client, and run native PostgreSQL isolation/concurrency tests on an isolated test database.
- Integrate the four page rendering hunks against the CRM owner's latest contracts. Re-run the real-route browser suite and combined role/candidate/campaign/thread flows; component fixtures alone are insufficient.
- Compare real-route captures against V01–V12, including mobile identity/header wrapping, table density, calendar grid, email history, missing assets and focus states. No original reference pixels were available on this executor.
- Inspect source criteria and skill contexts, including counterevidence, partial match and no-evidence cases. Confirm no local ranking change.
- Confirm photo/logo URL columns actually exist in allowed upstream records. No new provider configuration, credentials, webhook, telemetry subscription or historical backfill is included.
- Validate email/read metrics and timeblocks only within existing approved scopes. Unsupported provider ingest and complete time-range coverage remain separate setup gaps.
- Native mobile screens were not changed; responsive web was tested, and Electron shares that web UI. Native app feature parity needs its own review.
- Repository workflow audit found main-branch deployment triggers. External repository hooks could not be enumerated with the available read credential, so remote publication is held pending that audit; the delivery uses local patches. No push, PR, merge or deployment is implied.
- Rolling back removes the UI/API additions; no migration is required. Existing view events remain historical audit records in the existing event store. Do not backfill or delete unrelated events.
