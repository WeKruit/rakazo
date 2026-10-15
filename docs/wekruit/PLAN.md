# WeKruit Recruiting Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to execute this plan inline, task by task. Independent work may run in parallel under the user's explicit authorization; keep file ownership separate and centralize deployment/acceptance.

**Goal:** 在现有 Rakazo 网页交付 Main/Sourcer 原生协作、可恢复交互与记忆，迁入现有招聘工作，完成 [GOAL.md](GOAL.md) 的 P0–P6。

**Architecture:** 沿用 Rakazo Web → authenticated API → Postgres/worker → Pi → native tools/connectors → persisted result → Web。Supabase 独立数据库保存状态，原生 memory provider 保存记忆，Modal Volume 保存文件/检查点，E2B 提供原生执行环境。集成进入已有边界，不另建 harness。

**Tech Stack:** Rakazo/TypeScript、Pi、官方 Codex OAuth、Supabase Postgres、Graphile、Modal、E2B。

---

## 当前进度

| 阶段 | 当前证据 | 退出条件 |
| --- | --- | --- |
| P0 部署与状态 | 云端登录、独立数据库、Crew、聊天重启延续已验证；实际 E2B 暂停、Volume checkpoint、容器替换后的原文件只读恢复已验证 | 同一部署可用，状态及测试文件重启后可读，原 CRM 不变 |
| P1 模型连接 | 官方 Codex OAuth 与真实回复已验证 | 保存连接跨重启继续，明确过期/重连行为 |
| P2 原生产品与迁移准备 | Crew 上下文、Main/Sourcer 及共享记忆跨对话召回已验证；选择原卡跨重启继续、全对话归档已验证；自定义 input/一次性审批原卡跨重启继续、角色与五份 skills 已验证；其余卡片和迁移待验收 | 记忆、原卡恢复通过；Grok 完整归档与服务清单可核查 |
| P3 Autumn | 官方 MCP 原生传输与现有认证只读通过；两个 Dyna Data Infra 任务状态/分页已核对，原 Grok 批次关联未确认；尚未云端验收 | 创建、证据、反馈、原任务续搜回执一致 |
| P4 现有 CRM | 原 SSR consent、官方用户 OAuth/MCP、固定评审写入/原审计回执读回代码已保存并检查；未部署或真实用户验收 | 用户/组织鉴权、获准写入读回及越权拒绝通过 |
| P5 审批发送 | 官方 MCP Bearer 及三个只读 list 调用通过；云端发送未验收 | 精确内容一次性审批、发送确认和回复停止通过 |
| P6 全链路 | 未验收 | 完成任务 9 的权限、恢复、业务与无重复效果检查 |

按明确的文件和责任边界并行执行：网页原生能力与恢复、源工作迁移、Autumn 任务关联、CRM/Instantly 接入准备。
只有真实依赖串行：先保存精确审批规则再开放写工具、先获得具体批准再执行副作用、先核对原任务再续搜；最后集中验收任务 9。
只有实际验收后才能勾选。文档更新不要求重新部署，仅部署产品修复或配置变更。

## 当前优先修复：切换对话空白

网页已复现：只有一份全局 snapshot，切换目标后先显示空消息，远程查询完成前无加载状态。
在现有 Shell 中保留本次登录最近 20 个 thread 的原生 snapshot，原生 refresh/SSE 继续更新；
首次加载使用既有 Shimmer 显示 Loading…；路由模块加载复用现有 ShellSkeleton，显示 Opening your Space…。账号/space 改变时直接重建认证路由树，跨标签页原生 session/storage 更新同样隔离；旧异步 bootstrap 不再污染新身份。
复用现有 Web E2E 验证延迟 snapshot 返回时仍展示该会话记录且不泄露另一个会话。
状态：已部署并在真实网页验证。首次打开显示 Loading…；已访问对话切回立即显示自己的历史，原生 refresh/SSE 继续更新。组件检查 10 项通过；延迟请求的现有 Web E2E 回归已添加，尚未执行，不作为已通过证据。

追加审查已修复账号/space 所有者切换和 MCP 工具权限刷新后控件残留的两个状态边界：相关 6 个 focused 检查先红后绿；多人真实账号/组织权限仍单独验收，组件回归不替代该项。

## 任务 1：Main/Sourcer 持久记忆及跨对话召回

**复用：** packages/memory/src/index.ts、packages/adapters/src/memory-context.ts、
packages/adapters/src/executor.ts、apps/api/src/router.ts；原生 remember、save_shared_memory 与 memory 页面。

