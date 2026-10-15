# WeKruit Recruiting Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to execute this plan inline, task by task. Independent work may run in parallel under the user's explicit authorization; keep file ownership separate and centralize deployment/acceptance.

**Goal:** 在现有 Rakazo 网页交付 Main/Sourcer 原生协作、可恢复交互与记忆，迁入现有招聘工作，完成 [GOAL.md](GOAL.md) 的 P0–P6。

**Architecture:** 沿用 Rakazo Web → authenticated API → Postgres/worker → Pi → native tools/connectors → persisted result → Web。Supabase 独立数据库保存状态，原生 memory provider 保存记忆，Modal Volume 保存文件/检查点，E2B 提供原生执行环境。集成进入已有边界，不另建 harness。

**Tech Stack:** Rakazo/TypeScript、Pi、官方 Codex OAuth、Supabase Postgres、Graphile、Modal、E2B。

---

## 当前进度

| 阶段 | 当前证据 | 退出条件 |
| --- | --- | --- |
| P0 部署与状态 | 云端登录、独立数据库、Crew、聊天重启延续已验证；文件暂停/恢复未验证 | 同一部署可用，状态及测试文件重启后可读，原 CRM 不变 |
| P1 模型连接 | 官方 Codex OAuth 与真实回复已验证 | 保存连接跨重启继续，明确过期/重连行为 |
| P2 原生产品与迁移准备 | Crew 上下文、Main/Sourcer 及共享记忆跨对话召回已验证；选择原卡跨重启继续、全对话归档已验证；自定义 input 原卡跨部署继续已验证；审批及迁移未验收 | 记忆、原卡恢复通过；Grok 完整归档与服务清单可核查 |
| P3 Autumn | 官方 MCP 原生传输与现有认证只读通过；尚未云端验收 | 创建、证据、反馈、原任务续搜回执一致 |
| P4 现有 CRM | 独立数据库不等于现有身份/CRM 接入 | 用户/组织鉴权、获准写入读回及越权拒绝通过 |
| P5 审批发送 | 官方 MCP Bearer 及三个只读 list 调用通过；云端发送未验收 | 精确内容一次性审批、发送确认和回复停止通过 |
| P6 全链路 | 未验收 | 完成任务 9 的权限、恢复、业务与无重复效果检查 |

先执行任务 1–3，不等待其他服务 OAuth；再执行 4–8，最后验收 9。
只有实际验收后才能勾选。文档更新不要求重新部署，仅部署产品修复或配置变更。

## 当前优先修复：切换对话空白

网页已复现：只有一份全局 snapshot，切换目标后先显示空消息，远程查询完成前无加载状态。
在现有 Shell 中保留本次登录最近 20 个 thread 的原生 snapshot，原生 refresh/SSE 继续更新；
首次加载使用既有 Shimmer 显示 Loading…。账号/space 切换沿原生完整重载清空。
复用现有 Web E2E 验证延迟 snapshot 返回时仍展示该会话记录且不泄露另一个会话。
状态：已部署并在真实网页验证。首次打开显示 Loading…；已访问对话切回立即显示自己的历史，原生 refresh/SSE 继续更新。组件检查 10 项通过；延迟请求的现有 Web E2E 回归已添加，尚未执行，不作为已通过证据。

## 任务 1：Main/Sourcer 持久记忆及跨对话召回

**复用：** packages/memory/src/index.ts、packages/adapters/src/memory-context.ts、
packages/adapters/src/executor.ts、apps/api/src/router.ts；原生 remember、save_shared_memory 与 memory 页面。

- [x] 当前网页让 Main 调用 remember，写入一条新测试偏好和唯一标记；记录 memory revision、sourceRunId、sourceThreadId。
- [x] 切到另一 Main 对话，仅询问偏好，不在问题泄露标记；核对真实回复及持久记录。
- [x] Sourcer 独立写入并跨对话召回，核对原生 bot scope；多用户隔离由任务 7/9 验收。
- [x] Main 用 save_shared_memory 写一份新共享招聘约束，Sourcer 在另一对话召回；只覆盖专用测试文档。
- [ ] 截图展示记忆页面和另一对话的召回，记录 bot/private 与 shared 的可见范围。

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

## 任务 3：一次性审批、文件与恢复

**复用：** packages/core/src/action-approval.ts、packages/adapters/src/approval-effect.ts、
packages/adapters/src/executor.ts、infra/modal/app.py 及原生 sandbox/checkpoint。

