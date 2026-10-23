# Backend checklist audit — 2026-10-23

Audited code: `cefb44d8`; environment: isolated cloud checkout, source inspection only for this audit. Owner: CRM/function development. Requirement IDs follow `profile-workspace-review.md` and the ordered canonical `unified-workspace-acceptance.md` checklist. This is an evidence proposal, not acceptance. Every live status below is **pending authorization/acceptance**. No provider, database, email or calendar operation was performed. No fresh test execution is claimed here; named tests are existing reproducible evidence locations, with their limitations inspected.

Implementation uses `partial` below to mean the requirement as a whole remains **not implemented/verified complete**, even if individual primitives exist. Test status `partial evidence` means the whole checklist item remains **pending execution/acceptance**. Visual-only items R14–16, R23, R39, R41–47 stay with the profile/visual owner; this audit does not certify them.

| Item | Implementation | Test evidence / status | Remaining prerequisite or smallest missing work |
|---|---|---|---|
| R01 five connected pages | Partial | Shared routes and canonical correspondence exist; full journey pending | Combined navigation/state acceptance |
| R02 evidence per requirement | Partial | This audit plus profile matrix | Consolidated commit/environment/test/browser manifest |
| R03 separate statuses | Implemented in delivery convention | Document inspection | Retain separate live status |
| R04 original CRM roles | Implemented primitives | `recruiting-crm-workspace.postgres.test.ts`, API CRM tests; live pending | Deploy approved source capability and verify original IDs |
| R05 stable contact/conflicts | Partial | Scoped identities and loaded-list dedup tests | Visible conflicting external identity resolution is not proved |
| R06 complete relationship chain | Partial | Exact role/candidate/mail source fences | Booking-to-contact/original-mail thread persisted chain missing |
| R07 provider campaign/member/step | Partial | Campaign source mapping and lead read tests | Exact step and provider deep-link coverage not established |
| R08 provider mail identity | Partial | `recruiting.test.ts`: exact source/thread/campaign/mailbox preservation | Reply headers and all source direction/unread completeness not established |
| R09 booking identity chain | Partial | Native event receipt projection | Calendar/slot/contact/role/original-mail thread linkage not complete |
| R10 UTC/timezone | Partial | `interviewCalendar.test.ts`, linked scheduling DST scenarios | Two participant IANA identities and ambiguous local-time input validation not proved |
| R11 synchronization | Partial | CRM sync/idempotency and native external-effect tests | End-to-end repeated webhook/order/conflict/freshness acceptance pending |
| R12 isolation | Implemented audited boundaries | API CRM/Instantly scope fences and negative tests | Combined live/provider and UI access acceptance pending |
| R13 Contacts operations | Partial | Directory/hook tests; unknown union totals explicit | Full canonical filter/sort/status behavior requires UI owner acceptance |
| R17 exact cross-page links | Partial | Existing selected-record callbacks | Campaign/lead/step/interview roundtrip incomplete |
| R18 Inbox filtering/unread | Partial | Canonical Inbox selection and grouping tests | Authoritative unread data/actions absent; unknown must not be zero |
| R19 complete mail history | Partial | RoleMail v2 paging and exact thread grouping tests | Full source deployment/readback and coverage verification pending |
| R20 reply state machine | Partial | Native exact approvals, reply preflight/readback tests | Complete composer presentation and confirmation-specific failure state not proven |
| R21 Inbox/Sequence provider links | Partial | Exact retained IDs | Precise campaign/lead/step deep links and return context pending |
| R22 original thread scheduling | Not complete | Linked offline test uses generic send, no original thread | Carry actual selected thread into reviewable proposal and confirmation |
| R24 campaign list/filter/owner | Partial | Source campaign browse/status reads | Owner/steps/archive/filter completeness not proved |
| R25 actual metrics | Partial | Unknown-vs-zero and incomplete coverage tests | Complete provider metric definitions/time windows absent |
| R26 schedule/membership/deep links | Partial | Existing campaign/lead state | Complete real steps/schedule and exact external links pending |
| R27 outreach stop policy | Not complete | Existing approval boundaries only | Explicit accepted business policy plus verified provider state updates |
| R28 calendar controls/states | Partial | UI calendar tests; receipt projection | Full role/activity/source-state acceptance pending |
| R29 full slots/coverage | Not complete | Supplied availability records projected | No comprehensive busy/buffer/duration/range/pagination coordinator proven |
| R30 both participant zones/DST | Partial | Explicit UTC instants for repeated 01:30 DST cases | This does not validate ambiguous user local-time parsing or both-party zones |
| R31 reviewable approved plan | Partial | Exact native action approval retains payload | Full contact/role/thread/calendar/slot/both-zone plan is not one proven contract |
| R32 prewrite conflict and booking readback | Partial, blocker | Approval/idempotency/readback fixtures | Calendar approval replay has no availability/original-event preflight; fix before enabling writes |
| R33 same-thread confirmation/retry | Not complete | Separate retained effects prevent duplicate booking; uncertain confirmation preserved | Generic send fixture has no provider thread/readback; no joined booked/confirmation-failed product state |
| R34 reschedule/cancel/partial propagation | Partial | Mutation approvals and provider statuses exist | Linked reschedule/cancel/conflict/expiry/failure states across five pages not proved |
| R35 Overview unified filters | Partial | Source role filtering and count-coverage tests | Date-window aggregation across sources not complete |
| R36 Overview aggregates/tasks | Partial | Unknown counts preserved; existing activity | Upcoming bookings, complete reply counts and conversion cohorts incomplete |
| R37 drilldowns | Partial | Existing source-role callbacks | Exact page/filter deep-link acceptance pending |
| R38 activity actor/source/time | Partial | Actual profile views and existing provider receipts | Complete linked event identity/actor coverage not proved |
| R40 manual activity consistency | Partial | Notes preserved distinctly | Whole cross-page audit/dedup acceptance pending |
| R48 CRM→Contacts→Detail | Partial | Isolated actual-route fixtures | Complete source-backed journey/live readback pending |
| R49 Contacts→Sequence→Inbox | Partial | Scope unit tests | Multi-role/campaign/step browser journey pending |
| R50 Inbox→Interview | Not complete | Time display tests only | Original-mail linkage and full slot/proposal workflow pending |
| R51 approval→booking→confirmation | Partial, blocker | `scheduling-linked-offline.test.ts` | Missing preflight and original-thread readback; synthetic providers are not live proof |
| R52 booking→Overview | Not complete | Calendar receipt projection | Cross-page mutation/confirmation propagation not proved |
| R53 edge-case matrix | Partial | Several negative scopes/paging/replay tests | Complete combined browser/provider matrix pending |
| R54–56 authorization limits | Respected in this audit | No external operations | Separate authorization remains necessary for live actions/resources/cost |
| R57 final bundle | Pending | This proposal is one component | Combined functional/visual/E2E/provider manifest |
| R58 independent review | Pending | Root integrates and reviews | Original handoff independent review |
| R59 enablement | Pending | No activation performed | Approved source deployment, provider scopes, configuration, migrations, rollback/live acceptance |

