> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# 现有数据库与复刻 UI 的后端变更方案

状态：设计建议，尚未修改产品代码、执行迁移或发送任何业务请求。范围沿用本次 Sequence、Shortlist、Contacts、Analytics、Interview、Inbox、Profile 与精简导航。

## 1. 基线与判断依据

当前产品分两层：Rakazo/Headhunter 产品库（Prisma）与既有 CRM/Supabase 数据源。不能把旧 `repo/` CRM schema 当作整个现役产品数据库，更不能只修改 CRM 表就声称新产品流程闭环。

本次精确核对本地 `origin/main`：`55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d`（#658）。[基线和文件哈希](baseline.json)、[schema 快照](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/db/prisma/schema.prisma)。这是本地已获取主线的代码证据；没有在线拉取来证明远端最新，也没有生产库 introspection 或部署版本核验。下文“已有”表示代码中存在，不表示该生产用户的连接已配置或业务已经验收。

## 2. 结论：在已有业务对象上补缺口

不重建 CRM，不另做评分服务或发送调度器。沿用职位、候选人、CRM 镜像、原生操作回执、授权、工具与执行器。新增持久化仅服务 UI 明确需要而现有记录表达不了的状态；Web 按钮和 Agent 调用同一个业务服务。

| 功能 | 已有能力（代码确认） | 本次真正要补的变化 | 数据影响 |
|---|---|---|---|
| 全局/职位视图 | `RecruitingAccountViewInputSchema` 已包含角色、shortlist、contacts、sequence、inbox、interview 等视图与 roleId | 精简导航映射到已有账户级入口；不能要求先点某个角色才能打开 | 不因导航分组新建表 |
| Contacts / Profile | CRM 联系人、角色关联、缓存 Profile、笔记、来源与关联结果；`mergeRoleCandidates` 合并展示 | 补齐头像/公司/学校/logo/LinkedIn 链接的数据投影，详情页与联系人行共用展示数据；保留来源身份 | 优先扩充现有 Profile/Occurrence 投影；不另建一份候选人主库 |
| Shortlist | `RecruitingCandidate.shortlisted/shortlistedAt/revision` 与人工操作出处 | 卡片、表格、抽屉同一个 shortlist 写入口；全局结果携带 roleId；批量变更逐项返回结果 | 复用已有 role+candidate 关系；不是 candidate 全局一个布尔值 |
| Worth Talking / ranking | `match.score/rank/tier`、保留来源字段、sortAvailability、来源 Profile 与 Assessment | 按用户本轮要求：优先复用已有分数做排序和高分分组；不额外调 JEV/LLM 重评 | 派生展示值，默认不复制为人工 shortlist 或兴趣字段 |
| Sequence | OutreachSequence 内容格式、实际 Campaign/Lead 读取、步骤/发送窗口、原生外部操作与回执 | 独立的零收件人草稿、命名、步骤编辑、变量、设置、发布与回读；已有内容格式要求 recipients.min(1)，不能直接当零收件人编辑器模型 | 增加原生 Sequence 草稿实体；外部 campaign/lead 状态仍以真实服务返回为准 |
| Inbox | 邮件完整内容、线程信息、附件、CRM 镜像、导入历史、reply 操作结果 | 统一列表/详情、用户已读状态与未读计数；分页搜索不能逐角色拉完历史再在浏览器过滤 | 新增最小用户阅读状态；保留现有邮件内容和来源 |
| Interview | Scheduling plan、单一具体时段、源邮件、日历验证、booking/confirmation 分开记录 | 扩展多个候选时段、额外 guests、Online/In person、地址/链接、notes；编辑表单接现有 plan 服务 | 扩展现有 plan contract/记录；不另建 booking 引擎 |
| Analytics | Shortlist 时间、账户汇总、campaign sent/opened/replied 和 interested 的部分观察值 | 按日期、职位、campaign、同一批候选人定义指标；补 clicked/bounced 等来源字段与可查询记录；完整覆盖才给确定总数 | 查询已保存业务记录及真实供应商事件；不把缺失填0 |

