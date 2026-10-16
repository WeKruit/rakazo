# WeKruit 完整产品范围与验收矩阵

更新：2026-10-16。本文与 GOAL.md、PLAN.md 共同定义最终交付。**P0–P6 是第一个闭环里程碑，不能作为整个 Goal 的完成线。** Juicebox、Metix、Grok Bot 研究得到的用户能力都要进入本表、实现与验收；不能仅交付某一个岗位示范、聊天壳或工程检查。

## 交付里程碑

| 里程碑 | 产品交付 | 完成依据 |
| --- | --- | --- |
| M1 | 当前 P0–P6 招聘闭环：JD→条件/记忆→Autumn→证据→反馈→原 task 续搜→CRM→审批发送→回复停止 | PLAN.md 与 T01–T10 的真实验收 |
| M2 | Juicebox / Metix 招聘工作台：项目/岗位、聊天与条件、候选卡片/表格、来源定位、反馈校准、任务/名单/外联视图 | J/M 动作逐项对应持久记录、真实操作和页面 |
| M3 | Grok Bot 式完整 Agent 产品：agent 管理、群聊/@/A2A/subagent、memory、skills/plugins/MCP、文件/Library、sandbox/Computer、原生交互与 routines | A–H 动作逐项验收，优先验证并复用 Rakazo 原生功能 |
| M4 | 现有工作与服务完整迁入：Autumn、CRM、Instantly、邮箱/日历/Drive、enrichment、文件/去重/缓存、任务及 routines | 连接、agent 调用、业务闭环三种证据分别成立 |
| M5 | 整品验收与部署：所有适用动作、多用户权限、跨对话/重启/断线/取消/未知结果恢复、每 bot 更换模型/runtime/provider | 全表有结果与证据；未实现/未验收不能标 Goal 完成 |

M2/M3/M4 中独立工作可与 M1 并行。每个 worker 明确文件归属，主任务统一集成、部署及验收；不等待一条长串行计划全部结束才开始下一块。

## 固定产品边界

- 基于同一个 Rakazo 原生前后端、Pi、工具、MCP、Artifact、MemoryStore 和权限；不引入另一套 agent harness 或固定对话工作流。agent 负责语义判断与协作，服务端负责身份、版本、来源、状态、审批和真实回执。
- 每个 bot/subagent 独立配置 model/runtime/connection、OAuth 或 API key、memory provider/scope、skills、plugins、tools、sandbox。更换一位不改其他成员，旧原卡/任务保持原执行归属；共享产品上下文不冒充原生 session 迁移。
- 继续网页优先，复用现有 Modal、独立 rakazo 数据库、Volume、原生 E2B。现有 CRM 结构保持，服务按真实用户/组织权限接入。
- 搜索/续搜按现有账号权限、额度及 rate limit 执行，不逐次审批。外发仍展示精确目标与正文并走原生审批；新增付费、订阅或购买时停止。
- Slack 按用户后续明确要求暂停，本表保留旧动作 ID 作为延期记录；全量产品范围不自动恢复 Slack 工作。
- 复现研究中用户可用的功能及正确业务语义。参考产品的私有后端算法、内部权限入口、隐藏推理，以及静态分析暴露的缺陷不是已知可复刻接口；不能把其错误权限/费用/年限逻辑照搬。可见活动和提供者允许展示的摘要须与真实执行对应。
- 本表的“待验”不等于上游没有实现：先沿 Rakazo 真实调用链确认并复用，只有实际缺口才写代码。研究、代码、离线检查、线上操作、外部回执分别记录。

## Grok Bot 功能清单（保留原动作 ID）

来源：已归档的只读 UI/原生协议研究和用户明确要求。旧表基于早期独立 Gateway 的实现状态已失效；本表按当前 Rakazo 发布证据保守标记。

### A. 入口、账号、团队与权限

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| A01 | 打开 New chat 的 Recipients，选择已有 agent | 从 Main 与 Sourcer 分别新建；回读 bot/thread/run 归属及该 runtime 实际提供的 session 标识 | 线上已验：Main/Sourcer 可打开；其他组合待验 |
| A02 | 从 Recipients 进入 Create new Bot | 先 inspect 创建表单/必填项；再创建仅测试 agent 并回读 | 先核对/复用原生能力，待逐项验收 |
| A03 | 从 Recipients 进入 Create group chat | 选择两位 agent 与一名获权 human，创建后刷新成员一致 | 先核对/复用原生能力，待逐项验收 |
| A04 | 登录/退出产品账号，恢复授权用户 | 两位测试用户登录；退出后 API/SSE/附件拒绝，重新登录恢复其自身数据 | 线上已验当前账号登录；完整退出/第二用户待验 |
| A05 | 查看和编辑个人资料/头像 | 先确认 App 当前个人资料动作；确认项保存后刷新回读 | 先核对/复用原生能力，待逐项验收 |
| A06 | 创建/加入团队与接受邀请 | 用已有组织测试成员加入；非成员不可发现团队 room/文件 | 先核对/复用原生能力，待逐项验收 |
| A07 | 邀请/移除 human、设置成员角色 | 管理者修改；普通成员操作拒绝；移除后旧 SSE/卡/文件均拒绝 | 先核对/复用原生能力，待逐项验收 |
| A08 | 选择产品账号与外部连接的独立身份 | 产品账号邮箱不同于外部账号；仍按稳定 user/account/connection ID 关联 | 先核对/复用原生能力，待逐项验收 |
| A09 | 区分私人 agent 与团队 agent 可见/管理权限 | private agent不被另一用户列出；共享后仅获准动作可用 | 先核对/复用原生能力，待逐项验收 |
| A10 | 导出/删除账号数据与账号计费入口 | 只读确认当前入口与动作；若不存在记录排除，不自行加业务流 | 先核对/复用原生能力，待逐项验收 |

