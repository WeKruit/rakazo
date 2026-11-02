> **评审定稿口径**：以 [实施合同](IMPLEMENTATION-CONTRACTS.md) 和 [当前基线增量](CURRENT-BASELINE-DELTA.md) 为准。Sequence复用现有原生草稿campaign，不新增Sequence表或复制状态。

> 实施口径更新（2026-11-01）：下文保留原始基线盘点，后续评审以 [实施合同](IMPLEMENTATION-CONTRACTS.md) 为准。Sequence 复用已有原生零收件人 draft campaign，不新增 Sequence 表；Worth Talking 复用当前职位版本 Reviewer 分组，不引入本地评分器。完整页面、接口、存储和验收映射见 [实施验收清单](../../REA-IMPLEMENTATION-ACCEPTANCE.md)。本批新增持久结构为 Notes 附件引用、可检索的已保存邮件投影，以及独立于首次阅读基线的后台索引覆盖/续跑记录。个人阅读游标继续复用上一批实现；邮件回填只在已有后台同步循环运行，页面与角标只读。

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
| Sequence | OutreachSequence 内容格式、实际 Campaign/Lead 读取、步骤/发送窗口、原生外部操作与回执 | 独立的零收件人草稿、命名、步骤编辑、变量、设置、发布与回读；已有内容格式要求 recipients.min(1)，不能直接当零收件人编辑器模型 | 复用现有原生draft campaign；不新增Sequence表，外部campaign/lead状态以真实服务返回为准 |
| Inbox | 邮件完整内容、线程信息、附件、CRM 镜像、导入历史、reply 操作结果 | 统一列表/详情、用户已读状态与未读计数；分页搜索不能逐角色拉完历史再在浏览器过滤 | 新增最小用户阅读状态；保留现有邮件内容和来源 |
| Interview | Scheduling plan、单一具体时段、源邮件、日历验证、booking/confirmation 分开记录 | 多时段进入提议邮件，booking仍单时段；来宾、地点、notes按现有日历能力接线 | 保持Cal.com plan；Google沿用create_event，不另建booking引擎 |
| Analytics | Shortlist 时间、账户汇总、campaign sent/opened/replied 和 interested 的部分观察值 | 按日期、职位、campaign、同一批候选人定义指标；补 clicked/bounced 等来源字段与可查询记录；完整覆盖才给确定总数 | 查询已保存业务记录及真实供应商事件；不把缺失填0 |

已有来源：[候选人与分数字段](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/contracts/src/recruiting.ts)、[账户视图](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/contracts/src/recruiting-account.ts)、[排期格式](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/contracts/src/recruiting-scheduling.ts)、[业务读取](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/adapters/src/recruiting-reads.ts)、[账户汇总](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/packages/adapters/src/recruiting-account.ts)。

## 3. Worth Talking：采用已有分数，不引入新的判断链

用户方向已确认：优先使用现有打分形成 ranking，高分候选人进入 Worth Talking；没有新增 JEV/LLM 调用的必要。

具体规则：

- 原始 score、rank、tier 和 source/result identity 保留；新标签只是这些数据的展示分组。
- 现有 contract 明确写着 rank/score **只在同一个 saved result 内可比**。因此先在同一职位、同一可比较结果集合内排序；不能跨职位把80分和另一标准80分混排，也不能把“rank 1”默认当作比“rank 2”更差。
- score 的升降方向、范围、tier 含义必须来自实际来源数据；不能从字段名推断。rank 通常数字越小越靠前，但实现需服从该来源语义。
- Worth Talking仅由当前Reviewer的Promising tier映射；Strong映射Strong Match，Partial/Uncertain保留原意。score只做同职位、同role revision内的组内排序，不另设分数线或前N阈值；非Reviewer旧分数不进入该分组。
- 同分用稳定 candidate key 打破顺序，避免翻页跳动；缺分不是0分，放入明确的未评分集合。
- 排序/筛选在完整的授权查询范围内执行，然后分页；计数来自同一过滤条件，不对当前50张卡片局部排序冒充全量排名。
- 改JD后旧分数保留来源与版本，不静默改写为新JD评分。排序本身不调用模型、不自动触达、不改变人工 hold/pass。
- Shortlist = 招聘者选择；Interested = 候选人兴趣/回复；Worth Talking = 已有分数的优先联系分组。三者独立展示和统计。

若未来明确需要对无分数据补评，再限定具体对象与任务调用 JEV/LLM；本次方案不添加自动补评流程。

## 4. 最小数据变更

### 4.1 Sequence 草稿

草稿的唯一真相源是现有原生draft campaign：0个收件人合法，步骤、发送窗口与stopOnReply均保存在同一campaign。沿用create/ensure_role_campaign/add_leads/pause等既有非发送操作；读取用既有campaign服务。不能把内容Artifact的recipients.min(1)误当系统草稿限制。

**不新增RecruitingSequence表，不复制steps/delivery/revision/publishedRevision。** UI直接编辑已选定的campaign；必要的身份引用沿用现有RoleBinding/ExternalEffect。精确指定campaign，不能按名称猜选另一个草稿。保存不启动发送；正式启动继续经现有原生执行器及精确确认，审批内容变化由既有绑定机制校验。