已有来源：[候选人与分数字段](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/contracts/src/recruiting.ts)、[账户视图](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/contracts/src/recruiting-account.ts)、[排期格式](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/contracts/src/recruiting-scheduling.ts)、[业务读取](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/adapters/src/recruiting-reads.ts)、[账户汇总](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/adapters/src/recruiting-account.ts)。

## 3. Worth Talking：采用已有分数，不引入新的判断链

用户方向已确认：优先使用现有打分形成 ranking，高分候选人进入 Worth Talking；没有新增 JEV/LLM 调用的必要。

具体规则：

- 原始 score、rank、tier 和 source/result identity 保留；新标签只是这些数据的展示分组。
- 现有 contract 明确写着 rank/score **只在同一个 saved result 内可比**。因此先在同一职位、同一可比较结果集合内排序；不能跨职位把80分和另一标准80分混排，也不能把“rank 1”默认当作比“rank 2”更差。
- score 的升降方向、范围、tier 含义必须来自实际来源数据；不能从字段名推断。rank 通常数字越小越靠前，但实现需服从该来源语义。
- Worth Talking 的精确分界属于唯一尚未确定的产品参数：用现有等级映射、某个分数线，或前N名。方案不擅自写死80分/前20%。参数确定前，现有分数排序本身可独立实现。
- 同分用稳定 candidate key 打破顺序，避免翻页跳动；缺分不是0分，放入明确的未评分集合。
- 排序/筛选在完整的授权查询范围内执行，然后分页；计数来自同一过滤条件，不对当前50张卡片局部排序冒充全量排名。
- 改JD后旧分数保留来源与版本，不静默改写为新JD评分。排序本身不调用模型、不自动触达、不改变人工 hold/pass。
- Shortlist = 招聘者选择；Interested = 候选人兴趣/回复；Worth Talking = 已有分数的优先联系分组。三者独立展示和统计。

若未来明确需要对无分数据补评，再限定具体对象与任务调用 JEV/LLM；本次方案不添加自动补评流程。

## 4. 最小数据变更

### 4.1 Sequence 草稿

建议增加一个 `RecruitingSequence` 业务实体，原因是用户需要反复打开、编辑、保存尚无收件人的 Sequence；现有外部调用回执是审计事实，不能充当任意可修改的草稿。

最小字段（拟议新增，不是现有schema）：id、spaceId、ownerUserId、roleId、name、description、revision、steps（顺序/主题/正文/等待时间/变量引用）、sender connection reference、delivery（时区/窗口/工作日）、stopOnReply、publishedRevision、已确认的 provider campaign reference、archivedAt、createdAt/updatedAt。连接只引用既有 Connection/MCP 记录，不复制凭据。变量清单与可解析数据属于服务端 contract，预览与发送使用同一渲染逻辑。

发布/添加收件人继续通过现有工具与业务服务执行，保留 idempotency、授权、审批及真实回执。编辑中的 revision 与已发布 revision 分开；修改已审批内容会让原审批不再适用。打开空草稿绝不调用发送或自动启动。

是否新增 recipient 关系表取决于加入序列动作的现有回执能否提供可查询的 sequence+candidate+provider lead 关联：先使用现有持久关联；只有真实缺口才新增最小关系表，不预先复制整个外部 Lead 系统。当前尚未逐个服务连接核验该写能力，不能承诺只改一个 API 就具备所有 campaign 操作。

### 4.2 用户阅读状态

现有 `Correspondence.unread` 是供应商观察字段，注释明确不是 application viewed-by state。若要复刻 Inbox 未读 badge，需要 owner/space/source/thread 或 message identity 对应的阅读记录（例如 lastRead 时间/已读 message key）。具体按线程还是按消息，应与复刻的交互契约统一；不能只存组件内布尔值，不能因另一用户读信就清掉当前用户未读数。

阅读状态不修改历史邮件正文；是否同步供应商 read/unread 属于独立服务动作，不由打开详情隐式推出。

### 4.3 Profile 媒体