### B. Agent 生命周期与每 agent 执行配置

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| B01 | 列出和打开 Main、Sourcer 等 agent | 逐一打开；消息、任务、原卡、文件归属均为所选 agent | 线上已验 Main/Sourcer 与原 Crew |
| B02 | 创建 agent 名称/说明/角色 | 创建测试 agent；刷新/服务重启 definition不丢，新的原生对话/执行上下文归它 | 先核对/复用原生能力，待逐项验收 |
| B03 | 改名、说明、头像/颜色 | 逐字段保存回读；历史 author仍用稳定 agentId | 先核对/复用原生能力，待逐项验收 |
| B04 | 置顶/取消置顶、排序 | 确认当前动作后操作两位 agent，刷新保持顺序/状态 | 先核对/复用原生能力，待逐项验收 |
| B05 | 删除/归档/恢复 agent | 确认是删除还是归档；验收其历史、任务、权限与恢复行为 | 先核对/复用原生能力，待逐项验收 |
| B06 | Agent Details 查看实际配置与能力 | 所见 runtime/model/connection与实际原生执行记录相同 | 先核对/复用原生能力，待逐项验收 |
| B07 | 每 agent 独立选择 runtime | Main/Sourcer不同definition；修改Sourcer不改Main；不迁移正在运行session | 已核对原生仅存逐 bot 模型配置，无逐 bot runtime 字段；需要实现后验收 |
| B08 | 每 agent 独立选择可用 model | 列表来自runtime+connection；实际turn记录选择值；不可用值在边界拒绝 | 线上已验 Sourcer 独立换模型和召回；全部目录待验 |
| B09 | 每 agent 独立绑定 OAuth / API key connection | 两agent可指向不同connection；撤销一个不借另一个账号续跑 | 已核对现有 credential 按 user/provider 选择，无逐 bot connection ID；需要实现后验收 |
| B10 | 编辑 instructions / recruiting职责 | 保存不同职责；同一指令分别产生各自角色所需行为，definition revision可查 | 先核对/复用原生能力，待逐项验收 |
| B11 | 每 agent 启用 skills、tools、memory scopes | 只启用Sourcer的工具/skill；Main不能因共享环境自动获得 | 先核对/复用原生能力，待逐项验收 |
| B12 | 配置变更在下一任务生效，运行任务保留快照 | pending时改runtime/connection应拒绝或仅改后续配置；原卡仍绑定原owner | 先核对/复用原生能力，待逐项验收 |
| B13 | 查看连接错误、能力不可用与恢复 | 断开目标runtime，准确显示该agent失败/不可用；其他agent仍可用 | 先核对/复用原生能力，待逐项验收 |
| B14 | 语音设置/voice交互 | 确认UI动作与可用runtime；若有再验证录音/播放/配置保存 | 先核对/复用原生能力，待逐项验收 |
| B15 | 从已有 Agent 模板选择、导入与创建角色 | 保留模板 ID/版本/来源和初始化上下文；创建后原生 bot 配置/技能/记忆分别回读，不把模板存在当作已采用 | Grok recruiting-persona/template-contract；待核对原生复用与验收 |

### C. 单聊、消息、历史、搜索与渠道连续性

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| C01 | 给指定 agent 发普通消息并流式回复 | Main/Sourcer各发不同标记，完成后各只确认自己的标记 | 线上已验 Codex OAuth 正常流式回复 |
| C02 | 同 agent 同 room 继续对话 | 网页连续两轮、切换和重载后仍属同一获权 thread/bot/run 链；上下文和原卡延续。runtime 提供 session 时另核对，Slack 延期 | 线上已验原 Crew 连续对话；渠道项按当前排除范围处理 |
| C03 | 显示sender、时间、任务与回复归属 | human/agent/system/Slack镜像明确区分；每条replyTo指向正确消息 | 先核对/复用原生能力，待逐项验收 |
| C04 | 引用/回复原消息 | 针对旧消息回复；UI引用和native routing均指同一稳定ID | 先核对/复用原生能力，待逐项验收 |
| C05 | 编辑/删除/重新发送消息 | 确认是否重跑turn/删除显示；不得在验收时擅自重复有副作用任务 | 先核对/复用原生能力，待逐项验收 |
| C06 | 保留历史，分页读更早内容 | 构造超过单页的测试消息；翻页无漏/重，刷新仍归正确agent/session | 先核对/复用原生能力，待逐项验收 |
| C07 | unread与阅读位置 | 收到新消息→未读→打开→已读，切换agent不丢阅读位置 | 先核对/复用原生能力，待逐项验收 |
| C08 | 搜索历史/agent/文件 | 先确认可搜对象；以确知标记检索，不能返回无权限room/文件 | 先核对/复用原生能力，待逐项验收 |
| C09 | 复制文本/代码、打开链接与附件 | 复制保留实际内容；链接/下载指向当前message asset，权限核验 | 先核对/复用原生能力，待逐项验收 |
| C10 | 附件随human消息输入并传原native session | 上传测试CSV/image；runtime读取同字节/hash，另一agent无权文件不可读 | 先核对/复用原生能力，待逐项验收 |
| C11 | 新建/切换/归档conversation | 两agent各两chat；切换历史无串话；归档行为先确认 | 线上已验切换/加载修复；完整归档流程待验 |
| C12 | 中断/取消当前任务，再继续 | 取消Sourcer不停止Main；readback确认interrupted；新turn可继续 | 先核对/复用原生能力，待逐项验收 |
| C13 | 重复请求、断线重连不重复发turn | 同clientMessageId发送两次，只有一native turn；SSE重连不执行任务 | 先核对/复用原生能力，待逐项验收 |
| C14 | Slack绑定对应Web room/feed | 从指定agent attach；Slack消息/原卡只回该room绑定thread | Slack 部分延期；适用网页能力仍须验收 |
| C15 | Slack @触发和实际human身份权限 | 实际授权用户@指定agent；未授权Slack用户/非成员不能操作 | Slack 部分延期；适用网页能力仍须验收 |
| C16 | 绑定Slack后不泄露之前私人历史 | 绑定前写私密标记，绑定后Slack不出现该标记/旧附件 | Slack 部分延期；适用网页能力仍须验收 |
| C17 | 错误、未知回执、重试状态一致 | 模拟连接中断与未知发送回执；UI不标成功、不自动重发副作用 | 先核对/复用原生能力，待逐项验收 |
| C18 | Reset 当前对话并保留持久工作资产 | 明确重置对话上下文，旧聊天不再注入；memory/files/routines/settings 按确认语义保留，旧卡/任务不误续跑 | Grok history-compaction-memory；待核对原生复用与验收 |
| C19 | 长对话上下文压缩、历史回放与持久记忆分离 | 复用 runtime 原生压缩/恢复；长聊后当前岗位、来源、task、原卡和明确记忆仍可核，压缩摘要不冒充原始消息或新授权 | Grok history-compaction-memory；待核对原生复用与验收 |

