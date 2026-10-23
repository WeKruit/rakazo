# Current 59-item implementation and acceptance state

This supersedes the producer-only status map. IDs are the ordinal items in [the canonical checklist](unified-workspace-acceptance.md). Production-code checkpoint: `98545e370263efb55dbb7c92b9b254e520d340d4`; the delivery manifest pins later test/document commits. **Every live state is pending; none of these rows claims live acceptance.** Tests use synthetic providers and isolated native PostgreSQL. “Partial” is not complete. Visual evidence is targeted desktop/mobile review, not full pixel equivalence.

| ID | Code state | Implemented boundary | Actual local test / visual evidence | Missing capability or acceptance prerequisite |
| --- | --- | --- | --- | --- |
| R01 | Partial | Five canonical routes mounted | 12 route tests; targeted parent visual pass | Full source-backed journey |
| R02 | Implemented | This matrix plus exact manifests | Document review | Original session review |
| R03 | Implemented | Code/test/visual/live separated | Document review | Retain distinctions |
| R04 | Implemented | Exact canonical legacy workspace reuse | API + native PG | Source release and ID readback |
| R05 | Partial | Exact source/role/candidate identities | Scope, stale-response, dedup tests | Full conflict-resolution acceptance |
| R06 | Partial | Role/campaign/candidate/mail chain fenced | API scope tests | Booking-to-specific-mail persisted join missing |
| R07 | Partial | Existing campaign selection and observed lead/step IDs | API + route tests | Authoritative provider URLs/step IDs unavailable |
| R08 | Partial | Thread/mailbox/message identity preserved | Native reply + API tests | Full provider header/coverage readback |
| R09 | Partial | Creation and verified replacement UID lineage | API + linked tests | Specific contact/original-mail linkage missing |
| R10 | Partial | Explicit UTC intervals and named display zones | DST/calendar tests | Both participant zones and ambiguous input handling |
| R11 | Partial | Scoped sync/idempotency/error semantics | Native PG + API tests | Complete live reorder/conflict acceptance |
| R12 | Implemented scoped boundaries | Owner/space/role/source/revision checks | Native PG + negative API tests | Live permission/readback acceptance |
| R13 | Partial | Directory, existing actions and honest totals | UI + actual routes | Full source filter/status acceptance |
| R14 | Implemented for supplied fields | Explicit asset URLs and identity pairing | Unit/browser; parent visual pass | Actual avatar/logo availability |
| R15 | Implemented | Readable hierarchy and evidence navigation | UI/browser; parent visual pass | Live records review |
| R16 | Implemented for supplied criteria | Exact criterion revision; partial/unknown retained | Unit/browser; parent visual pass | Actual source evidence quality |
| R17 | Partial | Role/candidate/profile/navigation callbacks | API + route tests | Exact step/event/filter roundtrip incomplete |
| R18 | Partial | Observed unread tri-state and loaded filter | UI + route tests | Authoritative totals/mark-read unavailable |
| R19 | Partial | Scoped paged mail and exact grouping | Source SQL/API/browser | Source tool deployment and complete readback |
| R20 | Partial | Actual failures/uncertainty and exact draft context | Native reply/API/UI | Complete composer state workflow acceptance |
| R21 | Partial | Exact retained campaign/lead/thread identifiers | Scope tests | Verified external deep-link contract absent |
| R22 | Partial | Native original anchor/mailbox reply path | Linked offline tests | Full reviewable scheduling UI/context |
| R23 | Implemented | Viewed-by distinct from opens or locks | UI/API/native PG; visual pass | Actual new view records acceptance |
| R24 | Partial | Existing campaign pages/selector/status | API/browser | Owner/archive/search completeness source-dependent |
| R25 | Partial | Known/unknown and coverage-aware metrics | API/UI/browser | Complete provider definitions/windows |
| R26 | Partial | All observed schedules/steps/variants rendered | API/UI/browser | Unknown weekday encoding and deep links |
| R27 | Needs policy decision | No invented automatic outreach mutation | Existing approval boundaries | Agree exact replied/booked/declined stop policy |
| R28 | Partial | Primary calendar and source states | UI/browser; parent visual pass | Full role/activity contextual acceptance |
| R29 | Not complete | Supported exact intervals only | Preflight tests | Broad busy/buffer/range/pagination coordinator |
| R30 | Partial | DST and UTC display supported | Calendar/linked tests | Two actual participant IANA identities |
| R31 | Partial | Exact action + original snapshot approval | Native approval/PG tests | Complete contact/thread/slot/two-zone plan UI |
| R32 | Implemented supported paths | Fresh source/original/availability and readback | Linked + executor + PG | Unsupported schemas/durations fail; live unverified |
| R33 | Partial | Exact native same-thread confirmation | Linked reply/readback tests | Durable booking-confirmation join/retry UI missing |
| R34 | Partial | Reschedule/cancel approval and reconciliation | Linked + executor + PG | Five-page live propagation; no inferred confirmation |
| R35 | Partial | Role filters and dated shortlist chart | UI/browser | Cross-source date/cohort aggregation missing |
| R36 | Partial | Honest totals and proven upcoming subset | API/UI/browser | Complete reply aggregation/cohorts missing |
| R37 | Partial | Role/group/view drilldowns | UI/browser | Exact metric candidate/date filter not supported |
| R38 | Partial | Real view and retained source events | API/native PG/UI | Complete linked actor/source event coverage |
| R39 | Implemented | New views only; per-visit idempotency | Six profile native PG cases; visual pass | Live new-event acceptance |
| R40 | Partial | Notes distinct from provider operations | UI/API tests | Full cross-page audit consistency acceptance |
| R41 | Implemented tested layout | Shared controls/tokens and canonical surfaces | Actual routes; parent targeted pass | Not full pixel-copy fidelity |
| R42 | Implemented tested viewports | Desktop readable primary surfaces | 1440×900 captures; parent pass | Additional desktop widths |
| R43 | Implemented tested viewport | Responsive mobile controls and no overlap | 390×844 captures; parent pass | Additional devices/native app parity |
| R44 | Partial visual acceptance | Parent inspected reference comparisons | Targeted major blockers closed | Inbox density limitation; full V01–V12 |
| R45 | Implemented evidence set | 52 route screenshots plus manifest | 12 route tests | Coverage review by original session |
| R46 | Partial | Implemented controls and navigation exercised | UI + routes | Full combined cross-page business flow |
| R47 | Partial | Empty/unknown/error/partial states explicit | UI/API/browser | Remaining real provider states |
| R48 | Partial | Canonical Contacts/detail local journey | Native PG/API/routes | Source-backed live journey |
| R49 | Partial | Exact existing campaigns and Inbox routing | API/routes | Full multi-role live roundtrip |
| R50 | Not complete | Exact reply transport and calendar primitives | Linked synthetic fixture | Complete thread-to-plan interaction |
| R51 | Partial | Approved create/change/cancel + native confirmation | Linked offline production functions | Intent scripted; no autonomous/live proof |
| R52 | Partial | Proven upcoming bookings shown in Overview | API/UI/routes | Mutation-to-confirmation propagation incomplete |
| R53 | Partial | Negative scopes/paging/retry/deep-link cases | Unit/API/PG/browser | Complete combined provider matrix |
| R54 | Boundary respected | No real send/booking/mutation | Offline fixtures only | Separate live action authorization |
| R55 | Boundary respected | No deploy/resources/dependencies/Docker this batch | Diff and action review | Separate activation authorization |
| R56 | Boundary respected | No paid unlock/enrichment introduced | Diff review | Original reviewer verification |
| R57 | Implemented review artifact | Full patch/bundle/docs/tests/captures | Manifest/hash verification | Transfer/review, not release approval |
| R58 | Pending independent acceptance | Local independent code/visual checks done | Recorded reviewer results | Original handoff session final review |
| R59 | Pending enablement | Ordered prerequisites and grants documented | No activation performed | Authorized owner deployment/sync/readback |
