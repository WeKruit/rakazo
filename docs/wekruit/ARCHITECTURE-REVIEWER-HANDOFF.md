# Reviewer handoff — this execution batch

Scope is frozen per the user's latest instruction: review the work actually delivered by this session, not take over the entire architecture plan. No further A2 table batch or D1 framework/prototype work is included. All listed PRs target `claude/project-thread-f1cbzk` (#263), never `main`. This document distinguishes local implementation evidence from release-owner acceptance.

## Start here

- Review security-sensitive A2 #296/#337 together with the closing cross-Space regression fix #343; C5 #303/#309/#334; durable OAuth #274; public serving #265.
- Review frontend changes as a sequence: decomposition #298, server-state reads #301, virtualization #276/#300, then D1 boundaries/catalogs #295/#302/#304/#307/#308/#330/#331/#338. The final actual contacts result is **321,748 gzip B**, not 250 KB. No Mini or Preact replacement is delivered.
- Review F1 #269/#339 for business-rule removal without removing security/consent/receipt boundaries.
- **Our ownership:** only the explicitly listed PRs and their changes. Other sessions' code in #263, including Claude-owned A5/F2 and pre-existing A1/B1/B2/C1/C2/E1–E4 work, is not claimed as implemented or independently certified by this session. Integration SHAs contain others' work; review each PR's own diff for attribution.
- Tests below are revision-specific historical evidence, not one single all-green invocation on the final tree. Final combined-source checks and the closing #343 checks are distinguished below. Skips and unexercised paths remain unverified.

## Frozen review boundary and remaining limits