### D. 群组、成员、@、A2A 与 subagent

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| D01 | 创建含agents/humans的group | 创建测试room；回读name/description/member_agent_ids/human_member_user_ids | 原生 owner + bot 成员群聊可复用；human 成员及 group description 尚缺 |
| D02 | 查看group成员列表 | 打开后显示成员稳定ID/名字/类型，刷新与membership一致 | 先核对/复用原生能力，待逐项验收 |
| D03 | 编辑group name/description | 管理者改名回读；非管理者拒绝；历史仍同room ID | 原生群名编辑可复用；description 与团队管理权限尚缺 |
| D04 | 添加agent成员 | 先找真实Add入口；测试加入Sourcer，保存明确 room/member/context 归属，不伪造 runtime session | 先核对/复用原生能力，待逐项验收 |
| D05 | 移除agent成员 | 移除测试成员；旧卡/消息/API访问拒绝；其他成员不受影响 | 先核对/复用原生能力，待逐项验收 |
| D06 | 添加/移除human成员 | 确认管理入口后加入/移除测试human；SSE、history、file、response即时撤权 | 原生群成员为 bot，尚无 human 成员合同；需要实现及撤权验收 |
| D07 | 退出/归档/删除group | 确认当前动作和权限；按真实行为验收成员与历史可见性 | 先核对/复用原生能力，待逐项验收 |
| D08 | human在group中发送普通消息 | 两位测试human消息能互见且author正确；非成员不得读写 | 原生 owner 聊天可复用；多 human 成员/权限尚缺 |
| D09 | @指定一个或多个agent | @Sourcer只启动Sourcer；同名/非成员/不可见ID不能误路由 | 线上已验单个 @Sourcer；多目标及负向边界待验 |
| D10 | 未@的group消息如何调度 | 先只读确认原App规则；复现明确规则，普通消息不唤醒所有agent | 先核对/复用原生能力，待逐项验收 |
| D11 | 每位 group agent 保有明确独立执行上下文 | 同 room 的 Main/Sourcer 保留正确 bot/run/context/connection 归属；共享群聊与私有记忆区分，该 runtime 有 session 时核对真实标识 | 先核对/复用原生能力，待逐项验收 |
| D12 | agent向agent直接发送消息 | Main明确发送给Sourcer；保存from/to/replyTo且只产生一次目标执行 | 先核对/复用原生能力，待逐项验收 |
| D13 | 委派父任务、子任务与结果回传 | Main委派Sourcer，产物/result回原room/parent一次，所有ID可追踪 | 线上已验 Main→Sourcer 委派；完整任务树待验 |
| D14 | 创建产品管理subagent，独立配置runtime/model/connection | 显式override创建子agent；任务实际调用指定connection/runtime/model | 先核对/复用原生能力，待逐项验收 |
| D15 | 产品subagent显式inherit配置快照 | inherit后修改父definition，子任务仍使用创建时revision；UI可见来源 | 先核对/复用原生能力，待逐项验收 |
| D16 | runtime内部subagent配置与状态 | 只暴露native支持字段；原生事件/child task对应；不支持字段在入口拒绝 | 先核对/复用原生能力，待逐项验收 |
| D17 | 防止自发循环、回声和重复投递 | 重放human/A2A/Slack镜像与agent普通回复；只有显式目标动作唤醒一次 | 先核对/复用原生能力，待逐项验收 |
| D18 | 并发agent状态、卡片与取消隔离 | 两agent同时pending，交叉答卡拒绝，取消一个不改另一个task | 原卡归属已有窄范围验收；现有 group Stop 停整 thread，逐成员取消尚缺 |
| D19 | 成员权限变化期间的运行任务 | 移除成员后禁止后续读写/答卡；取消操作核对native回执，不虚假completed | 先核对/复用原生能力，待逐项验收 |
| D20 | 跨runtime混合group与A2A | 一room两agent绑定不同已验runtime；A2A回原任务，不能共享/伪造native session | 先核对/复用原生能力，待逐项验收 |

