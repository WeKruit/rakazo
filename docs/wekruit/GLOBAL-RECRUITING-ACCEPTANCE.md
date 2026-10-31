# Global recruiting acceptance

PR #597 replaces CRM-only correspondence gates with shared role/account reads. The web account pages and `recruiting_candidates` cross-role operations use `readRecruitingAccountView` in adapters. Existing per-role candidate detail remains available. The duplicate Recruiting workflow navigation item is removed.

## Scope and sources

- All reads use the authenticated user and Space. Archived role conversations are excluded. Explicit foreign role/group filters fail before data reads.
- Sequence reads each authorized role campaign, actual provider analytics and leads, plus saved candidate emails. Leads and candidate pools remain paginated; missing provider data is not zero.
- Inbox reads role campaign mail and authorized CRM correspondence. The page and chat count received messages; chat distinguishes message count from distinct senders and reports completeness.
- Interview reads scheduling plans/bookings and the existing connected calendar through native connector assignments. Calendar reads use a short permission-fenced cache. Contact association is distinct from booking proof. The global calendar deduplicates provider event identities and names associated roles.
- Main is a native account conversation using the existing crew. First admitted sessions provision it through the native bootstrap; release startup backfills private accounts without waiting for app open. Existing user changes and archived conversations remain preserved. Main stays unlinked to a role; role work opens that role's existing crew.
- Routines reuse the native editor/list/history/API and existing persisted thread target. Tasks use recruiting reminders. Mobile adds global Main, Interview agenda and Sequence lists; Electron uses web.

## Runnable checks

```sh
pnpm exec vitest run packages/adapters/src/recruiting-account.test.ts packages/adapters/src/recruiting-live-correspondence.test.ts packages/adapters/src/recruiting-assessment.test.ts packages/db/src/recruiting-bootstrap.test.ts packages/db/src/recruiting-global-conversation.test.ts packages/auth/src/identity-trust.test.ts apps/api/src/recruiting-routine-target.test.ts
pnpm --filter @rakazo/web exec playwright test --config playwright.recruiting.config.ts
pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=recruiting-global-journey.spec.ts
node --test infra/acceptance/global-recruiting.test.mjs
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

Provision these test copies through the normal product path in the isolated account before release. The account must contain only test-copy roles, each in a conversation prefixed `测试副本 · `. The post-deploy case reads every account/filtered view, checks actual records and both role kinds, then uses the existing restorable archive flow for the selected copies. It performs no paid search, send, booking or approval. Missing fixtures fail before deployment. A failed readback fails release acceptance.

## Routine/task UI audit

Ordinary recruiters can create/edit/pause/resume/run routines and view native run history. All-role routine reads include owned active group conversations across distinct Main bots. The editor preserves each routine's actual bot and thread target.

Existing message-trigger provider choices are not populated in the new recruiting entry. Global Tasks lists reminders and marks them done; reminder creation/editing remains in existing chat/profile controls. Native mobile routine management remains its existing bot-oriented surface; the new mobile scope is Main, Interview and Sequence. These limits do not introduce another scheduler or infer an external action.

Live calendar/OAuth, real campaigns, native mobile-device behavior and production backfill must be reported separately from deterministic checks. Do not call them tested from an offline fixture.

## Follow-up UI checks

Contacts hides the visible outer and table scrollbar tracks while preserving scrolling. The CRM/product page checks assert the scoped scrollbar CSS and retain profile keyboard interactions. The real-server journey exercises both the native Send button and Enter, and waits for persisted assistant answers. Main includes the separately owned Workloop read-intent approval fix from PR #608. Production Send/Enter behavior has not been tested with a live isolated account.

Local verification on the PR branch: 19 focused suites / 1,589 tests passed; the additional role-cursor regression and translation checks passed (37 tests); actual-app desktop/mobile screenshot checks passed (11); fresh-account real-server journey passed (1); release/selected-copy archive checks passed (16). Web, API, adapters and direct mobile TypeScript checks passed. The mobile wrapper still reports existing Expo dependency-version recommendations. Production remains not tested.
