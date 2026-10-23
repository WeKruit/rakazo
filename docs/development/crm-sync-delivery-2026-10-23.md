# CRM sync development delivery

This is development evidence, not live acceptance. No live CRM read/sync, production migration or outbound operation was performed. Source publication triggered external Vercel deployments; see the root delivery incident, whose main environment is unverified.

## Scope and dependencies

Current product code is Rakazo `fa2a2a0d29c57ebff9147c3467bb0d5c3bdaaa81` (merged #72, including #74 and concurrent #78). Documentation-only main `bb2a23c66a6891ce9380827282807d4ef8c562a0` and this documentation cleanup do not change that code. Source is pinned to merged #67, `11ca9c2df226782eee241fc5b36ba15600f4efcb`. Source SQL and existing MCP updates must precede product sync; Vercel success does not establish either prerequisite. Exact-ID version-2 presence checks and stored-profile reads are required.

Ordered product migrations across the coordinated delivery:

1. `20261023153000_recruiting_role_playbook_stage` (already merged #65).
2. `20261023160000_recruiting_crm_sync` (#72 projection tables).
3. `20261023170000_recruiting_candidate_notes` (#74).
4. `20261023171000_recruiting_candidate_shortlisted_at` (#74).
5. `20261023172000_recruiting_calibration_rounds` (concurrent main PR #78).
6. `20261023172000_recruiting_crm_sync_progress` (opaque progress tokens and contact profile JSON).

The separate CRM source migrations are `20261023180000_crm_candidate_presence` then `20261023181000_crm_candidate_presence_secondary_roles`; its authenticated read function reproduces the CRM's role-label matching and explicitly rejects unauthorized organizations. The existing MCP edge adapter exposes it through `list_crm_candidates` with `p_view: "presence"`. There is no new MCP server, dependency, credential, or cloud resource.

## Field mapping

Existing role/contact/link/mail mappings in the original handoff remain. Added mappings:

| Source | Product |
| --- | --- |
| Latest synced nonempty `candidate_sources.company` (source ID breaks ties) | `recruiting_crm_contacts.company` |
| `candidates.history` JSON | `profile.history`, preserved verbatim, including heterogeneous stored entries |
| `candidates.summary`, `skills` | `profile.summary`, `profile.skills` |
| Source ID, company, title, location, synced time | `profile.sources[]`; original evidence is retained |
| Interest, reviewed, last reply, resume received, phone | Existing typed contact fields, now retained in unified role-candidate CRM payload |

The inspected CRM schema has **no education field**. The historical handoff's claim that education was already stored was not supported by source. No education was invented or inferred. Outbox drafts, review notes and mail for contacts with no role remain outside the full-sync copy. Automated periodic sync is not implemented.

`recruiting.crmData` reads remain the authorized source boundary. Projection queries are owner/space/connection/organization/role scoped and exclude archived contacts, roles and links. The merged integration includes the projection consumer with the existing candidate-tool permission and connection-revision checks; there is no offline/live fallback and no offline availability claim. Run the full sync before evaluating projected CRM rows.

## Correctness changes

Progress is stored server-side with random single-use tokens bound to the user, Space and thread. New starts supersede earlier tokens. Modified, replayed, cross-owner, cross-thread and mode-mismatched cursors fail before source reads or projection writes. No new signing secret is needed.

Full-sync slices and incremental writes share the same per-owner database transaction lock. Newer observations and archive timestamps cannot be overwritten or restored by delayed older reads. Contacts appearing only after the organization scan are stored before role links are created. JSON comparison ignores object key order so a rerun stays unchanged.

Offset traversal is not treated as proof of absence. All potentially missing IDs are revalidated through the authorized source, in batches of at most 50. No row in a unit is archived unless every presence batch succeeds and declares corrected protocol version 2. Older source responses fail closed; never remove this fence to unblock deployment. Failed or incomplete reads are reported under `skipped`; they do not authorize absence-based archives. Incremental reads never archive.

A dry run writes **no CRM source data and no projection rows**. It does write/rotate temporary server-owned progress metadata; completion removes that metadata. Abandoned progress is superseded by the next run. Tokens expire after 24 hours. Do not mix dry-run and real-run tokens or parallelize calls using the same token.

## Local-owner procedure (not executed here)

1. Preserve the deployment/production-action hold. The local owner's earlier `e740fa44` checkpoint remains read-only while that hold applies; it is not a verified current live revision and does not authorize migration, grants, deployment or synchronization. Only the assigned owner may determine that the recorded sourcing restriction has ended and obtain the applicable release authorization. Record actual live source/product revisions and full-name migration ledgers before any later mutation.
2. For the current unified product, the older presence-only source release is insufficient. Start an isolated source checkout at **`11ca9c2df226782eee241fc5b36ba15600f4efcb`**, then apply the complete unpublished [three-part role-mail v2 patch](../handoff/2026-10-23/legacy-crm-role-mail-v2.patch) in its recorded order. The final local source head is **`34eca76027a932f5fb8ffac5f961a9debb291011`**; see [exact patch/base/tree and validation](legacy-crm-source-mail-prerequisite.md). Do not apply the separate archived **presence** recovery patch to `11ca9c2d`: that correction is already present. Source publication may trigger Vercel and still requires separate owner authorization; this handoff does not authorize a push. After the hold is explicitly lifted and the owner authorizes the release, inspect the actual source ledger and apply missing final SQL files in order: `20261023180000_crm_candidate_presence.sql`, `20261023181000_crm_candidate_presence_secondary_roles.sql`, `20261023184734_crm_role_correspondence_pages.sql`; then update the existing MCP function from the complete final source tree. Never apply intermediate versions of the new role-mail migration, create an accidental four-argument overload, prune functions, create resources or rotate secrets. If an intermediate unpublished migration was applied elsewhere, stop for source-owner schema reconciliation.
3. Apply all missing product migrations in repository lexical order before updating API/worker, preserving distinct migrations with the same timestamp. The unified workspace additionally requires `20261023190000_recruiting_crm_workspace`, including its `sourceMaterial` column, after both distinct `20261023172000_recruiting_calibration_rounds` and `20261023172000_recruiting_crm_sync_progress`. Verify the real ledger and final SQL rather than inferring completion from prefixes. No migration is needed for reply-outcome presentation. Before any sync, verify both source v2 responses and the actual caller's required role-mail grant. Customized/revoked assignments remain unchanged; the exact read-only grant described in [required mail](crm-required-mail-2026-10-23.md) remains pending explicit authorization. Do not broaden to all bots, `allowAllTools`, mail send or calendar access.
4. From the authorized signed-in product tab, use the existing group and Space. Do not paste cookies, tokens or credentials. Run the following loop first with `true`; stop if `skipped` is nonempty or expected source counts differ. Review counts with the owner before starting a fresh run with `false`.

```js
async function runCrmSync(dryRun, groupId) {
  let cursor;
  let report;
  do {
    const response = await fetch("/rpc/recruiting/crmSync", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { groupId, dryRun, ...(cursor ? { cursor } : {}) } }),
    });
    report = (await response.json()).json;
    if (!response.ok) throw new Error("CRM sync request failed; inspect the authenticated response.");
    if (report.skipped.length) throw new Error("CRM source reads were incomplete; do not accept this pass.");
    cursor = report.nextCursor;
  } while (cursor);
  return report;
}
await runCrmSync(true, "<authorized-group-id>");
// After reviewing the dry-run report, start a new run (no reused cursor):
await runCrmSync(false, "<authorized-group-id>");
```

If the deployment requires an explicit Space header, use its existing `x-rakazo-space-id` value. If a request fails, do not assume it committed or replay a consumed cursor: inspect the result/projection, then start a new pass. Idempotent upserts preserve record identities.

5. Read back aggregate counts scoped by `userId`, `spaceId`, `mcpServerId`, `organizationId` in all four projection tables. Check source IDs/role links, archived rows, company/history/summary/skills, and correspondence against the same authorized source. Do not publish names, emails, message bodies or production IDs in the delivery report.
6. Rerun `false` to completion and confirm no unexpected creates/updates/restores/archives. Source changes during a run may legitimately change counts; offset traversal is not a historical snapshot.
7. Open the same role's Contacts, Results, profile and Inbox, confirming matching identities and mapped fields. Check another authorized user cannot read the first user's projection; complete real two-user acceptance only with supplied accounts. Check no new outbound operation occurred. Record the actual deployed revision, ledger and results separately from development completion.

## Validation and limits

Focused PostgreSQL tests use a localhost-only disposable test database with synthetic identities and a fake CRM reader. They cover rerun counts, archive/restore, failed reads, isolation, dry-run separation, cursor tamper/replay/scope/concurrency, shifted offset pages, late contact arrivals, stale writes and archives, all-batch absence failure, and persisted-read field/scope behavior. Source adapter tests exercise exact source profile reads without a live CRM connection; source SQL tests exercise authorization and exact role matching.

Local checks do not establish live provider shape, live data acceptance, UI acceptance or an end-to-end recruiting outcome. No live acceptance is claimed. The source query returns all stored history JSON without interpreting or ranking it. Work requiring new education storage, an interview table, periodic automation, or new provider event ingestion remains outside this delivery.


Historical pre-integration results (superseded by the final 357/357 combined tests and API/web typechecks in the main delivery record):

- `VERIFY_DATABASE=1 DATABASE_URL='<isolated-local-test-url>' pnpm exec vitest run apps/api/src/recruiting-crm-sync.postgres.test.ts`: 14 tests passed on native localhost PostgreSQL 17.
- `pnpm exec tsc --noEmit -p apps/api`: passed.
- Running the PostgreSQL suite plus `apps/api/src/recruiting.test.ts`: 271 passed, 5 failed. The five match the recorded baseline: three saved-correspondence receipt fixtures and two live-CRM authorization-count/actor-boundary fixtures. These five failures were subsequently fixed; the final integration passed, as recorded in the main delivery document.
- `pnpm exec biome check` on changed TypeScript files and `git diff --check`: passed.

A Docker-local synthetic database was briefly used before the inherited no-Docker restriction was relayed. Its six original tests passed; the owned container was then stopped and its data preserved. All expanded fourteen-test evidence above is from the native PostgreSQL instance, not Docker. No production access occurred.