### E. 任务、后台运行与 Routines

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| E01 | 查看持久task列表与详情 | 完成/失败/等待任务刷新后可查且定位原room/agent | 先核对/复用原生能力，待逐项验收 |
| E02 | 显示queued/running/waiting/completed/failed/canceled真实状态 | 每状态由native/external回读驱动；accepted不显示completed | 先核对/复用原生能力，待逐项验收 |
| E03 | 查看父子任务与委派进展 | 从root找到child和回传；失败原因/取消状态不被父任务覆盖 | 先核对/复用原生能力，待逐项验收 |
| E04 | 继续等待输入的原任务 | 回答原卡继续原turn；外部Autumn澄清继续同task_id | 先核对/复用原生能力，待逐项验收 |
| E05 | 停止一个/全部实际子任务与后台执行 | 对明确测试树取消，逐个native child/background回读；未停止不标全部结束 | 已核对 group Stop 停整 thread；逐成员/子任务取消控件尚缺 |
| E06 | 创建schedule routine | 创建测试schedule，保存timezone/trigger/prompt，实际触发产生task/run ID | 先核对/复用原生能力，待逐项验收 |
| E07 | 编辑routine名称、prompt、trigger/timezone | 修改后回读；下一run记录生效revision，旧run记录不被改写 | 先核对/复用原生能力，待逐项验收 |
| E08 | 启用/暂停/删除routine | 暂停后不再启动新run；删除/恢复动作先确认；运行中任务状态另核 | 先核对/复用原生能力，待逐项验收 |
| E09 | webhook/Slack keyword等trigger | 确认已授权trigger；相同event重复送达只产生一次task | Slack 部分延期；适用网页能力仍须验收 |
| E10 | 查看last run、历史、错误、产物 | 成功与失败各一run；能回原room并打开对应文件/错误 | 先核对/复用原生能力，待逐项验收 |
| E11 | 后台任务需要人类时持久等待 | 后台产生原卡后等待；未回应不执行，不因重启自动批准 | 先核对/复用原生能力，待逐项验收 |
| E12 | 应用服务、worker 与 runtime 分别重启恢复 | 断Web/SSE、重启应用服务、重启owner分别记录session/card能否原样恢复 | 先核对/复用原生能力，待逐项验收 |
| E13 | routine执行账号/agent/policy归属 | run保存definition/connection/policy revision；连接撤销后不得借其他账号执行 | 先核对/复用原生能力，待逐项验收 |
| E14 | 后台通知与返回原房间 | 等待/完成/失败回原room/thread一次；不发到无关人或其他team | 先核对/复用原生能力，待逐项验收 |

### F. 原生卡、审批、Secure Form 与设置

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| F01 | 完整显示native单选/多选与option值 | 对照native payload与Web/Slack选项顺序/值，回答原request | 单选及原卡重启继续已验；原生 Ask 尚无多选合同 |
| F02 | 自定义文本输入保持原值 | 输入含空格/中文/换行，native接收内容与用户值完全一致 | 线上已验普通自定义输入；当前原生路径 trim，首尾空白原值保留尚缺 |
| F03 | 多问题/多字段表单与required/schema | 真实已授权elicitation逐字段比对，缺required拒绝，不改field ID | 原生 Ask 无多字段 schema；MCP 未声明 elicitation，尚需实现与恢复验收 |
| F04 | URL/浏览器绑定Secure Form | 由原URL/elicitationId完成原form；native状态确认，秘密值不进日志 | 原生 OAuth 不等于 URL elicitation；远端表单原请求桥接尚缺 |
| F05 | 命令执行一次性approve/deny | 展示完整command/args/cwd；approve/deny精确原request；deny后无执行 | 先核对/复用原生能力，待逐项验收 |
| F06 | 文件变更/diff一次性approve/deny | 显示完整变更范围；批准后字节匹配，拒绝后无变更 | 先核对/复用原生能力，待逐项验收 |
| F07 | 外部发送draft原文/目标/thread审批 | 展示原正文/收件人/渠道/thread；批准与拒绝分别核对真实外部状态 | 先核对/复用原生能力，待逐项验收 |
| F08 | 精确卡片owner与scope revision | Main卡提交Sourcer路径、另一connection/turn、改revision均拒绝 | 先核对/复用原生能力，待逐项验收 |
| F09 | 同卡Web/Slack竞争与重复答复 | 两入口同时答，同原native request只接受一次；另一入口回读resolved | Slack 部分延期；适用网页能力仍须验收 |
| F10 | 卡片过期、取消、连接丢失与unknown | 过期native request不可再答；unknown回执核对前不显示success/自动重试 | 先核对/复用原生能力，待逐项验收 |
| F11 | auto-review开关与实际运行判定 | 开/关回读；同测试操作实际判定随保存policy变化，记录版本 | 先核对/复用原生能力，待逐项验收 |
| F12 | custom allow/block rules与优先级 | 冲突规则按确认的App语义执行；block动作不能被allow/skill绕过 | 先核对/复用原生能力，待逐项验收 |
| F13 | 撤销一次性/长期授权与审计 | 撤销后新操作重新授权；记录actor、scope、native owner和结果，无秘密 | 先核对/复用原生能力，待逐项验收 |
| F14 | 未知原生交互类型 | 输入未声明native type，显示不可用且不向runtime发送伪响应 | 先核对/复用原生能力，待逐项验收 |
| F15 | General其他设置、语言/时区、通知等 | 逐项确认当前App有的设置；保存→重启→实际行为一致 | 先核对/复用原生能力，待逐项验收 |