### 4.2 用户阅读状态

确定为用户×space×来源邮件线程的lastReadAt游标。只有晚于该游标的入站消息触发未读；发件不触发，同一来源线程在多个职位出现仍共享阅读状态。保留标为未读操作，不回写供应商unread。没有来源线程identity时不能按主题/姓名猜合并。

首次启用为每个用户/space记录初始化基线时间，基线之前的历史邮件默认已读；之后的新入站邮件才触发未读。标为已读只推进到实际展示的入站消息时间，不能用客户端当前时间吞掉并发新信。

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
| 3 | 现有原生Sequence草稿编辑 | 0收件人草稿可重开；步骤变量与预览一致；旧revision不覆盖新编辑；不重复发布/加人；外部发送经过原生授权 |
| 4 | Inbox与Interview | 阅读状态跨刷新保留；导入/实时邮件去重；正文附件完整；booking/confirmation两种结果分开；时区与多时段正确 |
| 5 | Analytics与完整UI验收 | 图表/指标能下钻到同一组真实记录；日期与分母明确；unknown/partial如实展示；桌面手机布局按已有标注验收 |

以上设计只服务已经要求的功能，没有新增评价平台、工作流引擎、候选人主库或额外JEV自动判断。UI实施、schema迁移、部署以及真实用户验收是不同交付，须分别报告。

## 2026-11-01 实施核对：Candidates / Profile 媒体

本节更新代码状态，不改变上文原始基线证据；没有执行在线数据库盘点、客户数据回填或付费查询。可公开的逐项覆盖及查询合同见产品仓库 `docs/wekruit/REA-CANDIDATES-UI-COVERAGE.md` 的 “Saved-media inventory and historical repair”。

- 全局 Contacts 已接同页真实候选人的 PersonAvatar / CompanyLogo / LinkedIn 静态图标。查询为 `recruiting_saved_profiles WHERE ownerUserId=actor.userId AND spaceId=actor.spaceId AND personKey IN (当前页精确键)`，页面最大100人；不逐行补查。完整校验后的 `savedProfile` 与显式头像、公司/学校媒体位于共享 DTO。公司媒体只对应当前显示雇主；冲突值为空。Detached CRM 联系人可打开实际只读职业资料，不捏造职位权限。
- Profile/Shortlist 的工作、教育、逐段组织媒体沿用现有结构化 profile / report / timeline 解析；既有完整履历不被摘要、后续评分或补图替换。公司网站/logo仍复用既有组织服务与缓存，不引入候选人主表或第二套媒体框架。
- 历史补齐复用已有 `recruiting.fillRoleProfiles`，新增可选 `dryRun:true`。正常登录客户端调用 `rpc.recruiting.fillRoleProfiles({roleId: selectedOwnedRole.id, dryRun:true})` 即可得到只读盘点；actor/space来自会话，不能通过参数指定他人身份。dryRun不抓图、不调connector、不写profile。
- 身份与查询链：`listRecruitingRolePoolRuns` 校验owned role，读取精确LinkedIn pool keys与属于owner/space的candidate-page runs；`listRecruitingSavedProfiles`读取同owner/space/key；完成的catalog-tool effect按run/user/space统计并分页，每次最多400条，**不再把400当作整个run上限**，从旧到新扫描。当前source connection也必须属于actor/space；现有parser逐人核对LinkedIn key。补写时 `saveRecruitingSavedProfile` 再核对来源effect/run。
- `inventory.missingBefore` 与 `recoverable` 是photo/work/education/employerLogo/schoolLogo的**人数**。work/education表示非空历史；logo表示该人的对应历史至少有一张图，不表示每段经历全部有图。recoverable表示原投影缺失、已保留且可解析的原始来源中有实际值。dryRun下filled/photos/missing是模拟补齐结果，不是写入回执。`sourceCalls`、`sourcePageSize:400`、`sourceCoverage:owned_saved_results`标明读取范围，不代表供应商覆盖率或图片下载已成功。
- `dryRun:false` 使用同一已有服务补齐选定owned role。保留所有完整历史与非空媒体，仅补缺失历史/头像，以及组织名称匹配、已知网站无冲突且来源URL唯一的缺失组织媒体。普通keepSearchHistory也已修复“已有工作+教育导致缺头像永远被跳过”的问题。真正图片复制仍走原有URL/image guards；不补造图片。
- 真正缺失与未知必须区分：纯文本履历本身没有logo URL；受支持结构化Profile记录可保留真实公司/学校logo。断开/删除的source、未知来源形状和parser限制（结构化provider最多80段工作/40段教育，search history最多30段）不能证明其他原始记录中绝无值。原始effect/artifact不修改；不能据此推断头像、组织、邮箱/电话、联系方式验证状态。

验收分开记录：本地合成测试已覆盖同人媒体、完整履历保留、dryRun零fetch/零write、401条来源跨页，以及CRM-only/native单一Candidates标题、角色label与Role details。部署后由实际授权用户先对选定role运行dryRun，记录真实counts，再决定是否执行同范围历史补齐，并检查同人列表→详情→Shortlist图像；当前没有线上counts或上线验收结论。媒体接线和历史修复不需要新增表/迁移；Notes附件的artifact-ID数组属于单独业务状态迁移。