Frozen product integration: `f4bf54bd7ce2bb926dade664ddeda0fad69465c9` (closing fix #343). #341 documentation merged at `3f0f9b0186b290702a653e95528f07e7cd445ff8`. This handoff publication adds documentation only; no further product work is included.

Closing #343 passed independent six-file security review. Before: actual `spaces/create` HTTP 500 / PostgreSQL 42501. After: real RPC success with copied model/voice choices, notification defaults and ignored forged authority fields. PostgreSQL 23/23 (912 ms); router 221/221 (4.28 s); DB/API/testkit checks passed. API fixture: 144 OK, 98 separately unexercised, zero leaks/warnings, 4.067 s excluding setup. Commands: `RLS_TEST_DATABASE_URL='<dedicated-local-synthetic-db>' pnpm exec vitest run packages/db/src/actor-db.postgres.test.ts --maxWorkers=1 --no-file-parallelism`; `pnpm exec vitest run apps/api/src/router.test.ts --maxWorkers=1 --no-file-parallelism`; `pnpm --filter @rakazo/db --filter @rakazo/api --filter @rakazo/testkit check`. Fixture setup/command is in [the acceptance ledger](ARCHITECTURE-LOCAL-ACCEPTANCE.md#final-bounded-a2f1d1-integration); its maintained fixture now includes the new RPC.

Earlier combined-source `cc867dff3f834a4b5877590a1b51a91dcd47a685` passed all 11 package checks (`EXPO_OFFLINE=1`), PostgreSQL 22/22, and API fixture 144 OK + 98 unexercised in 2.116 s. The closing fix had the affected-package checks above, not a new rerun of every historical suite. Unpublished model/voice policy followup is paused and excluded; its local patch is preserved for the maintainer.

- A2 remains opt-in and partial (33 actor tables plus six system-only metadata tables); remaining policies are a future scope, not silently completed. Latency matched pairs sometimes exceed 10%; actual 6543 pooler compatibility and production grants are untested.
- D1 misses 250,000 B by 71,748 B. The design document records options only; no new architecture experiment is authorized by this handoff.
- A4 is evidence-only: four existing foreign-key update-action differences need correct-database metadata and intended semantics; no cascade behavior was changed.
- No production deployment, main merge, CI activation, cloud configuration/Secret/resource changes, real recruiting-data test, provider send or external communication occurred. Runtime deployment prerequisites are in [release preflight](ARCHITECTURE-RELEASE-PREFLIGHT.md); C5 storage cutover and actual remote continuity remain release-owner actions.
- [Exact integration commands and revision-specific evidence](ARCHITECTURE-LOCAL-ACCEPTANCE.md), [workplan](ARCHITECTURE-WORKPLAN.md), [historical handoff](ARCHITECTURE-HANDOFF.md). Linked evidence is part of this handoff; do not substitute a unit count for a browser request count.

## PR manifest

Each head and merge SHA is a full immutable revision from GitHub. PR descriptions below preserve their measured checkpoint; later followups supersede historical pending notes. Documentation-only PRs add no runtime behavior.

| PR | Kind | Head | Merge / status |
|---|---|---|---|
| [#265](https://github.com/WeKruit/rakazo/pull/265) | implementation | `0c077818e3436b876664102264efdabd5dbf9855` | `a95b8d944aed3f31a9d9745d3e5ce7c24b91e283` |
| [#267](https://github.com/WeKruit/rakazo/pull/267) | evidence/docs | `8edd799b769c09b5cb0126435e5624dc791aec5a` | `b314a52da2103fb923f7475bbf81995a5df00c0d` |
| [#268](https://github.com/WeKruit/rakazo/pull/268) | evidence/docs | `3f7b49d3cf553acfff52077d77d7096682e1aeca` | `cf48da330aada754a9e218ce40b0ca0ca051aaab` |
| [#270](https://github.com/WeKruit/rakazo/pull/270) | evidence/docs | `a72fa4deb4abc85226eaa99287c3c722f3220e6a` | `72a736fd61f0f762a4b1a02479569df5ea8298a4` |
| [#272](https://github.com/WeKruit/rakazo/pull/272) | implementation | `e6957b1bacf76764b3852bb9c1c147623914e687` | `074a24b0f08f6440c33e830a6c616677f0e24f39` |
| [#269](https://github.com/WeKruit/rakazo/pull/269) | implementation | `84a1572086a2a488a8e0946b01ec4dc63490020e` | `168fcaacc088e063b8cd2d0dc3b52b414f7eb88a` |
| [#277](https://github.com/WeKruit/rakazo/pull/277) | implementation | `4bd0da4262ba641a0fdbc2450f4c65db10d13559` | `299af876fea9d2577798c643bab0f404c35bdebc` |
| [#276](https://github.com/WeKruit/rakazo/pull/276) | implementation | `c4b7833906ced7d99aa1c29c8b96a599e3c53200` | `8188c88f3c58299030b8dbfb2ea128144c2a8755` |
| [#297](https://github.com/WeKruit/rakazo/pull/297) | evidence/docs | `e19585f1aada73156329733c2290a55497a4dc4d` | `a2204021c9fa5c81c92f342ade4ab0b3697cbd6f` |
| [#295](https://github.com/WeKruit/rakazo/pull/295) | implementation | `d852c664ef7d0132c8659e259269b20b031fa9b1` | `8016114c08dc7a10f76b460d8bb9740e77a009c0` |
| [#296](https://github.com/WeKruit/rakazo/pull/296) | implementation | `1c20a8f4fe2de44b1c1b3d2c1b2bf3efac6e4de9` | `791070e2bf39ca1d0ba1448059d6da63cbb6acc5` |
| [#274](https://github.com/WeKruit/rakazo/pull/274) | implementation | `998cca78a27c7dc839792b79392564b77baeb5c4` | `3c7a539d5f64ef9316b76a766cd4bf1e443532d5` |
| [#298](https://github.com/WeKruit/rakazo/pull/298) | implementation | `7937aab724f5b1f047502d974d688d632452783c` | `916401f65a3e30df70fb8756ee6082d6eb59926f` |
| [#301](https://github.com/WeKruit/rakazo/pull/301) | implementation | `48b91df0183108887b9b7a760ac29d685d8cd92a` | `b6b92f9cf38789231fbf97f483b505738cbccbb4` |
| [#300](https://github.com/WeKruit/rakazo/pull/300) | implementation | `b2e6c36cb08cd57afd8d7014b6cfdacb46abe18d` | `85a3bb1ba425358ebf03a3bcafd7fdc8cb12d527` |
| [#302](https://github.com/WeKruit/rakazo/pull/302) | implementation | `4aaa64941c93ab05a172e95d9423a9952672ac8f` | `d4fae3df17e08f1d80be64aa98582c036281e531` |
| [#303](https://github.com/WeKruit/rakazo/pull/303) | implementation | `ef937b42a99298287262a1c04695c47d55710d19` | `afdf729217a5ceecbf34a06d990a7578335209a3` |
| [#304](https://github.com/WeKruit/rakazo/pull/304) | implementation | `47ffa5554f068ebd19b0bc64f1a3bb13137b2e25` | `f0752e53987a0b0b4cbb17d6f9f70202421b7a5f` |
| [#305](https://github.com/WeKruit/rakazo/pull/305) | evidence/docs | `34acd2a5c9914f80c97bd8ddb8521f7985bbf0b0` | `743df6e1bc97127bf23d6d65f6c259ac69587a4c` |
| [#307](https://github.com/WeKruit/rakazo/pull/307) | implementation | `37a1ba5a9a425b51ce8ce632910770975363f615` | `c1a188f75b83d0e43d3348b4b756389634e23063` |
| [#308](https://github.com/WeKruit/rakazo/pull/308) | implementation | `643abfca2db84b4ab72dce3e51a9599a754f38e3` | `f2ed4a16779b49dbecc6839b9ab080873ac4631e` |
| [#309](https://github.com/WeKruit/rakazo/pull/309) | implementation | `fb0c8c233c27c29cded3b9d67bc6226e1ac08001` | `87697d06d3590c6ed99e2d4bffea6f7daea45bd4` |
| [#329](https://github.com/WeKruit/rakazo/pull/329) | evidence/docs | `244d724b90d7bbd7ca18d6cbed16689cef4238d4` | `4ec4a2cc3b9358653e8cefae6cb6da30bc3d5d84` |
| [#330](https://github.com/WeKruit/rakazo/pull/330) | implementation | `59568cde957e2df113ab75d0f555e695ed8b464e` | `60ccba9a666e9080c948f68aaaa35b4e0c405d4a` |
| [#331](https://github.com/WeKruit/rakazo/pull/331) | implementation | `239a32759bb742a714ef8f75756747cc8e1b3637` | `a9e2312c7fe2b0af0b6839fa7ccfdbcbd4f8ba7e` |
| [#332](https://github.com/WeKruit/rakazo/pull/332) | evidence/docs | `429703fb7ddc48ace478628efd85fa7fa49b7786` | `6aed06538256eecea02f50126966508db6bd5479` |
| [#334](https://github.com/WeKruit/rakazo/pull/334) | implementation | `a36011948890ca48a1aafb370d3d325aafd8d84e` | `fd5cb90f57dba9e16831c09ebc550ab25b7cbf0f` |
| [#335](https://github.com/WeKruit/rakazo/pull/335) | evidence/docs | `96536af3b375f41c340cf5baa8c9e11f6d3b5e09` | `ba744c11842a55905fd1c8301269774b73f325f8` |
| [#336](https://github.com/WeKruit/rakazo/pull/336) | evidence/docs | `a06151c2019e2a4f6346a7436c3679a4e0e381c7` | `ab37680a41aed24436a759c69efd41f6a26ba41d` |
| [#337](https://github.com/WeKruit/rakazo/pull/337) | implementation | `14173576ecf3218e30d9122294a685855d5b8252` | `5ac5c4892b48f79f53203a78fa56fc7829f39692` |
| [#339](https://github.com/WeKruit/rakazo/pull/339) | implementation | `ca82a5420666bead27f64d907b0aebbbbec0a2cd` | `265b5b38d66cb6d57747a4cd5636f858a04bcb31` |
| [#338](https://github.com/WeKruit/rakazo/pull/338) | implementation | `a6224fbc0a8de98ffbc7a4ca03a14f077efe83af` | `cc867dff3f834a4b5877590a1b51a91dcd47a685` |
| [#340](https://github.com/WeKruit/rakazo/pull/340) | evidence/docs | `08d56816e2377c8b16cf7f1ef2b90465cc5bed13` | `61b568a12a80dc69dccaa2330702107a574fcde7` |
| [#341](https://github.com/WeKruit/rakazo/pull/341) | evidence/docs | `b45b7078324291d4439c335ae006144445ee0ab1` | `3f0f9b0186b290702a653e95528f07e7cd445ff8` |
| [#343](https://github.com/WeKruit/rakazo/pull/343) | implementation | `c256a1a09c67fed8c67718f57e888ef8a6c3062c` | `f4bf54bd7ce2bb926dade664ddeda0fad69465c9` |

## Per-PR changes, rationale and validation

### [#265: C6: serve production Modal web traffic from the API process](https://github.com/WeKruit/rakazo/pull/265)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c6-web-serving`; head: `0c077818e3436b876664102264efdabd5dbf9855`. Status at capture: merged.

**Reviewer focus:** Review public/private listener separation, Host/path/symlink containment and capability revocation for HTTP/WebSocket proxy.

**Code/evidence entry points:** `apps/api/src/index.ts`, `apps/api/src/public-web.test.ts`, `apps/api/src/public-web.ts`, `apps/web/e2e/screen-proxy-isolation.spec.ts`, `apps/web/scripts/benchmark-public-web.ts`, `apps/web/src/novnc-html.test.ts`, `apps/web/src/novnc-html.ts`, `apps/web/src/screen-proxy.test.ts`, `apps/web/src/screen-proxy.ts`, `apps/web/vite.config.ts`, `infra/modal/README.md`, `infra/modal/app.py`, `packages/core/package.json`, `packages/core/src/node/novnc-html.test.ts`. The PR diff has 19 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why

Architecture work-plan C6: the Modal production entrypoint currently runs Vite preview for static files and the screen proxy. The API now owns the public web listener, so the runtime starts only API and worker Node processes.

#### Changes

- Serve the built web app with compression, SPA navigation fallback, Host validation, path/symlink containment, and explicit public API/RPC/readiness routes. Internal routes remain on the loopback listener.
- Move the existing HTTP/WebSocket screen proxy into a shared Node module; preserve capability checks, periodic revocation, header isolation, bounded HTML handling and retries. Development and preview reuse it.
- Close both listeners during API shutdown. Configure the static directory in the Modal entrypoint and remove its Vite runtime command.
- Add public-listener security tests, extend browser isolation tests to the production listener, and add a reproducible local TTFB benchmark. No new user-facing copy.

#### Local validation

Node 24.19.0, pnpm 9.15.0. Repository typecheck scripts are named `check` (there is no `typecheck` script).

- `pnpm --filter @rakazo/api --filter @rakazo/core --filter @rakazo/web check`: all pass.
- `pnpm --filter @rakazo/api --filter @rakazo/core test`: API 1,321 passed / 50 skipped; core 1,231 passed / 5 skipped.
- `pnpm --filter @rakazo/web test`: 1,649 passed.
- `pnpm --filter @rakazo/web exec playwright test -c playwright.screen-proxy.config.ts`: 12 passed, covering direct navigation, iframe isolation, HTTP/assets, WebSockets and revocation across three server modes.
- `RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build`: passes.
- `node scripts/bundle-server.mjs api`: passes.
- `RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec tsx scripts/benchmark-public-web.ts`: 20 warmups then 200 homepage requests per implementation, concurrency 20, gzip and keepalive. Before p50/p95/max 3.17/5.26/6.77 ms; after 4.07/7.49/9.89 ms; both zero errors. The replacement meets the local p95 <200 ms threshold; it is not a latency improvement claim.
- Biome on all changed TypeScript/JSON files and `git diff --check`: pass. Python AST inspection confirms Modal launches two Node services and zero Vite runtime commands.

#### Scope and untested limits

No deployment, cloud configuration, secret, resource, CI, or database-pool changes. The public listener shares the existing API process and pool; no additional database client is created. This change targets WeKruit's Modal deployment; other Compose/desktop preview entrypoints remain unchanged. Production-region TTFB, actual Modal image execution, live provider screens/TLS, and process shutdown with active production traffic are not tested. Browser tests use fake local services only. Existing skipped tests remain unverified. CI stays intentionally disabled. This PR targets the integration branch for #263, never main.

### [#267: C6: measure actual page requests and JavaScript load](https://github.com/WeKruit/rakazo/pull/267)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c6-evidence`; head: `8edd799b769c09b5cb0126435e5624dc791aec5a`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `apps/web/scripts/measure-public-page.ts`. The PR diff has 2 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Follow-up to #265 for architecture C6. Add a reproducible browser measurement using the same production build, fresh contexts, identical mocked local API responses, and blocked external resources. Actual first-party startup requests are 23 → 23; JavaScript requests 16 → 16; loaded raw JS bytes 2,060,246 → 2,060,246 and summed per-file gzip bytes 627,429 → 627,429. These are actual page-load counts, separate from the 200-request TTFB benchmark. C6 changes serving, not frontend payload; D1 owns payload reduction.

Validation: `PLAYWRIGHT_BROWSERS_PATH=/tmp/rakazo-c6-browsers RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec tsx scripts/measure-public-page.ts`, Biome on the script, and git diff --check passed. Plan now explicitly states local gates passed, online acceptance incomplete. Authenticated role-page loading, real cloud deployment, and online TTFB are untested. No deployment or cloud changes.

### [#268: A4: correct foreign-key drift diagnosis and record blocked production precheck](https://github.com/WeKruit/rakazo/pull/268)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-a4-schema`; head: `3f7b49d3cf553acfff52077d77d7096682e1aeca`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-WORKPLAN.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

The work plan described four missing foreign keys. Replaying all 129 migrations in a new local PostgreSQL 16.15 database proves the keys already exist: their ON UPDATE action is NO ACTION, whereas the Prisma relations implicitly expect CASCADE. Both migrated-database-to-schema and migration-directory-to-schema comparisons emit four DROP CONSTRAINT and four ADD CONSTRAINT statements. Blindly adding the existing keys would fail, and replacing them would change behavior.

This evidence-only PR updates A4 to blocked rather than claiming acceptance. The connected Supabase SQL tool targets the project's postgres database, while Rakazo uses a separate rakazo database; the tool has no database-selection parameter. A metadata-only precheck confirmed the expected product tables are absent from that connection. Correct production FK metadata is still needed before choosing schema alignment or a replacement migration. No credentials or user records were read/exported, and no cloud/schema changes were made.

Validation (Node 24.19.0, pnpm 9.15.0): all 129 migrations replayed successfully; both Prisma diff commands correctly report nonempty drift (Prisma exit 2, pnpm wrapper exit 1); Prisma generation and database package type checks passed; database unit suite 1,216 passed / 356 skipped. Full commands, four constraint names, required read-only query, and remaining limits are recorded in A4. No additional runtime connections or pool changes; CI remains disabled. This targets #263's integration branch, not main.

### [#270: A2: record RLS readiness audit and unpassed acceptance](https://github.com/WeKruit/rakazo/pull/270)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-a2-rls`; head: `a72fa4deb4abc85226eaa99287c3c722f3220e6a`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-WORKPLAN.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Architecture item A2 is not complete. This documentation-only change records what was actually verified and distinguishes remaining implementation from prohibited production changes.

On a new synthetic PostgreSQL 16 database replaying current migrations: 92 application tables, zero RLS-enabled/forced tables and zero policies. Setting transaction-local app.user_id did not protect missing-filter queries: five foreign artifacts and one foreign role remained visible under the fixture's privileged role. This is a local baseline, not a claim about production credentials.

The existing API account-isolation harness returned 143 OK checks, zero leaks/warnings, and 99 unexercised cases. DB package typechecking passed. Existing real-Postgres recruiting/membership suites returned 271 passed and 12 failed on unchanged integration code; setting the local database timezone to UTC and reconnecting left the same failures. No RLS acceptance is claimed.

The plan preserves exact reproduction commands and enumerates actor-bound client propagation, native/batch transaction integration and streaming/background lifetime handling still to implement. Production restricted-role credentials, role/grant changes and online p95 validation require currently prohibited production configuration/deployment. No application code, schema, pool, cloud configuration or CI was changed. No real customer records or messages were used. Targets #263's integration branch, never main.

### [#272: C3: reject expired push registrations in non-UTC database sessions](https://github.com/WeKruit/rakazo/pull/272)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c3-expiry`; head: `e6957b1bacf76764b3852bb9c1c147623914e687`. Status at capture: merged.

**Reviewer focus:** Review UTC expiry comparisons against non-UTC PostgreSQL sessions; preserve the existing push subscription lifecycle.

**Code/evidence entry points:** `packages/adapters/src/expo-push.postgres.test.ts`, `packages/adapters/src/expo-push.ts`. The PR diff has 3 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

A real local PostgreSQL regression run for C3 accepted an expired session when the database session timezone was America/Chicago. Prisma stores the session expiry as a UTC timestamp without timezone; comparing it directly with `now()` implicitly interprets that value in the database session timezone.

Compare with `now() AT TIME ZONE 'UTC'` and add real PostgreSQL tests for expired and valid sessions under UTC, America/Chicago and Asia/Tokyo. Existing token ownership, races, session retargeting and artifact nonce tests still pass. No new runtime pool/client is introduced; DATABASE_URL and REALTIME_DATABASE_URL budgets remain unchanged.

Validation: `DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_root VERIFY_DATABASE=1 pnpm test packages/adapters/src/expo-push.postgres.test.ts packages/adapters/src/expo-push.test.ts apps/api/src/artifacts.postgres.test.ts` — 35 passed. `pnpm --filter @rakazo/adapters check`, Biome on both changed files and `git diff --check` pass. Before the fix the existing expiry test failed (9 passed /1 failed across the two PostgreSQL suites). All data is synthetic and local; no real device push, deployment, cloud config or CI change. Live cross-container delivery remains untested.

### [#269: refactor: reduce executor-owned recruiting policy (F1 partial)](https://github.com/WeKruit/rakazo/pull/269)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-f1-instructions`; head: `84a1572086a2a488a8e0946b01ec4dc63490020e`. Status at capture: merged.

**Reviewer focus:** Review deleted business heuristics separately from retained identity, consent, source receipts and paid-effect idempotency.

**Code/evidence entry points:** `packages/adapters/src/executor-effect-idempotency.test.ts`, `packages/adapters/src/executor.ts`, `packages/adapters/src/recruiting-location.test.ts`, `packages/adapters/src/recruiting-location.ts`, `packages/adapters/src/us-places.ts`, `packages/core/src/recruiting-defaults.test.ts`, `packages/core/src/recruiting-defaults.ts`, `packages/db/src/recruiting-candidates.test.ts`, `packages/db/src/recruiting.postgres.test.ts`, `packages/db/src/recruiting.ts`. The PR diff has 11 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why
The executor imposed recruiting search-plan, geography and clarification sequencing decisions that belong to existing agent instructions and skills. This is a bounded F1 improvement, not completion of the full architecture acceptance.

#### Changes
- Remove the four-query clarification prerequisite and duplicate next-step directions; extend the existing intake skill with retained-search reuse guidance.
- Remove the geography majority/distance heuristic and automatic rejection of state/country/unknown locations. Delete the unused location implementation and data.
- Permit substantive clarification after partial candidate display or a recorded round. Preserve ten-profile formal calibration completeness, actor/role/source checks and human approval boundaries.
- Correct current-human-source selection and recovery of completed read receipts recorded after cancellation, without weakening ownership or receipt validation. Align stale PostgreSQL fixtures with the current approval/provenance rules.
- Executor recruiting matching lines: 482 → 477; total lines: 14,351 → 14,231. This is an audit count, not proof that all recruiting business logic is removed.

#### Local validation
Refreshed by ordinary merge of the #263 branch at 9b2705c66. No frontend integration changes are included.
- `pnpm --filter @rakazo/core --filter @rakazo/adapters --filter @rakazo/db check`: passed all three packages.
- `pnpm --filter @rakazo/adapters test`: 5,118 passed, 47 skipped; 230 files passed, six skipped; 25.78 seconds.
- `VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts` against a dedicated local synthetic database: 282/282 passed; 31.11 seconds. Includes the five previously failing fixtures corrected by the integration work.
- Six additional runtime counterexamples preserve unknown-candidate rejection and scoped validation errors while accepting geography clarification cases; earlier focused three-file run: 244 passed.
- `git diff --check`: passed.

#### Remaining acceptance
F1 remains partial in the workplan. Planned-search scheduling, automatic brief/card/turn-end behavior and approval-stage sequencing need further workflow-backed review. The external-provider test-copy role → ten-profile calibration → human feedback → same-task continuation workflow has not been tested. Skipped tests are not claimed as verified. No real jobs/candidates, outbound actions, deployment, cloud settings, Secrets, resources or CI changes were used.

Base is `claude/project-thread-f1cbzk`, not main. Parent integration task will serialize any merge; this PR remains draft until that review.

### [#277: A3: bound list queries and preserve client continuation](https://github.com/WeKruit/rakazo/pull/277)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-a3-pagination`; head: `4bd0da4262ba641a0fdbc2450f4c65db10d13559`. Status at capture: merged.

**Reviewer focus:** Review stable pagination, sparse/selected item continuation and unchanged full-list callers. Eight response-only adapters do not claim database pagination.

**Code/evidence entry points:** `apps/api/src/agent-secrets.ts`, `apps/api/src/agent-skills.test.ts`, `apps/api/src/agent-skills.ts`, `apps/api/src/artifacts.test.ts`, `apps/api/src/artifacts.ts`, `apps/api/src/list-pagination-router.test.ts`, `apps/api/src/list-pagination.postgres.test.ts`, `apps/api/src/list-pagination.test.ts`, `apps/api/src/list-pagination.ts`, `apps/api/src/memory-revisions.test.ts`, `apps/api/src/memory-revisions.ts`, `apps/api/src/recruiting.test.ts`, `apps/api/src/recruiting.ts`, `apps/api/src/router.test.ts`. The PR diff has 42 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why
A3 addresses unbounded navigation and recruiting contact lists. Large workspaces now receive pages of at most 200 rows per list while web and mobile follow continuation pages, preserving the complete view.

#### Changes
- Page bots, groups, navigation/bootstrap and contacts; preserve sparse group pages and selected threads beyond the first page.
- Replace role-wide candidate-key materialization with scoped batches of at most 200 observed provider identities.
- Add offset continuation to 31 array reads and 5 structured reads. Push 28 into scoped database queries with stable ordering and take/skip or SQL LIMIT/OFFSET, including latest distinct assessments and independently paged research tasks/actions. Preserve internal service callers that omit offsets.
- The remaining eight use response pagination: generated/static model and voice catalogs; complete-array connection/tool/voice provider interfaces; model backups already limited to 10; bot-secret metadata already limited to 100; scheduling slots expanded from at most 100 retained effects. These are distinguished from database pagination in the evidence document; no authorization cache or unsupported provider cursor is introduced.
- Retain full-list client semantics through shared web/mobile continuation. Mutation receipts remain intact.

#### Measured local acceptance
- Real loopback HTTP ORPC + PostgreSQL, 1,000 synthetic candidates and matching saved enrichment observations: 10 warmups/100 samples. First p95 **32.44 ms**; earlier rerun **26.37 ms**; after merging the current F1 base, publication-gate p95 **26.58 ms** (p50 22.47 ms, max 46.62 ms). Five HTTP requests returned all 1,000 unique contacts, 200 per response. Only session identity is fixed by the fixture; router authorization and database reads are real. No provider calls.
- Real Chromium App/Shell fixtures: contacts changed from one 1,000-row response to five 200-row responses. JS requests stayed at 15; loaded gzip JS changed from 625,224 to 626,840 bytes (+1,616). Raw JS: 2,060,327 to 2,066,452 bytes. Overall page RPC totals are timing-sensitive and are not attributed solely to pagination.
- Synthetic 1,000-bot PostgreSQL list: page sizes 200/200/200/200/200/0; all IDs unique and retained.
- Query-only measurements are separately identified: isolated p95 0.88→0.49 ms; concurrent HTTP benchmark run 8.52→4.05 ms. These are not substitutes for RPC latency.

Final base-merged gates: API **1,376 passed / 51 skipped**, adapters **5,118 / 47**, core **1,239 / 5**, contracts **332 passed**. Complete recruiting PostgreSQL: **285 passed**; synthetic HTTP/list files: **3 passed**. Web/Mobile: **1,654 / 1,004 passed**. Seven-package TypeScript checks passed, including DB cross-package tests. Expo's online patch-version advisory failed once; installed-map offline checking and mobile TypeScript passed without changing dependencies, and the advisory limitation is documented.

#### Validation commands
```sh
EXPO_OFFLINE=1 pnpm --filter @rakazo/api --filter @rakazo/db --filter @rakazo/adapters --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile check
pnpm --filter @rakazo/api --filter @rakazo/adapters --filter @rakazo/contracts --filter @rakazo/core test
pnpm --filter @rakazo/web --filter @rakazo/mobile test
TZ=UTC VERIFY_DATABASE=1 DATABASE_URL="$A3_TEST_DATABASE_URL" pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts apps/api/src/list-pagination.postgres.test.ts packages/db/src/list-pagination.postgres.test.ts
pnpm exec vitest run packages/db/src/recruiting-candidates.test.ts
PLAYWRIGHT_BASE_URL="$A3_FIXTURE_ORIGIN" pnpm --filter @rakazo/web exec playwright test --config playwright.a3.config.ts
```
The database and fixture variables refer only to dedicated local synthetic environments. Full measurements, prior failures and resolved fixture regressions are recorded in `docs/wekruit/A3-PAGINATION-VALIDATION.md`.

#### Acceptance limits
A3 remains in progress: **online** contacts RPC p95 is not tested. Local PostgreSQL uses pool maximum 2; production per-container session count and the 6543 transaction-pooler / 5432 realtime configuration were not changed or measured. Complete-array provider interfaces can repeat provider/catalog reads across pages. No deployment, cloud configuration/secret/resource change, real candidate/job test, or CI enablement occurred. This PR targets #263's branch only.


### [#276: perf: virtualize candidate directory rows (D3 partial)](https://github.com/WeKruit/rakazo/pull/276)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d3-virtualization`; head: `c4b7833906ced7d99aa1c29c8b96a599e3c53200`. Status at capture: merged.

**Reviewer focus:** Review keyboard/focus/selection and scroll restoration with virtualized rows; synthetic fixtures do not cover manual assistive technology.

**Code/evidence entry points:** `apps/web/e2e/candidate-virtualization.spec.ts`, `apps/web/e2e/fixtures/candidates.html`, `apps/web/e2e/fixtures/candidates.tsx`, `apps/web/package.json`, `apps/web/playwright.candidates.config.ts`, `apps/web/src/pages/recruiting/CandidateDirectory.tsx`, `apps/web/src/pages/recruiting/CandidateWindow.tsx`, `apps/web/src/pages/recruiting/latency.test.tsx`, `pnpm-lock.yaml`. The PR diff has 10 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

CandidateDirectory currently mounts every candidate. This D3 slice adds measured virtual windows to its table and cards, preserving selection, keyboard navigation, focused rows, layout switching and scroll restoration. It keeps the existing profile rendering and uses TanStack Virtual. The architecture plan remains incomplete for D3: legacy RecruitingPanel and streaming Transcript follow-ups depend on D1/D4 and will be integrated separately.

Base: `claude/project-thread-f1cbzk` (#263), refreshed by ordinary merge of `168fcaacc` in `600d11f7b`. Claim `09d5070b2` was pushed before implementation `0950da29b`; updated evidence is `c4b783390`.

Local synthetic acceptance, same production fixture before/after:

| Metric | Before | After |
| --- | ---: | ---: |
| Initial / maximum table rows for 1,000 candidates | 1,000 / 1,000 | 14 / 19 |
| Maximum mounted candidate cards | not sampled | 36 |
| Scroll tasks longer than 50 ms | 0 | 0 |
| Actual cold page / JS requests | 5 / 1 | 5 / 1 |
| Fixture raw JS bytes | 895,401 | 932,377 |
| Fixture gzip JS bytes | 286,363 | 297,393 |

The additional 11,030 gzip bytes are measured overhead, not a first-load bundle reduction. Fixture requests are real browser network requests, not scroll sample counts. These numbers do not represent the full app or deployed LCP.

Validation on refreshed base:

- `pnpm --filter @rakazo/web test`: 141 files, 1,649 tests passed (28.10 s).
- `pnpm exec vitest run apps/web/src/pages/recruiting/latency.test.tsx --maxWorkers=2`: 16 passed.
- `pnpm --filter @rakazo/web check`: passed.
- `RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest`: passed.
- `D3_BASE_REF=168fcaacc pnpm --filter @rakazo/web exec playwright test -c playwright.candidates.config.ts` and the same command without D3_BASE_REF: 1/1 passed each (5.4 s / 8.3 s), including keyboard, selection and scroll restoration assertions.
- Targeted Biome and `git diff --check`: passed.

Only local synthetic data was used. Real roles/candidates, production, other browser engines, CPU throttling and manual assistive-technology checks remain untested. CI is intentionally disabled; no CI screenshot is claimed. No deployment or cloud configuration change. Do not merge #263 into main.


### [#297: docs: architecture tested-work handoff and remaining acceptance](https://github.com/WeKruit/rakazo/pull/297)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-handoff`; head: `e19585f1aada73156329733c2290a55497a4dc4d`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-HANDOFF.md`, `docs/wekruit/ARCHITECTURE-LOCAL-ACCEPTANCE.md`, `docs/wekruit/ARCHITECTURE-RELEASE-PREFLIGHT.md`, `docs/wekruit/D1-250KB-OPTIONS.md`, `docs/wekruit/SHELL-SHORTCUT-READ-INVESTIGATION.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Preserve the completed implementation, exact local checks, independent release heads, and remaining acceptance boundaries for handoff. This documentation does not mark the whole architecture plan complete. Latest frontend regression: 2,216 passed; Web typecheck and production build passed. Contacts remain 347,938 bytes gzip, above the final 250 KB target. Includes the causal shortcut timer investigation and external validation preflight. Documentation diff and private-path scan passed. No deployment, cloud change, or main merge.

### [#295: perf(web): defer optional panels and message renderers (D1 partial)](https://github.com/WeKruit/rakazo/pull/295)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d1-lazy`; head: `d852c664ef7d0132c8659e259269b20b031fa9b1`. Status at capture: merged.

**Reviewer focus:** Review lazy-module errors and current visible content; more requests are an explicit tradeoff, not a full-budget pass.

**Code/evidence entry points:** `apps/web/scripts/measure-first-load.ts`, `apps/web/scripts/measure-initial-js.mjs`, `apps/web/src/App.tsx`, `apps/web/src/components/ArtifactFileCard.tsx`, `apps/web/src/components/AskCard.tsx`, `apps/web/src/components/ErrorBoundary.test.tsx`, `apps/web/src/components/ErrorBoundary.tsx`, `apps/web/src/components/markdown-link-prompt.tsx`, `apps/web/src/lib/message-text.ts`, `apps/web/src/pages/Artifacts.tsx`, `apps/web/src/pages/Board.tsx`, `apps/web/src/pages/GroupPanel.tsx`, `apps/web/src/pages/LocalSettings.tsx`, `apps/web/src/pages/PeerMessagesOverlay.tsx`. The PR diff has 32 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why
Initial page loads eagerly download optional panels and rich message renderers. This partial D1 change defers those features behind loading placeholders and keeps the shared Markdown context independent of its renderer.

#### Change
Lazy-load Shell and optional panels, isolate message rendering and routine-list modules, and declare package side effects for tree shaking. Preserve the current integration branch's pagination and candidate virtualization. This PR contains the initial D1 implementation only; later D2/D4 and D1 budget improvements are separate work.

#### Local validation
Against integration baseline 8188c88f3: web 1,655/1,655 tests and chat-ui 143/143 tests passed; web, chat-ui, contracts, core and ui-web type checks, Chinese production build, Biome and diff checks passed. CI remains intentionally disabled.

Real local Chromium cold loads with synthetic auth/API fixtures and the same Chinese locale:
- Sign-in: 629,622 → 268,915 gzip bytes; total requests 26 → 48, JS requests 16 → 40.
- Authenticated one-message chat: 626,677 → 501,396 gzip bytes; total requests 47 → 97, JS requests 15 → 65.

These integrated comparisons include baseline changes and are not exclusively attributable to D1. More chunks increase request counts. This initial PR does NOT meet the authenticated 350 KB first-stage budget or final 250 KB goal; D1 remains in progress. Deployed Fast4G LCP is untested. Exact commands and limitations are recorded in docs/wekruit/ARCHITECTURE-WORKPLAN.md.

No production deployment, cloud configuration change, or real candidate testing.


### [#296: feat(db): add opt-in actor RLS for first recruiting batch (A2)](https://github.com/WeKruit/rakazo/pull/296)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-a2-rls-pilot`; head: `1c20a8f4fe2de44b1c1b3d2c1b2bf3efac6e4de9`. Status at capture: merged.

**Reviewer focus:** Review transaction-local actor binding, restricted role checks, foreign-parent membership and rollback on decode failure. Explicit opt-in SQL/role setup is release-owner work.

**Code/evidence entry points:** `apps/api/src/app.ts`, `apps/api/src/env.test.ts`, `apps/api/src/env.ts`, `apps/api/src/router.ts`, `packages/db/prisma/rls/first-batch.sql`, `packages/db/src/actor-db.postgres.test.ts`, `packages/db/src/actor-db.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`, `packages/testkit/src/cli/account-isolation.ts`, `packages/testkit/src/cli/rls-benchmark.ts`. The PR diff has 16 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Problem and change

A missed application owner filter currently has no database-level guard. This implements A2's first recruiting batch: 29 tables covering all 22 recruiting tables plus artifacts, messages, threads, tasks, runs, events and external effects.

An optional ACTOR_DATABASE_URL wires a separate non-BYPASSRLS client into authenticated RPCs and deferred iterators. Transaction-local parameterized actor identity fails closed; background/auth/migration services retain their explicit privileged client. Startup rejects unsafe roles, policies and membership helper attributes. Foreign-parent checks and current membership remain enforced. The policy SQL is explicit opt-in, not an automatic migration; production activation remains off.

The actor pool uses pg's public pipeline for ordered parameterized SET and business queries on one exclusively checked-out transaction. Both operations settle before rollback/release; COMMIT waits for successful result decoding. No identity/permission cache or SQL interpolation. Native transactions bind once.

#### Local gates

- DB/API/testkit typechecks: passed.
- PostgreSQL RLS/recruiting/membership: 304/304 passed, 22.42 s.
- DB/API unit regression: 2,593 passed / 430 skipped, 46.44 s.
- Targeted client + RLS: 30 passed, including cancel, connection termination, SET failure, decoding failure rollback, pool-one actor switching, 29-table nonempty isolation, membership revocation and cross-parent writes.
- Prior integrated API isolation fixture: 144 OK, 0 leaks/warnings, 98 owner-empty reads unexercised. This fixture predates pipeline; subsequent real HTTP benchmark exercises pipeline.

#### Performance and incomplete acceptance

Two independent quiet B/R/R/B/B/R protocols retain all raw durations, 20 warmups and 200 requests per sample, concurrency five, query pool max four:

- Original serial warmup, pooled 600 requests/mode p95: 8.700708 → 9.427667 ms (+8.36%). Paired samples: -0.62%, +11.36%, +17.81%.
- Supplemental parallel warmup, pooled 600 requests/mode p95: 9.117208 → 9.345500 ms (+2.50%). Paired samples: +15.63%, +8.27%, +7.76%.

Both pooled local comparisons pass <10%, but individual pairs exceed it. This is NOT stable or formal online acceptance. Earlier failed measurements remain documented. Serial warmup produced one warm actor connection; parallel warmup four. Baseline system pool four; actor composition adds a separate pool four, without additional LISTEN sessions. Actual production pooler/backend usage and <=6 session connection budget remain unmeasured; actor URL production validation requires 6543, realtime remains 5432.

Formal online p95, production transaction-pooler pipeline compatibility, role/grant provisioning and remaining table batches remain unverified. A2 stays incomplete and this PR stays Draft for review. No deploy, cloud configuration, secrets, resources, real candidate/job tests, or main merge.

Full commands, historical results, boundary and complete raw traces: docs/wekruit/A2-RLS-PILOT.md, A2-RLS-COVERAGE.md and evidence/a2-pipeline-*.jsonl. Earlier publication rejection notes are historical; this Draft follows renewed authorization.


### [#274: C4: coordinate subscription OAuth across API instances](https://github.com/WeKruit/rakazo/pull/274)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c4-oauth`; head: `998cca78a27c7dc839792b79392564b77baeb5c4`. Status at capture: merged.

**Reviewer focus:** Review encryption, owner-loss non-replay, one-save receipt and provider cancellation races. Additive migration precedes activation; no real provider or multi-container acceptance.

**Code/evidence entry points:** `apps/api/src/app.ts`, `apps/api/src/router.ts`, `packages/adapters/src/index.ts`, `packages/adapters/src/pi-oauth-durable.postgres.test.ts`, `packages/adapters/src/pi-oauth-durable.ts`, `packages/adapters/src/pi-oauth.ts`, `packages/db/prisma/migrations/20261027031000_model_oauth_sessions/migration.sql`, `packages/db/prisma/schema.prisma`. The PR diff has 9 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why

Architecture work-plan C4: subscription OAuth login state currently exists only in the API process that started it. Requests reaching another instance cannot submit an authorization code or complete sign-in. The initiating process now keeps running the existing Pi flow while shared durable session records carry cross-instance status, encrypted input and completion receipts.

#### Changes

- Add `model_oauth_sessions` with user/space scope, owner identity, expiry, encrypted pasted codes and a credential-free result receipt.
- Reuse the existing secret store with ephemeral encryption and existing realtime fanout/NOTIFY; missed notifications are caught by bounded polling while a process owns active logins.
- The originating process automatically saves credentials once. Other instances read the receipt; repeated/concurrent `finish` requests do not save again. Provider transaction locks serialize replacements, disconnects and persistence claims.
- Preserve the existing Pi login implementation. Add a durable coordinator, route production API composition through it, and share the existing credential-persistence function.
- Handle cancellation, expiration, replacement, error redaction and shutdown. An uncertain in-flight save is never replayed after owner loss; its receipt expires and the user can start a fresh login. This does not resume a dead process's provider flow.

#### Local validation

Node 24.19.0, pnpm 9.15.0. Local PostgreSQL 16, synthetic users and credentials only.

- `pnpm --filter @rakazo/db generate` and `DATABASE_URL=postgres://postgres@127.0.0.1:55484/rakazo_c4 pnpm --filter @rakazo/db migrate`: successful on the isolated local database.
- `VERIFY_DATABASE=1 DATABASE_URL=postgres://postgres@127.0.0.1:55484/rakazo_c4 pnpm test packages/adapters/src/pi-oauth-durable.postgres.test.ts packages/adapters/src/pi-oauth.test.ts`: 120 passed (12 durable PostgreSQL cases plus 108 existing OAuth cases). A starts, B submits/completes, one credential row and one save call, repeated finish returns the same receipt; encrypted input and notification payloads contain no plaintext code. Covers isolation, cancellation/save race, provider-wide cancellation, device login auto-save, expiry, replacement, lost NOTIFY, owner-loss non-replay, sanitized persistence failures, and live/expired sessions under America/Chicago and Asia/Tokyo connection timezones. All SQL expiry comparisons and the initial expiry value use UTC. The stored receipt is parsed through the existing ModelCredentialSchema, which strips accidental credential fields; tests assert access/refresh material is absent.
- `pnpm --filter @rakazo/adapters test`: 5,125 passed / 52 skipped at the full-suite run (the eight C4 PostgreSQL cases present at that run were separately exercised; two more durable cases were subsequently added and passed above).
- `pnpm --filter @rakazo/api test`: 1,321 passed / 50 skipped.
- `pnpm --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/db check`: all pass, including database cross-package typechecks.
- `node scripts/bundle-server.mjs api`, Biome on changed TypeScript files, and `git diff --check`: pass.

#### Pool budget and limits

No new connection pool or LISTEN client is created by the coordinator. SQL uses the existing transaction pool, and NOTIFY uses the existing realtime subscriber. Keep `DATABASE_URL` on port 6543 transaction pooling and `REALTIME_DATABASE_URL` on port 5432; the established API 1 + worker 5 session budget remains unchanged by this code. The live six-session budget, actual multi-container routing, provider OAuth endpoints and deployment have not been tested. Existing skipped suites remain unverified. No cloud/Secret/resource/CI configuration was changed, no deployment performed, and no real recruiting data or external messages used. The additive migration must be applied by the authorized deployment flow.

#### Conditional error copy

New errors are `Sign-in is finishing. Try again.` and `Sign-in service is stopping.`; the safe persistence failure is `Subscription sign-in failed. Start sign-in again.` They appear only on the corresponding failed or concurrent action, explain why a retry is needed, and avoid exposing provider errors or credentials. There is no persistent UI copy.

### [#298: refactor(web): split oversized components and preserve translations (D4)](https://github.com/WeKruit/rakazo/pull/298)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d4-release`; head: `7937aab724f5b1f047502d974d688d632452783c`. Status at capture: merged.

**Reviewer focus:** Review extraction boundaries and Lingui macro ownership; ensure translated labels and hooks preserve behavior.

**Code/evidence entry points:** `apps/web/e2e/fixtures/recruiting-app-data.ts`, `apps/web/e2e/recruiting-app-routes.spec.ts`, `apps/web/e2e/recruiting-lingui.spec.ts`, `apps/web/scripts/check-component-size.mjs`, `apps/web/src/lib/desktop.test.ts`, `apps/web/src/lib/i18n-catalog.test.ts`, `apps/web/src/pages/ModelSettingsControls.tsx`, `apps/web/src/pages/ModelSettingsOverlay.tsx`, `apps/web/src/pages/RecruitingPanel.tsx`, `apps/web/src/pages/Shell.test.tsx`, `apps/web/src/pages/Shell.tsx`, `apps/web/src/pages/recruiting/CandidateFeedback.tsx`, `apps/web/src/pages/recruiting/CandidatePresentation.tsx`, `apps/web/src/pages/recruiting/CriteriaEditor.tsx`. The PR diff has 40 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Extract Shell, recruiting and model-settings views/controllers along existing responsibilities. Preserve product behavior and bind extracted translations to local Lingui macros. All 242 production Web TS/TSX files are at most 1,499 lines (limit 1,500), including hooks. Refreshed Web typecheck and 1,655 tests passed in19.99s; unchanged product tree previously passed production build and24browser cases across desktop/mobile routes and English/Chinese. Browser synchronization waits for actual lazy content and stable scrolling; assertions remain intact. Detailed commands and measurements: docs/wekruit/D4-INDEPENDENT-RELEASE.md and D4-LINGUI-REGRESSION.md. CI intentionally disabled, no CI screenshot available. No deployment or main merge.

### [#301: perf(web): scope recruiting query cache and prevent stale echo reads (D2)](https://github.com/WeKruit/rakazo/pull/301)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d2-release`; head: `48b91df0183108887b9b7a760ac29d685d8cd92a`. Status at capture: merged.

**Reviewer focus:** Review cache keys/invalidation against user+Space, fresh authorization and exact-count timer regression. Caching must never become authorization caching.

**Code/evidence entry points:** `apps/api/src/recruiting-read-view.test.ts`, `apps/api/src/recruiting-read-view.ts`, `apps/api/src/router.ts`, `apps/web/e2e/fixtures/recruiting-app-data.ts`, `apps/web/e2e/recruiting-query.spec.ts`, `apps/web/package.json`, `apps/web/playwright.d2.config.ts`, `apps/web/src/lib/query.test-support.ts`, `apps/web/src/lib/recruiting-read-cache.test.ts`, `apps/web/src/lib/recruiting-read-cache.ts`, `apps/web/src/lib/recruiting-read-view.test.ts`, `apps/web/src/lib/recruiting-read-view.ts`, `apps/web/src/pages/RecruitingCorrespondence.test.tsx`, `apps/web/src/pages/RecruitingCorrespondence.tsx`. The PR diff has 40 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Consolidate display reads with scoped TanStack Query caching and an authorized recruiting readView RPC. Preserve fresh authorization/workspace binding, pagination and mutations. Synthetic production contacts comparison: duplicate recruiting RPCs4→0, total RPCs21→17; gzip JS515,958→526,190 bytes (added cost reported). Independent updated fixture confirms0duplicates/17RPC. Also fixes a baseline send-echo timer surviving Shell unmount, proven by a deterministic failing original-baseline test; retains exact read-count assertions. Latest full Web1,667/1,667 in47.66s, Web typecheck, API/contracts76/76 passed. Prior production build and repeated browser gates documented in D2-INDEPENDENT-RELEASE.md; causal investigation included. CI remains disabled. No deployment, cloud change, real recruiting tests or main merge. Live acceptance remains unmeasured.

### [#300: perf(web): virtualize transcript and legacy recruiting results (D3)](https://github.com/WeKruit/rakazo/pull/300)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d3-followup-release`; head: `b2e6c36cb08cd57afd8d7014b6cfdacb46abe18d`. Status at capture: merged.

**Reviewer focus:** Review streaming/tail/prepend/focus preservation. Legacy result browser coverage is limited as recorded.

**Code/evidence entry points:** `apps/web/e2e/fixtures/transcript.html`, `apps/web/e2e/fixtures/transcript.tsx`, `apps/web/e2e/transcript-virtualization.spec.ts`, `apps/web/playwright.candidates.config.ts`, `apps/web/src/pages/RecruitingPanel.test.tsx`, `apps/web/src/pages/recruiting/CandidatePresentation.tsx`, `apps/web/src/pages/recruiting/CandidateWindow.tsx`, `apps/web/src/pages/recruiting/RecruitingEvidenceTab.tsx`, `apps/web/src/pages/shell/Transcript.tsx`, `apps/web/src/pages/shell/TranscriptWindow.tsx`. The PR diff has 12 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why and change

Long conversations and legacy recruiting results still mounted all loaded rows after D3's candidate directory change (#276). This independent follow-up virtualizes Transcript and the extracted RecruitingEvidenceTab while preserving full counts, candidate actions, actual grid columns, focused/selected transcript rows, distant jumps, streaming tail-following and earlier-message loading. It reuses the existing window primitives and adds no user-facing copy. D4 extraction is already in the base; no D1 lazy loading, D2 cache or shortcut-timer changes are included.

#### Validation

After normally merging #263 through D4 merge 916401f65:
- Web typecheck and production build passed.
- Web unit tests: 1,656/1,656 across 142 files, 32.51 s.
- Existing synthetic Chromium virtualization tests: 3/3, 9.8 s. Candidate initial/max mounted rows14/19, max36 cards; transcript initial/max17/24; no observed scroll long tasks; streaming tail gap0.
- The initial browser launch failed because the default cache lacked the required binary. The unchanged suite passed with the existing matching local cache.

Historical same-fixture baseline versus follow-up: 1,000 transcript initial rows →17; maximum1,030 →24 (including30 automatically prepended older messages). Baseline scroll long tasks259/177 ms →none. Requests remain9 total/4 JS; fixture raw JS1,510,469→1,510,836 bytes, gzip486,183→486,741 bytes. These are fixture sizes, not production first-page budgets. Current refresh reproduces follow-up counts/sizes; historical baseline and 12 route checks were not repeated.

Full evidence and commands: docs/wekruit/D3-INDEPENDENT-FOLLOWUP.md. Legacy results have a1,000-candidate unit regression but no separate browser route fixture. Online environment, other browsers, CPU throttling, manual assistive technology and every prepend/image-resize anchor combination remain untested. CI is intentionally disabled, so no CI screenshot is available. No deployment, cloud change, real data or main merge.


### [#302: perf(web): defer optional entry dependencies and reduce cold page requests (D1)](https://github.com/WeKruit/rakazo/pull/302)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d1-followup-release`; head: `4aaa64941c93ab05a172e95d9423a9952672ac8f`. Status at capture: merged.

**Reviewer focus:** Review lazy loading/catalog readiness, locale races, fallback and public API parity; keep visible controls and validation intact. Browser measurements use synthetic auth/API, not deployed LCP.

**Code/evidence entry points:** `apps/web/e2e/deferred-popup.spec.ts`, `apps/web/e2e/fixtures/deferred-popup.html`, `apps/web/e2e/fixtures/deferred-popup.tsx`, `apps/web/e2e/fixtures/recruiting-app-data.ts`, `apps/web/e2e/recruiting-contacts-cold.spec.ts`, `apps/web/scripts/measure-contacts-load.ts`, `apps/web/scripts/measure-first-load.ts`, `apps/web/src/components/DeferredMenuSurface.tsx`, `apps/web/src/components/DeferredPopover.tsx`, `apps/web/src/components/DeferredPopoverSurface.tsx`, `apps/web/src/components/ErrorBoundary.test.tsx`, `apps/web/src/components/ErrorBoundary.tsx`, `apps/web/src/components/LazyOverlay.tsx`, `apps/web/src/components/LiveWork.tsx`. The PR diff has 89 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Reduce actual cold contacts/chat downloads after the separately merged D1/D2/D3/D4 prerequisites. Defer optional menus, panels, media/desktop services and large-list machinery; use canonical lightweight constants/types and deliberate shared chunks without removing features or weakening schema validation. Preserve visible contacts and chat, skeleton/loading states, keyboard focus and authorization.

Chinese production Chromium: original chat626,677→310,672B gzip, JS15→8,total requests47→39; sign-in629,622→203,469B,JS16→7,total26→15. Contacts347,938B,7JS/35total,17RPC/0duplicates; intermediate saved contacts baseline469,995B was not the original project baseline. Auth/API fixtures are synthetic. The350KB stage passes; final250KB and deployed Fast4G LCP remain unmet/unmeasured.

Web typecheck, production build and2,216/2,216 frontend/shared tests passed. Production routes and English/Chinese accessible-name/error tests12/12, cold contacts/detail/focus1/1. Exact commands, raw request evidence, failed workspace-link setup and scope limits: D1-CONTACTS-ENTRY-FOLLOWUP.md. Language-catalog optimization is separate. CI intentionally disabled, no CI screenshot; no deployment, cloud change, real recruiting data or main merge.

### [#303: feat(worker): add safe C5 drain and process lifecycle foundation](https://github.com/WeKruit/rakazo/pull/303)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c5-services`; head: `ef937b42a99298287262a1c04695c47d55710d19`. Status at capture: merged.

**Reviewer focus:** Review drain refusal on timeout, active-job completion and physical connection lifetime. This foundation is superseded/completed by #309/#334.

**Code/evidence entry points:** `apps/worker/src/drain.postgres.test.ts`, `apps/worker/src/drain.test.ts`, `apps/worker/src/drain.ts`, `apps/worker/src/health.ts`, `apps/worker/src/index.ts`, `infra/modal/app.py`, `infra/modal/drain_worker.py`, `infra/modal/service_runtime.py`, `infra/modal/test_service_runtime.py`, `infra/modal/test_topology.py`, `infra/modal/topology.py`. The PR diff has 13 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Worker shutdown currently aborts active runs before waiting for queue shutdown, which cannot prove an uninterrupted replacement. This C5 foundation adds an explicit SIGUSR2 deployment drain using existing Graphile graceful stop, retains active job signals and connections until completion, exposes optional read-only health/drain state, and provides a local preflight that refuses replacement on timeout instead of killing work.

The existing Modal process lifecycle is extracted so API/Web and worker can be started independently in local tests. Existing deployment still runs both processes with migration-before-start and reap-before-volume-commit. Distinct database URLs now must satisfy the required 6543 transaction / 5432 session boundary. Whole-rollout budget validation rejects 17-session single-worker overlap and 24-session full overlap against the existing total of 15.

C5 is **not complete**. No placeholder split entrypoint, actual new Modal service definitions, new resource, cloud configuration, Secret change, deployment, or rolling cutover is included. Existing production release protection remains enforced. Shared-home authoritative pointer migration and serialized worker replacement remain prerequisites; no environment assertion bypasses them. Claim `558f876037ae931f8a8a47508adf06d3075fe756` was pushed before implementation.

Validation (Node 24.19.0, pnpm 9.15.0, synthetic local PostgreSQL 16):
- `VERIFY_DATABASE=1 DATABASE_URL="$LOCAL_TEST_DATABASE_URL" pnpm exec vitest run apps/worker/src packages/adapters/src/wakeup-graphile-host.test.ts`: 21 passed. The real Graphile test shows one active job finishing exactly once while a second queue host completes a new job during drain.
- `PYTHONPATH=infra/release python3 -m unittest infra.modal.test_topology infra.modal.test_service_runtime infra.release.test_modal_config infra.release.test_release`: 62 passed.
- `pnpm --filter @rakazo/worker check`, `node scripts/bundle-server.mjs api worker`, changed TS Biome and diff checks passed.

Exact commands, connection arithmetic and untested limits are recorded in `docs/wekruit/C5-LOCAL-DRAIN.md`. Real Modal containers, online 1Hz homepage/RPC zero failures, live conversation continuity and connection high-water marks remain untested. No real candidate/job/customer data or outbound messages were used; CI remains intentionally disabled. Base is #263's integration branch; no main merge.


### [#304: perf(web): defer optional page translation catalogs (D1)](https://github.com/WeKruit/rakazo/pull/304)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d1-feature-catalogs`; head: `47ffa5554f068ebd19b0bc64f1a3bb13137b2e25`. Status at capture: merged.

**Reviewer focus:** Review lazy loading/catalog readiness, locale races, fallback and public API parity; keep visible controls and validation intact. Browser measurements use synthetic auth/API, not deployed LCP.

**Code/evidence entry points:** `apps/web/catalog-test-plugin.ts`, `apps/web/e2e/i18n-feature-catalog.spec.ts`, `apps/web/lingui.config.ts`, `apps/web/playwright.catalog.config.ts`, `apps/web/src/App.test.tsx`, `apps/web/src/App.tsx`, `apps/web/src/components/SubscriptionGate.test.tsx`, `apps/web/src/components/SubscriptionGate.tsx`, `apps/web/src/lib/i18n-catalog.test.ts`, `apps/web/src/lib/i18n-features.test.ts`, `apps/web/src/lib/i18n-startup.test.ts`, `apps/web/src/lib/i18n.ts`, `apps/web/src/pages/LocalSettings.tsx`, `apps/web/src/pages/SettingsOverlay.tsx`. The PR diff has 46 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why
Cold contacts and chat load translation strings for optional pages before those pages open. Split those strings at the existing lazy-page boundaries while preserving all languages, visible UI, authorization and validation.

#### Change
Use complementary Lingui startup/optional catalogs. The 33 optional top-level pages and their indirect parent boundaries wait for messages before rendering. Keep latest-selection locale activation atomic, including concurrent page opening and English fallback. Shared translations remain consistent; the official compiler confirms all 2,006 original message IDs have identical values in every supported locale. Most of the large PO diff is relocation between catalogs.

This is D1 only, ordinarily merged with integration base d4fae3df1. It preserves the timer and lazy-palette readiness fixes. No schema API, deployment, cloud configuration or real candidate data changes.

#### Actual local production measurements
Same Chinese locale, synthetic auth/API fixtures, actual requested JS gzip totals:

| Cold entry | Published base | This PR | JS / total requests |
| --- | ---: | ---: | ---: |
| Contacts and visible role chat | 347,938 B | 339,147 B | 7 / 35 |
| Authenticated one-message chat | 310,672 B | 301,872 B | 8 / 39 |
| Sign-in | 203,469 B | 194,711 B | 7 / 15 |

Contacts retains 17 RPC calls and zero duplicate recruiting reads. Final 250 KB remains unmet: contacts is 89,147 B above target. D1 remains in progress; deployed Fast4G LCP is untested.

#### Validation
Web 1,694/1,694 tests (149 files), web type check, production Chinese build and Biome pass. Fifteen production Chromium tests pass: original routes at both viewport widths, cold contacts detail/keyboard/focus, bilingual labels, optional-catalog absence before activation, and mounted English/Chinese locale switches. New loader tests cover races, fallback, missing catalogs and retry. Board/paywall tests await their actual new catalog import without weakening access checks.

Exact commands, matched-baseline explanation, earlier failed experiments and limits: docs/wekruit/D1-FEATURE-CATALOGS.md. Machine-readable contacts evidence: docs/wekruit/evidence/d1-catalog-contacts.json. CI is intentionally disabled; no CI screenshot is available, and no CI was enabled. Local production browser acceptance is the evidence for this change; no new visible copy was introduced.


### [#305: docs: reconcile architecture merges, measurements and remaining work](https://github.com/WeKruit/rakazo/pull/305)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-final-handoff`; head: `34acd2a5c9914f80c97bd8ddb8521f7985bbf0b0`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-HANDOFF.md`, `docs/wekruit/ARCHITECTURE-LOCAL-ACCEPTANCE.md`, `docs/wekruit/ARCHITECTURE-WORKPLAN.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Update handoff and workplan with verified small-PR merge SHAs, current D1 catalog measurements and the final DB/API, PostgreSQL, RLS and eleven-package typecheck evidence. D2/D3/D4 meet their stated local criteria. D1 remains above250KB; C5 foundation is merged but remaining safe local storage/replacement implementation continues. Preserve Claude-owned A5/F2 and distinguish actual external gates from unfinished local code. Documentation diff/private-path checks passed. No deployment, cloud changes or main merge.

### [#307: perf(web): defer recruiting catalogs and plain-text link dependencies](https://github.com/WeKruit/rakazo/pull/307)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d1-recruiting-catalogs`; head: `37a1ba5a9a425b51ce8ce632910770975363f615`. Status at capture: merged.

**Reviewer focus:** Review lazy loading/catalog readiness, locale races, fallback and public API parity; keep visible controls and validation intact. Browser measurements use synthetic auth/API, not deployed LCP.

**Code/evidence entry points:** `apps/web/e2e/auth-client-boundary.spec.ts`, `apps/web/lingui.config.ts`, `apps/web/playwright.catalog.config.ts`, `apps/web/scripts/measure-first-load.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/pages/RecruitingPanel.tsx`, `apps/web/src/pages/Shell.tsx`, `apps/web/src/pages/recruiting/CrmWorkbench.tsx`, `apps/web/src/pages/recruiting/LazyViews.tsx`, `apps/web/src/pages/recruiting/RecruitingEvidenceTab.tsx`, `apps/web/src/pages/recruiting/RecruitingSummary.tsx`, `apps/web/src/pages/recruiting/RecruitingSupplementaryTab.tsx`, `apps/web/src/pages/shell/ShellConversation.tsx`, `apps/web/src/pages/shell/ShellPanelContent.tsx`. The PR diff has 45 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

D1 still pays for translations of unopened recruiting views, unused organization client hooks, and Linkify even on plain-text entries. This moves the optional translations behind the existing feature-catalog guard, removes the unused client plugin (server authorization unchanged), and defers the canonical Linkify parser while preserving its exact parsing/sanitization and public exports.

Chinese production synthetic cold-entry gzip: contacts 339147 → 325302 bytes (7 JS / 35 requests, 17 RPC / 0 duplicate recruiting reads); plain chat 301872 → 288026; sign-in 194711 → 180756. Linkify-only matched URL/email/bare-domain cold message is 410505 → 411345 (+840 bytes); both original anchors and literal bare domain are retained. This tradeoff is explicit; not every content case is smaller.

Validation: web + chat-ui typechecks; production build; combined `pnpm exec vitest run packages/chat-ui/src apps/web/src`: 1852 passing tests / 158 files; production `playwright.catalog.config.ts`: 16/16 (responsive real routes, focus/keyboard, EN/ZH labels, catalog switching, auth/session/space). Canonical parser parity includes Unicode, punycode, protocols, email and newline boundaries. Latest base merge changes documentation only.

D1 remains in progress: contacts is 75302 bytes above the 250000-byte final goal; linked-message rendering also exceeds 350000. Online Fast4G LCP remains unmeasured. No deployment, cloud/secret change, real-user data, CI activation, or main merge. Complete commands and limits: docs/wekruit/D1-FEATURE-CATALOGS.md.


### [#308: perf(chat-ui): separate plain-link presentation from Markdown parsing](https://github.com/WeKruit/rakazo/pull/308)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d1-link-presentation`; head: `643abfca2db84b4ab72dce3e51a9599a754f38e3`. Status at capture: merged.

**Reviewer focus:** Review lazy loading/catalog readiness, locale races, fallback and public API parity; keep visible controls and validation intact. Browser measurements use synthetic auth/API, not deployed LCP.

**Code/evidence entry points:** `packages/chat-ui/src/link-presentation.web.tsx`, `packages/chat-ui/src/markdown.web.tsx`, `packages/chat-ui/src/plain-text-links.web.tsx`. The PR diff has 4 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Plain-text links currently import the complete Markdown renderer solely to reuse link presentation. Extract the canonical confirmation/anchor/favicon/link components; Markdown and plain text share them, preserving public exports and exact security behavior.

Chinese production cold URL/email/bare-domain user message: 411345 → 354913 gzip bytes (-56432). Actual hrefs and literal bare domain unchanged. Formatted Markdown with a link and inline code: 410702 → 411337 (+635 bytes shared-boundary cost). Contacts 325302 → 325328; sign-in 180756 → 180757. This is a linked-message improvement, not progress toward contacts' remaining 75328-byte gap to 250000. Linked messages still exceed 350000 by 4913 bytes.

Validated both real synthetic browser cases after actual anchors rendered, web/chat-ui typechecks, production build, Biome, and all 370 Shell/chat-ui tests across 10 files. Existing confirmation/sanitization/Markdown/table assertions retained. Latest integration base merged normally; no product changes from that merge.

D1 remains ongoing. No deployment, main merge, cloud changes, real-user data or CI activation. Full commands and tradeoffs: docs/wekruit/D1-FEATURE-CATALOGS.md.


### [#309: C5: fence shared home authority and validate replacement policy](https://github.com/WeKruit/rakazo/pull/309)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c5-home-authority`; head: `fb0c8c233c27c29cded3b9d67bc6226e1ac08001`. Status at capture: merged.

**Reviewer focus:** Review immutable snapshot integrity/CAS, tombstones and fail-closed legacy-writer rejection. Initial cutover requires a stopped-writer window; no actual storage migration occurred.

**Code/evidence entry points:** `apps/api/src/app.ts`, `apps/worker/src/index.ts`, `infra/modal/replacement.py`, `infra/modal/test_replacement.py`, `packages/adapter-kit/src/interfaces.ts`, `packages/adapter-kit/src/types.ts`, `packages/adapters/src/computer-lifecycle.ts`, `packages/adapters/src/computer-workspace.ts`, `packages/adapters/src/home-authoritative-store.ts`, `packages/adapters/src/home-authority.postgres.test.ts`, `packages/adapters/src/home-authority.ts`, `packages/adapters/src/home-replicated.ts`, `packages/adapters/src/home.ts`, `packages/db/prisma/migrations/20261027160000_home_revision_authority/migration.sql`. The PR diff has 20 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

C5 needs a shared home authority before API and worker can safely run in separate containers. This follow-up makes verified immutable snapshots publish through the existing Computer revision CAS, rejects legacy writers and deleted-key reuse, and preserves current Team membership and maintenance/run/lifecycle ownership checks. Complete verified migration records a system receipt; new computers then enter a reserved pending state and initialize through verified snapshot publication. Existing homes never fall back to empty or local data.

It also adds a tested serialized replacement policy. SDK 1.6.1 source review found that fixed minimum autoscaling can bypass the driver admission sequence; the candidate split-service factory and dedicated tests were removed. The report lays out the actual deployment decision: platform-proven per-instance controls for two worker replicas, or separately deployed single-worker slots. Neither choice is silently selected. Production entrypoints and release commands remain unchanged. The deployment drivers for writer quiescence, fleet-wide replacement locking and atomic capacity reservation are not wired to cloud operations. C5 remains incomplete until its online release acceptance is measured.

Validation:
- Final migration replayed from an empty isolated local PostgreSQL database; 14 authority tests and 6 restricted-role/RLS tests passed.
- Adapters: 5,118 passed, 73 skipped. API/worker/db: 2,616 passed, 437 skipped.
- Adapter-kit/db/adapters/API/worker type checks, API and worker bundles, 20 Python tests, Biome and diff checks passed.
- No new C5 model drift in Prisma diff; four pre-existing foreign-key update-action differences remain unchanged.
- Final full tests ran with loopback access after stopping the sandboxed run whose existing network fixtures timed out.

Connection budget stays API 1 / worker 5 session connections. Two of each is 12; overlapping an additional worker is 17 and a whole generation is 24, above the existing total of 15. Replacement must drain and confirm stop plus zero sessions before starting the replacement. Query traffic retains transaction pooler 6543 and realtime retains 5432; no persistent connection added.

Not measured: real storage migration and writer exclusion, actual cloud replacement/capacity driver, production session high-water, every-second homepage/RPC zero-failure probing, or uninterrupted real conversations. Docker/desktop local-directory computers require a separate migration before this database-wide remote-fleet cutover. No deployment, resource/config/secret changes, real candidate/job tests, or outbound messages occurred.

See docs/wekruit/C5-HOME-AUTHORITY.md and C5-REPLACEMENT.md for exact commands, protocol and limitations. Base is the actual #263 head branch, not main.


### [#329: docs: record integrated acceptance and C5 deployment boundaries](https://github.com/WeKruit/rakazo/pull/329)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-final-handoff`; head: `244d724b90d7bbd7ca18d6cbed16689cef4238d4`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-HANDOFF.md`, `docs/wekruit/ARCHITECTURE-LOCAL-ACCEPTANCE.md`, `docs/wekruit/C5-REPLACEMENT.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Records the broad local regression results, merged C5 storage protection, and the remaining deployment decision without treating synthetic checks as live acceptance. Links official Modal contracts and distinguishes integrated D1 measurements from its subsequent local work.

Validation: git diff --check passed. Combined source through #309 passed all 11 package checks with EXPO_OFFLINE=1. Earlier broad regression passed 13,376 tests with 686 skipped; repairing omitted local updater dependencies yielded a separate 36/36 targeted pass (not one fully green invocation). Detailed commands and revision boundaries are in the acceptance record.

Documentation only. No deployment, cloud configuration change, or merge to main.

### [#330: perf(web): defer link confirmation and optional chat translations](https://github.com/WeKruit/rakazo/pull/330)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d1-link-confirmation`; head: `59568cde957e2df113ab75d0f555e695ed8b464e`. Status at capture: merged.

**Reviewer focus:** Review lazy loading/catalog readiness, locale races, fallback and public API parity; keep visible controls and validation intact. Browser measurements use synthetic auth/API, not deployed LCP.

**Code/evidence entry points:** `apps/web/lingui.config.ts`, `apps/web/scripts/measure-first-load.ts`, `apps/web/scripts/verify-link-confirmation.ts`, `apps/web/src/components/markdown-link-prompt.tsx`, `apps/web/src/pages/Shell.tsx`, `apps/web/src/pages/ShellMessage.tsx`, `apps/web/src/pages/recruiting/RecruitingSupplementaryTab.tsx`, `apps/web/src/pages/shell/ShellOverlays.tsx`, `apps/web/src/pages/shell/ShellPanelContent.tsx`, `apps/web/src/pages/shell/Transcript.tsx`, `packages/chat-ui/src/external-link-alert-loader.ts`, `packages/chat-ui/src/external-link-alert.web.tsx`, `packages/chat-ui/src/link-confirmation-loading.web.test.tsx`, `packages/chat-ui/src/link-presentation.web.tsx`. The PR diff has 38 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

D1 still loads the external-link alert before any link click and startup translations for eight already-lazy chat/control modules. Defer the original alert behind synchronous preventDefault; guard optional chat code with the existing atomic feature-catalog loader. All 2006 existing compiled messages remain unchanged in all ten locales.

Chinese actual cold fixtures: contacts 325328→322135 gzip bytes (7 JS/35 requests,17 RPC,0 duplicate reads), URL/email/bare-domain user message354913→291476, sign-in180757→177577. Current plain chat284874. Contacts remains72135 bytes above250000; no claim all content routes reach the goal.

Security/recovery: no destination opens while loading or on failure; cancel discards late imports. Real Chromium showed a rejected dynamic import remains cached, so error offers explicit Refresh rather than a false retry. Refresh can discard unsent local state; it is user-triggered and Cancel remains available. Existing global idle recovery is unchanged. After refresh a second guarded click still requires the original confirmation. Local production test aborts the chunk once during global-recovery cooldown and verifies refresh, alert and cancel, with external navigation stubbed.

Validation:1854 web/chat-ui tests across159 files; both typechecks; production build;16 production route/auth/locale/keyboard cases;10-locale full translation parity; Biome/diffcheck. Starting/send/zero-extra-read assertions preserved. Exact commands, measurements and remaining dependency ownership in docs/wekruit/D1-FEATURE-CATALOGS.md and D1-250KB-OPTIONS.md.

No production deployment, main merge, cloud/Secrets/resources, live customer testing or CI activation. D1 remains ongoing. Latest integration base merged normally; parent owns merge decision.

Review fix: Refresh now asks only when the user selects that recovery action:
“Refreshing closes this link confirmation and may discard unsaved messages, attachments, reply context and selections. Refresh anyway?”
This copy is necessary to obtain an informed choice before a reload can discard transient state; removing it would make Refresh silently destructive. It is revealed only after an import failure and an explicit Refresh click, not in ordinary chat. All ten locales include the warning. Dismissing leaves the app mounted; accepting reloads. Real production test verifies unsent draft and attachment remain after dismissal, then accepts and checks original link confirmation after reload. Relevant186tests, two typechecks/build pass; contacts now322286B (+151 bytes), same7JS/35requests/17RPC/0duplicates. Independent read-only review found the silent-loss issue resolved.


### [#331: fix(web): preserve usable translations when optional catalogs fail](https://github.com/WeKruit/rakazo/pull/331)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-i18n-failure-preservation`; head: `239a32759bb742a714ef8f75756747cc8e1b3637`. Status at capture: merged.

**Reviewer focus:** Review lazy loading/catalog readiness, locale races, fallback and public API parity; keep visible controls and validation intact. Browser measurements use synthetic auth/API, not deployed LCP.

**Code/evidence entry points:** `apps/web/src/lib/i18n-features.test.ts`, `apps/web/src/lib/i18n.ts`. The PR diff has 3 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Opening a deferred feature after both preferred and English catalog downloads failed replaced the current language with empty English. Preserve the last activated catalog, keep untranslated features blocked, and retain the original first-bootstrap fallback. No new visible copy.

Validation: 36 tests across five locale/catalog suites passed in 1.84s, Web typecheck passed, production build passed in 2.56s, diff check passed. Independent read-only review found no blocker in generation ordering or feature readiness. This correctness followup does not claim the remaining D1 250KB or deployed LCP gates passed. Exact commands are in ARCHITECTURE-LOCAL-ACCEPTANCE.md. No cloud changes or deployment.

### [#332: docs: update integrated frontend results and rejected compatibility experiment](https://github.com/WeKruit/rakazo/pull/332)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-integration-evidence`; head: `429703fb7ddc48ace478628efd85fa7fa49b7786`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-HANDOFF.md`, `docs/wekruit/ARCHITECTURE-WORKPLAN.md`, `docs/wekruit/D1-ZOD-MINI-PROTOTYPE.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Updates the work plan and handoff to the merged #330/#331 results, including the reviewed refresh warning and 38-test combined failure-path regression. Records the isolated Zod Mini prototype's failed public API/error compatibility so it cannot be mistaken for an accepted performance change. No prototype product code is included.

Validation: documentation diff check; referenced integration at 60ccba9a6 passed 38 tests across six locale/link suites and Web typecheck. D1 250 KB remains unmet. C5 code-only slot work continues; no deployment or cloud changes.

### [#334: feat(c5): enforce independent worker slot admission and replacement](https://github.com/WeKruit/rakazo/pull/334)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c5-worker-slots`; head: `a36011948890ca48a1aafb370d3d325aafd8d84e`. Status at capture: merged.

**Reviewer focus:** Review global admission/generation fences, external reservation and physical-session accounting; retain reservations on uncertain stop. Verify SDK/build identity binding and remote replacement ordering before release.

**Code/evidence entry points:** `apps/api/src/app.ts`, `apps/worker/src/drain.ts`, `apps/worker/src/health.ts`, `apps/worker/src/index.ts`, `apps/worker/src/replace-slot.test.ts`, `apps/worker/src/replace-slot.ts`, `infra/modal/replacement.py`, `infra/modal/slot_platform.py`, `infra/modal/slot_services.py`, `infra/modal/test_replacement.py`, `infra/modal/test_slot_platform.py`, `infra/modal/test_slot_services.py`, `packages/adapters/src/index.ts`, `packages/adapters/src/realtime.test.ts`. The PR diff has 32 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

C5 previously had no safe binding between worker replacement, physical session release and the 15-session budget. Define API plus two independent worker Apps without creating cloud resources; reserve worker 5/API 1 sessions before connecting, fence worker generations, and serialize replacement with verified App/container/build identities. Drain deadlines postpone replacement. Failed observations or shutdown retain reservations for attended recovery. Remove the superseded fake Python replacement policy.

Local validation: 7,762 related tests passed / 510 skipped across 335 passing files (115.71s); dedicated real PostgreSQL and local Node process suites 23/23 (5.43s); four package typechecks; final Python 17/17; API, worker and slot-control builds passed. Final commit a36011948890ca48a1aafb370d3d325aafd8d84e was rebuilt and both manifests match its revision and actual bundle hashes. Commands and revision boundaries: docs/wekruit/C5-WORKER-SLOTS.md.

DATABASE_URL remains transaction pooler 6543; REALTIME_DATABASE_URL remains session port 5432. Each worker is hard capped at 4 pool connections + 1 listener, each API at 1 listener. Explicit external reservation is required; old/new API overlap fits 15 only with the documented allocation.

Not deployed. Actual cloud stop/recreate ordering, pooler observability, 1 Hz availability and uninterrupted live conversations remain untested. Initial stopped-writer storage cutover and cloud configuration remain release-operator work. C5 is not marked fully accepted. No main merge, Secrets changes, new cloud resources or real recruiting data tests. No new user-facing copy.

### [#335: docs: close C5 publication handoff with verified merge](https://github.com/WeKruit/rakazo/pull/335)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-c5-worker-slots`; head: `96536af3b375f41c340cf5baa8c9e11f6d3b5e09`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-HANDOFF.md`, `docs/wekruit/ARCHITECTURE-WORKPLAN.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Links merged C5 #334 and its exact implementation/merge revisions in the work plan and handoff. Preserves the distinction between completed local implementation checks and untested cloud rolling/conversation acceptance. Documentation only; git diff --check passed. No deployment or main merge.

### [#336: docs: refresh A2 coverage and integrated isolation evidence](https://github.com/WeKruit/rakazo/pull/336)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-a2-preferences`; head: `a06151c2019e2a4f6346a7436c3679a4e0e381c7`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/A2-RLS-COVERAGE.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

The RLS inventory still described 92 tables and pre-pipeline API evidence. Refresh it to the current 99 models and distinguish OAuth coordination from the six system-only home/admission metadata tables.

Re-ran the existing synthetic API isolation fixture on the integrated source with a real restricted actor role: exit 0, 144 checks, zero leaks/warnings, and 98 explicitly unexercised owner-empty paths in 2.098 seconds excluding setup. No product code changes. Historical latency failures remain documented; online acceptance is untested and A2 remains incomplete.


### [#337: feat(db): add actor RLS for four personal preference tables](https://github.com/WeKruit/rakazo/pull/337)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-a2-preference-policies`; head: `14173576ecf3218e30d9122294a685855d5b8252`. Status at capture: merged.

**Reviewer focus:** Review policy USING/WITH CHECK and live membership revocation. Review together with #343: the original fixture missed cross-Space creation.

**Code/evidence entry points:** `packages/db/prisma/rls/first-batch.sql`, `packages/db/src/actor-db.postgres.test.ts`, `packages/db/src/actor-db.ts`. The PR diff has 4 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Personal consent, action-review, notification and backup-model preferences currently rely on application filters. Extend the opt-in actor RLS installation and startup validation to these four tables, requiring the current user, active Space and live membership for reads and writes. Explicit system bootstrap/background composition remains unchanged.

Validation:
- Real PostgreSQL restricted-role suite: 22/22 passed, 745 ms, including nonempty two-user/two-Space data, legitimate writes, foreign mutations, revoked reads/inserts/updates/deletes and system defaults. Retained notification/action-review rows stay hidden after membership revocation.
- Backup-model/API consent unit tests: 19/19 passed, three files, 5.03 seconds.
- DB and API typechecks passed, including cross-package DB test types.
- Full synthetic API isolation after all 33 policies: 144 executed checks with verdict ok, zero leaks/warnings, plus 98 separately recorded unexercised owner-empty paths. Exit 0; acceptance duration 2.465 seconds excluding setup. No real provider actions.

A2 remains incomplete: online p95 acceptance, production role grants and transaction-pooler behavior are untested. No new pool or physical connection is introduced; deployment and cloud configuration are unchanged. All historical latency evidence remains intact. The OAuth coordination table remains outside this narrow batch.


### [#339: fix(recruiting): preserve brief validation after calibration](https://github.com/WeKruit/rakazo/pull/339)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/f1-boundary-audit`; head: `ca82a5420666bead27f64d907b0aebbbbec0a2cd`. Status at capture: merged.

**Reviewer focus:** Review both pre-round and post-round error behavior; preserve existing confirmation and receipt/idempotency guards.

**Code/evidence entry points:** `packages/adapters/src/executor-effect-idempotency.test.ts`, `packages/adapters/src/executor.ts`. The PR diff has 3 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

#### Why
A material brief validation error was hidden whenever a calibration round already existed. The executor instead returned a next-step card instruction, preventing the agent from addressing the actual conflict.

#### Change
Remove that timing exception. Both pre-round and post-round calls retain the original brief validation result. Existing scoped confirmation, approval, source receipts and effect idempotency remain intact. This is a bounded F1 follow-up; broader recruiting orchestration and real-provider workflow acceptance remain incomplete.

#### Validation
- Characterization before the change: one pass, one failure; only the recorded-round case suppressed the error.
- Executor effect idempotency, planned searches and recruiting defaults: 246 tests passed.
- Adapter TypeScript check and Biome passed. Prisma client was generated from the current schema; an initial check against stale generated models failed and was not counted as a pass.
- Executor recruiting matching lines: 477 to 475; total lines: 14,231 to 14,218.
- Synthetic fixtures only. Real provider-supported recruiting workflow remains untested; no external sends, deployment or cloud changes.


### [#338: perf(web): avoid eager recovery UI through a predicate re-export](https://github.com/WeKruit/rakazo/pull/338)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-d1-sandbox-predicate`; head: `a6224fbc0a8de98ffbc7a4ca03a14f077efe83af`. Status at capture: merged.

**Reviewer focus:** One import boundary only: ensure public re-export and recovery controls remain intact. 565 B reduction does not meet final budget.

**Code/evidence entry points:** `apps/web/scripts/measure-first-load.ts`, `apps/web/scripts/verify-sandbox-recovery.ts`, `apps/web/src/pages/shell/useShellController.tsx`. The PR diff has 4 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

The Shell controller imports a pure availability predicate through the recovery UI module. Import it directly from the existing computer-sandbox leaf instead, retaining the component's re-export and all recovery UI. This is one production import change; no new lazy boundary, delayed control or validation change.

Matched Chinese actual cold contacts on ba744c118: 322313→321748 gzip bytes (-565); 7 JS/35 total requests,17 RPC and0 duplicate recruiting reads unchanged. The latest base merge adds only A2 documentation.

Validation: web typecheck, production build,217 Shell/sandbox tests (28.58s), Biome/diffcheck. A synthetic production browser fixture opens the real no-sandbox computer panel, verifies recovery controls, fails its mocked health check, retries successfully and verifies the recovered state. It uses only synthetic owner/provider data and does not create or contact a sandbox. No new product copy.

Commands and limits: docs/wekruit/D1-FEATURE-CATALOGS.md. D1 remains ongoing: 250000-byte final target is not met; no deployed LCP claim. No deployment, cloud/main/Secrets change or CI activation. Parent owns merge into #263.


### [#340: docs: finalize bounded A2 F1 and D1 acceptance handoff](https://github.com/WeKruit/rakazo/pull/340)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-integration-evidence`; head: `08d56816e2377c8b16cf7f1ef2b90465cc5bed13`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-HANDOFF.md`, `docs/wekruit/ARCHITECTURE-LOCAL-ACCEPTANCE.md`, `docs/wekruit/ARCHITECTURE-WORKPLAN.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Updates the current handoff and plan for merged #336–#339, distinguishes historical checkpoints from current C5 completion, and records exact reproducible final fixture commands. Corrects acceptance-ledger columns and preserves unmet/untested gates.

Final integrated product cc867dff3: all 11 package checks passed; restricted PostgreSQL 22/22; full synthetic API isolation 144 executed OK checks plus 98 separately unexercised paths, zero leaks/warnings, 2.116s excluding setup. D1 is 321748 gzip bytes and remains above 250000. F1 real-provider workflow and external deployment acceptance remain untested.

Documentation only; git diff --check passed. No production, cloud configuration, new resources, real-data testing or main merge.

### [#341: docs: separate implementation backlog and measured D1 budget decision](https://github.com/WeKruit/rakazo/pull/341)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-integration-evidence`; head: `b45b7078324291d4439c335ae006144445ee0ab1`. Status at capture: merged.

**Reviewer focus:** Check that evidence matches the referenced revision and does not turn skipped, synthetic or untested gates into acceptance. No runtime change.

**Code/evidence entry points:** `docs/wekruit/ARCHITECTURE-HANDOFF.md`, `docs/wekruit/D1-FINAL-BUDGET-DESIGN.md`.

**Change, reason, commands/results and limitations recorded for this PR:**

Separates unfinished implementation from release-owner acceptance and provides a bounded, measured D1 compatibility design. Actual contacts remains 321748 gzip bytes; the 71748-byte gap is not explained by accidental backend imports. The record gives exact asset shares, source reachability, and two explicit decisions with estimates and go/no-go budgets; no new runtime prototype or product change is included.

A2 remains an implementation backlog beyond its current actor tables. The handoff also records the newly found spaces.create cross-Space initialization regression, which is being fixed separately instead of weakening active-Space isolation. It does not mark all implementation complete.

Validation: current production diagnostic graph matches the measured asset names; documentation diff check. Official compatibility references checked. No deployment, main merge or cloud changes.

### [#343: fix(api): preserve Space creation under actor RLS](https://github.com/WeKruit/rakazo/pull/343)

Base: `claude/project-thread-f1cbzk`; head branch: `adam/architecture-a2-space-bootstrap`; head: `c256a1a09c67fed8c67718f57e888ef8a6c3062c`. Status at capture: merged.

**Reviewer focus:** Review authenticated context derivation, source-Space AND organization membership, serializable initialization, target-ID generation and caller-only preference copying. No generic privileged client reaches arbitrary RPCs.

**Code/evidence entry points:** `apps/api/src/app.ts`, `apps/api/src/router.ts`, `packages/db/src/actor-db.postgres.test.ts`, `packages/db/src/spaces.ts`, `packages/testkit/src/cli/account-isolation.ts`. The PR diff has 6 changed paths; this is the review entry list, not a complete file manifest.

**Change, reason, commands/results and limitations recorded for this PR:**

Creating a Space under the actor RLS pilot failed when its source-Space transaction inserted notification defaults in the new Space. Reproduced through the actual RPC: HTTP 500, PostgreSQL RLS error 42501.

Supply a narrow system-backed Space creation capability at API composition. The RPC derives user/source from authenticated context; the serializable service verifies Space and organization membership, generates target IDs, and copies only the caller's provider preferences. No generic privileged client is exposed and no policy is relaxed.

Validation: enhanced real API fixture verifies model/voice preference copies, notification defaults and ignored forged authority fields, then 144 successful isolation checks with zero leaks/warnings and 98 separately unexercised paths (4.067 seconds). PostgreSQL 23/23 (912 ms), router unit tests 221/221 (4.28 seconds), DB/API/testkit typechecks passed. Before/after evidence is retained in the A2 coverage report. No deployment or online latency measurement.


## Copyable reviewer prompt

```text
Review this execution batch in WeKruit/rakazo using docs/wekruit/ARCHITECTURE-REVIEWER-HANDOFF.md at the frozen handoff commit provided with delivery. Scope only the PR manifest, not the whole architecture backlog. All PRs target claude/project-thread-f1cbzk (#263); do not merge #263 to main or deploy.
Prioritize A2 actor identity/RLS and #343 cross-Space initialization, C5 physical-session admission/storage/replacement fail-closed behavior, OAuth receipt/encryption, and public listener isolation. Then review frontend request/cache/virtualization/catalog/recovery behavior and F1 security boundaries. Compare each PR's own diff to distinguish other sessions' changes. Check recorded exact commands and revision-specific results; do not count skips, 98 unexercised API paths, synthetic tests, or unmeasured release gates as acceptance. D1 is 321748 B, not 250000 B. Report concrete findings with file/line, impact, reproducer and severity; distinguish bugs from remaining explicitly excluded scope. Do not publish new changes or perform cloud actions as part of read-only review.
```