### G. Library、文件、产物、截图与 Computer

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| G01 | Agent Library列出CSV/XLSX/brief/rules | 分页列出name/type/size/etag；只显示获权agent资产 | 先核对/复用原生能力，待逐项验收 |
| G02 | 上传文件并供agent读取 | 上传小CSV/XLSX/text，回读字节/hash；agent读取正确版本 | 先核对/复用原生能力，待逐项验收 |
| G03 | 预览CSV/XLSX/text/PDF/image | 按当前App确认的类型逐个预览；内容/编码/权限正确 | 已有 HTML/Markdown/PDF/image 预览；CSV/XLSX 网格及 Artifact 纯文本预览尚缺 |
| G04 | 下载原文件/截图 | 下载bytes/hash与原asset一致；不能以链接返回当成功下载 | 先核对/复用原生能力，待逐项验收 |
| G05 | 删除/替换/重命名Library文件 | 确认动作后更改并回读；旧etag不误读新内容，删除后不再授权访问 | 先核对/复用原生能力，待逐项验收 |
| G06 | 外部文档/Drive等引用与created_by_bot | 已授权文档列出真实来源；撤销连接后不可借缓存越权拉取 | 先核对/复用原生能力，待逐项验收 |
| G07 | 区分用户资料与agent生成产物 | 新产物回task/room/agent，来源与Library上传文件不同但权限一致 | 先核对/复用原生能力，待逐项验收 |
| G08 | 截图/文件向原Slack thread交付 | 发送已授权测试asset，Slack原thread真实附件bytes/hash一致 | Slack 部分延期；适用网页能力仍须验收 |
| G09 | 文件权限、分页与大小边界 | 跨用户下载拒绝；超页可列全；无编辑权不可上传/删除 | 先核对/复用原生能力，待逐项验收 |
| G10 | Computer preview/会话画面 | 后期连接获权computer session；预览timestamp/session与实际控制对象一致 | 先核对/复用原生能力，待逐项验收 |
| G11 | browser/remote desktop观察与操作 | 在明确授权的测试页执行一次无副作用操作；回读实际UI状态 | 先核对/复用原生能力，待逐项验收 |
| G12 | computer screenshot与文件upload/download | 各取/传一份测试文件并核hash；权限与实际session一致 | 先核对/复用原生能力，待逐项验收 |
| G13 | local shell/tool能力与permission | 能力声明与真实支持一致；测试权限卡拒绝后无local执行 | 先核对/复用原生能力，待逐项验收 |
| G14 | computer控制权、暂停、取消与连接错误 | 确认当前App控件；暂停后无继续动作，cancel有native回执 | 先核对/复用原生能力，待逐项验收 |
| G15 | mobile/local messages/discover tool等能力 | 只读确认当前安装版本可见能力；存在才分runtime验收，不推断全支持 | 先核对/复用原生能力，待逐项验收 |

### H. Memory、Skills、Plugins、OAuth 与 API key

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| H01 | 查看agent私有memory facts | 写入已授权测试fact后list回读ID/时间/来源/范围 | 先核对/复用原生能力，待逐项验收 |
| H02 | 写入/更新/删除并recall长期事实 | 写→读→更新→recall新值→删→不再召回，保留版本审计 | 线上已验写入/跨对话召回；新修订/撤销链待验 |
| H03 | 私有记忆与transcript分开 | 普通临时聊天不自动变永久rule；B不能召回A私有fact | 先核对/复用原生能力，待逐项验收 |
| H04 | 选择facts显式promote到team | promote前B不可读，后获权可读；created/already共享不重复 | 当前 user scope 只共享同一用户的 bots；跨 human team promote 尚缺 |
| H05 | 团队context summary版本/新鲜度 | 事实更新后旧summary显stale；重建后版本/来源可查 | 原生聊天压缩可复用；team summary 版本/新鲜度尚缺 |
| H06 | memory scope、作者、来源与权限撤销 | user/agent/room/task/team逐scope正反向检查；移出team立即不可recall | 先核对/复用原生能力，待逐项验收 |
| H07 | memory profile/logs导入导出 | 先确认公开可用导出/导入能力与授权；不能从wire伪造全量迁移 | 先核对/复用原生能力，待逐项验收 |
| H08 | 列出/读取skill详情与来源 | 回读skill名称/版本/hash/source；展示实际加载内容 | 先核对/复用原生能力，待逐项验收 |
| H09 | 安装/创建/编辑/删除skill | 保存测试skill后runtime实际加载新revision；删除/停用后不加载 | 先核对/复用原生能力，待逐项验收 |
| H10 | 按agent启停skill与工具依赖 | 仅Sourcer启用；Main不能获得；缺工具授权明确拒绝调用 | SKILL.md 为 user/Space 目录，taught skills 为 bot；逐 bot recipe 启停尚缺 |
| H11 | 查看插件目录、已安装与连接状态 | 分别显示installed/authenticated/enabled；状态由实际回读而非硬编码 | 先核对/复用原生能力，待逐项验收 |
| H12 | 插件安装/移除与scope | 确认原App动作；在测试plugin作用域安装/移除，不波及其他用户/agent | 先核对/复用原生能力，待逐项验收 |
| H13 | OAuth连接、回调、失败与撤销 | 使用已授权测试连接核对外部account/scope；revoke后调用拒绝 | 先核对/复用原生能力，待逐项验收 |
| H14 | API key连接与保护存储 | 只用明确授权连接；key不入DB明文/日志/模型；只展示metadata与引用 | 先核对/复用原生能力，待逐项验收 |
| H15 | 自定义MCP服务器/工具配置 | 真实支持的已授权server discover→只读call；tools显示与native一致 | 先核对/复用原生能力，待逐项验收 |
| H16 | 插件工具permissions与原生elicitation | 执行已授权工具，原schema/request回答后同tool续行；撤权拒绝 | MCP 逐 bot 工具白名单/版本校验可复用；elicitation/form 合同尚缺 |
| H17 | 日历/邮件/Drive/Clay/Instantly/Supabase/GitHub/Origin | 逐个记录实际account/scope，以已授权最小只读动作验；写动作单独授权 | 先核对/复用原生能力，待逐项验收 |
| H18 | Apollo与Slack当前账号连接 | 按账号实际授权连接 Apollo，核对工具发现/只读调用与撤销；Slack 延期，新增付费停止 | Slack 部分延期；适用网页能力仍须验收 |
| H19 | runtime认证与工具认证独立 | runtime有效/MCP撤销时普通chat仍可用、tool拒绝；不能其他connection代跑 | 先核对/复用原生能力，待逐项验收 |
| H20 | 模型/runtime切换后授权memory/skills/tools共享 | 新runtime仅获产品授权资产；旧pending/session留原runtime，不假称原生历史迁移 | 先核对/复用原生能力，待逐项验收 |

