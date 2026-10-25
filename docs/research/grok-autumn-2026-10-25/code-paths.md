# 调用链、来源保留与模型边界

## 不同系统不能按名称合并

| 来源 | 确认事实 | 不能推出 |
| --- | --- | --- |
| 旧 headhunter-agent gateway | 固定 `186dacdabb43ecc488b85a140dfebb632ac23dc2` 的 server 只实例化 CodexRuntime 并注册 codex；gateway 保留 provider=grok 兼容分支 | 不能据 “Answer Grok Bot” 或分支名认定这就是用户 Grokbot 的实际 Autumn 实现，也不能据 CodexRuntime 名称认定某个底层模型版本 |
| 旧 headhunter-agent 示例应用 | 固定 `11ca9c2df226782eee241fc5b36ba15600f4efcb` 的 web composition root 调用 createMockRuntime；mock deep research 名为 autumn-mock | 模拟 retrieval/scoring/batch 常量不能解释当前 Rakazo 或真实 Grokbot 效果 |
| Rakazo helper | current-role/context 确认 → buildRecruitingResearchRequest → version 3 frozen bytes/hash → create prompt 或 same-task message | helper 的输入形状不代表每个 native 调用都经过 helper |
| Rakazo native MCP | 工具 assignment + Autumn task ownership → 传递该次 call.args → 保留执行效果/原返回 | 不在 transport 中自动追加 helper prompt，不等于模型没写同样内容；必须看实际参数 |
| Grokbot UI / 所有者提供的离线案例 | 见分开的 UI 与案例报告 | 两个不同岗位/日期/运行不能合并成同岗比较 |

固定旧源码：
[server startup](https://github.com/WeKruit/headhunter-agent/blob/186dacdabb43ecc488b85a140dfebb632ac23dc2/apps/gateway/server.mjs#L16)，
[gateway dispatch](https://github.com/WeKruit/headhunter-agent/blob/186dacdabb43ecc488b85a140dfebb632ac23dc2/apps/gateway/gateway.mjs#L624)，
[mock composition](https://github.com/WeKruit/headhunter-agent/blob/11ca9c2df226782eee241fc5b36ba15600f4efcb/apps/web/lib/app.ts#L295)，
[mock runtime](https://github.com/WeKruit/headhunter-agent/blob/11ca9c2df226782eee241fc5b36ba15600f4efcb/packages/core/src/index.ts#L86)。

## helper / native 的当前机制

[helper builder](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/adapters/src/recruiting-research.ts#L263) 校验 role/revision 和已确认 brief，拼接 role context、purpose、instructions、output、recallScope、未知/qualification 边界以及 candidate output instructions。create 参数为 `{prompt}`；continue 为 `{task_id,message}`，保存不可变字节及 SHA256。[工具入口](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/adapters/src/recruiting-tools.ts#L159) 把 manifest 和请求 artifact 留在现有存储。

[native connector](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/adapters/src/mcp-connector.ts) 对 Autumn 检查账号/Space/连接版本和 task 归属；实际 args 来自调用方。CRM/Instantly 参数隔离分支不能误说成 Autumn prompt 重写。[任务所有权](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/adapters/src/recruiting-research.ts#L90) 也不等于请求语义质量保证。

[current-role context](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/adapters/src/recruiting-context.ts) 保留当前 role/revision、source strength、反馈和记忆边界；新增 CRM 原始 JD 背景明确作为不可信外部数据，重新鉴权。它不能证明模型在某个真实请求里完整转交了这些内容。

## 输出、投影与 UI 是三层

- `candidate_output_v1` 七字段是身份/基础 schema，loose object 允许额外字段。[合同](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/contracts/src/recruiting.ts#L465)。
- 当前 [输出指令](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/core/src/recruiting-candidates.ts#L17) 还要求 experience/education 的 `list[str]`、profile_image_url、公司 URL 及短摘要等；保留 `{value,source_id}` 与 `_sources`。不能把自然语言要求说成已经配置了 provider 的嵌套 object schema。
- 原 body.rows / provider result 的持久化与规范化/报告投影不同。历史 `3afad1b2` 修复曾被丢弃的嵌套记录及直接 timeline 展示，合成 source-shaped fixture 证明该产品缺陷；没有证明用户截图对应真实行确实包含这些嵌套字段。
- 标量头像 URL 已有独立通路。经历对象曾被投影丢弃，不足以证明头像/logo 同因；真实素材应逐层核对原值、传输、投影、渲染和实际加载失败。
- 当前 main 对短列/同页 source context 还有后续修订，不能拿历史本地修复当当前全链验收。

## 排序、轮次、预算

旧源码检查见 provider 的 updated_rank/overall_rank/rank 保留逻辑，以及历史 mock 中本地 score-sort；后者不能代替当前 Rakazo 的排序证据。默认指令要求保留来源与未知，不能从输出顺序反推模型评估正确。

历史 Rakazo poll 配置为前台约 10 秒、后台每 10 秒、最多 720 次；这描述观察机制，不证明所有状态读取免费。Pi 工具调用上限默认 0 和子代理并发 4 是运行代码默认，不是该真实 run 的额度/付费 provider 并发。实际模型、连接、费用、runtime 配置与 stop reason 必须来自相同 run 的已有回执；本研究没有读取当前生产配置或环境密钥。

## 必须保留的反证

- PLAN 中的旧 benchmark 不是 Grokbot / Rakazo 同岗比较；曾有提取条件不同、历史不相同，不能用单个准确率宣称某路径更优。
- UI 看到了文字只能证明可见内容；Bot 自述已发、可复制 prompt、工具执行成功、provider accepted 与结果成功是不同层次。
- 完整离线比较未发现本 Dyna 请求 OR 被改成 AND 的直接证据；原十人纠错明确禁止增人，后续扩量有分别确认。Grok 相同 run 原请求/输出仍缺失，某一模型更差不能作为既定根因。

源所有者最新报告补充了 Grok REST wrapper/scout 的方法自述和一个明确 dry-run 重建样例；它不是已直接检查的脚本或 wire receipt。详见 [Grok UI 与模板](grok-ui-and-template.md)。
