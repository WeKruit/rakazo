# Saved Sequence pages

## Change and scope

Global Sequence uses the existing `recruiting.accountView` read with `view: "sequence"` and `sequenceSummary: true`. A single saved-record query returns at most 25 campaign rows for the UI, the matching row count, a forward cursor, the existing owned role selector metadata, and saved summary counts. Next/Previous fetch only the requested page. Name, role, status, contact membership, and sort filters apply on the server before the page limit. The UI no longer exhausts role cursors or waits for per-role workspace reads.

No provider request, lookup, campaign write, send, migration, new table, or index runs on the global page-read path. Existing role-detail reads and campaign actions keep their current authorization and approval paths.

## Provenance and honest limits

- Native campaign identity comes from the latest completed `instantly_role_campaign` receipt for an owned active role and enabled owned source. The owning run and bot must belong to the same user and space, and the run must belong to the exact role conversation.
- Saved campaign/analytics observations must match that source, its current revision, the campaign ID and the owned role conversation. Both direct and bound catalog request shapes are understood. Native draft read/create/update/clone outputs use their retained exact role and returned campaign identity. Latest valid stored observations win; foreign and obsolete source receipts do not supply metrics.
- CRM rows use the existing exact workspace attachment or native binding, enabled source/revision, organization and CRM role. Lead counts describe the owner-scoped stored mirror. Native membership totals describe retained lead mappings. They are saved observations, not a claim that all provider leads were read.
- Opened/replied/sent native metrics use the existing explicit cumulative analytics fields. Missing values remain null. Zero stays zero. Shared campaign summary identities include source and CRM organization so unrelated sources or organizations are not collapsed.
- Global summaries are all-time saved observations. Receipt observation time is never treated as a send timestamp. The unsupported recent-period selector is removed. No saved metrics produces one clear overview empty state; missing timestamp history produces text instead of an empty calendar chart. Privacy, click counts, unknown campaign state and absent send history are not inferred.
- Campaign rows preserve role-specific destinations. The matching row total counts the role/campaign rows displayed by this list; summary totals count a shared source campaign once. Saved counts do not promise current live provider state.

## Verified UI changes and asynchronous observations

The existing Sequence RPC returns the verified provider response immediately. Native agent reads and edits reuse the same tracked deferred writer as UI actions, without double-enqueuing when the UI already owns the callback. Native campaign, analytics and role-draft results retain the actual GET start time; saved-page ordering uses that time, so a slow older tool completion cannot replace a newer verified pause. Native read/pause verification captures the actual verification GET start; after a mutation this is after the mutation completed, rather than the earlier button/request time. The existing create/save/clone completed-effect write also retains its verified readback without another database roundtrip.

Derived display observations use the existing association/effect JSON. The API tracks deferred writes and drains them before database shutdown; failures are logged without source payloads. The write rechecks user, space membership, exact owned role/thread, assignment, source revision and observation time. Older reads and older source epochs cannot overwrite a newer observation. The same CAS projects the verified campaign name into existing owned source/campaign associations, so existing search and native selector readers converge too. Private observation metadata is removed from native tool output.

This cache is not canonical provider state. A hard kill may lose a derived cache update, never the already-accepted provider action. No stronger durability is claimed. Display cache keys retain actor/space/thread/role/source/campaign, and monotonic source revision plus provider observation time prevents a slow older response replacing a verified pause.

For delayed projection, the existing page request can carry at most 50 exact observation identity/time keys, never editable facts or action authority. The same owned SQL corpus acknowledges them before filters. While a filtered membership is still unknown, the UI retains verified changes, avoids showing a paused row under Active, avoids a false empty renamed search, and withholds exact totals, overview and pagination. The existing bounded transient-read retry refreshes the same server page; it adds no provider request. A PostgreSQL two-connection test holds a newer source/cache transaction while an old-epoch query takes its snapshot, then verifies that the old update cannot overwrite the committed new epoch.

## Runnable checks

From the repository root with dependencies installed and the Prisma client generated:

```sh
pnpm exec vitest run packages/adapters/src/recruiting-account-sequences.test.ts apps/web/src/pages/recruiting/AccountSequences.test.tsx apps/web/src/pages/recruiting/AccountRecruitingView.test.tsx packages/adapters/src/recruiting-account.test.ts
SEQUENCE_TEST_DATABASE_URL='<isolated-local-postgres-url>' pnpm exec vitest run packages/db/src/recruiting-sequences.postgres.test.ts
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/adapters check
pnpm --filter @rakazo/db check
cd apps/web
WEB_PORT=5207 pnpm exec playwright test --config playwright.config.ts e2e/recruiting-account-sequences.spec.ts --workers 1
```

The PostgreSQL check creates transaction-local shadow tables, exercises 60 roles and 61 campaign rows, verifies pages of 25/25/11 with exact totals, checks native 4 sent / 3 opened / 1 replied observations, CRM counts, latest corrections, absent metrics, contact membership removal, actor/space/role/source revision isolation, filters, sorting and source revocation. A separate two-connection race uses an isolated ephemeral schema. Neither check reads product records.

Browser tests open the actual app route with isolated synthetic transport fixtures at 1440, 390 and 320 pixels. Additional desktop/390 cases deliberately hold the second response: the first 25 rows and total 61 must already render after one request, and the second request starts only after Next. These implementation checks do not claim live staging acceptance.

Browser screenshot artifacts are emitted by the existing test runner as `global-sequences-*.png`, `global-sequences-table-*.png` and `saved-sequences-page-*.png`.
