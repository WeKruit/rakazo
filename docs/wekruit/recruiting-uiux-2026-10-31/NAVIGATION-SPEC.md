> **实施边界**：本文件的侧栏入口映射交由既有corner/shell线程实现；本工作不另写导航。创建岗位沿用Kruit右侧面板，不整页离开Kruit。

> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# Headhunter 精简导航规格

日期：2026-10-31。目标用户是同时处理多个岗位的招聘人员。核心任务是找到人、判断是否值得沟通、推进外联、处理回复和安排面试。用户明确指出现有侧栏信息过多，要求参考 Juicebox 与 Metix 减少常驻入口。本规格改变功能的摆放，不删除既有业务能力；本文均为 **REQ 复刻产品的设计要求**，不是竞品已实现行为。

## 1. 简化目标

[用户提供的现有侧栏（原始证据未公开）](PRIVATE-EVIDENCE.md) 同时呈现 Kruit、New Role、Job Brief、Client feedback、Shortlist、Contacts、Sequence、Inbox、Interview、岗位搜索和岗位列表、Routines、Tasks、Integrations、账户。它混合了四种东西：业务工作台、创建动作、岗位资料和系统设置。用户在每次跳转时都必须重新区分这些层级。

改后的左栏只承担两个问题：“我要做哪类招聘工作？”和“我要看哪个岗位？”。主工作区承担当前业务对象的资料、筛选、二级标签与具体动作。

验收目标：

- 常驻一级业务导航从截图中的九项收敛为五项。
- New Role、Job Brief、Client feedback、Routines、Tasks、Integrations 都有明确新入口。
- 无需先进入某个岗位，仍能查看全局候选人、外联、收件箱和面试。
- 选中岗位后，四个招聘业务页面与岗位资料共享同一明确范围。
- 岗位列表常态只显示名称和真正需要用户注意的标记，不为每行常驻时间戳和无含义紫点。

## 2. 结构取舍

| 结构 | 优点 | 代价 | 本次决定 |
|---|---|---|---|
| 五个主导航，岗位作为范围，详情放页内 | 高频工作可一步到达，适合跨岗位招聘；侧栏短且稳定 | 候选人中的 Contacts / Shortlist 需清楚标签 | 采用 |
| 主导航只留 Kruit 和 Roles，所有功能嵌入岗位 | 表面最短 | 全局 Inbox / Interview 被埋，跨岗位跳转增加 | 不采用 |
| 保留所有入口，只分组或折叠 | 改动小 | 用户仍面对同样入口，默认状态和展开状态都难扫读 | 不采用 |

最终规格只有第一套，不保留“双导航”“旧版侧栏”或按角色动态长出多套一级导航。

## 3. 最终侧栏

```text
┌──────────────────────────┐
│ Headhunter          [折叠]│
│                          │
│ Kruit                    │
│ Candidates               │
│ Sequence                 │
│ Inbox                 3  │
│ Interview                │
│                          │
│ Roles          [搜索] [+]│
│ All roles                │
│ Software Engineer        │
│ Senior Account Executive │
│ Front Desk Supervisor    │
│ ...                      │
│ View all roles           │
│                          │
│                          │
│ [头像] 示例对象16   [⌄]│
└──────────────────────────┘
```

英文产品沿用英文导航：Kruit、Candidates、Sequence、Inbox、Interview。中文界面分别为 Kruit、候选人、外联序列、收件箱、面试。不要混用 Contacts 和 Candidates 作为同一一级项，也不要把 Kruit 改成含糊的 Dashboard。

- 上方五项顺序固定；只使用一层链接，每项一个图标和一个短名称。
- Inbox 右侧显示该账户有权查看的未读线程数量。零时隐藏数字，视觉上不出现 `0`。计数所属范围见第六节。
- Roles 是范围选择区，不是第二套功能导航；不在每个岗位下重复候选人、Inbox、Sequence 等五个入口。
- 品牌区域保持紧凑；账户只在底部一个位置，不另设常驻 Settings / Integrations 行。
- 不为“折叠”做只有图标才能操作的唯一入口。图标模式保留名称 tooltip 和可访问名称。

导航提案预览（REQ 设计稿，非已部署界面）：[左右对照](navigation.html)、[静态截图（原始证据未公开）](PRIVATE-EVIDENCE.md)。英文提案主项为 Candidates，页内仍明确区分 Contacts / Shortlist。

