# Grok / Autumn：16:54 UTC main 历史快照

> Historical snapshot at f8740356; read latest-main.md before applying any conclusion to current code.

核查时间：2026-10-25 16:54–16:57 UTC。范围仅为已授权 GitHub 源码与本地交付材料的只读检查。

## 结论
1. **反馈指令的范围冲突仍存在于核查时 main。** 默认流程和 Sourcer 要求每轮反馈后请求十位新人；同时加载的证据反馈 skill 要求 evaluation-only 不增加候选。没有在这几条指令中明确写出例外优先级。此结论是当前源码事实，不是对实际运行行为或搜索效果的证明。
2. **helper 与 native MCP 的主要差别仍存在，但不能沿用“只请求七字段”的旧结论。** helper 仍构造并冻结完整请求；当前 main 已向实际请求文字追加经历、教育、头像、公司链接和展示摘要列。原生 Autumn MCP transport 仍在权限与 task ownership 检查后传递调用参数，不在该层自动拼入 helper 的冻结请求。实际 native 参数可能已包含同样字段，需真实请求原件确认。
3. **PLAN 没有给出可直接定位归档的具体文件名、存储路径、Artifact ID 或原始来源链接。** 只记录了历史完整性统计及两份 Dyna CSV 已归档到 Sourcer 的附件消息。新定位的 **“connect frontend to grok agent”** session 尚待历史调查提供材料；不再用旧 11 会话记录推断当前 Grok 的请求或效果。

## 版本与证据来源

