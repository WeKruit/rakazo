# Scheduling plan service delivery

Development commits: `d4ea2f16`, `63154c17`, `a3bf2ee6`. Shared contract dependencies: `03c659d3` and `32526cf1`; native executor integration is separately owned in `b7c81b76`. These are development commits, not evidence of deployment or live acceptance.

The API and native agent use the same draft service. A draft is an internal `recruiting_scheduling_plan` effect with immutable input and explicit associations to real booking and confirmation effects. It is not a completed provider receipt or an approval. No new table, migration, dependency, service, secret or provider resource is required. Booking and external confirmation still use native approvals and dispatch.

The draft binds current actor, Space, thread, role revision, selected retained availability interval, explicit participant IANA zones, and exact original correspondence. CRM provenance remains separate from the native sending source and its revision. A legacy CRM selection requires its scoped saved message/contact/role projection and a unique matching authorized native email read; a prior human chat message is unnecessary. Native LinkedIn candidates can use the existing exact candidate-key-to-lead mapping in their role campaign, or an actual CRM import occurrence/receipt and scoped contact projection. No title, display name, or email similarity is used to join identities. Original subject, sender, date and source label are derived from actual saved evidence for review.

Booking and confirmation associations are serialized, immutable across retries, and checked in both directions. Cosmetic changes to a plan cannot bypass an existing operation for the same original email, candidate and interval. Uncertain operations remain associated for reconciliation; saving another draft does not authorize a resend or another booking. Provider requests remain unchanged, and their hashes are checked against their associations.

Confirmation requires a successful booking and a later authorized readback of its exact UID, interval, candidate attendee and requested interviewer host. A message POST acknowledgment alone is uncertain. A completed confirmation projection requires an exact stored sent record, including original anchor, mailbox, thread, recipient and approved content. Scheduled or incomplete records are not labeled sent, and no result is labeled delivered. Booking state and confirmation outcome remain separate.

## Validation

- `pnpm --filter @rakazo/api check`: passed on `a3bf2ee6`.
- `vitest run apps/api/src/recruiting-scheduling.test.ts packages/contracts/src/attachments.test.ts`: 6 tests passed on `a3bf2ee6`; includes session revocation before access and while a read is pending.
- Independent linked fixture: 13 tests passed against the final service, including real draft/load/bind calls and native executor readback. Synthetic provider data establishes implementation behavior, not live delivery.
- The separate PostgreSQL review suite covers concurrency, actor/source/role isolation, legacy no-chat bridging, ambiguous native sources, mailbox/campaign mismatch and uncertain-operation duplicate prevention. Use its final committed test report for the final count; the integration owner records that result separately.

## Deployment-owner acceptance prerequisites

The existing production hold remains in force. Do not execute this document as authorization to deploy, migrate, synchronize CRM, book or send.

Once separately authorized, the local owner must first follow the existing ordered product/source migration and CRM synchronization handoff, including source role-mail v2 support and authorized tool assignments. Do not broaden custom or revoked assignments. Verify the intended role's actual saved contact/message projection and exact existing native campaign/mailbox. Obtain genuine native email and availability reads under the active role, then save and inspect the plan with both participant zones. Draft saving should perform no external action.

Exercise booking through the exact native approval, then read back the booking's UID, interval, attendee and host before requesting the separately approved original-thread confirmation. Read back the actual confirmation record. For a timeout, keep the operation uncertain and reconcile the existing provider identity; do not rebook or resend. Live account connection, provider behavior, delivery and full user acceptance remain unverified by these offline checks.