## 4. 原入口到新入口的完整映射

| 原入口 | 新入口 | 一级选中态 | 必须保留的语义 |
|---|---|---|---|
| Kruit | Kruit → Chat | Kruit | 当前全局/岗位会话与历史 |
| New Role | Roles 标题右侧 `+`，可访问名称 `New role` | 创建完成后在 Kruit 右侧面板打开新岗位，保留当前 Kruit 上下文 | 新建是动作，不是列表页面 |
| Job Brief | 当前岗位页头 `Job brief` | 保持当前业务页；资料抽屉打开时不改一级选中态 | 岗位条件、原始材料和版本 |
| Client feedback | 当前岗位页头 `Client feedback` | 保持当前业务页 | 该岗位客户意见、关联候选人及处理结果 |
| Shortlist | Candidates → Shortlist | Candidates | 岗位入选集合，不等于所有联系人 |
| Contacts | Candidates → Contacts | Candidates | 全局联系人及岗位关联 |
| Sequence | Sequence → Sequences | Sequence | 模板与每人执行记录分开 |
| Inbox | Inbox | Inbox | 完整邮件线程、未读、回复、材料和安排入口 |
| Interview | Interview | Interview | 日历、邀请状态及活动 |
| Routines | Kruit → Work → Routines | Kruit | 已有定时/重复工作及启停状态 |
| Tasks | Kruit → Work → Tasks | Kruit | 已有人工待办和运行任务 |
| Integrations | 账户菜单 → Settings → Integrations | 保持来源业务页；设置有独立标题 | 已有连接、授权和连接状态 |
| 示例对象16 | 底部账户菜单 | 无业务页切换 | 账户和 workspace |
| 新规格所需 Analytics 入口 | Sequence 页头 `View analytics`；Candidates 的 Shortlist 页头 `View insights` | 保持来源业务页 | 外联表现和人才池画像是不同统计 |

Kruit 的 Chat / Work 是工作区内的短标签；Work 内保留 Tasks / Routines 两个清楚命名的子页。它们复用现有工作数据，不引入新的任务系统或运行引擎。Kruit 顶部的 Work 标签在有待处理事项时可以显示数量；只有真正待用户处理的状态计入提醒，不把后台正常运行或历史完成任务计为未读。

## 5. Candidates 的二级结构

```text
Candidates                         [All roles ⌄]
[Contacts] [Shortlist]
Search…                 Filter      [上下文动作]
------------------------------------------------
当前标签的列表 / 表格
```

- **Contacts** 显示人及其关联的岗位。联系人身份不因为岗位切换变成新的人。
- **Shortlist** 显示人和岗位的入选关系。全局模式下必须展示岗位列，同一个人在两个岗位中有两个不同阶段时不可只保留一个状态。
- 初次访问 Candidates 默认 Contacts。用户在本次会话明确选过的标签可以恢复；从 Shortlist 深链进入时必须打开 Shortlist，不能被“上次标签”覆盖。
- `Add to Sequence`、批量状态修改和针对已选人的 Request review 只在选择后出现在批量工具栏。Shortlist 页头仍保留面向当前完整 shortlist 的 `Request review`；弹窗明确展示待评审人数。不得因精简导航而丢失全池评审入口。
- Shortlist 页头保留 `View insights`，查看的是当前 shortlist 范围；不能把它改名为全局 Analytics 后悄悄换统计集合。

## 6. 全局与单岗位范围

### 6.1 唯一作用域

页面范围只有 `All roles` 或一个明确岗位。侧栏 Roles 的选择和页面右上范围选择器必须指向同一个当前范围，不能一边选 A 岗位、一边 Inbox 仍查询上次的 B。

- 点击 `All roles` 保持当前一级页面及二级标签，切换为全局范围。
- 点击某个岗位保持当前一级页面及二级标签，切换为该岗位范围。首次从 Kruit 进入一个岗位时显示该岗位会话。
- 在全局范围打开某人的线程或详情，不偷偷把全局页面变成该岗位列表；详情明确展示关联岗位。
- 点击一级 Candidates / Sequence / Inbox / Interview 保持用户已经选择的范围；不能因为一级链接跳转而无提示恢复 All roles。
- 页面标题附近始终可见当前范围。侧栏折叠、窄屏隐藏后也不能丢掉这一信息。
- Job brief / Client feedback 是单岗位数据：在 All roles 模式不显示模糊的可编辑“当前岗位”文案；从具体岗位行或页面范围选择器选择岗位后，两个入口才在该岗位页头出现。