- [x] 当前网页让 Main 调用 remember，写入一条新测试偏好和唯一标记；记录 memory revision、sourceRunId、sourceThreadId。
- [x] 切到另一 Main 对话，仅询问偏好，不在问题泄露标记；核对真实回复及持久记录。
- [x] Sourcer 独立写入并跨对话召回，核对原生 bot scope；多用户隔离由任务 7/9 验收。
- [x] Main 用 save_shared_memory 写一份新共享招聘约束，Sourcer 在另一对话召回；只覆盖专用测试文档。
- [x] 已保存原生共享记忆页面与跨对话召回截图；bot/user scope 由持久记录核对。跨人/组织隔离仍由任务 7/9 单独验收。

**通过：** 真实工具调用、持久 revision、不同对话的回复对应；共享事实通过共享 scope 读取。

## 任务 2：选择、自定义 input 与原卡续跑

**复用：** packages/adapters/src/pi-runtime.ts、apps/web/src/components/AskCard.tsx、
apps/api/src/router.ts、packages/db/src 的现有卡片/任务持久化。

- [x] 正常招聘讨论中生成原生 ask_user 的 2–4 选项，记录 card/message/run/thread ID 及待答状态。
- [x] 保持卡片未答，受控重启当前服务；重开网页核对同一原卡和消息，无重发任务。
- [x] 点击原卡选项，核对保存的 action、真实继续回复及原任务关联；截图待答和继续结果。
- [x] 同一业务上下文生成第二张原生卡，跨部署保留待答状态，使用原生自定义答案输入框填写新值并继续；原 8 个 run ID、16 条原消息保留，同一 waiting run 完成，仅增加 1 条继续回复。
- [ ] 检查取消、重复回答与失效卡：取消无业务效果，重复回答不重新执行，旧卡不能回答新任务。

**通过：** 按钮选择及自定义答案都走原生 answer 路径，等待卡跨重启继续，无人工改库或伪造卡。

**明确缺口：** 当前 MCP 两条路径未声明/注册 elicitation/create；MessageBlock 与 answer 只有字符串交互，尚无多字段 schema。原生 OAuth 连接流程已经存在，不能替代远端 URL elicitation。补接时复用 SDK 类型/handler 与原生持久状态；远端必须支持 session replay/tasks，才能证明重启恢复同一请求，不能重新发起有副作用 tools/call。

## 任务 3：一次性审批、文件与恢复

**复用：** packages/core/src/action-approval.ts、packages/adapters/src/approval-effect.ts、
packages/adapters/src/executor.ts、infra/modal/app.py 及原生 sandbox/checkpoint。

- [x] 使用原生 save_shared_memory 的精确 require_approval 规则，对新共享评审文档做无外发/费用的真实审批；普通 shell/write_file 不充当审批证明。
- [x] 已修共享审批生成函数，展示真实参数并保护凭证；待定时记录原卡/effect/run 与参数 hash 后重启，全部保持一致。
- [x] 原卡仅 Allow once 后，同一 effect/run 完成，新共享文档仅 revision 1、仅一条继续回复；另已实测 Deny 无写入，未创建永久允许规则。
- [x] 再次实际容器替换后核对已完成的原 effect/run/参数 hash、记忆 revision 1 保持不变，没有重放旧写入。
- [ ] 验证重复点击及未知结果重试不产生第二个效果；上游缺陷复现后只修改共享调用链。
- [x] 原生文件工具写入公开测试文件，经实际 E2B paused、Modal Volume checkpoint 及服务容器替换后，同一 Sourcer 对话仅调用 read_file 读回原内容；未重建文件。
- [x] 已保存待审批、重启后原卡、Allow once 后继续和原生记忆页面截图及数据库回执，未执行历史外发。

文件检查已通过：E2B 的预期非零闲置探测曾被 SDK CommandExitError 丢弃，导致保持 running；共享 provider 最小修复及 73 个相关检查通过，已部署。静态 provider getInfo 独立确认 paused，Volume 原路径读回测试内容；服务替换后原 provider 恢复 running，同一对话的真实 tool audit 只有 read_file。云端 adapters 类型检查通过。

**通过：** 待审批原卡恢复，授权绑定相同 payload，操作一次，文件经原生恢复路径读回。

## 任务 4：完整导出 Grok Bot 与服务盘点

**产物：** 私有原始对话归档、完整性 manifest、脱敏能力/服务清单。原始聊天、个人资料、
凭证、附件和私有路径不进入公开仓库。

