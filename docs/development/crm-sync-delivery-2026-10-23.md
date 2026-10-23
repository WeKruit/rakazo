# CRM sync development delivery

This is development evidence, not live acceptance. No live CRM read/sync, production migration, deployment or outbound operation was performed by this workstream.

## Scope and dependencies

Starts from PR #72 head `461c496472edd53b1445ee47b2097134230cdba7`, merged with repository main `a5003a28`. Root integration records the final delivery/merge SHA. The CRM source changes are in the separate `WeKruit/headhunter-agent` delivery and must precede product sync. Do not run sync against an older source deployment: exact-ID presence checks and stored-profile reads are required.

Ordered product migrations across the coordinated delivery:

1. `20261023153000_recruiting_role_playbook_stage` (already merged #65).
2. `20261023160000_recruiting_crm_sync` (#72 projection tables).
3. `20261023170000_recruiting_candidate_notes` and `20261023171000_recruiting_candidate_shortlisted_at` (#74, when integrated).
4. `20261023172000_recruiting_crm_sync_progress` (opaque progress tokens and contact profile JSON).

The separate CRM source migration is `20261023180000_crm_candidate_presence`; its authenticated read function reproduces the CRM's role-label matching and explicitly rejects unauthorized organizations. The existing MCP edge adapter exposes it through `list_crm_candidates` with `p_view: "presence"`. There is no new MCP server, dependency, credential, or cloud resource.

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

`recruiting.crmData` reads remain the authorized source boundary. Projection queries are owner/space/connection/organization/role scoped and exclude archived contacts, roles and links. Integration adds the projection consumer with the existing candidate-tool permission and connection-revision checks; there is no offline/live fallback and no offline availability claim. Run the full sync before evaluating projected CRM rows.

## Correctness changes

Progress is stored server-side with random single-use tokens bound to the user, Space and thread. New starts supersede earlier tokens. Modified, replayed, cross-owner, cross-thread and mode-mismatched cursors fail before source reads or projection writes. No new signing secret is needed.

Full-sync slices and incremental writes share the same per-owner database transaction lock. Newer observations and archive timestamps cannot be overwritten or restored by delayed older reads. Contacts appearing only after the organization scan are stored before role links are created. JSON comparison ignores object key order so a rerun stays unchanged.

Offset traversal is not treated as proof of absence. All potentially missing IDs are revalidated through the authorized source, in batches of at most 50. No row in a unit is archived unless every presence batch succeeds. Failed or incomplete reads are reported under `skipped`; they do not authorize absence-based archives. Incremental reads never archive.

A dry run writes **no CRM source data and no projection rows**. It does write/rotate temporary server-owned progress metadata; completion removes that metadata. Abandoned progress is superseded by the next run. Tokens expire after 24 hours. Do not mix dry-run and real-run tokens or parallelize calls using the same token.

## Local-owner procedure (not executed here)

1. Preserve the deployment hold. Verify the active sourcing run has ended, outreach is stopped, and no active run would be interrupted. Record actual live source revision and migration ledger; historical handoff revisions are not current verification.
2. Review the root's final SHAs and local test evidence. Apply the source presence migration, then deploy only the existing MCP edge function using the existing owner process. Never prune functions, create resources, rotate secrets, or change permissions as a shortcut.
3. Apply the ordered product migrations before updating API/worker. Deploy only when the owner can lift the hold.
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


Commands and observed results before root integration:

- `VERIFY_DATABASE=1 DATABASE_URL='<isolated-local-test-url>' pnpm exec vitest run apps/api/src/recruiting-crm-sync.postgres.test.ts`: 14 tests passed on native localhost PostgreSQL 17.
- `pnpm exec tsc --noEmit -p apps/api`: passed.
- Running the PostgreSQL suite plus `apps/api/src/recruiting.test.ts`: 271 passed, 5 failed. The five match the recorded baseline: three saved-correspondence receipt fixtures and two live-CRM authorization-count/actor-boundary fixtures. Integration must record any subsequent fixes/results separately.
- `pnpm exec biome check` on changed TypeScript files and `git diff --check`: passed.

A Docker-local synthetic database was briefly used before the inherited no-Docker restriction was relayed. Its six original tests passed; the owned container was then stopped and its data preserved. All expanded fourteen-test evidence above is from the native PostgreSQL instance, not Docker. No production access occurred.
