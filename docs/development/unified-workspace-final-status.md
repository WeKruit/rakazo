# Current 59-item implementation and acceptance state

> Required correction: [confirmation freshness](scheduling-confirmation-freshness.md). The immutable `eb216182` checkpoint could reuse an accepted booking read after a later mutation; use the corrective artifact and its exact manifest before release. Earlier test counts remain historical evidence.

This supersedes the producer-only status map. IDs are the ordinal items in [the canonical checklist](unified-workspace-acceptance.md). Production-code checkpoint: `861dba93ef8b5d50b46bc247e5d818bbb2241782`; the delivery manifest pins later test/document commits. **Every live state is pending; none of these rows claims live acceptance.** Tests use synthetic providers and isolated native PostgreSQL. “Partial” is not complete. Visual evidence is targeted desktop/mobile review, not full pixel equivalence.

| ID | Code state | Implemented boundary | Actual local test / visual evidence | Missing capability or acceptance prerequisite |
| --- | --- | --- | --- | --- |
| R01 | Partial | Five canonical routes mounted | 12 route tests; targeted parent visual pass | Full source-backed journey |
| R02 | Implemented | This matrix plus exact manifests | Document review | Original session review |
| R03 | Implemented | Code/test/visual/live separated | Document review | Retain distinctions |
| R04 | Implemented | Exact canonical legacy workspace reuse | API + native PG | Source release and ID readback |
| R05 | Partial | Exact source/role/candidate identities | Scope, stale-response, dedup tests | Full conflict-resolution acceptance |
| R06 | Implemented supported chain | Exact role/candidate/original mail/booking/confirmation persisted association | Linked workflow + native PG | Source activation and live readback |
| R07 | Partial | Existing campaign selection and observed lead/step IDs | API + route tests | Authoritative provider URLs/step IDs unavailable |
| R08 | Partial | Thread/mailbox/message identity preserved | Native reply + API tests | Full provider header/coverage readback |
| R09 | Implemented supported creation | Specific contact/original-mail linkage and verified replacement lineage | Linked + API + native PG | Immutable plans are not automatically revised after rescheduling |
| R10 | Implemented explicit input | Selected UTC interval and distinct participant zones/offsets | DST fold + plan UI + linked tests | Missing zones and unsupported availability are not inferred |
| R11 | Partial | Scoped sync/idempotency/error semantics | Native PG + API tests | Complete live reorder/conflict acceptance |
| R12 | Implemented scoped boundaries | Owner/space/role/source/revision checks | Native PG + negative API tests | Live permission/readback acceptance |
| R13 | Partial | Directory, existing actions and honest totals | UI + actual routes | Full source filter/status acceptance |
| R14 | Implemented for supplied fields | Explicit asset URLs and identity pairing | Unit/browser; parent visual pass | Actual avatar/logo availability |
| R15 | Implemented | Readable hierarchy and evidence navigation | UI/browser; parent visual pass | Live records review |
| R16 | Implemented for supplied criteria | Exact criterion revision; partial/unknown retained | Unit/browser; parent visual pass | Actual source evidence quality |
| R17 | Partial | Exact weekly date filter plus existing role/candidate navigation | Actual desktop/mobile route tests | Unsupported provider step/event deep links |
| R18 | Partial | Observed unread tri-state and loaded filter | UI + route tests | Authoritative totals/mark-read unavailable |
| R19 | Partial | Scoped paged mail and exact grouping | Source SQL/API/browser | Source tool deployment and complete readback |
| R20 | Partial | Actual failures/uncertainty and exact draft context | Native reply/API/UI | Complete composer state workflow acceptance |
| R21 | Partial | Exact retained campaign/lead/thread identifiers | Scope tests | Verified external deep-link contract absent |
| R22 | Implemented supported path | Original thread/mailbox to reviewable plan and native confirmation | Linked offline + actual route tests | Live mail and calendar acceptance |
| R23 | Implemented | Viewed-by distinct from opens or locks | UI/API/native PG; visual pass | Actual new view records acceptance |
| R24 | Partial | Existing campaign pages/selector/status | API/browser | Owner/archive/search completeness source-dependent |
| R25 | Partial | Known/unknown and coverage-aware metrics | API/UI/browser | Complete provider definitions/windows |
| R26 | Partial | All observed schedules/steps/variants rendered | API/UI/browser | Unknown weekday encoding and deep links |
| R27 | Needs policy decision | No invented automatic outreach mutation | Existing approval boundaries | Agree exact replied/booked/declined stop policy |
| R28 | Partial | Primary calendar and source states | UI/browser; parent visual pass | Full role/activity contextual acceptance |
| R29 | Partial | Actual retained supported availability intervals selectable | UI + preflight + linked tests | Unknown busy/buffer/range coverage remains unavailable |
| R30 | Implemented explicit input | Both participant IANA zones and UTC selection | New York/Tokyo DST + linked/UI tests | Actual participant identity and live provider acceptance |
| R31 | Implemented supported plan | Exact contact/thread/slot/two-zone review and native approval | UI + linked + native PG | Live approval/readback acceptance |
| R32 | Implemented supported paths | Fresh source/original/availability and readback | Linked + executor + PG | Unsupported schemas/durations fail; live unverified |
| R33 | Implemented supported path | Durable booking-confirmation association and reconcile-only retry | Linked + native PG + UI | Sent readback is not delivery; no automatic resend |
| R34 | Partial | Verified changes/cancellations refresh list and supersede stale original | Linked + executor + native PG | No automatic immutable-plan revision; live propagation pending |
| R35 | Partial | Role filters and dated shortlist chart | UI/browser | Cross-source date/cohort aggregation missing |
| R36 | Partial | Honest totals and proven upcoming subset | API/UI/browser | Complete reply aggregation/cohorts missing |
| R37 | Implemented supported filter | Weekly shortlist retains role/source/date/cutoff | Desktop/mobile clear/back/reload tests | Other metrics explicitly use generic role navigation |
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
| R48 | Partial live acceptance | Legacy no-prior-chat identity and Contacts/plan local journey | Native PG/API/actual routes | Source-backed live journey |
| R49 | Partial live acceptance | Legacy and native candidate campaign/Inbox/plan routing | Native PG/API/actual routes | Full multi-role live roundtrip |
| R50 | Implemented supported interaction | Original thread to saved plan and interview context | Actual routes + linked fixture | Live providers and unsupported availability schemas |
| R51 | Implemented supported offline workflow | Real plan services to native approvals, booking and exact confirmation readback | 13 linked cases; synthetic providers | Intent scripted; autonomous and live acceptance unproven |
| R52 | Partial | Proven upcoming projection and exact confirmation association | API/linked/UI/routes | Live propagation and historical cohort coverage |
| R53 | Partial | Negative scopes/paging/retry/deep-link cases | Unit/API/PG/browser | Complete combined provider matrix |
| R54 | Boundary respected | No real send/booking/mutation | Offline fixtures only | Separate live action authorization |
| R55 | Boundary respected | No deploy/resources/dependencies/Docker this batch | Diff and action review | Separate activation authorization |
| R56 | Boundary respected | No paid unlock/enrichment introduced | Diff review | Original reviewer verification |
| R57 | Implemented review artifact | New full bundle and delta; prior checkpoint immutable | Manifest/hash/tree verification | Publication held; no PR or release approval |
| R58 | Pending independent acceptance | Local independent code/visual checks done | Recorded reviewer results | Original handoff session final review |
| R59 | Pending enablement | Ordered prerequisites and grants documented | No activation performed | Authorized owner deployment/sync/readback |

Current increment evidence: 733 web checks, 750 server checks, 33 targeted native PostgreSQL checks, 10 final plan UI checks; counts overlap. Five combined actual-route cases and three final scheduling presentation cases passed. See [increment delivery](scheduling-plan-increment.md) for commands, exact checkpoints and unsupported capabilities. No blanket completion claim is made for this matrix.
