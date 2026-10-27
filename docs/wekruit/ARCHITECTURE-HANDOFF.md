# Architecture handoff — 2026-10-27

This checkpoint preserves tested work; it does not declare the whole plan complete. PR #263 remains the integration target and must not be merged into main. No deployment or cloud configuration was performed.

## Published implementation

Merged small PRs: #265, #267 (C6), #268 (A4 audit), #270 (A2 audit), #272 (C3), #275 (honest acceptance ledger), #269 (F1), #277 (A3), #276 (candidate virtualization portion of D3). C4 #274 remains open. Check live PR status before any integration action.

C5 claim 558f876037ae931f8a8a47508adf06d3075fe756 was published after incorporating current integration work at e7dfafeca. Implementation has not yet started at this checkpoint. F2 remains owned by Claude; do not duplicate that work.

## Tested local integration

Branch `adam/architecture-local-validation`, documentation HEAD `f23b4fbe933092fd88ac512b10a4cbf9f3fa7c08`, product HEAD `52cfe7474`. This aggregate branch is local evidence, not an alternative to separate small PRs.

Latest frontend/shared suite: 2,216 passed across 179 files in 31.14 seconds. Web typecheck and Chinese production build passed. Cold contacts 347,938 bytes gzip (7 JS /35 total requests,17 RPC/zero duplicates); cold chat310,672 bytes (8/39); sign-in203,469 bytes (7/15). D1's250KB target remains unmet.

The historical shortcut extra-read defect is reproduced on original baseline: a three-second send-echo timer survives unmount. Fix commits1b927fbae38a8947a34c1523fd8264267b8c1b93 and aee66a16e clear pending timers and prevent scheduling after late acceptance. Original assertion retained. See investigation for counterexample and limits.

Independent release branches: D1 initial `adam/architecture-d1-lazy` at d852c664ef7d0132c8659e259269b20b031fa9b1; D4 `adam/architecture-d4-release` at d564a9268c05abd96b92c9c8963f2a0b1667951e; D2 `adam/architecture-d2-release` at dc3d4d56efe58d3429cc453ce28a93a7cd59e59d; D3 follow-up `adam/architecture-d3-followup-release` at1f5742a25c8df4e98bd135eb392feabe6c61d585; D1 later `adam/architecture-d1-contacts-entry` at34b9eb587671257272ae7cd215478a55a3d183a5; A2 `adam/architecture-a2-rls-pilot` at81a25a382f325c1d61745dd089f629fc5625e22c; C4 `adam/architecture-c4-oauth` ate50214acb. Local existence is not proof of publication. Publish/integrate serially and verify each remote head.

## Remaining boundaries

A2 has local isolation tests but some latency pairs exceed10%; A4 needs correct-database metadata and an explicit foreign-key update-semantics decision. C5 implementation and multi-container deployment validation remain. E1–E4 and other deployment-dependent checks remain unmeasured; the release preflight specifies minimal operator actions. Never infer live acceptance from synthetic fixtures.

Full commands, measurements, skipped tests and commit chronology: [local acceptance](ARCHITECTURE-LOCAL-ACCEPTANCE.md). [D1 remaining choices](D1-250KB-OPTIONS.md). [Shortcut investigation](SHELL-SHORTCUT-READ-INVESTIGATION.md). [External validation preflight](ARCHITECTURE-RELEASE-PREFLIGHT.md).