现有 `RecruitingSavedProfile.profile`、CRM contact.profile、原始来源 Artifact 可保留媒体字段。将已存在的头像、公司/学校 logo URL 明确投影给前端；公共组织 logo 可沿用现有 `OrganizationLogo`。具体字段是否存在由实际保存结果确认，不能仅凭截图补出 URL。主线已有 PersonAvatar、CompanyLogo、profileAssets 与组织批量查询组件，实施复用它们；stage 当前全局 Contacts 未渲染这些媒体，须核对实际页面接线与部署版本，不能以源码存在代替验收。

图片与业务图标分开：LinkedIn 图标是界面资源；候选人头像/雇主/学校 logo 是数据资源。不能把竞品示例人物照片固定贴到自己的候选人记录。完整组件及资源核对见 [Profile 媒体清单](../design-details/PROFILE-ASSETS.md)。

## 5. 后端到 UI 的实际链路

1. **人选与分组**：保存结果/CRM镜像 → 授权身份关联 → 按同一职位及结果评分口径查询 → 服务端排名与筛选/计数 → 卡片/Contacts/Profile → 人工Shortlist。已知联系人身份与来源去重保留原始关联，不能按显示姓名合并。
2. **触达**：Sequence草稿 → 变量预览与收件人核对 → 现有原生确认/执行 → provider返回campaign/lead/message标识 → 保存回执与关联 → Sequence/Inbox/Profile同一记录更新。
3. **回复**：邮件同步/实时授权读取 → 按来源message ID去重、保留candidate+role关系 → Inbox显示 → 阅读状态更新 → 回复草稿 → 精确确认 → 执行/真实结果回读。失败与uncertain单独显示，不能本地先冒充已发送。
4. **面试**：已读候选人邮件+真实availability → 编辑排期计划 → 校验时区、时段、参与人 → 精确确认 → booking回执 → confirmation回执 → Interview回读。预约成功和确认邮件成功是两个结果。
5. **统计**：上述实际保存时间与事件 → 同一日期/职位/序列过滤 → 去重与覆盖检查 → Analytics指标及可下钻列表。列表数量与指标分母必须吻合。

这些是代码追踪得出的目标链路，尚未作为修改后的真实业务E2E跑通。

## 6. 查询与历史数据处理

`readRecruitingImportedCorrespondence` 当前按role读取已完成history-import回执并解析；`getRecruitingCorrespondence` 有逐页汇总导入历史的路径。账户级入口再按role聚合会放大读取成本。因此新列表必须使用有界服务端分页与可查询投影，保留现有回执/Artifact作为原始证据；如需物化索引，只索引本次页面实际需要的邮件和关联字段，不加第二套同步框架。

现有客户数据按owner、space、role和source keys接续；保留附件、原始时间、方向、纠错覆盖顺序、精确来源。导入历史用于阅读，不构成可重放发送权限。迁移不能只按姓名或邮箱猜角色，也不能为省查询丢失客户已保存记录。

## 7. 验证与交付顺序

| 顺序 | 实施范围 | 必须通过的验收 |
|---|---|---|
| 1 | 当前部署与DB实际schema核对，评分/媒体字段盘点 | 确认生产迁移版本、已保存profile字段、实际连接与完整分页；不以本地schema冒充线上 |
| 2 | Contacts/Profile/Shortlist与ranking投影 | 全局及role作用域一致；同一人可在不同职位独立Shortlist；分数缺失/同分/跨结果不可比/筛选后分页均正确；头像logo对人对公司 |
| 3 | Sequence草稿与发布服务 | 0收件人草稿可重开；步骤变量与预览一致；旧revision不覆盖新编辑；不重复发布/加人；外部发送经过原生授权 |
| 4 | Inbox与Interview | 阅读状态跨刷新保留；导入/实时邮件去重；正文附件完整；booking/confirmation两种结果分开；时区与多时段正确 |
| 5 | Analytics与完整UI验收 | 图表/指标能下钻到同一组真实记录；日期与分母明确；unknown/partial如实展示；桌面手机布局按已有标注验收 |

以上设计只服务已经要求的功能，没有新增评价平台、工作流引擎、候选人主库或额外JEV自动判断。UI实施、schema迁移、部署以及真实用户验收是不同交付，须分别报告。
