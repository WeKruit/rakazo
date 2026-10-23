# 2026-10-23 Handoff (all threads) / 交接索引

Start with `00-OVERALL-HANDOFF.md`. / 请先阅读 `00-OVERALL-HANDOFF.md`。

## Files / 文件

- `00-OVERALL-HANDOFF.md` - overall handoff across all threads / 总交接
- `core.md` - core workstream handoff / 核心工作流交接
- `release.md` - release notes and status / 发布说明与状态
- `acceptance.md` - acceptance handoff / 验收交接
- `acceptance-report.md` - product acceptance report / 产品验收报告
- `frontend.md` - frontend thread handoff / 前端交接
- `juicebox-profile.md` - Juicebox profile thread / Juicebox 档案线程
- `crm-sync.md` - CRM sync thread / CRM 同步线程
- `crm-sync-mapping.md` - CRM sync field mapping / CRM 字段映射
- `resizable-panels.md` - resizable panels thread / 可调整面板线程
- `resizable-panels-shell.patch` - Biome reformat patch for the shell / shell 的 Biome 格式化补丁
- `rolling-deploy-proposal.md` - rolling deploy proposal / 滚动部署方案
- `instantly-findings.md` - Instantly integration findings / Instantly 集成调查结果
- `ask-audit.md` - ask audit (partly stale) / 提问审计（部分过期）
- `workloop-prd-zh.md` - Workloop PRD, Chinese transcription / Workloop PRD 中文转录

## PR status / PR 状态

- Merged / 已合并: #65 turn guard + stage machine, #73 inbox-remote, #75
- Open / 未合并:
  - #72 CRM sync (draft; migration 20261023160000; merge before #74 / 须先于 #74 合并)
  - #74 Juicebox WIP (do not merge until its not-done list clears / 未完成项清零前不要合并)
- Branch `claude/resizable-panels` (no PR yet / 暂无 PR)

## Deploy state / 部署状态

- main is 0aea24c2: merged but NOT deployed. / main 为 0aea24c2，已合并未部署。
- Live is 00abb64a, ledger 114. / 线上为 00abb64a，ledger 114。
- Next deploy target is 0aea24c2, which carries migration 20261023153000 from #65. / 下次部署目标 0aea24c2，包含 #65 的迁移 20261023153000。
- Hold the deploy until the new role's calibration run finishes; check active runs first. / 新角色 calibration 运行结束前暂缓部署，部署前先检查活跃运行。

## Correction / 更正

`frontend.md` says "deployed is 162b6ea2"; this is outdated. Live is 00abb64a. / `frontend.md` 中 "deployed is 162b6ea2" 已过时，线上为 00abb64a。
