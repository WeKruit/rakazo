# Recruiting REA implementation and release acceptance

This implements the approved recruiting UI/UX and backend field map. The original proposal's separate Sequence entity is superseded by review: zero-recipient drafts are existing provider campaigns, linked through existing external-effect receipts. Reviewer owns qualification; no new local evaluator or paid lookup is introduced.

## Implementation map

| Scope | Concrete implementation | Contract / storage | Verification |
| --- | --- | --- | --- |
| Five-item navigation | Kruit, Candidates, Sequence, Inbox, Interview; 240px default resizable sidebar; 34px primary rows; role search and five recent/attention roles; real active role across pages; native links preserve browser open-in-tab behavior | Existing group/role routes; selected CRM source/role preserved; explicit All roles retains current business page | Shell and RecruitingNavigation unit tests; `recruiting-navigation.spec.ts` at 320/1440px |
| Original entry points | New role at Roles heading; Job brief / Client feedback in Role details on role chat and Candidates; Tasks / Routines in Work and their existing pages; Integrations in account menu; Analytics in Sequence | Existing native services and route destinations | Shell integration and navigation browser tests |
| Candidates / Contacts / Shortlist | Dense table, sticky controls/footer, saved selection and sorting, Cards/Board from same records, bulk actions and exact enrollment preview | Existing role candidates, contacts, role associations, source pagination and native assistant approval | `REA-CANDIDATES-UI-COVERAGE.md` |
| Profile and media | Shared 720px default drawer, 64px header, 24px desktop inset, expand/collapse, focus restoration, exact-person avatar, employer/school logos and LinkedIn link, actual timeline and criteria, notes/files and sequences | Existing SavedProfile/source projections and media components; artifact IDs added to existing note rows | Candidate/Profile tests, native artifact authorization tests and cold Contacts browser fixture |
| Worth Talking | Existing current-revision Reviewer grade and source-bound rank/score projection; explicit saved sort choices retained | Existing assessments and candidate/source identity; no cross-result numeric comparison or invented thresholds | Original PostgreSQL regression suite plus explicit mixed-domain sort regression |
| Sequence | Overview, actual run list/filter/details, editable zero-lead native draft, steps and variants, content/timing preview, clone and reload, exact configuration conflict protection | Existing campaign plus existing external effects; stable client nonce and expected configuration revision; no new Sequence table | Draft adapter/native-write regression tests, editor tests and synthetic route fixture |
| Global Inbox | Two-pane list/detail, exact source/mailbox/person attribution, bounded stored-mail search and pagination, personal unread, full-body retention and attachment provenance | Existing imported receipts/CRM mirror/native authorized reads projected into indexed stored mail; personal cursors; source-scoped identities | Real PostgreSQL projection tests, ownership/RLS tests, Inbox UI and responsive actual-App fixtures |
| Interview | Five consecutive dates, date/timezone/status controls, independent activity pane, exact saved-event details, responsive view | Existing native calendar sources and saved availability | Interview calendar tests and responsive browser fixture |
| Scheduling | Recorded availability → customize → exact review; IANA zones/DST, guests/notes/location, dirty close protection, multiple-option email proposal | Existing scheduling plan JSON and native reviewed operations; Cal source owns event-type location; no automatic invite/send | Scheduling UI/service tests and browser single/multiple-time fixture |
| Analytics | Six metric positions, two actual dated charts, period/group/response controls, scoped role table, CSV/SVG exports and bounded people drilldown | Same owner/space-scoped observed CRM cohort in aggregate and people query; earliest observed contact, subsequent reply follows that cohort | SQL cohort/paging/isolation tests; UI metric drill and stale-response tests |
| Talent Insights | Full filtered shortlist population, supplied category frequencies and dated-history quartiles, explicit denominators, CSV | Existing complete candidate pagination; rejects changed/incomplete scope | TalentInsights tests and shortlist browser fixture |

## Data rules

- Missing fields remain unknown; no guessed email, inferred identity, fabricated stage, synthetic availability, fabricated open/click rate or zero for unavailable history.
- A photo/logo already in retained source data is projected through existing validated fields and components. Existing organization lookup/cache is reused. A real absence is not filled by copying another person's or employer's media.
- Global Inbox is the indexed **stored** corpus. Provider completeness is false; index backfill progress and unknown thread identity remain visible. Unread counts do not claim unobserved provider mail.
- Analytics currently aggregates dated saved CRM messages. Native/imported mail and complete first-ever send history are not silently added to a denominator. Unknown rates remain unknown; observed totals expose their actual people.
- Provider campaign writes do not activate campaigns or send mail. Provider APIs do not provide a documented compare-and-swap guarantee; app configuration revision checks and existing reservation receipts prevent app retries/stale editors from blind duplication. External provider edits still require a fresh read.
- Customer source screenshots, real candidate records and local secrets are excluded from this public-safe change.

## Additive database changes

- `20261101130000_recruiting_inbox_actor_rls` (landed with the preceding implementation): register personal Inbox tables in the existing actor isolation and first-batch policy system.
- `20261101140000_recruiting_note_attachments`: artifact references on existing candidate notes.
- `20261101150000_recruiting_inbox_projection`: queryable stored-mail projection, provenance and actor RLS; original receipts/messages remain authoritative and retained.

Apply only the release's migrations through the established staging deployment workflow. Local synthetic migration/test results do not prove an online migration.

## Release evidence — update after each gate

| Gate | Evidence / state |
| --- | --- |
| Local code and database checks | Post-merge PR suites: 1,105 passing assertions (36 files); four database-gated Analytics cases passed separately. Isolated PostgreSQL domain/cohort: 215/215; strengthened Inbox projection: 6/6; restricted-role RLS: 24/24. Full responsive browser suite: 20/20 at 320/390/1440px. Seven affected packages typecheck; production web build passes. Expanded production-catalog checks 15/15 across ten locales, plus eight browser scenarios against the built production assets pass. No online database or provider acceptance is implied. |
| Latest stage integration | Merged stage `6f500f0f9`. Independent reminder, saved reply suggestions, account mail provisioning and optional role tool input retained. Neither KruitDock nor StackedConversation differs from stage. Expanded explicit-sort regression tests retained alongside Best match defaults. |
| Independent review | Claude Headhunter reviews the concrete pushed PR, including source isolation, draft durability, unread/date semantics and original-entry preservation. |
| Staging migration and deployed revision | Pending new UI PR. A prior PR merge or `/ready` alone is not proof that this UI is deployed. |
| Actual staging pages | Verify navigation, global Inbox, Contacts, Shortlist, Profile, Sequence, Analytics and Interview at desktop and compact sizes using authorized real records; preserve existing data and perform no unapproved send/invite. |
| Production release | After staging acceptance, Claude's unified stage-to-main release and observed deployed revision/page checks. |

Browser screenshots from synthetic tests demonstrate layout and interaction only. Provider delivery, customer-data inventory/backfill and live page acceptance require their own release evidence.

## Review screenshots

See [synthetic implementation screenshots](rea-implementation-proof/README.md).
