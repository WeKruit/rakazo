# Architecture handoff — 2026-10-27

This is the current handoff, not a declaration that every architecture item passed. The target is PR263's `claude/project-thread-f1cbzk`; never merge it into main or deploy from this task. The live plan now has23rows: original21 plus Claude-owned F2 and A5. Preserve their ownership.

## Implementation status — separate from release acceptance

Release-owner checks below do not undo completed implementation and are not a reason to repeat local mock work.

| Scope | Implementation state |
| --- | --- |
| A1, A3, B1, B2 | Pool routing/budgets, bounded list reads, conversation-slot reservation and queue reporting are implemented. |
| C1–C6 | Object-storage adapters, durable push/OAuth state, home authority, independent slot admission/replacement and production static serving are implemented. Cloud resources/configuration and data cutover have not been performed. |
| D2–D4 | Shared server-state cache, bounded virtualized lists and component decomposition meet their documented local code criteria. |
| F1 | The scoped executor business-heuristic removals and the post-calibration validation fix are implemented. Identity, consent, receipts, approval and paid-effect idempotency remain. This does not claim every recruiting reference must or has been removed. |
| **A2 — implementation still partial** | 33 actor tables are protected; six system metadata tables reject actor access. The remaining 60 tables are not all system-only: 25 personal Space tables, shared-Space/credential/child-association categories and OAuth coordination still require policy/composition work according to their actual semantics. Some auth/system tables need separate system authorization rather than actor policies. This is a code/design backlog, not merely an online acceptance task. See the complete 99-model inventory. |
| **A4 — decision/evidence required before code** | Four existing foreign keys have NoAction versus implicit Cascade differences. Correct-database metadata and intended parent-key update semantics are still needed; no cascade behavior was guessed or changed. |
| **D1 — code budget unmet** | Actual contacts is 321,748 gzip bytes; the final 250,000-byte target still requires 71,748 bytes of reduction. No claim of implementation completion at this target. [Measured graph and explicit design choices](D1-FINAL-BUDGET-DESIGN.md) document the remaining compatibility decision. |
| A5 / F2 | Claude-owned work is preserved. Refer to that owner's implementation evidence; this task does not take over or certify unobserved changes. |

## Release-owner acceptance — independent handoff

- A1/B1/B2/A3: actual pool routing and session counts, 50-conversation pool wait, queue bursts/minute logs and deployed list RPC latency.
- A2: production role/grant setup and opt-in activation, actual transaction-pooler compatibility and before/after RPC p95. These release steps are separate from the still-unimplemented later table batches.
- C1/C2/C5: approved object-store configuration, stopped-writer inventory/cutover, actual cloud slot ordering and session visibility, 1 Hz availability and uninterrupted conversations. C3/C4/C6: actual push/provider/multi-container behavior and production image/TLS serving.
- D1: deployed Fast4G LCP, separate from the unresolved local JS-byte implementation target. F1: provider-backed test-copy recruiting workflow, separate from its completed scoped code removals.
- E1–E4: configure/trigger alerts, authorized 20/50-conversation provider load, restore an approved real backup and measure RTO/RPO, and exercise configured fallback connections. Existing local evidence/runbooks are preparation, not these operational outcomes.

No production deployment, cloud configuration, Secret change, new cloud resource, real recruiting-data test or #263-to-main merge was performed. Publisher-owned acceptance may be completed separately; it must not be used to conceal the A2/D1 code backlog or the A4 decision.

## Current result after the bounded A2/F1/D1 followups