### I. 招聘功能专门化与外部服务

| ID | 产品能力 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| I01 | JD导入、澄清与RoleSpec确认 | 实际JD缺项→澄清→确认，记录规格revision与来源 | 自然岗位描述创建/绑定 v1 与同群读回已验；JD URL 来源及完整条件澄清仍有缺口 |
| I02 | 创建Autumn真实search task | 使用已授权连接；真实task_id、status、source回读可核 | 已发布原生 task/action 实现；真实创建待验 |
| I03 | Autumn澄清继续原task | 原task提出问题→用户回答→continue相同task_id，结果关联一致 | 已发布同 task 续搜实现；真实反馈续搜待验 |
| I04 | 候选证据卡与来源链接 | 每个关键判断能指原来源/日期；空字段不编造，不把模型生成当搜索 | 已读 provider 原始结果并转述；独立证据判断待做 |
| I05 | 小批候选approve/reject与原因校准 | 真实批次反馈→保存→继续原search；业务判定与provider grade分开 | 先核对/复用原生能力，待逐项验收 |
| I06 | 去重、role/client/org来源关联 | 相同稳定来源只建一次；client/role用完整同源对，不用空数据覆盖 | 先核对/复用原生能力，待逐项验收 |
| I07 | 候选stage/review disposition/notes/undo | accept/reject不改stage；内部notes不外发；undo恢复最近review | 先核对/复用原生能力，待逐项验收 |
| I08 | profile/JD切换保留各自阅读位置 | 读到两处不同位置往返切换，各自位置保持 | 先核对/复用原生能力，待逐项验收 |
| I09 | 持续sourcing与配置锁定/纠偏 | 确认规格后routine按该revision运行；反馈更新只作用后续任务 | 先核对/复用原生能力，待逐项验收 |
| I10 | 联系草稿与发送outbox分离 | 生成草稿后pending outbox仍为零；批准前无外部消息 | 先核对/复用原生能力，待逐项验收 |
| I11 | 经批准的真实发送/sequence与回执 | 展示原文/目标后明确批准；唯一business ID、真实receipt、未知不重发 | 先核对/复用原生能力，待逐项验收 |
| I12 | 回复后停止follow-up与状态更新 | 测试回复进入后后续scheduled sends停止，CRM stage/review不混写 | 先核对/复用原生能力，待逐项验收 |
| I13 | enrichment供应商与消耗权限 | 逐供应商确认连接与成本；未授权不自动waterfall/消耗credits | 先核对/复用原生能力，待逐项验收 |
| I14 | 职位/候选/任务/草稿搜索与历史追溯 | 从候选找role/source/search task/review/draft；权限过滤全链一致 | 先核对/复用原生能力，待逐项验收 |

## J. Juicebox 招聘工作台

