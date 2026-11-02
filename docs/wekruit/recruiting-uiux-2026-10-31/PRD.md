> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

> **后端与内容补齐增补**：[后端变更方案](backend/BACKEND-CHANGE-PROPOSAL.md)、[逐字段数据映射](backend/DATA-FIELD-MAP.md)、[Profile媒体与图标](design-details/PROFILE-ASSETS.md)。Worth Talking优先使用已有评分排序；头像/组织logo复用现有组件，并核对保存、投影与页面接线。

> **组件级设计增补（本轮实测）**：尺寸、页面高度、响应式、组件状态与互动以 [设计交付入口](design-details/README.md)、[逐页标注](design-details/inspector.html) 为准。新增 99 个配对截图/DOM 状态。Metix Maybe later 可进入 Tailor 表单，Continue to emails 可进入三步邮件编辑器；旧记录中的“未进入编辑器/手机未测”仅表示当时的覆盖范围。本轮已创建一个 UI inspection 未发布草稿，0收件人，未发送。

# 招聘工作台六项功能复刻 PRD 与精简导航

日期：2026-10-31，America/Chicago。对象：WeKruit Headhunter 的招聘人员。目标：按照 Juicebox 与 Metix 的实际界面，把候选人筛选、Shortlist、联系人、外联序列、邮件回复、面试和统计做成可连续使用的工作台，同时减少左侧常驻入口。本次交付为产品与交互规格，未修改或部署产品代码。

## 1 交付内容

| 文档 | 用途 |
|---|---|
| [NAVIGATION-SPEC.md](NAVIGATION-SPEC.md) | 当前左栏到精简左栏的逐项映射、岗位上下文、全局访问与导航验收 |
| [UIUX-SPEC.md](UIUX-SPEC.md) | 真实截图、测量值、布局、组件、滚动、抽屉、选中态与适配要求 |
| [JUICEBOX-PRD.md](JUICEBOX-PRD.md) | Sequences、Contacts、Shortlist、Talent Insights、Outreach Analytics 详细字段和交互 |
| [METIX-PRD.md](METIX-PRD.md) | 评级、候选人分阶段、Inbox、资料、回复、Outreach、Interview 与排期详细交互 |
| [METIX-ACCEPTANCE.md](METIX-ACCEPTANCE.md) | 对应业务和交互验收；是将来实现的检查项，不是已通过的产品测试 |
| [index.html（原始证据未公开）](PRIVATE-EVIDENCE.md) | 本地截图索引与导航对照，按功能查看原始页面 |
| [manifest.json（原始证据未公开）](PRIVATE-EVIDENCE.md) | 本次浏览器观察、页面地址、完整可访问性树和截图的索引 |
| [rea/REPORT.md](rea/REPORT.md) | 最新 REA 6.8.0 的实际分析、来源哈希、源码定位与覆盖限制 |
| [verify.py（原始证据未公开）](PRIVATE-EVIDENCE.md) | 在目录运行 `python3 verify.py`，检查文档链接、捕获文件与截图格式 |

阅读顺序：本页 → 导航规格 → 对应模块 PRD → UIUX → 验收。两份竞品规格保留各站差异；下文定义我们产品中的共同业务边界，不把两家的不同枚举强行合并。

## 2 产品结果与范围

招聘人员应当能在同一岗位下连续完成：查看候选人 → 理解评级与条件证据 → 留下 shortlist/评审状态 → 检查联系人历史 → 选择并预览 sequence → 观察实际执行 → 阅读回复 → 安排面试 → 回看筛选范围内的统计。全局视图用于跨岗位处理工作，单岗位视图用于集中推进当前岗位。

本次覆盖 Sequence、Shortlist、Contacts、Analytics、Interview、Inbox，以及这些页面依赖的 Worth Talking 等评级、资料抽屉、邮件步骤、入序列表单、简历/availability 标记、排期和上下文导航。Job Brief、Client feedback、Routines、Tasks、Integrations 的现有业务在导航精简中有明确去处，不扩展成新的业务重建项目。

不从这些前端界面推定私有候选人库、评级算法、阈值、模型、邮件投递实现或服务器内部规则。原站有缺陷的显示也不自动成为我们产品的业务要求。

## 3 证据边界

