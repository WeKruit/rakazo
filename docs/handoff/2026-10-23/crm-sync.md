# Handoff: CRM data sync into our format (rakazo)

You are taking over the "CRM data sync into our format" thread of the headhunter project. The person asked: copy our own CRM data (clients/roles, contacts, correspondence, which live in the headhunter-agent Supabase CRM) into the product's own format, idempotently and re-runnably, never deleting CRM rows, archiving instead of deleting.

## State (2026-10-23 ~15:58 UTC)

- Branch `claude/project-thread-q0vthw` in WeKruit/rakazo, draft PR WeKruit/rakazo#72 (https://github.com/WeKruit/rakazo/pull/72). Not merged, not deployed.
- Mapping doc (CRM field → product field, gaps): `docs/handoff/2026-10-23/crm-sync-mapping.md`.
- Design: no direct CRM DB access. Everything goes through the existing authorized CRM MCP reads (`getRecruitingCrmData` in `apps/api/src/recruiting.ts`), as the signed-in user.
  - Migration `packages/db/prisma/migrations/20261023160000_recruiting_crm_sync` (new tables only): `recruiting_crm_roles`, `recruiting_crm_contacts`, `recruiting_crm_role_contacts`, `recruiting_crm_messages`. Scoped by `userId + spaceId + mcpServerId + organizationId`, unique on the CRM ids. Core's migrations use ≤ 20261023153000; Juicebox thread was asked to use ≥ 20261023161000.
  - `packages/db/src/recruiting-crm-sync.ts`: keyed upserts with dry-run counts; archive-not-delete via `syncedAt < startedAt` after a complete pass.
  - `apps/api/src/recruiting-crm-sync.ts`: `syncRecruitingCrm` (rpc `recruiting.crmSync`, input = `groupId` or `botId` + `dryRun?` + `cursor?`). First call lists organizations and syncs each org's full role list; then pages contacts (org-wide), each role's links, each role's mail, ~40 s per call, returning `nextCursor` until null. Output = cumulative counts per kind (`seen/created/updated/unchanged/archived/restored`) + `skipped` failed reads (nothing archived for those).
  - Incremental: `getRecruitingRoleCandidates`' `crm()` source fire-and-forget calls `recordCrmRoleRead` to write the role read it already made (never fails the list).
  - `RecruitingCrmCandidatesReadSchema` / crmData candidates items gained optional `interest/reviewed/lastReplyAt/resumeReceived`.
- Tests: `apps/api/src/recruiting-crm-sync.postgres.test.ts` (6 cases: dry run = real counts, re-run unchanged, archive + restore, failed read leaves links, per-user isolation, stale cursor mode, incremental record). Run: start a local Postgres, `prisma migrate deploy`, then `DATABASE_URL=... VERIFY_DATABASE=1 npx vitest run apps/api/src/recruiting-crm-sync.postgres.test.ts` → 6 passed. `apps/api` tsc clean; api/contracts/web recruiting tests pass except pre-existing `memory-revisions.test.ts` (2, fails on main too) and a load-flaky `RecruitingPanel.test.tsx` case that passes alone.

## Next steps

1. Review the PR diff once, mark ready, merge (user rule: merge ourselves after local tests, no CI wait).
2. Ask the coordinator to have the release thread deploy main (migration before API) and then run the dry run, then the real sync, in the user's signed-in product tab (DevTools console), using a role conversation's group id (e.g. the test role group `cmvl1c44400081hfqbkb0xk2b`):

```js
async function crmSync(dryRun) {
  let cursor, out;
  do {
    const res = await fetch("/rpc/recruiting/crmSync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ json: { groupId: "cmvl1c44400081hfqbkb0xk2b", dryRun, ...(cursor ? { cursor } : {}) } }),
    });
    out = (await res.json()).json;
    if (!res.ok) throw new Error(JSON.stringify(out));
    cursor = out.nextCursor;
  } while (cursor);
  const { nextCursor, ...report } = out;
  return report;
}
await crmSync(true);   // dry run: counts only, writes nothing
await crmSync(false);  // real sync; re-running is safe
```

   If the space header is needed, add `"x-rakazo-space-id": "<spaceId>"`. Report counts (no names/emails) back. Verify with read-only SQL: `select count(*) from recruiting_crm_contacts;` etc.
3. Follow-ups (not done): (a) company/experience/education need a new read-only CRM MCP tool in headhunter-agent (RLS select of `candidate_sources` + `candidates.history`), plus adding it to Main's allowlist; (b) read the copy in `roleCandidates` / profile panel (phone, interest, last reply) — coordinate with the "Juicebox-level profile and dashboard" thread, which owns RecruitingPanel/DetailPanel; (c) an automatic periodic full sync (e.g. on app open, rate-limited).

## Constraints

Never print or commit secrets; no new cloud resources/Secrets; never `--prune` on Supabase function deploys; don't change other edge functions; no outbound email; Dyna roles are read-only (real candidates). Public repo: no personal data in commits/PRs. Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; PR bodies start with the project attribution block and end with the Claude Code line.