| ID | 产品能力 | 退出条件 | 研究映射 / 当前状态 |
| --- | --- | --- | --- |
| J01 | JD/描述/链接/附件启动；结构化召回条件与语义资格分开 | 同一岗位版本贯穿聊天、条件编辑、检索与评估；不把召回范围写成资格 | JB-MATCH:J01–J03；待核对原生复用与实施/验收 |
| J02 | 聊天输入与当前项目/岗位范围 | 正常消息绑定正确 project/role/thread；切换项目不夹带旧 composer 或任务 | JB-FLOW:F01；待核对原生复用与实施/验收 |
| J03 | 单选/多选/Other/跳过与自定义输入 | 答案绑定原问题；提交失败仍可重试；确认后可从持久记录回读 | JB-FLOW:F02；待核对原生复用与实施/验收 |
| J04 | 工具进展及类型化结果卡 | 准备、执行、结果、错误与实际状态一致；显示原工具产物而非伪造文本 | JB-FLOW:F03；待核对原生复用与实施/验收 |
| J05 | 小批样本校准：接受/拒绝/原因 | 逐候选、原批次、岗位版本、用户及真实提交关联；下一轮采用反馈可核查 | JB-FLOW:F04; JB-MATCH:J07；待核对原生复用与实施/验收 |
| J06 | 手动编辑条件及 filters | 先保存成功并更新版本，再让 agent 使用；失败/冲突不显示已采用 | JB-FLOW:F05；待核对原生复用与实施/验收 |
| J07 | 开始 sourcing 前保存 shortlist-only / sequence 外联设置 | shortlist-only 不入列或发送；sequence 设置版本、账号权限及实际模式一致，未授权不发送 | JB-FLOW:F06；待核对原生复用与实施/验收 |
| J08 | 已找到名单的批准及缓存同步 | 批准是持久业务动作；刷新/多页后结果一致，不能仅靠本地选中 | JB-FLOW:F07；待核对原生复用与实施/验收 |
| J09 | 聊天停止/重连与 sourcing pause/resume/close/reopen 独立 | 停止 turn 不等于停止远端搜索；关闭项目可明确选择是否取消 sequence，并显示部分失败数量；恢复原项目不重复创建任务 | JB-FLOW:F08–F10；待核对原生复用与实施/验收 |
| J10 | 候选人卡片/表格、筛选、分页及列表状态 | 显示真实候选快照；稳定标识、排序/过滤/页码可恢复；无串任务数据 | JB-MATCH:J02–J04；待核对原生复用与实施/验收 |
| J11 | 逐条件结果与 profile 证据定位 | 来源片段/引用可打开，未知与不满足分开；分数不代替证据或硬条件 | JB-MATCH:J04–J06；待核对原生复用与实施/验收 |
| J12 | 项目 private/shared、协作者和管理权限 | 列表、详情、修改、删除均在服务端鉴权；只读角色不能靠客户端按钮获写权限 | JB-ACL:roles-projects；待核对原生复用与实施/验收 |
| J13 | 邮箱 owner/shared/public 与实际发送权限 | 连接可见不等于可发送；sender 选择和最终发送一致核验授权 | JB-ACL:mailbox-send-authority；待核对原生复用与实施/验收 |
| J14 | 组织配额、用量、导出/enrichment 权限与费用边界 | 显示真实账户单位；额度未知/不足不误报成功，不触发新购买；权限不由 analytics 标签决定 | JB-ACL:exports-plan-credits; JB-ACCOUNT:JC01–JC04；待核对原生复用与实施/验收 |
| J15 | 组织级 agent 自动化与 MCP 控制 | 管理员策略真实限制 agent/tools/自动操作；个人连接不能绕过组织政策 | JB-ACL:organization-agent-controls,organization-mcp-connectors；待核对原生复用与实施/验收 |
| J16 | Company / User Knowledge Vault 两类描述编辑器 | 分别读取、编辑、保存并刷新读回；账号/公司 scope 与来源明确，不冒充逐项事实 CRUD | JB-WEB:W03；待核对原生复用与实施/验收 |
| J17 | Memory 参与、采用的 learnings 与反馈 | 显示实际被注入/采用的记忆版本及影响；普通反馈未持久时不显示已学习，撤销后新 run 不再采用 | JB-WEB:W04；Grok memory-write-injection；待实施/验收 |
| J18 | 可展示的 Thinking/活动摘要流 | 仅渲染 provider 实际提供并允许展示的活动或摘要；流式开始/增量/结束与实际 run 对应，不请求或伪造隐藏推理 | JB-WEB:W01；MX-WEB:W02；Grok activity；待核对原生复用与验收 |
| J19 | Shortlist / unshortlist 单人及批次反馈 | 对稳定候选/项目保存真实可逆选择，刷新后保持；不隐式导出、enrich、入 sequence 或发送 | JB-FLOW:F03,F07；待核对原生复用与实施/验收 |
| J20 | 单人/批量候选导出与费用预览 | 明确字段/范围及已有费用单位；实际授权后导出正确名单字节，取消无导出或消耗，结果未知不盲重试 | JB-FLOW:F03；JB-ACL:exports-plan-credits；待实施/验收 |
| J21 | 直接传入候选 profile / LinkedIn URL 并分析 | 读取指定真实 profile，保留候选身份与来源/时间；未读内容标未知，不将链接存在当能力证据 | JB-FLOW:F03 fetchProfiles/findProfilesByLinkedIns/profileAnalyzer；待实施/验收 |
| J22 | 人才池、市场研究与人才流动洞察 | 研究范围/数据来源/时间、样本覆盖和实际结果可核；报告与 candidate assessment 分开，不声称复现私有评分算法 | JB-FLOW:F03 contextResearch/evaluatePool/talentInsights/talentFlow；待核对原生工具/实施/验收 |

## M. Metix 招聘工作台