| 对象 | 精确版本 / 状态 |
| --- | --- |
| GitHub `WeKruit/rakazo` main | `f87403562e8dce0973e615e066e0c9451fdf14a3`，于 2026-10-25 16:54:52 UTC 读取 main 分支记录 |
| 该提交 | 2026-10-25T16:49:05Z；Stop asking recruiters to connect a profile-data service (#110) |
| 本地对照树 | `3afad1b2b81d942e7fe8f92a405212f00e48b804`，`codex/candidate-profile-usability`；未切换、更新或修改业务工作树 |
| 本次方法 | 通过 GitHub 逐文件读取固定 SHA，和本地文件做文本比较；没有使用默认分支搜索缺失结果来证明代码不存在 |
| 线上状态 | 未读取生产、运行配置、数据库或真实 provider task；main 不等于已部署版本 |

[固定提交](https://github.com/WeKruit/rakazo/commit/f87403562e8dce0973e615e066e0c9451fdf14a3)

## 当前反馈指令冲突

固定文件：[packages/core/src/recruiting-defaults.ts](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/core/src/recruiting-defaults.ts)

| 当前位置 | 读到的具体规则 | 判定 |
| --- | --- | --- |
| 第 25 行，共享职责的第 5 阶段 | 把该轮全部反馈合并成同一 task 的一次 reply，要求十位未返回过的新人 | 沿用旧规则 |
| 第 43 行，Sourcer 默认指令 | 反馈可仅涉及方向或任意人员；全部作为一次 reply，并要求十位新人。开头同时要求使用下面两个 skills | 沿用旧规则 |
| 第 76 行，Recruitment sourcing continuation | 后续每轮只显示新人，同一 task 一次 reply 请求十位新人 | 沿用旧规则 |
| 第 86 行，Candidate evidence and feedback | evaluation-only 不请求额外候选；不重评其余池 | 沿用旧规则 |

潜在歧义是“只复核已有人的证据”也属于反馈，但前述统一反馈规则没有显式排除这种意图。不能据此断言每次运行必定加人：模型是否加载该 skill、用户当轮范围、保存的 Bot 指令与实际工具参数都未读取。合理的下一步是用真实 evaluation-only 消息与其冻结/原生请求做离线核对；本次没有修改业务逻辑。

当前同文件确有其他变更，如回复名单读取、供应商名称的展示约束、0–100 分数单位提示、排期规则；这些变更没有消除以上范围冲突。

## helper / native：当前差异与已发生的变化

| 层面 | 当前 helper 路径 | 当前 native Autumn MCP 路径 | 与本地 3afad 对照 |
| --- | --- | --- | --- |
| 入口 | `recruiting_research prepare/continue` 读取同 run/用户/岗位上下文，调用 `buildRecruitingResearchRequest` | MCP connector 取得工具 assignment，调用 `requireAutumnTaskOwnership` | 这部分机制保留 |
| 上下文与冻结 | 验证当前 role revision 和已确认 brief；组装 context、purpose、instructions、output、recallScope、证据边界及输出说明；保存 version 3 manifest 和 SHA256 | 在所核查的 transport 段直接使用调用方 args；没有调用 helper builder | 核心差异保留；不能推出 native 实际 prompt 缺上下文 |
| 参数 | create 为 `{prompt: text}`；continue 为 `{task_id, message: text}` | 对 Autumn research/reply，传入该次 `call.args`；新增 CRM / Instantly 参数约束属于其他 provider 分支 | builder 函数的这一段未变；connector 周边已变更 |
| 身份 schema | `candidate_output_v1` 仍为 name、linkedin_url、current_title、current_company、location、resume_url、evidence_urls；loose schema 接受额外列 | 不在该 transport 层强制拼入这份 schema | 七字段身份 schema 未变，但**不是完整的当前请求文字** |
| 输出说明 | **新增 profile columns，详见下方**；保留 `{value, source_id}` 和 `_sources` 的明确文字 | 是否包含这些说明由真实调用参数决定；该 transport 不自动追加 | 请求内容发生实质变化 |
| CRM 原始 JD | context loader 现在重新鉴权读取已有 CRM source material，标注为不可信外部背景，保留人类确认边界，并纳入 context/保存记录 | 同一 run 可能也读到上下文；单凭 transport 无法证明模型完整转交 | 相比 3afad 新增 |
| 历史报告读取 | `projectRecruitingCandidateReport(row, observation.rows)` | 本次不把该变化推断成所有 native 页面都已正确显示 | 由单 row 调用改为带同页 rows，已变化 |

关键固定链接：
- [helper 入口，recruiting-tools.ts 第 159–278 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/adapters/src/recruiting-tools.ts#L159)
- [builder、参数与冻结，recruiting-research.ts 第 263–346 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/adapters/src/recruiting-research.ts#L263)
- [Autumn task ownership，recruiting-research.ts 第 90 行起](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/adapters/src/recruiting-research.ts#L90)
- [native 调用，mcp-connector.ts 第 748–875 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/adapters/src/mcp-connector.ts#L748)
- [当前身份 schema，contracts/recruiting.ts 第 465–489 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/contracts/src/recruiting.ts#L465)
- [CRM source 上下文，recruiting-context.ts 第 88–141 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/adapters/src/recruiting-context.ts#L88)
- [报告读取变化，recruiting-research.ts 第 591–592 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/adapters/src/recruiting-research.ts#L591)

### 必须更正的历史判断：当前请求已包含资料列

当前 [packages/core/src/recruiting-candidates.ts 第 17–43 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/core/src/recruiting-candidates.ts#L17) 把下列说明加入 helper 输出指令：

- `experience: list[str]`，每个职位一项，格式为职位、公司、公司官网、起止日期、地点；当前职位用 Present，保持来源日期精度。
- `education: list[str]`，每个学位一项，格式为学校、学位/专业、学校官网、起止日期。
- `profile_image_url`、`current_company_url`、`current_company_industry`、`current_company_size`。
- `headline`、`highlights`、`key_works`、`concerns`、`criteria_brief`、`entities`。
- 未知项留空/null，来源放入 `source_id`，不编造内容；match_score 请求为 0–100。

这是**自然语言中的扁平 list[str] 输出要求**，不是新增嵌套 object schema，也不是证明 Autumn 实际返回了这些字段。该列表没有请求 `company_logo_url` / `school_logo_url`。不能把“已请求头像 URL”说成“实际 URL 已返回/可加载”，也不能把它与公司学校 logo 缺失混为一谈。

当前源码有对应 profile-column 单测（[recruiting-candidates.test.ts 第 316–333 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/packages/core/src/recruiting-candidates.test.ts#L316)）；本次只读了源码，没有运行该 SHA 的测试。

## PLAN 归档定位：能给出的安全信息

固定来源：[docs/wekruit/PLAN.md 第 1780–1796 行](https://github.com/WeKruit/rakazo/blob/f87403562e8dce0973e615e066e0c9451fdf14a3/docs/wekruit/PLAN.md#L1780)。该文件与本地 3afad 对照完全相同。

| 字段 | 文档实际包含的信息 |
| --- | --- |
| 章节 | “任务 4：完整导出 Grok Bot 与服务盘点” |
| 归档类型 | 私有原始对话归档、完整性 manifest、脱敏能力/服务清单 |
| 旧导出统计 | 11 个 Bot/群聊，11 个 session，7,074 条 transcript entries；文档记录分页结束、无失败、校验通过 |
| 附件覆盖 | 177 条附件引用；其中两份历史 Dyna CSV 已下载并验证 SHA/EOF，其余引用没有文件 payload |
| 两份 CSV 的归档位置描述 | Sourcer 的原生附件消息；文档称 Artifact Store 字节数和 SHA256 与原件一致 |
| **具体归档文件名 / manifest 文件名** | **未提供** |
| **CSV 文件名 / storage key / Artifact ID / 来源消息链接** | **未提供** |
| 私有本机或云存储路径 | 本段未提供；文档明确私有路径不进入公开仓库。本次没有查找或访问这些路径 |
| 可以直接分享的链接 | 只有上述固定 SHA 的 PLAN 章节链接；它是状态记录，不是原始归档 |

因此本段可辅助原归档负责人定位 Sourcer 附件历史，但不能仅据此找到原始文件，更不能确认其属于用户新指出的 session。

## 新材料待核对与最小缺口

用户最新定位是标题为 **“connect frontend to grok agent”** 的 session，且提示还有较新的多份材料。父线程的历史 worker 正在定位；本报告不替代该调查。

实际 Grok vs 当前 Rakazo 请求差异至少还需：
1. 该 session 的可访问来源引用，以及其中关联的新 export / prompt / request artifact 的精确文件标识或来源消息。
2. 一份已有 Grok 真实请求（system/tool prompt、当轮 brief/反馈、Autumn 实际工具名和参数、provider task receipt）；可脱敏保留字段、结构与 hash。
3. 同岗位、同范围的 Rakazo 已有请求原件及对应输出，注明 helper/native、有效 Bot 指令版本、role revision、时间和模型。只看默认源码不能证明实际采用。
4. 若要比较结果质量，还需同口径的人类评价、去重池和来源证据；本次没有质量评测结论。

这些是**证据尚未定位/待提供**，不是工具拒绝或已失败的生产查询。本次未尝试任何生产查询、新 Autumn research、付费搜索或旧任务重放。

## 验证与交付边界

- 已完成：固定 SHA 的 10 个源码文件读取；本地文本差异核对；PLAN 对照；报告写入既有交付目录。
- 业务文件：未修改；本地 HEAD 保持 `3afad1b2b81d942e7fe8f92a405212f00e48b804`。
- 当前 main 测试：**未运行**，此次任务为只读核查，没有 checkout 当前 main。
- 上一轮本地 3afad 的离线聚焦检查为 7 passed / 147 skipped / 3 files；不能转写成当前 main 通过。
- 未做：部署、迁移、同步、生产读取/写入、真实邮件、订阅、paid Autumn 调用。
- 不判定：Grok 效果优于 Rakazo 的原因、当前部署是否采用这些默认值、实际头像/logo 是否返回、真实邮件闭环是否完成。本次有限范围没有新增这些方面的证据。