全包使用四种标记：**LIVE** 是本次已登录页面实际显示或经过点击验证的行为；**STATIC** 是 REA 对保存的 JavaScript 的静态结论；**REQ** 是实现已列功能所需的产品约束；**UNKNOWN** 是当前样本、权限或未提交动作无法确定的部分。REQ 不等于已验证竞品实现。

最新 REA 包为 6.8.0，实际运行使用 Node 24.22.1。其本次静态输入来自 2026-10-14 保存的 Juicebox 文件：选中 5 个文件分析，目录发现 152 个，147 个未分析，语义图存在截断。因此它补充源字段和文案定位，不能证明当前线上全部代码或后台逻辑。实时界面证据另由 computer use 获取，不能混称为 REA 已恢复所有源代码。

| 功能 | 本次已观察的覆盖 | 仍不能声称已恢复的部分 |
|---|---|---|
| Juicebox Sequence | 总览、历史指标、行菜单、运行表、筛选菜单、已有邮件编辑器、延迟/时区、新建入口、enrollment 前置与邮箱偏好 | 新建完成、预览后的最终 enrollment、真实发送/重新入列、取消/暂停后的持久化 |
| Juicebox Shortlist | 99 人表格、40 条分页、9 列看板与真实计数、显示列、筛选/排序、选中批量栏、Request review 表单、Insights 满态 | 评审提交与审阅人端结果、拖动后的持久化、删除与写状态后的实际结果 |
| Juicebox Contacts | 全局 999 人、完整表头、21 种筛选入口、状态枚举、批量操作、入序列表单、资料与五个业务子页 | 导入/导出结果、实际改标签和联系人信息后的服务端校验 |
| Juicebox Analytics | Outreach 满态、日期/项目/序列/发送人/邮箱范围入口、指标卡、两幅趋势图、可配置汇总表 | Usage、Projects、Agents 当前账号均被 Business 套餐限制，内部页面没有实测 |
| Metix 评级 | All scores / Strong Match / Worth Talking / Not Match 菜单，Worth Talking 筛选实际 6→3，资料条件展开 | 私有评级算法、分数阈值、评级与条件结果之间的生成规则 |
| Metix Inbox | 全局与岗位入口、All/Unread、多个真实线程、折叠邮件组、资料、简历/availability 标记、回复前置介绍表单、Schedule 入口 | 真实发送、附件文件内容和下载结果、服务端读状态契约 |
| Metix Outreach | Completed 满态、计数、首封/两次 follow-up/等待回复/Interested 条件分支、Job Posting | 正在运行/失败重试/暂停等未出现状态的完整操作结果 |
| Metix Interview | 五日日历、日期选择、时区选择、角色/状态过滤、空态；从真实 Inbox 打开两步邀请，单时间/多选时间/Advanced/退出确认 | 已保存事件详情、受邀者确认/拒绝/过期后的界面、重排与取消的实际持久化 |
| Metix Shortlist / Sequence | 当前账号空态；New sequence 的邮箱前置选择（Gmail/Microsoft coming soon、IMAP、Maybe later） | 非空 Shortlist、可复用 Sequence 编辑器与完成新建后的管理界面 |

这些缺口保留为明确的 parity 边界。不能用假数据截图补成“已完整实测”，也不能因为套餐受限而擅自升级账号。

## 4 精简导航的主规格

主导航固定五项：**Kruit、Candidates、Sequence、Inbox、Interview**。中文说明里 Candidates 称“候选人”；正式界面使用现有语言设置，避免中英文混杂。

Candidates 页内保留 **Contacts / Shortlist** 两个明确标签，数据集合和计数分别显示。Contacts 回答“有哪些人及其历史”，Shortlist 回答“当前范围内哪些人已入选”。把入口合并不能把两个数据集合合并。

岗位区标题为 Roles，旁边一个有标签的 New role 操作；列表只显示岗位名和必要的待处理提示。默认不在每行显示创建/更新时间，不对每个岗位常驻紫点。岗位菜单收起归档等低频管理。搜索用明确入口展开，保留键盘访问。

Job Brief 和 Client feedback 进入所选岗位的上下文导航；在 Kruit 的已有工作入口访问 Tasks 与 Routines；账户菜单进入 Integrations。Analytics 从 Sequence 的 View analytics 和候选人的 Insights 访问，保留页内统计导航，不增加第六个左侧常驻模块。详细映射及点击路径见导航规格。

