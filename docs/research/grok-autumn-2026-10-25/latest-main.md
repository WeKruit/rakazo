# 最新 main 对照

基线：[`5c210b626c22ab2f1ecd34836c216b52e197bcd6`](https://github.com/WeKruit/rakazo/commit/5c210b626c22ab2f1ecd34836c216b52e197bcd6)，2026-10-25 17:22:41 UTC 合入 #115。研究分支与本基线比较，只允许 docs 变化。这里的“当前”只指该源码版本，不指运行中的 Bot 配置或生产部署。

## 相比两份先前审计

| 项目 | 先前观察 | 基线代码与结论 |
| --- | --- | --- |
| 反馈后默认请求十人 | `f8740356` 的 Sourcer/default stages 与 evaluation-only skill 存在范围歧义 | `3f02c76a` 已把校准轮次移到 Main 快搜，scale 后由 Sourcer 续 Autumn task。不能继续引用旧 Sourcer 句子证明当前相同缺陷。校准期纯复核是否启动新搜索仍需离线 intent 用例确认。 |
| 搜索提示词 | 完整 brief 经 helper 或模型选择的 native args 交付 | #115 加入 `RECRUITING_SEARCH_BRIEF_TEMPLATE`，Sourcer instructions 要求每次 research/reply 使用它，JD 放背景。它是指令，不是 transport 保证或实际采用回执。 |
| 核心职责证据 | 旧规则保留来源、未知和 provider judgment | 新模板要求实际职责引文，区分 A/B、排除 title-only；Main quick search 也强调核心工作文字。已有实现，不再列为本研究待写功能。 |
| 约束 | 保存原文强度；缺项/推断保持未知 | 新 Main 默认要求 min/max 年限、明确 language，另有近六个月入职的默认排除。需要核对具体角色授权，不应把代码默认或示例当成用户已批准的所有岗位硬规则。 |
| Profile 输出 | 七字段身份 schema；额外 profile 请求已在 `f8740356` 加入 | 仍须区分身份 schema、自然语言要求的额外列、provider 实际返回、报告投影和渲染。头像请求不等于实际返回可加载 URL；公司/学校 logo 更不能从经历字段存在推断。 |
| 旧 flow-gap 文档的 “Covered” | 实现摘要 | “Covered”最多表示代码基础，不能代替 HM 介绍、提醒、EA 私有转发和真实 booking/confirmation 的业务验收。详见九阶段表。 |

## 可直接复核的当前来源

- [模板和共享指令](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/core/src/recruiting-defaults.ts#L14)：core work、A/B、未知、同 task 和新增默认约束。
- [模板相关测试](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/core/src/recruiting-defaults.test.ts)：测试存在，不宣称本研究运行或证明搜索质量。
- [平台服务配置](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/db/src/recruiting-bootstrap.ts#L17)：Main people-search 与 Sourcer Autumn 分配边界；不是实际安装凭据证明。
- [输出列](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/core/src/recruiting-candidates.ts#L17)、[helper](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/adapters/src/recruiting-research.ts#L263)、[native connector](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/adapters/src/mcp-connector.ts)。
- [#115](https://github.com/WeKruit/rakazo/pull/115)：原实现 diff；本 PR 不改或重做它。

## 待验证，不能写成已修质量

1. template 的 B 允许 “one hard limit slightly off”，但其他规则要求不放宽硬条件。应在源判断/展示中明确违例与未知，不能把 B 自动当满足所有硬条件。
2. 自动增加年限上限、近六个月入职排除或 language 必答可能影响召回。需要用角色原文/确认记录核对适用范围，不能用 Grok 某一岗位模板泛化为所有岗位事实。
3. Main quick search 的本地选十人与“Autumn owns judgment”存在明确新增例外。与旧 Autumn 首轮比较时，必须把 provider、模型、选择步骤和预算分别固定。
4. 源码中的 “proven in production sourcing” 是作者对模板的注释，不是这份研究完成了同岗对照。没有用该注释给质量结论背书。

以上是离线 review 问题，不是本 PR 的业务改动或新的执行授权。
