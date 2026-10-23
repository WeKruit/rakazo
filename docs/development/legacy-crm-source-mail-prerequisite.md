# Legacy role correspondence source prerequisite

This is an unpublished development patch, not a deployed source capability.

- Source base: `11ca9c2df226782eee241fc5b36ba15600f4efcb`.
- Final local source head: `34eca76027a932f5fb8ffac5f961a9debb291011`.
- Patch: [legacy-crm-role-mail-v2.patch](../handoff/2026-10-23/legacy-crm-role-mail-v2.patch).
- Local commits, in order: `d447bfb4fee7f735e007123a35ce76116c8de660`, `5fe805ff2443e52afdd0e0dc3af7b6c2b5da5775`, `34eca76027a932f5fb8ffac5f961a9debb291011`.

The existing role-mail tool uses bounded SQL pages rather than collecting a role's candidate IDs into a capped HTTP filter. It preserves exact organization and role membership, excludes explicitly other-role campaign mail, and retains stored message/thread/mailbox identity and full body. Optional `p_candidate` filters before pagination and requires an exact candidate echo and matching rows. Candidate-only unscoped mail is not a substitute for role-scoped history. Source-email aliases do not establish identity. A pending outbox without role provenance is unavailable for a role, not an empty or sent mailbox.

The source migration is `20261023184734_crm_role_correspondence_pages.sql`, after the existing source presence migrations `20261023180000_crm_candidate_presence.sql` and `20261023181000_crm_candidate_presence_secondary_roles.sql`. Verify the full names against the pinned source checkout before execution. Apply the complete patch to the pinned source base first, inspect the final tree, and apply the final migration exactly once. Do not execute intermediate versions between patch commits: the final SQL function has an optional fifth candidate argument, whereas an intermediate unpublished version had four arguments. Applying both separately can leave an unintended overload. If any intermediate migration was already applied, stop and have the source owner reconcile its actual schema before continuing.

Publication, source migration, and MCP deployment require their owner's separate authorization. Source GitHub publication can trigger the existing Vercel integration; no source push occurred for this patch. The application requires role-mail protocol version 2 and exact scope evidence. Missing capability, permission, or proof must fail visibly. A successful Vercel deployment is not proof that this SQL or MCP capability is installed.

Local validation at the final source head:

```sh
deno test --config supabase/functions/mcp/deno.json --node-modules-dir=none --allow-env --allow-read supabase/functions/mcp/tools/crm.test.ts
psql -X -v ON_ERROR_STOP=1 "$ISOLATED_TEST_DATABASE_URL" -f supabase/tests/crm-role-correspondence.sql
```

The Deno suite passed 77 tests with type checking. The native PostgreSQL fixture passed and rolled back its synthetic schema. It covers a large role across five pages, campaign-only association, foreign organizations/campaigns, deterministic ordering, full bodies, null mailbox data, and exact candidate filtering. No production connection or actual synchronization was used. Static independent review found no remaining blocker in this source patch; the reviewer did not rerun the tests.