- [x] 优先使用原生导出，枚举全部可访问 bot、群聊及各 session，包含可访问的归档对话。
- [x] 导出每个 session 全部分页，保留消息顺序、交互结构、来源 ID、时间、附件引用；区分已下载附件与仅引用。
- [x] manifest 记录会话/消息数量、分页结束、校验值和逐项失败；未完成分页不得声称全部导出。
- [x] 本次全量导出沿获准的只读原生接口，内存解密、仅官方 host、私有存储；无凭证输出/落盘，无旧任务执行。
- [x] 已将原生连接设置与对话来源映射为服务/角色/认证/文件脚本/routine 清单，明确配置证据、调用报告及未迁入状态的差别。
- [x] 历史动作仅归档；迁移包不包含永久自动批准规则或激活旧队列。

当前导出证据：原生只读接口枚举 11 个可访问 Bot/群聊、11 个 session，7,074 条 transcript entries；
分页全部完成、无失败，会话文件校验通过。原始归档保留 177 条附件引用（115 条 Bot 附件、62 条用户附件）；其中两份历史 Dyna CSV 已另行下载并验证 SHA/EOF，其余引用没有文件 payload。
UI 已盘点 9 项已安装插件，8 项显示 Connected，1 项待认证；方法/脚本依赖已按来源核对。两份关键 CSV 已只读下载并校验；其余附件、脚本及真实 provider task/checkpoint 仍待迁入。

**通过：** 所有可访问 session 有完整或明确失败记录；服务清单可追溯到真实配置/调用。

## 任务 5：通过原生配置迁入招聘能力

**复用：** packages/adapters/src/builtin-tools.ts、packages/adapters/src/installed-connectors.ts、
packages/adapters/src/mcp-connector.ts、apps/api/src/integration-catalog.ts 及原生 bot settings/memory/skills/secrets。

- [x] Main/Sourcer 职责与五份招聘方法已通过原生设置/skill_create 保存并读回核对，附归档来源；另三份历史记忆草稿尚未合并，不冒充已导入。
- [x] Main 通过原生 handoff_to_bot 委派 Sourcer，后者使用已安装技能和共享规则，在原 Crew 返回实际 Dyna 检索计划与证据表；本次没有执行业务检索。
- [ ] 原始聊天保留为归档；只有原生导入/召回验收的内容标记为可用记忆，不将全部聊天拼成系统提示词。
- [ ] 服务清单映射原生 connector、已安装 API 或 MCP；已有能力直接配置，不加第二套注册系统。
- [ ] 在服务端原生加密 secret store 配置已提供的 Autumn、Instantly、LeadMagic、ContactOut、FullEnrich 等实际所需凭证。
- [ ] Gmail、Calendar、Drive 及其他实际发现的服务用原生 OAuth；新权限展示真实授权页，不复制 Grok OAuth token。
- [ ] 各服务分别记录配置存在、认证通过、agent 调用通过、业务闭环通过；先验证不消费检索/enrichment 额度的操作。
- [ ] 原生 routines 依据迁入后的任务及权限重建；不激活旧待发送队列或自动触发历史动作。

**通过：** 服务在网页原生设置可见，agent 使用获准工具，凭证隔离，工作能调用迁入规则和记忆。

## 任务 6：Autumn → 证据 → 反馈 → 原任务续搜（P3）

**复用：** 原生 API/tools、任务/run 存储、Crew、choice/input 与实际 Autumn 官方接口。

- [ ] 核对创建、查询、反馈/继续接口及费用，确认既有账户授权覆盖实际检索，否则停在待授权步骤。
- [ ] 约定招聘需求后创建一个外部任务，保存外部 ID 与用户/组织/bot/thread 的对应关系。
- [ ] 在原 thread 展示真实候选来源与证据，区分事实、推断、缺口及模型评分。
- [ ] 原生 choice/input 收集反馈，通过支持的继续操作续搜；外部任务 ID 保持不变。
- [ ] 持久化任务状态、去重与反馈；重试/重启不重复创建或重复消耗相同请求。

**通过：** 创建、证据、反馈及同一外部任务续搜有真实回执；缺失继续接口不能换新任务冒充。

当前只读进展：官方任务列表/状态核对两个完成的 Dyna Data Infra 任务，各 15 行；代表任务 get_rows 读取一行并返回真实 next_cursor。两个检查窗口余额变化均为 0。全部旧对话中没有这些 provider ID 的精确来源，不能把相似岗位任务认定为旧批次；原工作区任务索引仍缺。没有调用 research/reply/stop_task。