### 6.2 计数

Inbox 一级徽标表达 **账户全局未读**；其可访问名称说明 `N unread across all roles`。进入单岗位 Inbox 后，页面中的 Unread 数量表达当前岗位，不能把全局角标当作本岗位总数。徽标只作信息展示，不设置独立点击行为；点击包含徽标的 Inbox 链接保持当前范围。页面可见的 All roles 选择和 Unread 标签承担切换范围及过滤，不让徽标承担隐式筛选动作。

岗位行仅当该岗位存在需要用户处理的事项时显示小标记，并在 tooltip / 可访问名称说明原因；“运行中”可以在岗位工作区内表达，不用每行紫点制造所有岗位都紧急的错觉。

## 7. 岗位列表的降噪

- 常态显示最近使用的最多五个岗位，不显示每行创建/更新时间。完整时间仍在岗位详情可读，不能通过删除展示把审计时间也删除。
- 名称单行，超出省略；hover 和键盘聚焦能看到完整名称。两个同名岗位需用现有公司或客户信息区分，不能靠同色紫点区分。
- `View all roles` 打开已有岗位管理列表；新建 `+`、岗位搜索均有文字辅助或 tooltip。
- 岗位搜索图标点开后显示输入框；输入时保留 `All roles` 选项和清除动作。搜索无结果显示 `No roles found`，并保留 New role 入口。
- 三点操作在 hover / focus 时显示，保持等宽尾部空间以避免名称跳动；触屏上在选中行可见。
- 岗位列表独立滚动，五个主导航和底部账户保持稳定，不随数百岗位一起滚出视野。
- 搜索和最近五项仅改变显示集合；不归档、不删除、不停止未显示的岗位工作。

## 8. 深链接和返回行为

这是导航归属调整，不新增兼容导航层。应以现有路由读取能力直接解析当前页面、范围、二级标签、选中对象，新的导航使用同一组现有路由状态。

| 目标 | 加载后的可见状态 |
|---|---|
| 某岗位 Shortlist 中某人 | Candidates 高亮；Shortlist 标签；该岗位范围；选中人详情 |
| 全局 Contacts 某人 | Candidates 高亮；Contacts 标签；All roles；该人详情 |
| 某 Sequence run | Sequence 高亮；指定序列和 run；具体人和范围可见 |
| 某候选人回复 | Inbox 高亮；对应线程；原消息及岗位可见 |
| 面试邀请详情 | Interview 高亮；正确日期区间与事件详情 |
| 岗位 brief 或 feedback | 当前岗位已解析；正确资料面板；不跳到别的岗位 |
| Task / Routine | Kruit 高亮；Work 已打开；正确子标签和目标任务 |

关闭详情回到原列表的筛选、排序、分页和滚动位置。浏览器 Back 返回前一真实页面状态；不能通过默认入口覆盖已有对象深链。没有权限或对象已不存在时显示明确错误和返回业务页动作，不能自动选中另一个岗位或人。

## 9. 页面动作层级

- 一级导航只做地点切换；新建、发送、安排面试、加序列都放在当前页面内。
- 页面头最多一个当前任务的主要动作，例如 Sequence 的 New sequence。筛选与统计是次要动作，低频菜单是第三层。
- Reply 和 Schedule 跟随当前线程/候选人，不放左栏；在此上下文里显示收件人和岗位。
- Job brief 和 Client feedback 使用清楚命名的页头入口，不藏入泛称 More。它们从任意单岗位业务页可一步打开。
- Settings 从账户菜单能直接识别；发送或安排流程遇到未连接服务时，表单内给出与原能力一致的连接入口，而不是让用户先猜账户菜单。

## 10. 状态和交互

### 正常及加载

五个主导航立即呈现。范围切换时标题和选中态立即响应；列表呈现加载状态，旧范围数据不可冒充新范围数据。加载中的计数用占位符，不显示 `0` 表达尚未查询的数据。

### 错误与未保存内容

