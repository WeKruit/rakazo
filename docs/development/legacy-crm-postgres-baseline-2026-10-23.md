# PostgreSQL baseline comparison

An independent comparison on 2026-10-23 used separate fresh native PostgreSQL databases, separate worktrees and separately generated Prisma clients. No Docker or production connection was used.

- Baseline: `94a706a089710cea083192a126ab77a8f577e91c`.
- Current development comparison: `d39d3a13ef25ba0225485a58acf67823a3680f03`, plus this commit's projection test expectation correction.
- Each database received its own revision's complete migration set successfully.

Commands (with `DATABASE_URL` set separately to each isolated synthetic database):

```sh
pnpm --filter @rakazo/db generate
pnpm --filter @rakazo/db migrate
VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts
```

The current run additionally included `apps/api/src/recruiting-crm-sync.postgres.test.ts`.

Results:

| Run | Result |
| --- | --- |
| Baseline recruiting domain | 267 passed, 12 failed; additional suite teardown foreign-key failure |
| Current recruiting domain plus CRM sync | 285 passed, 12 failed; clean teardown |
| Current CRM sync suite within that run | All 18 passed |
| Final corrected projection test, including known-empty assertion | 1 passed, 17 intentionally unselected |

The 12 failing recruiting domain test names are identical between baseline and current. There are no current-only failing domain test names in this comparison. The baseline additionally fails its organization cleanup with `recruiting_crm_imports_bindingEffectId_fkey`; the already-integrated fixture cleanup ordering fixes that teardown failure.

Reproduced baseline failures in `packages/db/src/recruiting.postgres.test.ts`:

1. `atomically recovers native role create after commit ACK loss without overriding newer human state` — receives isolation failure before the expected lost-acknowledgment error.
2. `atomically recovers native role revise after commit ACK loss without overriding newer human state` — criterion source reference array fails its minimum-length validation.
3. `rejects native role identity, request and lease mismatches and revalidates completed source ACL` — criterion source reference validation.
4. `verifies native human authorship and current source atomically for role tools` — criterion source reference validation.
5. `uses the actual native choice answer after the original run resumes` — criterion source reference validation.
6. `uses the actual native custom answer after the original run resumes` — criterion source reference validation.
7. `recovers an actually bound completed read from a cancelled run without rewinding current summaries` — recorded research read artifact isolation failure.
8. `prepares a corrected revision directly after superseding an unsent action (effect reserved: false)` — recruiting revision conflict at the approval gate.
9. `prepares a corrected revision directly after superseding an unsent action (effect reserved: true)` — same revision conflict.
10. `orders native ranks, tiers and scores across numeric, tie and unknown cursor boundaries with source proof` — expected candidate ordering differs.
11. `requires a feedback card after the tenth saved candidate advances the real stage` — guard returns ended rather than continued/feedback.
12. `filters saved native pages with overlapping identities without narrowing role counts` — source artifact isolation failure.

This comparison establishes pre-existence, not correctness, of those failures. No runtime changes or baseline assertion weakening were made to hide them. The broad PostgreSQL domain suite must not be described as passing.

The changed CRM projection test now explicitly distinguishes missing owner/organization scope (`null`, unknown coverage) from an existing synchronized role with no active contacts (`[]`, known empty). The earlier empty-array expectation for unknown scope was stale after the deliberate API coverage change. Production behavior is unchanged by this test correction.