- **A2:** [#336](https://github.com/WeKruit/rakazo/pull/336) inventories all 99 Prisma models, distinguishing OAuth application authorization from the six system-only home/admission metadata tables. [#337](https://github.com/WeKruit/rakazo/pull/337) extends the opt-in actor policies from 29 to 33 tables with four personal preferences; both users and Spaces are populated, legitimate/foreign writes and membership revocation are tested, and the tested system/bootstrap paths are preserved. A subsequent audit found that `spaces.create` cross-Space default creation is not covered by that fixture and is rejected by the new active-Space policy; a narrow authorized initialization fix and real RPC regression are in progress. Restricted PostgreSQL 22/22 and related units 19/19 passed. API fixture results are **144 executed OK checks plus a separate 98 unexercised owner-empty paths**, not 144 checks containing 98 empty paths. No full API coverage or online latency claim is made.
- **F1:** [#339](https://github.com/WeKruit/rakazo/pull/339) removes only the rule that hid brief-validation errors after a calibration round and forced a next-step card. Characterization failed before the fix and passed after it; 246 related tests and adapter typecheck passed on the refreshed base. Identity, consent, source receipts, approval and paid-effect idempotency remain intact. Real-provider business acceptance is still untested.
- **D1:** [#338](https://github.com/WeKruit/rakazo/pull/338) imports a pure predicate from its existing leaf instead of through recovery UI. Matched actual contacts gzip is **322,313 → 321,748 B**, with 7 JS / 35 requests / 17 RPC / zero duplicate reads unchanged. 217 tests, Web typecheck/build and real synthetic recovery-panel failure/retry checks passed. No active control was delayed. The final 250,000 B goal is still missed by **71,748 B**; the rejected Mini prototype was not resumed.
- **C5:** [#334](https://github.com/WeKruit/rakazo/pull/334) and its [publication handoff #335](https://github.com/WeKruit/rakazo/pull/335) are complete. Code-only local implementation is not a new TODO. Actual storage cutover and cloud rolling/conversation acceptance remain untested; no Apps were created or deployed.

Current product integration: `cc867dff3f834a4b5877590a1b51a91dcd47a685`. The sections explicitly labeled historical below retain earlier measurements, not current pending work. A4 semantics/real metadata and A5/F2 ownership remain unchanged.

Final combined-source gates at `cc867dff3f834a4b5877590a1b51a91dcd47a685`: all **11 package checks passed** with `EXPO_OFFLINE=1`; the full synthetic API isolation fixture again returned **144 OK / 0 leaks / 0 warnings**, plus **98 separately unexercised paths**, in **2.116s** excluding setup; the real PostgreSQL actor matrix passed **22/22**, **832ms**. These final runs include A2, F1 and the one-line D1 change together. No failed or unexercised paths were relabeled as passed.

## Integrated small PRs

| Scope | PR | Verified merge commit |
|---|---|---|
| C6 serving | #265 | a95b8d944aed3f31a9d9745d3e5ce7c24b91e283 |
| C6 browser evidence | #267 | b314a52da2103fb923f7475bbf81995a5df00c0d |
| A4 audit | #268 | cf48da330aada754a9e218ce40b0ca0ca051aaab |
| A2 initial audit | #270 | 72a736fd61f0f762a4b1a02479569df5ea8298a4 |
| C3 UTC expiry | #272 | 074a24b0f08f6440c33e830a6c616677f0e24f39 |
| F1 instructions | #269 | 168fcaacc088e063b8cd2d0dc3b52b414f7eb88a |
| A3 bounded lists | #277 | 299af876fea9d2577798c643bab0f404c35bdebc |
| D3 candidate directory | #276 | 8188c88f3c58299030b8dbfb2ea128144c2a8755 |
| Initial handoff | #297 | a2204021c9fa5c81c92f342ade4ab0b3697cbd6f |
| D1 initial lazy entry | #295 | 8016114c08dc7a10f76b460d8bb9740e77a009c0 |
| A2 opt-in RLS pilot | #296 | 791070e2bf39ca1d0ba1448059d6da63cbb6acc5 |
| C4 durable OAuth | #274 | 3c7a539d5f64ef9316b76a766cd4bf1e443532d5 |
| D4 components | #298 | 916401f65a3e30df70fb8756ee6082d6eb59926f |
| D2 queries and echo-timer fix | #301 | b6b92f9cf38789231fbf97f483b505738cbccbb4 |
| D3 transcript/legacy results | #300 | 85a3bb1ba425358ebf03a3bcafd7fdc8cb12d527 |
| D1 cold-entry follow-up | #302 | d4fae3df17e08f1d80be64aa98582c036281e531 |
| C5 drain/process foundation | #303 | afdf729217a5ceecbf34a06d990a7578335209a3 |
| D1 optional translations | #304 | f0752e53987a0b0b4cbb17d6f9f70202421b7a5f |
| D1 additional catalog boundary | #307 | c1a188f75b83d0e43d3348b4b756389634e23063 |
| D1 link presentation | #308 | f2ed4a16779b49dbecc6839b9ab080873ac4631e |
| C5 home authority | #309 | 87697d06d3590c6ed99e2d4bffea6f7daea45bd4 |
| D1 link confirmation/catalogs | #330 | 60ccba9a666e9080c948f68aaaa35b4e0c405d4a |
| Translation failure preservation | #331 | a9e2312c7fe2b0af0b6839fa7ccfdbcbd4f8ba7e |
| C5 independent worker slots | #334 | fd5cb90f57dba9e16831c09ebc550ab25b7cbf0f |
| C5 publication handoff | #335 | ba744c11842a55905fd1c8301269774b73f325f8 |
| A2 99-model audit/current fixture | #336 | ab37680a41aed24436a759c69efd41f6a26ba41d |
| A2 four preference policies | #337 | 5ac5c4892b48f79f53203a78fa56fc7829f39692 |
| F1 brief validation | #339 | 265b5b38d66cb6d57747a4cd5636f858a04bcb31 |
| D1 predicate import boundary | #338 | cc867dff3f834a4b5877590a1b51a91dcd47a685 |

Each PR URL is `https://github.com/WeKruit/rakazo/pull/<number>`. C5 claim558f876037ae931f8a8a47508adf06d3075fe756 was normally pushed at e7dfafeca6e92e0fb8f5949334e5a49faaec481c before implementation. No force push, main merge, deployment, new cloud resource or cloud configuration occurred.

## Historical product checkpoint through #304

D1 follow-up branch `adam/architecture-d1-followup-release` HEAD4aaa64941c93ab05a172e95d9423a9952672ac8f is merged. Frontend/shared2,216/2,216 across179files in49.55s; Web typecheck and Chinese production build pass. Real production routes and English/Chinese names/error feedback12/12,33.0s; cold contacts/detail keyboard/return focus1/1,1.9s; final Shell212/212,29.32s. Synthetic mocked auth/API only.

After#304, contacts339,147B gzip (7JS/35requests,17RPC/0duplicates), chat301,872B (8/39), sign-in194,711B (7/15). Matched pre-catalog values were347,938/310,672/203,469B. These are actual requested scripts, not a static entry-only approximation. The350KB stage passes,250KB does not; deployed Fast4G LCP remains unmeasured. Catalog revision47ffa5554 passed1,694Web tests and15production browser cases, Webcheck/build, and compiled parity for all2,006message IDs across10languages. See[D1-FEATURE-CATALOGS.md](D1-FEATURE-CATALOGS.md).

D2/D3/D4 satisfy their stated local criteria: zero duplicate identical RPCs;1,000-candidate window at most19rows/36cards without observed>50ms scroll long tasks; every production Web source file at most1,499lines. This does not assert online, other-browser or manual assistive-technology acceptance.

The shortcut defect was reproduced on original baseline: a3-second send-echo timer survived Shell unmount. The merged fix cancels timers and prevents scheduling after late acceptance, retaining exact-count assertions. See [causal investigation](SHELL-SHORTCUT-READ-INVESTIGATION.md).

Latest backend regression on the#302 product revision: DB/API2,609passed/430skipped(64.06s),11packagechecks passed, actual local PostgreSQL307/307(22.69s), separate RLS18/18(761ms). Expo online dependency catalog remains unvalidated. C5 separately passed21TS tests (including actual two-host Graphile drain),62Python tests, workercheck and API/workerbundles. That checkpoint predates the completed local C5 implementation in #334; see the publication section below.

## Remaining boundaries

A1/B1/B2 need deployed pool/queue measurements. A2's33-table opt-in batch passes local database isolation, but some paired latency samples exceed10%, and remaining table batches/pooler compatibility/actual connection usage remain unverified. A3's online p95 is unmeasured. A4 requires correct-database foreign-key metadata and explicit parent-key update semantics; no silent Cascade change. C1/C2 need approved shared-storage cutover. C3/C4 need actual push/provider/multi-container validation. C5 local storage authority, slot admission and serialized replacement code is complete in #309/#334. Actual stopped-writer migration, cloud configuration and deployed continuity acceptance remain untested. C6 production routing/TLS and image runtime remain unmeasured. D1 needs further design to reach250KB. E1–E4 require the specific operator actions documented in the preflight. F1's actual agent business flow is untested; F2/A5 remain with Claude.

[Workplan and per-item state](ARCHITECTURE-WORKPLAN.md) · [exact local evidence](ARCHITECTURE-LOCAL-ACCEPTANCE.md) · [D1 follow-up](D1-CONTACTS-ENTRY-FOLLOWUP.md) · [D1 remaining design choices](D1-250KB-OPTIONS.md) · [external validation preflight](ARCHITECTURE-RELEASE-PREFLIGHT.md). Older “pending publication” notes in chronological reports describe their original checkpoint; the merge table above supersedes them.

## Historical integration checkpoint through #309 (superseded)

- D1 followups #307 and #308 are merged. C5 storage authority #309 is merged at `87697d06d3590c6ed99e2d4bffea6f7daea45bd4`; unsafe service factory removed. See [C5 decision and official evidence](C5-REPLACEMENT.md#decision-brief-and-official-evidence-2026-10-27).
- C5: all 131 migrations on an empty synthetic database; authority 14/14 and restricted actor 6/6; adapters 5,118 passed/73 skipped; API/worker/db 2,616 passed/437 skipped; five package checks and API/worker builds passed. These are local implementation checks, not a deployed rolling/cutover acceptance.
- Final combined source through #309 passed all 11 package checks (`EXPO_OFFLINE=1`); no production deployment or #263-to-main merge occurred.
- Further D1 work remains local only on `adam/architecture-d1-link-confirmation` at `bc5c94d44dd38295a2c095376a86da66f322e4d9`: commits `003f0fade` and `c5e42f043`. Contacts 322,135 B, plain chat 284,874 B, linked message 291,476 B, sign-in 177,577 B. Contacts remains 72,135 B above the final 250 KB target. 1,854 unit tests, two package checks, build, 16 production browser cases and 10-language/2,006-message parity passed. Its push/PR creation was denied before execution by automatic approval; no retry or alternate publication was attempted. These bytes are not claimed for the integrated branch.
- C5 decision, D1 final budget, A2 latency thresholds and external acceptance gates remain open. This is not an all-plan completion declaration.

## Subsequent integration

Publishing resumed after explicit confirmation. #329 documentation merged as `4ec4a2cc3b9358653e8cefae6cb6da30bc3d5d84`; #331 translation failure preservation merged as `a9e2312c7fe2b0af0b6839fa7ccfdbcbd4f8ba7e`; #330 D1 merged as `60ccba9a666e9080c948f68aaaa35b4e0c405d4a`. The earlier publishing denials above are historical and resolved.

#330's reviewed followup `59568cde957e2df113ab75d0f555e695ed8b464e` warns explicitly before a failed-import Refresh can discard transient state. Actual browser verification preserves an unsent draft and synthetic attachment when the warning is dismissed, then verifies confirmation again after accepted refresh. Final measured contacts is **322,286 B**, 7 JS / 35 requests / 17 RPC / zero duplicate recruiting reads; the earlier 322,135 B predates that safety fix. Final 250 KB remains unmet.

At integrated `60ccba9a6`, locale and link-confirmation regression passed **38 tests / 6 files, 1.86s**; Web typecheck passed. C5 slot design is approved for code and local tests only; creating/deploying Apps and initial stopped-writer cutover remain outside execution scope.

D1 followup experiments were excluded from integration: the matched action-boundary experiment saved only 558 B (322,313 → 321,755 B) while adding asynchronous race handling. The isolated canonical Zod Mini prototype failed public schema-method and error-class compatibility (3 parity checks passed, 2 failed), so it was not measured or published as a product change. See [the exact compatibility evidence](D1-ZOD-MINI-PROTOTYPE.md). Types/build success did not override the failed prerequisites. No new performance claim is made for that prototype.

## Historical A2 boundary before the four-preference batch

The 29-table pilot is not full RLS completion. Final pooled HTTP p95 deltas were +8.36% (serial warmup) and +2.50% (parallel warmup), but matched pairs included +11.36%, +17.81% and +15.63%. No repeatable additional narrow root cause has been established; do not rerun until a favorable sample or weaken transaction/identity rules. Membership helpers, static plans and public ordered pipelines already reduced observed business SQL cost; committing before result decoding is unsafe because decoding failures must still roll back writes.

The original other 63 tables comprise 14 auth/system/membership, six shared Space, three cross-Space personal credential, 11 general child-association and 29 other personal Space tables. They require their actual ownership/read/write semantics, not a blanket current-Space policy. New cutover/tombstone/admission metadata is system-only and rejects actor access. The API fixture still has 98 owner-empty paths unexercised; the nonempty two-actor database matrix does not fill those API gaps.

Formal deployed RPC p95 <10%, actual 6543 pooler pipeline compatibility, role/grant setup and connection budget are not tested. Deployment and cloud configuration remain prohibited. A2 therefore remains partial: pilot implementation and local database isolation pass; local latency pairs are unstable and the formal deployed gate is unmeasured.
## C5 publication completed

[C5 PR #334](https://github.com/WeKruit/rakazo/pull/334) merged into `claude/project-thread-f1cbzk` at `fd5cb90f57dba9e16831c09ebc550ab25b7cbf0f`, from implementation head `a36011948890ca48a1aafb370d3d325aafd8d84e`. The earlier C5 publication denial is resolved.

[Implementation, exact commands and remaining gates](C5-WORKER-SLOTS.md): related regression 7,762 passed/510 skipped; real PostgreSQL and local child-process suites 23/23; final Python 17/17; four package checks and final committed API/worker/controller builds passed. Both manifests matched the final source revision and bundle hashes. Superseded fake replacement policy was removed.

No cloud Apps were created or deployed. Actual pooler observability, remote stop/recreate ordering, 1 Hz availability and uninterrupted live conversations remain untested. Initial stopped-writer storage cutover is release-operator work. D1 final 250 KB and other documented external acceptance gates remain open. #263 has not been merged into main.