## 5 必须独立的业务状态

| 状态轴 | 已观察示例 | 实现约束 |
|---|---|---|
| 评级 | Strong Match / Worth Talking / Not Match | 属于候选人对特定岗位条件的评估；不得以是否已回复替代 |
| 单条件评估 | Met / Not met，含 Preferred 条件、理由 | 原始评估理由与所属岗位一起呈现；缺少证据不是已经证明不具备能力 |
| Shortlist 招聘阶段 | Not Contacted、Pending、Contacted、InMail Sent、Interested、Interviewing、Hired、Rejected、Not Interested | 项目/岗位上下文中的推进状态；不自动改成全局个人标签 |
| Sequence 运行 | 步数、Finished No reply、Replied 等 | 具体 enrollment 的执行结果；与模板本身独立 |
| 回复意向 | No response / Interested / Not interested | 回复的业务解释，与一次打开邮件或评级档位不同 |
| 邮件阅读 | Unread / New reply / Replied | 显示未处理消息，不能直接等价于候选人有兴趣 |
| 材料 | Resume provided / Availability provided | 材料是否已收到；收到 availability 并不等于面试已确认 |
| 面试邀请 | Invited / Confirmed / Declined / Expired | 候选人对特定邀请的状态；不会因打开排期表单而推进 |

