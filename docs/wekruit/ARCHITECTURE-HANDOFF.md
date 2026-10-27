# Architecture handoff — 2026-10-27

This is the current handoff, not a declaration that every architecture item passed. The target is PR263's `claude/project-thread-f1cbzk`; never merge it into main or deploy from this task. The live plan now has23rows: original21 plus Claude-owned F2 and A5. Preserve their ownership.

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

Each PR URL is `https://github.com/WeKruit/rakazo/pull/<number>`. C5 claim558f876037ae931f8a8a47508adf06d3075fe756 was normally pushed at e7dfafeca6e92e0fb8f5949334e5a49faaec481c before implementation. No force push, main merge, deployment, new cloud resource or cloud configuration occurred.

## Verified product checkpoint

D1 follow-up branch `adam/architecture-d1-followup-release` HEAD4aaa64941c93ab05a172e95d9423a9952672ac8f is merged. Frontend/shared2,216/2,216 across179files in49.55s; Web typecheck and Chinese production build pass. Real production routes and English/Chinese names/error feedback12/12,33.0s; cold contacts/detail keyboard/return focus1/1,1.9s; final Shell212/212,29.32s. Synthetic mocked auth/API only.

After#304, contacts339,147B gzip (7JS/35requests,17RPC/0duplicates), chat301,872B (8/39), sign-in194,711B (7/15). Matched pre-catalog values were347,938/310,672/203,469B. These are actual requested scripts, not a static entry-only approximation. The350KB stage passes,250KB does not; deployed Fast4G LCP remains unmeasured. Catalog revision47ffa5554 passed1,694Web tests and15production browser cases, Webcheck/build, and compiled parity for all2,006message IDs across10languages. See[D1-FEATURE-CATALOGS.md](D1-FEATURE-CATALOGS.md).

D2/D3/D4 satisfy their stated local criteria: zero duplicate identical RPCs;1,000-candidate window at most19rows/36cards without observed>50ms scroll long tasks; every production Web source file at most1,499lines. This does not assert online, other-browser or manual assistive-technology acceptance.

The shortcut defect was reproduced on original baseline: a3-second send-echo timer survived Shell unmount. The merged fix cancels timers and prevents scheduling after late acceptance, retaining exact-count assertions. See [causal investigation](SHELL-SHORTCUT-READ-INVESTIGATION.md).

Latest backend regression on the#302 product revision: DB/API2,609passed/430skipped(64.06s),11packagechecks passed, actual local PostgreSQL307/307(22.69s), separate RLS18/18(761ms). Expo online dependency catalog remains unvalidated. C5 separately passed21TS tests (including actual two-host Graphile drain),62Python tests, workercheck and API/workerbundles. C5 is a foundation, not completed service splitting.

## Remaining boundaries

A1/B1/B2 need deployed pool/queue measurements. A2's29-table opt-in pilot passes isolation, but some paired latency samples exceed10%, and remaining table batches/pooler compatibility/actual connection usage remain unverified. A3's online p95 is unmeasured. A4 requires correct-database foreign-key metadata and explicit parent-key update semantics; no silent Cascade change. C1/C2 need approved shared-storage cutover. C3/C4 need actual push/provider/multi-container validation. C5 needs safe shared-home authority transition and serialized drained worker replacement before any split deployment. Its remaining local CAS/fence and replacement-controller code is still in progress; only actual storage migration and online cutover require external authority, so this is not yet a claim that all local work is exhausted. C6 production routing/TLS and image runtime remain unmeasured. D1 needs further design to reach250KB. E1–E4 require the specific operator actions documented in the preflight. F1's actual agent business flow is untested; F2/A5 remain with Claude.

[Workplan and per-item state](ARCHITECTURE-WORKPLAN.md) · [exact local evidence](ARCHITECTURE-LOCAL-ACCEPTANCE.md) · [D1 follow-up](D1-CONTACTS-ENTRY-FOLLOWUP.md) · [D1 remaining design choices](D1-250KB-OPTIONS.md) · [external validation preflight](ARCHITECTURE-RELEASE-PREFLIGHT.md). Older “pending publication” notes in chronological reports describe their original checkpoint; the merge table above supersedes them.

## Latest integrated checkpoint (2026-10-27)

- D1 followups #307 and #308 are merged. C5 storage authority #309 is merged at `87697d06d3590c6ed99e2d4bffea6f7daea45bd4`; unsafe service factory removed. See [C5 decision and official evidence](C5-REPLACEMENT.md#decision-brief-and-official-evidence-2026-10-27).
- C5: all 131 migrations on an empty synthetic database; authority 14/14 and restricted actor 6/6; adapters 5,118 passed/73 skipped; API/worker/db 2,616 passed/437 skipped; five package checks and API/worker builds passed. These are local implementation checks, not a deployed rolling/cutover acceptance.
- Final combined source through #309 passed all 11 package checks (`EXPO_OFFLINE=1`); no production deployment or #263-to-main merge occurred.
- Further D1 work remains local only on `adam/architecture-d1-link-confirmation` at `bc5c94d44dd38295a2c095376a86da66f322e4d9`: commits `003f0fade` and `c5e42f043`. Contacts 322,135 B, plain chat 284,874 B, linked message 291,476 B, sign-in 177,577 B. Contacts remains 72,135 B above the final 250 KB target. 1,854 unit tests, two package checks, build, 16 production browser cases and 10-language/2,006-message parity passed. Its push/PR creation was denied before execution by automatic approval; no retry or alternate publication was attempted. These bytes are not claimed for the integrated branch.
- C5 decision, D1 final budget, A2 latency thresholds and external acceptance gates remain open. This is not an all-plan completion declaration.