## Scheduling findings requiring action

1. `packages/adapters/src/executor.ts` approved replay restores the exact request, calls `readReplyEvidence` and `preflightReply`, then consumes the replay. `preflightReply` returns immediately without a recruiting reply selection. There is no equivalent calendar conflict/original-event check. `docs/wekruit/skills/scheduling/SKILL.md` step 4 explicitly requires blocking recovery if that preflight cannot be performed. A prompt instruction alone does not enforce this boundary.
2. `apps/api/src/scheduling-linked-offline.test.ts` discovers only `create_booking` and `get_booking`; slots and participant selection are scripted. `booking_conflict` is the provider rejecting a mutation after dispatch, explicitly not preflight. This is useful rejection/idempotency evidence, not compliance with R32.
3. The confirmation fixture invokes `GMAIL_SEND_EMAIL` with `to`, `subject`, `body`; it neither supplies nor reads back the original provider thread. A local run/thread ID is not an email thread ID. R33 remains incomplete.
4. Definitive confirmation rejection is a retained external effect with `status: completed` and `result.error`; uncertain acknowledgement remains `status: uncertain`. Consumers must inspect the result, not equate effect completion with successful mail. The booking remains distinct and is not recreated. A joined product state for booked-but-confirmation-failed is not demonstrated.
5. DST fixtures choose unambiguous UTC instants and show the repeated New York 01:30 with different offsets. They do not parse ambiguous local-time input. Cal.com event projection currently has `timeZone: null`; availability uses request timeZone or UTC. Neither proves both participants' actual timezone identities.

## Smallest authorized next steps versus external prerequisites

- Development: enforce a calendar replay preflight boundary using actual assigned provider schemas; fail closed with an explicit capability gap if exact slot/original-event verification is unavailable. Do not invent tool arguments, approval payloads or booking mappings.
- Development: preserve exact original-mail identity in the scheduling plan and use an existing thread-aware reply operation; project separate booking and confirmation outcomes from actual receipts. Treat uncertain sends as reconcile-only, never automatic resend.
- Development: add isolated regressions for slot changes while approval is pending, unavailable preflight, original event mismatch, same-thread confirmation readback, and partial failure. None requires a live connection.
- Prerequisites for live acceptance: authorized current calendar/free-busy/event and mailbox/thread read/write capabilities, explicit action approval, real source identity mapping, authorized deployment/migrations and event/message readback. These are not reasons to stop isolated development, and this audit does not request or assume authorization to perform them.

## Public provider contract follow-up

Read-only public documentation check (no authenticated provider call): the [official MCP tool list](https://cal.com/docs/mcp-server) names `get_availability` and `get_booking`. The [slots API](https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type) documents event identity, query dates, duration, range output and `bookingUidToReschedule`; the [booking API](https://cal.com/docs/api-reference/v2/bookings/create-a-booking) documents `lengthInMinutes`. These support investigating a narrow functional preflight; they do not prove the configured hosted MCP tool's input schema. The publicly published `@calcom/cal-mcp` 0.0.6 source inspected in temporary files uses controller-style tool names rather than the hosted tool names; it was not installed as a dependency.

A usable preflight needs: the assigned source's actual `get_availability` schema; an exact approved event-type identity and interval/duration; a fresh matching available interval; and, for reschedule/cancel, the exact original event and relevant preapproval state. Dynamic discovery validates argument shape, but cannot by itself recover missing approved duration or original-event state. A blanket disablement is not a functional implementation. Any temporary fail-closed experiment remains isolated and is not included in this documentation commit.