**LIVE 实例**：示例候选人 在 Inbox 显示 Worth Talking，完整推荐包含 6 项 Met、1 项 Not met；该 Not met 理由是缺少 PostgreSQL 与 AWS/GCP 的明确证据。原站仍显示 Worth Talking。不能据此自创“满足六项就属于 Worth Talking”的公式，也不能把档位改写为“已满足所有条件”。证据：[metix-示例候选人-worth-talking-criteria.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

## 6 端到端交互契约

以下为 **REQ**，用于实现及验收已有功能，不代表本次已经提交这些业务动作。

1. **选定范围**：每个页面明确 All roles 或单岗位。岗位切换后清掉不属于新范围的选择和资料，旧请求不得回填到新岗位。单岗位记录不能出现在无权限的全局结果中。
2. **筛选与评级**：筛选只改变可见集合。更改评级筛选不能改变 shortlist、发信和材料状态。评级显示必须能进入同一候选人的条件说明。
3. **Shortlist 与联系人**：同一个人可关联多个岗位。取消某岗位 shortlist 不能删除全局 Contact 或其他岗位的入选关系。批量栏明确作用于当前已选集合，页选/跨页全选的范围要一致。
4. **Sequence 模板与 enrollment**：模板编辑、逐人文案、发送账号、邮箱偏好、计划开始时间和每一步等待时间各自明确。预览展示实际发送内容与目标；不得把模板变量未解析的文本直接发送。
5. **启动与执行**：启动后显示每人的实际执行结果和异常。重复点击不能重复创建同一次 enrollment 或重复投递。操作未完成时不提前显示成功。
6. **回复与停止跟进**：Metix 的可见业务规则为任何回复停止该人的剩余 follow-ups。实现该规则时只停止对应人的剩余跟进，保留其他人的运行与原邮件历史。
7. **候选人有兴趣**：Interested 分支后续发送职位及收集材料，不能由一次打开、点击或 AI 推荐档位推定候选人兴趣。保留分支结果和收到的材料。
8. **Inbox 回复**：保持同一候选人、岗位和邮件线程。首个雇主回复若需要介绍，先展示介绍承诺和 Send introduction & reply，不能静默多发一封未呈现的邮件。发送失败时保留输入。
9. **安排面试**：有 availability 的 Inbox 可进入 Schedule，Step 1 选时，Step 2 填客人/地点/备注。点 Next、Back、选中日历格不发送邀请；退出有未保存提醒。只有最终 Send invitation 产生邀请。
10. **时区**：展示招聘人员及候选人的时间；计算用事件具体日期与 IANA 时区，不用浏览当下的 GMT 偏移硬套未来事件。原站现场存在可疑时区显示，本次记录它的布局和行为，不把其偏移当正确算法。
11. **统计**：时间范围、序列、岗位/项目、发送人、邮箱、分组维度与指标定义都要可追溯。历史累计运行数不能强制等于近30天新发生数；邮件数不能强制等于人数。
12. **返回与失败**：返回列表恢复筛选、页码、滚动和选中项；加载中、真实空结果、无权限、请求失败分开显示。失败重试不能再次触发已经完成的业务动作。

## 7 统计口径的实测对照

Juicebox 两个序列累计 99 + 140 = 239；Outreach Analytics 显示 239 sequence runs、238 opened、26 clicked、16 replies、10 interested、1 bounce。对应约 99.6%、10.9%、6.7%、4.2%、0.4%。这组样本支持这张报表中的分子/分母关系，不证明所有报表的全局去重方式。见 [juicebox-analytics-outreach-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

同站 Sequence 总览 Last 30 days 显示 0，与累计表格非零可以共存。Metix 角色候选人标签显示 Contact 303，而角色 Outreach 工作区显示 261 Contacted、19 Replies、6 Interested、17 Failed；当前没有证据证明两个 Contact 数采用同一计算规则。实现前不能靠前端相加或改数消除这种差异。

复刻验收应检查所选范围的数据定义与一致性，不把上述客户样本数字硬编码为成功条件。

## 8 设计与实现验收

| 场景 | 必须得到的结果 |
|---|---|
| 首次进入工作台 | 左侧五项主导航，岗位区与账户区层级清楚；无需扫描十几个同级入口 |
| 从旧功能寻找新入口 | 所有现有功能在导航映射中有明确去处；不依赖在聊天里猜命令 |
| 全局与岗位切换 | 名称、列表、计数、资料和操作目标保持同一范围，跨范围晚响应不能串数据 |
| Candidates 切 Contacts / Shortlist | 两个集合分别保留数据、计数和筛选；同一人不因切标签而被改变业务状态 |
| Worth Talking 筛选 | 筛出该评级集合；打开资料仍能看到不满足/缺证据条件，不卡成“全部满足” |
| Shortlist 表格/看板互切 | 同一集合和阶段计数，切视图不产生候选人状态变化 |
| 批量入序列 | 已选数量、目标序列、目标邮箱、计划时间、预览和最终提交范围一致 |
| 邮件回复到达 | 对应线程出现新回复；该人的剩余跟进依规则停止，其他人继续 |
| 回复发送失败 | 不丢输入，不伪装成功，不重复发送介绍或正文 |
| 收到简历/availability | 标记、资料及排期入口与同一人关联；availability 不直接变 Confirmed |
| 排期前进/后退/退出 | 选择暂存在表单，只有最终提交创建邀请；未保存退出有提示 |
| 夏令时跨日排期 | 同一真实时刻在双方时区正确显示，不用当前偏移算未来日期 |
| 空列表与查询失败 | 空态有明确范围与下一步，失败显示重试；不得把网络失败显示成0条 |
| 统计切换 | 指标、趋势图、明细表和导出遵循同一筛选范围和各自口径 |
| 可访问性 | 所有图标有名称，选中/部分全选可读，键盘能进出菜单与抽屉，焦点恢复 |

更细的逐页验收在两份模块规格与 Metix 验收清单中。本次文档完整性检查包括本地链接存在、截图存在、捕获范围、术语和状态相互一致；这些检查不等价于产品已经实现或投递/排期已经通过。

## 9 现场动作与保留材料

本次未发送邮件、未发送面试邀请、未提交评审请求、未启动/重新入列 Sequence、未更改候选人的招聘阶段、未升级套餐。

只读查看并非绝对无写入：Metix 打开邮件会改变该消息的未读显示；Juicebox 打开资料可记录 Viewed 活动。已有 Sequence 编辑器点击 Done 返回时显示 Sequence saved，未改动内容/步骤字段。多时段排期仅在表单暂存，已通过 Exit 放弃，未提交邀请。以上可见行为与未执行的业务动作分别记录。

个别捕获是在页面加载过程取到的结构，不作为满态证据；优先使用同名的 loaded/final 文件。`metix-worth-talking-profile` 和 `metix-worth-talking-criteria-expanded` 两个早期文件实际是 示例候选人 的资料，名字不准确，不能作为 Worth Talking 的样例；以 `metix-示例候选人-profile`、`metix-示例候选人-worth-talking-criteria` 为准。完整说明见 [OBSERVATIONS.md](OBSERVATIONS.md)。