- [ ] 读取实际审批分类，选无外部收件人、无付费效果的原生操作；普通 shell/write_file 成功不算审批卡证明。
- [ ] 展示完整操作与目标，保持审批待定，记录 card/action/effect/run ID 后重启服务。
- [ ] 回同一原卡仅批准一次，确认真实效果一次；拒绝无效果，不写永久批准规则。
- [ ] 验证重复点击、重试及再次重启不产生第二个效果；上游缺陷复现后只修改共享调用链。
- [ ] 原生文件工具写入公开测试文件，经 sandbox 暂停/恢复及服务替换后读回一致内容，核对持久副本位置。
- [ ] 保存原卡、继续结果截图及回执；不执行历史邮件或活动来制造审批测试。

**通过：** 待审批原卡恢复，授权绑定相同 payload，操作一次，文件经原生恢复路径读回。

## 任务 4：完整导出 Grok Bot 与服务盘点

**产物：** 私有原始对话归档、完整性 manifest、脱敏能力/服务清单。原始聊天、个人资料、
凭证、附件和私有路径不进入公开仓库。

- [x] 优先使用原生导出，枚举全部可访问 bot、群聊及各 session，包含可访问的归档对话。
- [x] 导出每个 session 全部分页，保留消息顺序、交互结构、来源 ID、时间、附件引用；区分已下载附件与仅引用。
- [x] manifest 记录会话/消息数量、分页结束、校验值和逐项失败；未完成分页不得声称全部导出。
- [ ] 若需超出旧单 bot 探测范围使用加密会话，先展示只读范围、官方 host、私有存储及不输出凭证的方式，再取得新增范围授权。
- [ ] 对照连接设置与真实调用，列出服务、使用 bot、操作、认证、文件/脚本依赖和 routines；区分配置证据与 agent 自述。
- [ ] 历史待审批/已批准动作只归档，不执行，不迁入永久自动批准规则。

当前导出证据：原生只读接口枚举 11 个可访问 Bot/群聊、11 个 session，7,074 条 transcript entries；
分页全部完成、无失败，会话文件校验通过。177 条附件引用（115 条 Bot 附件、62 条用户附件）已保留，尚未下载附件文件。
UI 已盘点 9 项已安装插件，8 项显示 Connected，1 项待认证；工作方法/脚本依赖仍需从归档核对。

**通过：** 所有可访问 session 有完整或明确失败记录；服务清单可追溯到真实配置/调用。

## 任务 5：通过原生配置迁入招聘能力

**复用：** packages/adapters/src/builtin-tools.ts、packages/adapters/src/installed-connectors.ts、
packages/adapters/src/mcp-connector.ts、apps/api/src/integration-catalog.ts 及原生 bot settings/memory/skills/secrets。

- [ ] 从归档提取 Main/Sourcer 职责、招聘约束、去重及工作方法，使用原生配置、memory/skills 导入并记录来源。
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

## 任务 7：现有 Supabase 身份、组织与 CRM（P4）

**复用：** 原生认证/连接鉴权、现有 CRM 身份、成员、RLS 及业务接口。

- [ ] 只读核对现有身份、组织和 CRM schema；独立 rakazo 数据库不代表现有 Auth/CRM 已连接。
- [ ] 后端绑定实际操作人及组织，每次调用核验权限；不通过通用 service-role 工具绕过权限。
- [ ] 将获准候选来源、证据、反馈和内部备注写入现有 CRM 后读回，不无意改变候选阶段。
- [ ] 验证其他用户/组织不能读任务、记忆、credential、CRM 行或批准卡。

**通过：** 获准写入/读回一致，越权实际拒绝，现有 CRM 结构与规则保持不变。

## 任务 8：Instantly 审批发送与回复停止（P5）

**复用：** 原生 API connector、draft/approval、持久 jobs/routines 与已安装 Instantly 操作。

- [ ] 草稿绑定 task、candidate、sender、recipient、正文和附件；修改使旧批准失效。
- [ ] 确定真实收件人及用途并获准后，仅一次批准并发送；没有批准保持草稿。
- [ ] 保存服务回执，区分排队、接收与发送确认；网络不确定先查询服务状态，不盲目重发。
- [ ] 回复后持久化停止状态并取消跟进；发送前复查回复/审批，重启不恢复已停止的跟进。
- [ ] 单独验证附件和服务 API 限制，不用浏览器绕过缺失接口或新增权限。

**通过：** 一次精确批准对应一次确认发送；重复点击、重试、重启及已确认回复不引发第二次外发。

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