## 任务 7：现有 Supabase 身份、组织与 CRM（P4）

**复用：** 原生认证/连接鉴权、现有 CRM 身份、成员、RLS 及业务接口。

- [ ] 只读核对现有身份、组织和 CRM schema；独立 rakazo 数据库不代表现有 Auth/CRM 已连接。
- [ ] 后端绑定实际操作人及组织，每次调用核验权限；不通过通用 service-role 工具绕过权限。
- [ ] 将获准候选来源、证据、反馈和内部备注写入现有 CRM 后读回，不无意改变候选阶段。
- [ ] 验证其他用户/组织不能读任务、记忆、credential、CRM 行或批准卡。

**通过：** 获准写入/读回一致，越权实际拒绝，现有 CRM 结构与规则保持不变。

当前实现准备：复用现有 CRM 的 HttpOnly SSR 登录、官方 Supabase 用户 OAuth/MCP 和原 RLS；固定只读工具及 crm_review_candidate/get_crm_candidate_review 已保存，后者核对原组织/候选/用户和实际 audit receipt，保留 stage。代码检查通过，真实用户授权、部署、写读及越权仍待验收。现有 sourced-person/evidence 后台 RPC 不允许 authenticated 调用，不借 service-role 绕过。

## 任务 8：Instantly 审批发送与回复停止（P5）

**复用：** 原生 API connector、draft/approval、持久 jobs/routines 与已安装 Instantly 操作。

- [ ] 草稿绑定 task、candidate、sender、recipient、正文和附件；修改使旧批准失效。
- [ ] 确定真实收件人及用途并获准后，仅一次批准并发送；没有批准保持草稿。
- [ ] 保存服务回执，区分排队、接收与发送确认；网络不确定先查询服务状态，不盲目重发。
- [ ] 回复后持久化停止状态并取消跟进；发送前复查回复/审批，重启不恢复已停止的跟进。
- [ ] 单独验证附件和服务 API 限制，不用浏览器绕过缺失接口或新增权限。

**通过：** 一次精确批准对应一次确认发送；重复点击、重试、重启及已确认回复不引发第二次外发。

现有 CRM 的 post-message RPC 会立即插入 pending 发送队列，不是未批准草稿，不在本轮调用。先复用 Rakazo 原生持久化 tool approval 保存精确 Instantly 参数；不得同时把同一消息加入 CRM pending 造成双发。现有 CRM 还缺只记录已发 provider receipt 的用户入口，业务验收需单独对齐这一边界。

## 任务 9：P6 全链路验收与交付

- [ ] 网页实际完成 Main → Sourcer → Autumn → 证据 → 反馈 → 原任务续搜 → CRM → 草稿 → 审批 → 发送确认 → 回复停止。
- [ ] 在等待选择、等待 input、等待审批、外部任务运行、发送状态未知各状态恢复，核对原任务/原卡及回执。
- [ ] 验证对话切换、多用户/组织权限、独立 bot 配置、取消/拒绝/失效卡及重复提交；单账号 Crew 不代表多人权限通过。
- [ ] bot/subagent 使用原生连接配置，换模型不重建聊天、memory、服务连接；不同 runtime 内部 session 不承诺相同。
- [ ] 更新 revision、测试网址、截图、阶段状态和剩余缺口；业务证据完整才标记 P6 完成。

## 检查与修复规则

先用网页复现，再沿 Web intent → API 鉴权 → 持久状态 → worker/Pi/tool → 服务回执 → Web 定位。
原生能力通过就不改代码；确认缺陷才在共享函数修复，并留下一个捕获该缺陷的最小检查。
不运行 Docker/Electron 测试、不启动旧本机服务，不为文档变更执行整个测试集。

实际修改对应边界时，从仓库根目录选择已有检查：

    pnpm exec vitest run packages/memory/src/index.test.ts packages/adapters/src/memory-context.test.ts
    pnpm exec vitest run packages/adapters/src/pi-runtime-choice.test.ts apps/web/src/components/AskCard.test.tsx
    pnpm exec vitest run packages/core/src/action-approval.test.ts packages/adapters/src/approval-effect.test.ts packages/adapters/src/executor-approval-replay.test.ts

预期为所选检查通过；离线结果不替代真实 Codex、数据库、原卡恢复与业务服务验收。
私有回执记录 revision、场景、原生 ID、预期/实际及截图；公开仓库只放脱敏结论。
