# Legacy CRM workspace development

Development only. No production connection, migration, CRM synchronization, provider send, deployment, or resource creation was performed. Root will publish a draft PR; deployment and live acceptance remain the local owner's work.

Base: `e740fa44`. Attachment implementation: `597665ae`. The follow-up commit containing this document adds the campaign read bridge and further conflict regressions.

Opening an exact CRM role through `groups.create` now performs the existing fresh authenticated role read, then serializes the owner/space/source/organization/role identity. It reuses a uniquely proven native binding or creates one intake shell, stores the actual source material in `recruiting_crm_workspace_attachments`, and attaches the original group. It does not manufacture a conversation message, human approval, stage progression, campaign, or execution receipt. Conflicting bindings, archived canonical roles, revoked permissions, changed connection revisions, and ambiguous canonical identities fail explicitly. Matching titles are not identity.

The imported campaign view reads the current exact CRM role's campaign mapping and verifies the same campaign ID through the already assigned Instantly connection. It does not require or fabricate an `ensure_role_campaign` receipt. Multiple or incomplete campaign mappings report an explicit selection conflict. A known campaign without direct provider authorization remains known but unavailable. The source does not supply a verified sender mailbox in its campaign mapping; this view leaves sender unknown. The separate correspondence bridge carries actual email account evidence from the stored message and preserves its permissions.

New migration, after all existing migrations: `20261023190000_recruiting_crm_workspace`. It adds only the attachment table, exact identity unique key, and native role foreign key. No cloud resource or secret. Apply the final migration file once; the developer's isolated synthetic database was manually adjusted while the migration was being authored, and is not a deployment template.

Validation:

- Native PostgreSQL, localhost 55439, isolated `rakazo_legacy_crm`: six focused attachment tests pass. They cover concurrent idempotent opens, no chat/effect fabrication, identity rather than title matching, connection/revocation fences, conflicting native binding versus attachment, archived legacy binding with no attachment, and archived canonical role refusal.
- API `recruiting.test.ts`: 280 tests pass, including five new imported campaign cases (ready, multiple mappings, revoked CRM membership, absent provider authorization, mismatched provider ID).
- Existing CRM receipt PostgreSQL tests: three tests pass, together with all six attachment tests. Fixed fixture-owned teardown order (replies, imports, then organization) after its existing foreign-key cleanup failure. Final targeted run: nine tests pass, clean teardown.
- Complete candidate domain unit suite: 417 tests pass, including duplicate native binding refusal. Test doubles explicitly model absent attachments; no runtime compatibility path was added.
- API TypeScript check and Biome checks pass. No dependencies added.

Local owner acceptance after review/deployment approval:

1. Keep deployment paused while the separately recorded Autumn search restriction applies. Verify current deployed SHAs and pending source patches first.
2. Apply the reviewed application migration in order, deploy the reviewed application, and separately apply/deploy the required source correspondence patch through its authorized owner. This document does not authorize production execution.
3. Open a known legacy CRM role twice, including concurrently. Confirm one canonical native role/group, the same original chat and crew, source description preserved, no fabricated messages, no approval/stage advancement, and no created campaign.
4. Verify exact org/source/role identity and the existing campaign ID against the legacy CRM. Confirm campaign view does not create another campaign. Confirm multiple campaign mappings request exact selection instead of silently choosing.
5. Read the real correspondence through the separate Inbox bridge; verify original campaign, message IDs, sender account and body. Test revoked membership and changed connection revision fail rather than returning another role's data.
6. CRM synchronization remains separate: use the existing delivery runbook's local-owner dryRun=true, inspect counts and field mapping, then dryRun=false and readback. No live sync was run during this development.

Development tests do not establish live acceptance, source deployment, real mailbox availability, or successful production migration.

## Source context and deferred read follow-up

The saved CRM job description now enters the existing recruiting run context as escaped JSON explicitly marked untrusted external reference data. It is separate from native criteria, human history, and approvals. A fresh owner/thread/active-role/source-epoch/assignment check is required even when the caller already supplied a trusted native role snapshot. Locked context adoption rechecks the source material and authorization before recording the context artifact; changed or revoked source material cannot be adopted or replayed as current.

Imported campaign reads now revalidate the exact CRM mapping after awaited provider responses, then recheck the session, conversation target, and provider assignment/revision before returning lead data. Both role campaign/setup router handlers pass the session reauthorization callback. Deferred-response tests revoke CRM membership, source revision, session, conversation target, or provider assignment while the provider response is paused; each fails closed.

Follow-up validation: eight native PostgreSQL attachment/context tests passed. Combined API and recruiting context suites passed 324 tests. API TypeScript passed. The broad adapters TypeScript check remains blocked by existing test-only errors in executor, MCP connector/OAuth, credential, secret-persistence and wakeup fixtures; no errors reference the changed recruiting context files. No new migration or production operation is part of this follow-up.
