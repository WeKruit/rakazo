# Grokbot / Autumn recruiting research

这份研究汇总用于独立 review：比较源 Grokbot 工作方式、Rakazo 的实际调用边界、一个已有离线研究案例，以及九阶段产品现状。只新增文档，没有业务代码、依赖或 workflow 变更，也没有执行新研究、发送、同步、部署或迁移。

## 先读结论

- **没有完成同岗位、同要求、同时间窗口的 Grokbot / Rakazo 配对实验。** 用户观察到的质量差异值得调查；本材料不能证明某个模型、prompt 或 provider 导致差异。
- **不能用项目名识别执行路径。** 旧 headhunter-agent 的 “Grok” 兼容分支、mock research、真实 Grokbot UI 以及 Rakazo Main → Sourcer → native MCP 是不同证据，不能合并为同一调用链。
- **反馈冲突和“只请求七字段”都有版本边界。** 16:54 快照有统一反馈请求十人和 evaluation-only 的范围歧义；17:11 已改 Main quick search 校准、Sourcer/Autumn 扩量；17:22 的 #115 又加入模板。helper 当前还追加资料列，不能再说它只请求七字段。
- **已有离线案例中应分别检查 provider 结果质量和展示一致性。** 200 条 partial 输出、空 score、reasoning 与匹配标签矛盾不等于新的当前生产结果；原始数据保留与 UI 更可读也不等于来源判断正确。
- **后半段不是只有 Bot 文本。** Native 外发审批、Inbox、排期计划及 CRM 写校验存在；真实邮件、面试、初筛和写回的完整验收仍不能宣称完成。

## 阅读顺序

| 文档 | 用途 |
| --- | --- |
| [证据索引](evidence-ledger.md) | 区分直接源码检查、原件所有者报告、UI 观察、历史交付、推断和未知 |
| [最新 main 对照](latest-main.md) | 本研究分支基线及 #115 已合入的变化，避免重复实现或把旧缺陷当当前结论 |
| [调用链和保留边界](code-paths.md) | helper/native、旧 gateway/mock、输出字段、上下文与预算 |
| [Grok UI 与模板](grok-ui-and-template.md) | UI 可见内容、模板意图与执行证明的界线 |
| [离线案例](dyna-offline-comparison.md) | 已有请求/输出的脱敏对照，不是新付费搜索或对照实验 |
| [九阶段现状](nine-stage-status.md) | 代码、历史开发/业务记录与未验收分列 |
| [16:54 历史快照](snapshot-1654-main-audit.md) | 保存当时的固定 SHA、反馈歧义与 helper/native 检查 |
| [下一步离线验证](validation-and-next-steps.md) | 可复核问题、最小改进候选及本次文档验证 |
| [发布触发器审计](publication-review.md) | docs-only PR 会触发什么；与部署授权分开 |

## 版本顺序

| 读取时刻（UTC，2026-10-25） | 固定版本 | 不能混用的事实 |
| --- | --- | --- |
| 16:54:52 | `f87403562e8dce0973e615e066e0c9451fdf14a3` | 当时的反馈范围歧义、helper 追加 profile columns |
| 17:11 | `3f02c76a3bf25e5d2d5f7d1e639eb95908e3256b` | Main quick calibration / Autumn scale；九阶段表的链接固定在此 |
| 17:22 附近，研究分支基线 | `5c210b626c22ab2f1ecd34836c216b52e197bcd6` | 已合 #115：search brief、core-work/A/B 规则及相应测试；未作为本次质量验收 |
| 历史开发快照 | `3afad1b2b81d942e7fe8f92a405212f00e48b804` | profile 投影修复和离线检查；不是当前部署或 Grokbot 模型版本 |

已有 [grokbot-flow-gap](../../development/grokbot-flow-gap.md) 是 #115 的简短实现说明。本目录补充来源等级、版本差异和验收边界，不复制该 PR 的业务改动。[部署验收交接 #112](https://github.com/WeKruit/rakazo/pull/112) 由另一任务维护，也不混入本研究。

## 公开材料范围

本目录只含脱敏观察、聚合计数、代码引用和验证方法。完整候选数据、对话导出、真实 task/session/account IDs、私有路径、截图和原始 request/response 留在其获授权的原存储中，不进入公开仓库。证据标签用于联系保管者核对，不能当成可公开读取原件的链接。材料中的人类或 Bot 自述均不自动升级为供应商执行回执。
