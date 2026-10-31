# Global recruiting acceptance

PR #597 replaces CRM-only correspondence gates with shared role/account reads. The web account pages and `recruiting_candidates` cross-role operations use `readRecruitingAccountView` in adapters. Existing per-role candidate detail remains available. The duplicate Recruiting workflow navigation item is removed.

## Scope and sources

- All reads use the authenticated user and Space. Archived role conversations are excluded. Explicit foreign role/group filters fail before data reads.
- Sequence reads each authorized role campaign, actual provider analytics and leads, plus saved candidate emails. Leads and candidate pools remain paginated; missing provider data is not zero.
- Inbox reads role campaign mail and authorized CRM correspondence. The page and chat count received messages; chat distinguishes message count from distinct senders and reports completeness.
- Interview reads scheduling plans/bookings and the existing connected calendar through native connector assignments. Calendar reads use a short permission-fenced cache. Contact association is distinct from booking proof. The global calendar deduplicates provider event identities and names associated roles.
- Main is a native account conversation using the existing crew. First admitted sessions provision it through the native bootstrap; release startup backfills private accounts without waiting for app open. Existing user changes and archived conversations remain preserved. Main stays unlinked to a role; role work opens that role's existing crew.
- Routines use one paginated account read with canonical role IDs, reusing the native list query/DTO and editor/list/history/API with the persisted thread target. Tasks use recruiting reminders. Mobile adds global Main, Interview agenda and Sequence lists; Electron uses web.

## Runnable checks

```sh
pnpm exec vitest run packages/adapters/src/recruiting-account.test.ts packages/adapters/src/recruiting-live-correspondence.test.ts packages/adapters/src/recruiting-assessment.test.ts packages/db/src/recruiting-bootstrap.test.ts packages/db/src/recruiting-global-conversation.test.ts packages/auth/src/identity-trust.test.ts apps/api/src/recruiting-routine-target.test.ts
pnpm --filter @rakazo/web exec playwright test --config playwright.recruiting.config.ts
pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=recruiting-global-journey.spec.ts
node --test infra/acceptance/global-recruiting.test.mjs infra/acceptance/global-recruiting-chat.test.mjs
```

The dedicated journey starts a fresh local database and account, enters job descriptions through ordinary recruiting input, persists synthetic provider receipts, opens all global/filtered views and asks Main cross-role questions through native tools. It never answers approval cards or calls paid providers. It is an implementation proof, not live-provider acceptance. The configured CI Global recruiting workflow retains desktop/mobile screenshots and both HTML reports. Repository workflow dispatch currently returns HTTP 422 “Actions has been disabled for this repository”, so no CI screenshot artifact is available yet. Local reports are implementation evidence only.

## Post-deploy readback

The `release-cloud.sh` flow requires existing isolated test-account sign-in and a private JSON fixture file supplied with `RAKAZO_GLOBAL_FIXTURES` (or `RELEASE_REGRESSION_CASES/global-recruiting.json`). No fixture credentials or real records belong in the repository.

```json
{
  "isolatedTestAccount": true,
  "roles": [
    {"roleId": "product-test-copy", "shortlist": 1, "contacts": 1, "replies": 1, "interviews": 1},
    {"roleId": "crm-test-copy", "shortlist": 1, "contacts": 1, "replies": 1, "interviews": 1}
  ]
}
```

Provision these test copies through the normal product path in the isolated account before release. The account must contain only test-copy roles, each in a conversation prefixed `测试副本 · `. The post-deploy case reads every account/filtered view, checks actual records and both role kinds, then uses the existing restorable archive flow for the selected copies. It performs no paid search, send, booking or approval. Missing fixtures fail before deployment. A failed readback fails release acceptance. Routines are included in global/filtered readback and must retain the exact role thread target.

Native model chat is a separate opt-in because new paid calls require approval. Only after explicit cost authorization, pass `--global-chat` to `infra/acceptance/regression.mjs --only global-recruiting --global-fixtures <private-file>`. It duplicates the existing native account Main, asks three read questions, verifies successful tool receipts plus persisted answers against authoritative counts, and archives only that Main copy; the existing finally flow archives the selected role copies. Without this flag, the report explicitly marks native chat **not tested**. No release run automatically authorizes model calls.

## Routine/task UI audit

Ordinary recruiters can create/edit/pause/resume/run routines and view native run history. All-role routine reads include owned active group conversations across distinct Main bots. The editor preserves each routine's actual bot and thread target.

Existing message-trigger provider choices are not populated in the new recruiting entry. Global Tasks lists open reminders and removes them after marking them done; reminder creation/editing remains in existing chat/profile controls. Native mobile routine management remains its existing bot-oriented surface; the new mobile scope is Main, Interview and Sequence. These limits do not introduce another scheduler or infer an external action.

Live calendar/OAuth, real campaigns, native mobile-device behavior and production backfill must be reported separately from deterministic checks. Do not call them tested from an offline fixture.

## Follow-up UI checks

Contacts hides the visible outer and table scrollbar tracks while preserving scrolling. The CRM/product page checks assert the scoped scrollbar CSS and retain profile keyboard interactions. The real-server journey exercises both the native Send button and Enter, and waits for persisted assistant answers. Main includes the separately owned Workloop read-intent approval fix from PR #608. Production Send/Enter behavior has not been tested with a live isolated account.

Current revision verification: backend 7 suites / 505 tests passed; focused web/mobile tests passed; release/native-chat/exact-archive validators 35/35 passed; actual-app desktop/mobile route checks 11/11 passed; fresh-account real-server journey 1/1 passed. The journey asserts actual counts, Sequence saved emails, calendar/mail provider calls, all nine global/filtered pages and persisted read-tool answers, with zero approval-card submissions. API, adapters, DB, web, mobile and testkit TypeScript checks passed. Biome and diff checks passed (the standalone release runner retains existing Turbo environment warnings). The offline MCP mail fixture now returns mail records rather than calendar-shaped data, so complete-source reply counts are proved. Production remains **not tested**.

## Current release blockers

The release owner reported that there is no isolated test account or separate product/CRM test-copy fixture with an active booking/calendar record. Existing historic test conversations are not sufficient. Production feature acceptance is **not tested**; do not manufacture provider receipts or send/book to make the readback pass. GitHub Actions remains disabled by user preference, so CI screenshot links remain unavailable.