| ID | 产品能力 | 退出条件 | 研究映射 / 当前状态 |
| --- | --- | --- | --- |
| M01 | 快速搜索、深度研究、持续 Agent、recent query / autocomplete 入口和任务类型 | 按用户选择执行实际可用的对应能力，JD/链接/附件归正确 session；不同模式状态不能混用，最近查询/补全建议不能冒充已执行搜索 | MX-DEEP:M01; MX-MATCH:MX01,MX03；待核对原生复用与实施/验收 |
| M02 | 任务创建、激活和实际运行分离 | 已创建不显示已启动；权限/额度检查和激活回执归同一任务，未知结果不重复消耗 | MX-DEEP:M02；待核对原生复用与实施/验收 |
| M03 | 搜索轮次/结果代际及列表访问 | 每次结果绑定明确 generation/search ID；访问授权、总数与完整页来自实际服务端状态 | MX-DEEP:M03；待核对原生复用与实施/验收 |
| M04 | 候选 Cards/Table、分页/筛选/排序与旧请求取消 | 切换 search/role/page 后迟到结果不覆盖当前列表，选择/过滤状态保留 | MX-DEEP:M04; MX-MATCH:MX03–MX04；待核对原生复用与实施/验收 |
| M05 | 职业时间线与可解释年限核算 | 按本岗位日期/全职/重叠规则计算；不用最早年份到现在替代实际年限 | MX-DEEP:M05；待核对原生复用与实施/验收 |
| M06 | 持久事件回放、流式 blocks/run 和输入可用状态 | 重载/分页不漏重；原卡、消息及 run ID 一致；停止/关闭/待答状态明确 | MX-DEEP:M06; MX-MATCH:MX09；待核对原生复用与实施/验收 |
| M07 | 岗位 brief / must-have / nice-to-have /职责、JD 与候选侧岗位预览 | 显示权威条件版本与真实原材料，逐候选 criterion 稳定关联，不靠 label 猜 ID | MX-DEEP:M07; MX-MATCH:MX02；待核对原生复用与实施/验收 |
| M08 | 候选逐项 met/unmet/unknown 和展开详情 | required/preferred 分清；缺理由不生成默认“潜在匹配”；任一缺证据不冒充通过 | MX-MATCH:MX06–MX08；待核对原生复用与实施/验收 |
| M09 | 匹配评分/推荐理由和活动摘要分离 | 分数单位、来源、评估版本明确；推荐理由、来源证明、可见活动摘要各自真实 | MX-MATCH:MX04–MX05,MX07–MX08；待核对原生复用与实施/验收 |
| M10 | 反馈动作和 follow-up 选择/自由输入 | 原 session/run/block/action/candidate 绑定；持久确认前不伪称已学会或执行成功 | MX-MATCH:MX09；待核对原生复用与实施/验收 |
| M11 | 手动外联与自动模式配置 | 默认仍按现有外发审批；自动模式只有明确保存的适用授权才可运行，不能由模式切换绕过权限 | MX-DEEP:M08；待核对原生复用与实施/验收 |
| M12 | Sequence：收件人、冲突预检、草稿、预览、入队 | 保存的有效草稿和精确目标对应；重复入列/编辑冲突/权限失败不重发 | MX-DEEP:M09；待核对原生复用与实施/验收 |
| M13 | 配额与 email credits 预检和实际服务拒绝 | quote 失败不当作足额；服务端拒绝、原任务及余额同步可核，不自动购买 | MX-DEEP:M10；待核对原生复用与实施/验收 |
| M14 | 外联 timeline 与 sent/reply/interested/failed 统计 | 计数来自真实事件；pause/stop/resume 与后续实际执行一致；回复后停止跟进 | MX-DEEP:M11；待核对原生复用与实施/验收 |
| M15 | 候选、外联、聊天、interview 视图连续导航 | 正确清理不适用 filter，保留各视图阅读位置；不残留上个 stage/search 的条件 | MX-DEEP:M12；待核对原生复用与实施/验收 |
| M16 | 用户工作流默认值与候选侧 recruiter 展示身份 | 保存实际用户配置并在新任务生效；候选侧显示真实获准字段，与组织权限和模型指令分离 | MX-WEB:W08；待核对原生复用与实施/验收 |
| M17 | 项目/岗位/搜索会话改名与刷新恢复 | 修改持久标题后重新读取确认；原 session/search/role ID 和结果不变，不因改名新建搜索 | MX-DYN:updateTitleRemark；静态/动态观察不替代本产品验收 |

## 研究来源索引

这些别名指向已归档研究，不是新的服务 API 或当前上线证明。原件哈希和精确位置保存在私有 provenance manifest，公开文档只保留功能摘要。

| 别名 | 研究范围与证据边界 |
| --- | --- |
| JB-FLOW | Juicebox Eren 输入、问题卡、工具卡、校准、配置、名单、sourcing/chat 生命周期；客户端静态分析 |
| JB-MATCH | Juicebox JD/结构化召回与语义条件、候选结果/证据定位、反馈；客户端静态分析 |
| JB-ACCOUNT / JB-ACL | 组织角色、项目/邮箱权限、配额/导出、agent/MCP 管理；有限 UI 与静态分析，服务端行为未知 |
| MX-DEEP / MX-MATCH | Metix 模式、激活、代际、cards/table、条件/理由、反馈、外联/sequence、导航；有限 UI 与静态分析 |
| JB-WEB / MX-WEB | 可见 reasoning/活动、Knowledge Vault、memory 参与/采用、persona 和用户工作流展示；静态分析，私有写入算法未知 |
| JB-DYN / MX-DYN | 获准的页面/网络观察：创建、聊天/问题、历史重载/重连、候选分页/详情、rename；只证明对应观测窗口 |
| GROK | 原生 UI、安装包协议/renderer、memory/template/reset 及已导出对话研究；存在协议不等于公共 API 或已执行 |
| 内部/未知边界 | debug-only Minos memory、受内部权限限制的 conversation outline，以及私有缓存/压缩生产算法：缺少普通用户可用或服务端语义证据，不冒充公开功能或自行绕过权限；其对应正常历史、memory 与活动功能仍须验收 |

## 当前状态与后续执行

- 云端当前产品版本 `6554c46`；已验证登录、保存的 Codex OAuth、新一轮原 Crew 回复和旧状态保留。T01–T05 现有实现已发布，真实招聘业务验收仍未完成。
- T05 跨新 run 的读结果恢复：已有本地 DB 实现与真实 PostgreSQL 检查；executor/adapter 集成未完成。
- T06：递归条件/年限核心已提交 `af3b123`，33 项 focused 及独立审查通过，尚未部署；来源材料校验、原生评估工具和持久评估尚未贯通。
- T08：原生 Web 五视图只读面板已修复来源归属/同 thread 版本刷新问题，23 项 focused、类型/构建及独立审查通过，已提交 `9427a15`，尚未发布；原消息导航 API、交互与手机待完成。
- 原 P0–P6 / T01–T10、原 A–I 139 项和新增动作全部保留。上游现成能力先验收；缺的产品能力进入共享调用点。不能因 M1 完成就停止，也不能只补一个演示任务而取消后续工作。

## 证据与完成门槛

每个 ID 的完成记录应包含：代码版本、可测试页面、真实 actor/space/role/thread/bot/run、当前 runtime/model/connection、实际输入、持久读回/外部回执、适用截图或文件 hash，以及权限/恢复边界。私人原件单独保存，不进入公开仓库。

全表适用动作都实现并验收后才完成总 Goal。暂时不可验证的项目保留缺口；静态发现、UI 入口、worker 报告、离线 green 或旧版本截图均不能代替本版本真实验收。