加载失败留在用户选择的页面与范围，显示重试；未读角标失败保持未知，不把用户未处理的消息清零。Reply / Sequence 编辑 / 安排面试含未保存内容时，跨页和切换岗位遵循现有未保存保护；取消离开后焦点回到刚才动作，不能丢输入。

### 键盘和辅助技术

Tab 顺序为品牌/折叠、五项业务导航、岗位范围、岗位列表、账户。一级导航以链接语义和 `aria-current=page` 表达；范围选择以选中状态表达，不能把岗位误读为第二个“当前页面”。折叠菜单支持 Escape 关闭并恢复焦点。搜索框、New role、完整岗位名、未读数都有可访问名称。激活态不只靠颜色，还要有底色/字重/语义。

### 窄屏

竞品移动端未实测；以下是复刻产品的必要 REQ。可用宽度不足以保留主内容时左栏成为抽屉，页头显示菜单按钮、页面名和当前范围。抽屉内保持同样五项顺序，不能将移出的 Job brief 等入口重新堆回一级。选择页面后关闭抽屉；浏览器返回仍恢复原列表和范围。当前岗位的 brief / feedback 在页头紧凑菜单中保留清楚文字。

## 11. 验收清单

| ID | 操作 | 通过条件 |
|---|---|---|
| NAV01 | 初次打开桌面 | 五个一级业务项，Roles区，底部单一账户；不再铺满十三个入口 |
| NAV02 | 打开 Candidates | Contacts / Shortlist 标签都可见，集合及状态语义分开 |
| NAV03 | 点 Roles 的 `+` | 进入现有新建岗位流程，不立即创建空岗位 |
| NAV04 | 在岗位 Inbox 打开 Job brief | 正确岗位资料，一步可达；返回保留原线程 |
| NAV05 | 打开 Client feedback | 正确岗位，候选人关联未丢失 |
| NAV06 | 打开 Kruit Work | Tasks / Routines 保留，运行和人工待办不混成同一状态 |
| NAV07 | 账户菜单进入 Integrations | 连接列表及授权能力保留 |
| NAV08 | A岗位切B岗位 | 标题、范围、数据、详情上下文同时正确；迟到A响应不覆盖B |
| NAV09 | 单岗位切 All roles | 保持当前功能和二级标签，正确显示跨岗位数据 |
| NAV10 | 岗位超过五个 | 最近五项可扫读，View all / 搜索能找到任一其余岗位 |
| NAV11 | 打开已有直接链接 | 页面、标签、范围、对象正确，一级高亮符合新归属 |
| NAV12 | 关闭候选人详情 | 筛选、分页、排序、滚动和选中前状态恢复 |
| NAV13 | 新邮件到达 | 全局徽标和当前范围未读语义清楚，不刷新整页或跳走 |
| NAV14 | 无未读 | 一级 Inbox 不显示 `0`；页面可以清楚表达无未读 |
| NAV15 | 未读查询失败 | 不误报清零，保留错误状态和重试 |
| NAV16 | 未保存回复后切岗位 | 按现有保护确认离开，取消后输入完整保留 |
| NAV17 | 只用键盘 | 所有入口可达、焦点可见、菜单可退、完整岗位名称可读 |
| NAV18 | 窄屏 | 五项导航移入抽屉，范围仍可见，原功能有明确新入口 |
| NAV19 | 打开统计 | Sequence→外联统计；Shortlist→人才池画像，范围不串 |
| NAV20 | 静态路由审查 | 没有新旧导航双套结构、重复任务引擎或孤儿路由 |

## 12. 与竞品的关系

Juicebox 的桌面侧栏把 Contacts、Sequences、Analytics 与 Current project 下的 Shortlist 分开；Metix 用较短的主功能列表加 All Roles。这里借用的是稳定一级导航和上下文分层原则，五项最终命名与迁移关系是本产品的设计决定。原站 Screenshot 中出现的 Network、Support、套餐、供应商品牌和升级按钮不因复刻而成为新增业务要求。

现场参考：[Juicebox Sequence（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Juicebox Contacts（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Metix Inbox（原始证据未公开）](PRIVATE-EVIDENCE.md)。详细模块见 [Juicebox PRD](JUICEBOX-PRD.md)、[Metix PRD](METIX-PRD.md)、[UIUX 规格](UIUX-SPEC.md)。
