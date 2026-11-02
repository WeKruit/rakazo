> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# Metix 招聘功能复刻 PRD 与 UI UX 规格

本规格覆盖 Metix 已登录界面中的候选人列表与评级、Shortlist、Sequence、Inbox、Interview，以及它们共享的资料抽屉和角色上下文。复刻目标是还原招聘人员看到的信息、操作入口和工作流关系。当前 Metix 导航没有独立 Contacts 或 Analytics 页面；这两个模块应查阅同目录 Juicebox 规格，不能将其写成 Metix 已有页面。

## 1 证据与交付边界

| 标记 | 含义 | 开发使用方式 |
| --- | --- | --- |
| LIVE | 本次登录态页面或实际只读交互中看到的行为 | 复刻已观察的布局、文案、可用状态及切换结果 |
| REQ | 为使已观察功能逻辑正确而必须满足的实现约束 | 属于复刻验收要求，不声称 Metix 后端已这样实现 |
| UNKNOWN | 当前账号或当前操作范围内没有验证的行为 | 不填写虚构字段、阈值、成功结果或业务规则 |

采集日期按用户时区为 2026 年 10 月 31 日。网页截图中具体候选人数、日期、时间、姓名和消息只说明样例状态，不是产品常量。规格不复制私人邮箱和邮件正文作为默认内容。

本次已验证列表、菜单、筛选、详情和空态；没有发信、创建面试、修改评级或启动新搜索。已采集 Inbox 发起排期的选时间与定制邀请两步表单，但没有发送邀请。Sequence 已补齐新建上下文、生成后的三封邮件编辑器、变量、交付设置和零收件人视图；Continue已创建一个服务器草稿，未Publish或发送。非空 Shortlist、非空Sequence收件人与已保存面试事件详情尚没有登录态证据。未验证项集中列在第 12 节，不能把这些项目当成已经完成的完整行为逆向。

## 2 信息架构与页面入口

### 2.1 全局侧栏

**LIVE。** 左侧固定侧栏依次包含产品标识和收起按钮、New Role、Job Brief、Shortlist、Sequence、Inbox、Interview；其下是 All Roles 和具体角色列表；底部为用户头像、姓名和 Starter 套餐。Inbox 在视觉上带未读数字；角色列表可带紫色提示点和 Session actions 菜单。

| 导航 | 已观察路径 | 页面作用 |
| --- | --- | --- |
| New Role | `/hire` | 新角色入口；本规格不扩展其创建过程 |
| Job Brief | `/hire/jobbrief` | 职位需求入口；本规格仅保留关联 |
| Shortlist | `/hire/shortlist` | 已保存候选人集合 |
| Sequence | `/hire/sequence` | 可复用邮件工作流及 enrollment |
| Inbox | `/hire/inbox` | 按候选人查看回复及邮件线程 |
| Interview | `/hire/calendar` | 面试日历和活动记录 |
| 具体角色 | `/hire/role/{roleId}?workspace=…` | 该职位的聊天、候选人和 outreach 工作空间 |

**REQ。** 导航选中项必须与实际页面一致；角色用稳定角色标识关联，两个同名职位不能互相覆盖。全局页面的 All Roles 范围与单角色页面应明确区分。会话菜单入口已见，具体菜单内容未验证，不自行添加删除、归档等动作。

证据：[Inbox 页面结构（原始证据未公开）](PRIVATE-EVIDENCE.md)、[角色候选人结构（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 2.2 全局与角色的关系

**LIVE。** Inbox、Shortlist、Sequence、Interview 是全局导航。Inbox 和 Interview 可按角色筛选。角色候选人页单独显示该职位的阶段标签和候选人数；角色标题旁还有 Describe the role、Find Candidates、Outreach、Interview 进度入口。

**REQ。** 同一候选人在不同角色中的评级、阶段和邮件关联必须分别读取。全局 Inbox 项须同时显示候选人及职位，用户才知道在替哪个岗位回复。改变筛选范围不能把原线程的回复对象切换成筛选后另一个人。

## 3 视觉与布局基线

下表保留初轮1806×1011桌面视觉概览。新增精确几何、计算字体/色值/边框、内部滚动和1440/1024/768/390视口结果以 [METIX DESIGN ANNOTATIONS](design-details/METIX-DESIGN-ANNOTATIONS.md) 为准；测得单一状态的计算值不等于源码全局token或全部响应式断点。

| 区域 | LIVE 视觉结构 | REQ 复刻约束 |
| --- | --- | --- |
| 侧栏 | 约 244 px；白底；右侧细分隔线；顶部品牌；底部用户菜单 | 页面滚动不使主导航消失；长角色名单行截断 |
| 主体 | 白色或浅灰底；内容卡片白底；深色标题；灰色元信息 | 主要动作、结果与辅助信息有明确层级 |
| 当前导航 | 浅灰圆角底、深色图标和文字 | 不能只依靠细微颜色区分选中项 |
| 主要按钮 | 黑底白字；次要按钮白底深色边框 | disabled 状态与可点击态可区分 |
| 候选人卡片 | 约 16 px 圆角、1 px 浅灰边框；内部约 20 px 留白 | 名称和评级在首行；履历和状态条不相互挤压 |
| 评级 | Strong Match 紫色描边；Worth Talking 青绿色描边；图标加文字 | 文字保留，不能仅用色点编码评级 |
| 回复状态 | New reply 用紫色；Replied 用灰色；底部浅灰状态条 | 与评级分区域显示 |
| 抽屉 | 右侧白色面板；原页面保留并加暗遮罩；独立滚动 | 焦点进入抽屉；关闭回到触发点 |
| 空态 | 简洁插图、标题、说明，位于可用内容区中部 | 无数据、筛选无结果、加载、失败不得全部显示同一空态 |

视觉依据：

![Metix 候选人列表（原始证据未公开）](PRIVATE-EVIDENCE.md)

![Metix Inbox 主从布局（原始证据未公开）](PRIVATE-EVIDENCE.md)

## 4 候选人列表与 Worth Talking

### 4.1 页面目标及结构

**LIVE。** 单角色候选人页头显示职位名称及编辑名称按钮。主体以 Candidate List 为标题，提供 Back to chat。阶段标签视觉顺序为 Interview、Interested、Contact、Match，激活标签有紫色下划线。样例分别显示 Interested 6、Contact 303、Match 307；Interview 没有数字。

候选人以两列卡片展示。阶段标签下方是 Score 下拉筛选，默认 All scores；主体卡片根据所选阶段和评级显示。Match 页有分页，当前样例为 `1-50 of 307`、`Page 1 of 7`，Previous candidate page 禁用、Next candidate page 可用。Interested 6 的截图显示六张卡片。

角色聊天历史与候选人 UI 的 AX 树可能同时存在；实际复刻以截图可见的 Candidate List 布局为准，不能将 AX 树中的历史聊天逐段堆在列表上方。

证据：[角色列表（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Match 加载完成（原始证据未公开）](PRIVATE-EVIDENCE.md)、[列表截图（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 4.2 卡片组件

| 顺序 | LIVE 字段 | 展示规则 |
| --- | --- | --- |
| 1 | 姓名 | 左上，较粗字体；姓名后紧跟评级 badge |
| 2 | 评级 | `Strong Match` 或 `Worth Talking`；筛选菜单还出现 `Not Match` |
| 3 | 联系标识 | Match 样例卡片可同时显示 `Contacted` |
| 4 | 头像或占位头像 | 右上；有未读时可带紫色点 |
| 5 | 地点 | 姓名下一行，小号灰字 |
| 6 | 当前经历 | 公司 logo、职位、公司、起止日期；日期靠右 |
| 7 | 另一段经历 | 较次级；与当前经历形成简化纵向履历 |
| 8 | 教育 | 学位或学校；左侧教育图标；过长单行截断 |
| 9 | 联系反馈 | Interested 卡片底部显示 `New reply` 或 `Replied` 与相对时间 |
| 10 | 已提供材料 | `Resume provided`、`Availability provided` 可以同时存在 |

**REQ。** 数据缺失时不填造信息；没有头像显示占位；没有第二段经历不复制第一段；有多个材料标记时允许自然换行或横向合理排布。卡片整体的可访问名称要包含候选人姓名。AX 使用 checkbox 表示卡片选中，不证明这是批量选人功能，复刻不自行添加批量发送或批量淘汰。

### 4.3 评级筛选的实际行为

**LIVE。** Interested 阶段的 Score 菜单是单选结构，选项及当前样例计数如下：

| 选项 | 样例计数 | 已观察结果 |
| --- | --- | --- |
| All scores | 6 | 默认完整 Interested 集合 |
| Strong Match | 3 | 菜单存在；本次未以该选项完成独立筛选验证 |
| Worth Talking | 3 | 实际选择后仅显示三张 Worth Talking 卡片 |
| Not Match | 0 | 菜单存在；本次未验证零结果页文案 |

Worth Talking 过滤后的三人是原 Interested 集合的子集；Interested 标签仍显示阶段总数 6。切换至 Match 后，所观察页面恢复为 All scores；该行为仅说明本次阶段切换结果，不证明所有筛选均永久重置。

**REQ。** 筛选值、菜单选中态和结果要一致。各选项计数的范围应是当前角色、当前阶段，而不是其他角色或全库。过滤不能改评级、阶段或原始候选人记录。用户能从 Worth Talking 回到 All scores。分页在筛选后重新计算，不能保留超出结果范围的旧页码。

证据：[Score 菜单（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Worth Talking 实际筛选结果（原始证据未公开）](PRIVATE-EVIDENCE.md)、[阶段切换后 Match 页（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 4.4 Worth Talking 的实际条件解释

**LIVE。** 已确认选中 示例候选人 的线程及本人 Profile 后，展开七项 Recommendation。该候选人在列表中是 Worth Talking，细项却并非全部失败：

| 条件 | UI 状态 | 界面解释的类型 |
| --- | --- | --- |
| 7+ years | Met | 平台估算约 9.8 年总职业经历 |
| Backend & data pipeline | Met | 引用 ETL 与后端经历 |
| 3D spatial systems, coordinate transformations, or geometric computation | Met | 引用 robotics、computer vision、geospatial、stereoscopic 等资料 |
| Mathematical/geometric intuition applied in code | Met | 引用数学与算法学习背景和技术项目 |
| Robotics domain | Met，Preferred | 引用 robotics domain 经历 |
| Simulation, computer vision, or game engine background | Met，Preferred | 引用 computer vision 和 Unity |
| Python (NumPy, Pandas), PostgreSQL, Redis, cloud-native infra (GCP or AWS) | Not met | `The candidate lacks explicit evidence of working with PostgreSQL and cloud-native infrastructure like AWS or GCP.` |

这个样例证明 Worth Talking 可与六项 Met、一项 Not met 共存，且 Not met 的解释可能是“缺少明确证据”，不能转述为候选人确定不会某技术。它不能证明“六项通过即 Worth Talking”的评分公式。Preferred 标签、组合条件名称、状态和解释是独立内容，复刻不应只保留总评级而删除这些细节。

证据：[确认 示例候选人 本人资料（原始证据未公开）](PRIVATE-EVIDENCE.md)、[示例候选人 七项 Worth Talking 条件（原始证据未公开）](PRIVATE-EVIDENCE.md)。文件名为 `metix-worth-talking-profile` 和 `metix-worth-talking-criteria-expanded` 的较早捕获实际显示另一候选人，不用作本节证据。

### 4.5 必须分开的状态维度

| 状态维度 | LIVE 值或入口 | 不得混淆的内容 |
| --- | --- | --- |
| 匹配评级 | Strong Match、Worth Talking、Not Match | 不等于候选人有兴趣，也不等于已人工核实 |
| 招聘阶段 | Match、Contact、Interested、Interview | 不等于单项条件满足情况 |
| 联系标识 | Contacted | 不等于 Replied，也不意味着排期成功 |
| 邮件读取状态 | New reply、Replied、Unread 标记 | 不改变候选人评级 |
| 材料状态 | Resume provided、Availability provided | 有 availability 不等于已有 confirmed interview |
| 条件评价 | Mira's Recommendation 中的 Met 与解释 | 平台判断应保持其来源，不变成原始事实 |

**UNKNOWN。** Strong Match 与 Worth Talking 的评分算法、数字阈值、权重及自动更新时机均未恢复。不能写出“80 分以上 Strong Match”或“缺一项自动 Worth Talking”等虚构规则。当前需求只要求复刻已存在的评级展示和筛选，数据应读取已有评估结果。

## 5 共享候选人资料抽屉

### 5.1 入口和内容顺序

**LIVE。** Inbox 线程头部的 Profile 打开右侧资料抽屉，背景 Inbox 保留。1806 px 宽截图中抽屉约占右侧 720 px。标题栏显示 Profile 和关闭按钮；正文顺序如下：

1. 姓名、头像、headline、地点、LinkedIn 链接。
2. Download 按钮；当前样例禁用。
3. Mira's Recommendation；默认显示三项条件及解释，后有 `Show all 7 criteria`；示例候选人 的七项已进一步展开，见第 4.4 节。
4. 可折叠 Contact details，包含 Email 和 Phone。当前 Email 显示 Finding…、Finding email；Phone 提供 Show phone。
5. Experience、Education、Skills、Projects、Courses 段落导航。
6. 履历、学校、技能、项目、课程等内容。

Experience 按经历显示公司 logo、职位、公司、地点、日期和持续时长，描述过长时出现 `... more`。Projects 可有项目名和描述。Courses 可有课程名与课程编号。公司名及 logo 旁存在 company details 弹层入口，未展开验证其内容。

**REQ。** 关闭不丢失 Inbox 当前线程；抽屉滚动不能迫使用户丢失底层列表位置。段落导航应定位到对应内容。链接打开真实关联档案，不能用搜素链接冒充候选人直链。

### 5.2 条件评价

**LIVE。** Recommendation 每项有条件名称、状态图标或 `Met` 可访问文本、自然语言解释。样例中出现年限、backend/data pipeline、3D spatial/coordinate/geometric experience 条件。它们是平台当时给出的评价，不构成对候选人真实能力的独立验证。

**REQ。** 评价与角色关联；相同人换岗位不能复用错误岗位的条件。解释保留其原始来源和语气，不能把“lists experience”改写为“已核实独立实现”。补充展开中已看到 `Not met`；没有看到的 `Unknown` 等状态不能强写成 Metix 原生枚举。

**LIVE 补充。** Match 列表打开的另一名候选人已展开全部九项条件，前五项为 5+ years software engineering、Python (NumPy, Pandas)、PostgreSQL and Redis、Cloud-native infra (GCP/AWS)、Mathematical intuition for algorithms and geometry；后四项有 Preferred 标识，分别是 Data-intensive or human-in-the-loop platform background、React/TypeScript、ML infrastructure experience、Robotics or physical AI domain。展开后评价名称、Preferred 与解释必须保留。不同捕获的评估分别出现九项与七项，不能把条件数量或条件集合写成全产品常量。

**UNKNOWN。** Download 何时可用、找邮箱是否消耗 credits、Show phone 后的解锁和计费流程尚无本次完成态证据；不应为了复刻交互自动执行联系信息解锁。完整九项仍不能证明评级算法已恢复。补充证据：[Match 条件展开（原始证据未公开）](PRIVATE-EVIDENCE.md)。

证据：[资料抽屉完整结构（原始证据未公开）](PRIVATE-EVIDENCE.md)。

![资料抽屉与背景线程（原始证据未公开）](PRIVATE-EVIDENCE.md)

## 6 Inbox

### 6.1 招聘人员任务

查看谁回复、属于哪个岗位、是否值得沟通、是否提供简历和时间；阅读完整邮件往来；打开资料；在同一线程发出自己的回复。列表摘要与线程内容同时存在，避免在多个页面之间来回查找候选人上下文。

### 6.2 桌面结构

**LIVE。** 除固定侧栏外，Inbox 是左右主从布局。截图中候选人列表约 500 px 宽，右侧线程占余下宽度，两者用细竖线分隔。

| 区域 | LIVE 内容 |
| --- | --- |
| 左上 | Inbox 标题 |
| 列表筛选 | 全宽 All Roles 下拉；下面 All、Unread 胶囊切换；All 默认为黑底白字 |
| 候选人列表 | 纵向卡片，使用共享卡片字段；额外显示岗位名称 |
| 选中卡片 | 深色描边；保持卡片圆角 |
| 线程头部 | 头像、姓名、邮箱、岗位 · headline · 地点；右侧 Profile 和 Reply |
| 线程内容 | 发出的邮件组摘要、收到的邮件卡片、时间、主题、正文、引用文本入口及 Reply |
| 底部 | `No more messages` 作为已加载到底标识 |

**REQ。** 左列表与线程正文独立滚动；切换候选人后头部、邮件和 Reply 对象同步。邮箱只显示当前线程真实地址；没有地址时不使用另一条记录的缓存值。筛选应用后，若当前选择不在结果中，应清除或明确处理选择，不能让列表与右侧无提示地指向不同集合。

**LIVE 补充。** All Roles 下拉菜单展示 checkbox `All Roles 1` 与当前可用的职位项 `Software Engineer, Data Infra 1`，均为选中。这里的 1 是该菜单样例值，不能据此推导一人或一条邮件；与列表六人不是同一计数。具体选择角色后的列表结果未在本批证据里完成验证。证据：[Inbox 角色筛选菜单（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 6.3 列表字段与视觉语义

**LIVE。** 卡片包含姓名、评级、岗位、地点、两段履历、教育、邮件反馈条。未读卡片在头像附近用紫色点提示；`New reply` 与相对时间用紫色；已读或较旧回复显示灰色 `Replied`。简历和 availability 标记位于相同底部状态条，可与 New reply 同时出现。

当前捕获列表中存在六人；不得把六人写成页面容量。全局侧栏 Inbox 未读数字与可见卡片数量不相同；未读计数的服务端算法未验证。

### 6.4 邮件线程组件

| 组件 | LIVE 默认状态 | REQ 行为 |
| --- | --- | --- |
| 跟进组摘要 | `4 recruiting follow-ups were sent.`，灰底横条、时间、折叠箭头 | 展开时应显示该组真实消息，不重复其他线程 |
| 外联组摘要 | `3 candidate outreach emails were sent.`，可折叠 | 摘要数与组内消息一致 |
| 收到邮件 | 发件人头像、姓名、NEW、小时间、主题；正文默认展开 | 邮件只读展示，正文保留换行；安全展示邮件 HTML |
| 引用文本 | `Show quoted text`，截图表现为省略号小按钮 | 只展开引用内容，不触发邮件回复 |
| 邮箱 | Copy email 按钮 | 复制实际显示值；不改变发送对象 |
| 回复入口 | 线程头部及邮件内部均有 Reply | 进入同一候选人同一线程的编辑器 |
| 加载到底 | `No more messages` | 不当成没有任何消息的空态 |

**UNKNOWN。** 组摘要展开后具体邮件布局、加载更多方式、邮件排序开关、归档/删除/标记未读入口没有在这批证据中完成验证，不能自行加入。

### 6.5 回复编辑器

**LIVE。** 点击 Reply 后，编辑器插入在线程头下方，原线程保留。编辑器顶部显示 Mira 头像和说明：`Mira will introduce you to {candidate} first`，下一行 `Your reply will be sent immediately after in the same thread.`；随后显示当前招聘人员头像和名字。

| 内容 | 已观察规格 |
| --- | --- |
| 正文区 | 富文本可编辑区域，可访问说明 `Reply content area, start typing to enter text.` |
| 工具栏 | Undo、Redo、List options、Bold、Italic、Strike、Underline、Link、Align left/center/right/justify |
| 字数区 | 空值显示 `0 / 10000` |
| 取消 | `Cancel` |
| 提交 | `Send introduction & reply`，空正文时禁用；帮助提示 `⌘ + Enter` |

**REQ。** 输入正文不应立即发信。空白和超长校验与按钮状态一致，快捷键走相同校验。取消应退出编辑器；本次空编辑器取消后已回到线程。发送必须始终绑定打开编辑器时的候选人和线程，并避免重复提交。提交失败时保留正文并呈现真实错误；这些是复刻功能正确运行所需约束，不是本次已完成发送验证。

**UNKNOWN。** 实际 introduction 邮件内容、introduction 与 reply 的服务端顺序和失败补偿、已有 introduction 时是否改为普通 Send、草稿自动保存和跨页恢复均未验证。本次没有发送邮件，不能报告邮件闭环已通过。

证据：[Inbox 完整结构（原始证据未公开）](PRIVATE-EVIDENCE.md)、[回复编辑器（原始证据未公开）](PRIVATE-EVIDENCE.md)。

![回复编辑器（原始证据未公开）](PRIVATE-EVIDENCE.md)

## 7 Interview

### 7.1 页面目标与结构

**LIVE。** Interview 通过 `/hire/calendar` 打开。背景为浅灰，标题行左侧 Interview，右侧 All Roles 和 All Status。下方是宽日历和窄活动栏，截图中日历约 1005 px、活动栏约 300 px，两者间距约 16 px。两部分白底圆角卡片。

日历不是月视图，也不是固定周一至周五：本次默认显示 Oct 31 – Nov 4, 2026，五列分别为 Saturday 至 Wednesday；选中 Oct 21 后显示 Oct 21 – Oct 25。应称五日时间网格，不能因为空态写着 week 就假定七天。

### 7.2 日历头和时间网格

| 组件 | LIVE 内容或状态 | REQ 复刻约束 |
| --- | --- | --- |
| Today | 当前范围时禁用；历史范围时启用 | 返回当前日期范围，不生成事件 |
| 前后箭头 | 两个图标按钮 | 有可访问名称；实际翻动步长尚未验证 |
| 范围按钮 | 例如 `Oct 31 – Nov 4, 2026` | 与网格列头一致 |
| 日期选择器 | 月标题、前后月按钮、日期表格、当前/选中日期标识 | 选日期后五日范围和列头同步更新 |
| 时区按钮 | `Chicago 10:30 PM GMT-5` | 同时显示地点/时区、当前时间与偏移；时间不得硬编码 |
| 列头 | 英文星期缩写加日期，当前日用紫色 | 日期在时区下保持一致 |
| 时间轴 | 左侧小时刻度，横向细分隔线；当前时间紫线 | 按真实时区换算，夏令时日期不能按固定 GMT-5 计算 |

日期选择器已看见 October 2026 的月历；点击 Oct 21 后显示 Oct 21 – Oct 25，网格确实更新。跨月、夏令时切换和改时区的结果未验证。

证据：[默认日历（原始证据未公开）](PRIVATE-EVIDENCE.md)、[日期选择器（原始证据未公开）](PRIVATE-EVIDENCE.md)、[历史日期结果（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 7.3 筛选

**LIVE。** All Roles 是角色筛选入口，All Status 为状态筛选。状态菜单包含 checkbox，初始五项全部选中：All Status、Invited、Confirmed、Declined、Expired。该菜单的 checkbox 结构表明可多选，但本次没有执行状态子集切换。

**REQ。** 角色和状态共同约束日历事件；不得把 `Availability provided` 直接映射为 Confirmed。全选项与子项一致，所有筛选都使用实际事件数据。筛选后仍无事件时，空态要与未筛选空态区分其原因；具体 Metix 筛选无结果文案为 UNKNOWN。

### 7.4 空态与活动栏

**LIVE。** 日历网格仍显示，即使没有事件；其上居中浮出带阴影的白色空态卡，包含日历插图、`No interviews this week`、`Try another week.`。右栏标题 All Activity，下方插图和 `No activity yet`。本次默认和一个历史五日范围均无事件。

**REQ。** 没有该时段事件不等于没有角色或候选人。请求失败不能呈现此空态。活动栏若存在数据应与事件关联，点击行为和字段须等有数据证据后确定。

**UNKNOWN。** 已保存的非空面试卡片、发送邀请后的回写、候选人接受/拒绝、已存在事件的改期/取消、拖拽和活动详情均无本次证据。下节记录本次已观察的创建邀请表单，不以这些表单证明邀请已送达。

证据：[状态菜单（原始证据未公开）](PRIVATE-EVIDENCE.md)、[五日历视觉（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 7.5 从 Inbox 发起安排面试

**LIVE。** 具有 Resume provided 与 Availability provided 的候选人线程头部出现 Schedule，和 Profile、Reply 并列。点击 Schedule 后出现 `Schedule Interview - {candidate}` 大抽屉。桌面截图中背景 Inbox 加暗，右侧约 1150 px 被排期界面覆盖：左边约 710 px 五日时间网格，右边约 440 px 配置侧栏。两步之间日历和已选择时间持续可见。

#### 第一步 Pick times

**LIVE。** 配置标题 `Step 1: Pick times`，右上 Close，底部 Next。默认 Single time 选中；未选时间时显示 `Pick a time on the calendar to get started`，Next 禁用。

| 组件 | LIVE 文案和状态 | REQ 实现约束 |
| --- | --- | --- |
| Single time | `One specific interview time.` | 一次具体面试时间的模式，不等于已确认的事件 |
| Multiple options | `Propose several slots. Candidate picks one.` | 与 Single time 互斥；多个候选时间不是多个同时创建的面试 |
| 日历可用时间 | 浅紫底区域；图例 Preferred interview times；Candidate: GMT-7 | 表示候选人提供的偏好，不是主办人全量日历空闲 |
| 已选时段 | 紫色边框/浅紫填充，网格内显示开始结束时间 | 与侧栏的同一时段联动，不能各存一份互相失步 |
| 时间范围卡 | Start/End 日期弹出按钮与时间 combo box；Remove time | 结束晚于开始；修改日期和时间后统一校验 |
| 候选人本地时间 | `CANDIDATE Nov 2, 9:00 AM - 9:30 AM (GMT-7)` 样例 | 必须以时区和该事件日期转换，不能直接复用截图偏移 |
| Add time range | 按钮 | 当前模式允许范围的规则应清楚；本次未验证添加上限和重复时段处理 |
| Next | 未选时禁用；选中单时段后可进入第二步 | 只推进表单，不发送邀请 |

本次在 Nov 2 日历上选择 11:00 AM 后，UI 生成 11:00–11:30 的范围并显示候选人 9:00–9:30（GMT-7），然后进入第二步。此样例证明 UI 会显示双方时间，不证明其转换正确，尤其跨夏令时日期。复刻必须用具体事件日期和真实时区计算，而不照搬原站的动态时间数值。

#### Multiple options 与 Advanced

**LIVE。** 切换 Multiple options 后出现 Duration 下拉，当前值 `30 min`；Times 区显示 `1 slot`，提供 Preview；保持一条范围时 Next 禁用。本次没有添加第二时段，因此无法确定这是“至少两个选项”校验还是其他原因。

Advanced 展开后包含：

| 字段 | LIVE 值或文案 | 范围 |
| --- | --- | --- |
| Minimum Notice | 数字输入 `2`，单位 `hours` | `Candidates won't see slots starting sooner than this.` |
| Avoid conflicts | 默认勾选 | 下方明确 `Only checks Metix AI meetings.` |
| Connect Calendar | 按钮，后接 `to include your full schedule.` | 只看到连接入口，未执行连接 |

**REQ。** 未连接外部日历时不能声称已排除招聘人员所有日历冲突。Minimum Notice 按实际当前时间与时段起点判断；单位及范围校验与输入一致。Duration 的可选集合、Preview 内容、多个时段的排序和冲突策略均是 UNKNOWN，不自行填入常见日历产品默认值。

#### 时区选择

**LIVE。** 点击日历时区按钮打开带搜索输入的城市列表，各行展示城市、当地日期时间和 GMT 偏移。菜单中观察到多个城市项；本次未执行选择新的城市。

**REQ。** 复刻列表以平台时区数据生成；展示偏移根据日期计算。截图中的若干城市偏移及样例未来时间转换需要独立验证，不能将菜单数值视为可靠时区规格。切换显示时区应保留相同实际时间点，而不是保持数字时刻造成面试漂移。

#### 第二步 Customize invite

**LIVE。** 点击 Next 进入 `Step 2: Customize invite`。右侧依次为 Guests、Location、Notes，底部 Back 与 Send invitation。

| 字段 | LIVE 表现 | REQ 校验 |
| --- | --- | --- |
| Guests | `Guests (2)`；候选人 chip 标 Candidate、当前用户 chip 标 You | 两个身份来自当前线程和当前用户，不混用缓存的收件人 |
| 额外来宾 | `Enter email to invite others...` 输入 | 邮箱格式和重复值校验；输入不等于已发送邀请 |
| Location 类型 | Online 默认黑底选中；In Person 为另一选项 | 两者互斥，所填位置与模式对应 |
| Online 位置 | 输入占位 `https://example.invalid/resource` | 这是占位提示，不能宣称已自动生成 Google Meet |
| Notes | 可选多行；占位 `Any additional information for the candidate...` | 最大 1000，计数 `0/1000`；超长不可静默截断 |
| Back | 返回选时间 | 保留当前合理输入及已选时段 |
| Send invitation | 提交动作 | 才可触发邀请；提交中防重，错误保留输入并显示真实失败 |

本次没有填写额外来宾、位置和 Notes，也没有点击 Send invitation。空位置时按钮看起来可用，不证明位置在后端是可选字段；原站最终提交校验为 UNKNOWN。

#### 关闭与未保存更改

**LIVE。** 有已选时间的编辑界面关闭时出现确认弹窗：`Exit editing this event?`，说明 `Your changes to this event will not be saved.`；按钮 `Back to Edit`、`Exit`。复刻必须保留该退出提醒，避免用户无意丢失已选时段；这里的 event 字样不表示事件已经保存。

证据：[带资料和 availability 的 Inbox（原始证据未公开）](PRIVATE-EVIDENCE.md)、[排期初态（原始证据未公开）](PRIVATE-EVIDENCE.md)、[选择时段（原始证据未公开）](PRIVATE-EVIDENCE.md)、[多选模式（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Advanced（原始证据未公开）](PRIVATE-EVIDENCE.md)、[时区菜单（原始证据未公开）](PRIVATE-EVIDENCE.md)、[定制邀请（原始证据未公开）](PRIVATE-EVIDENCE.md)、[退出提醒（原始证据未公开）](PRIVATE-EVIDENCE.md)。

![安排面试 选择时间（原始证据未公开）](PRIVATE-EVIDENCE.md)

![安排面试 定制邀请（原始证据未公开）](PRIVATE-EVIDENCE.md)

## 8 Shortlist

### 8.1 当前已观察页面

**LIVE。** `/hire/shortlist` 显示 Shortlist 标题及空态：

| 部分 | 原文 |
| --- | --- |
| 空态标题 | `No shortlisted candidates yet` |
| 说明 | `Save candidates from a search and they will show up here.` |
| 行动 | `Start Search`，链接到 `/hire` |

这说明 Shortlist 表达用户保存的候选人，而不是 Match、Contact 或 Interested 集合的别名。当前角色 Interested 有六人而全局 Shortlist 为空，进一步说明不能用阶段结果替代 shortlist membership。

**REQ。** Shortlist membership 应独立保留。没有已保存候选人时展示上述空态；正在加载时不能先断言无人。Start Search 应进入新角色/搜索入口，不能自动启动计费搜索或对候选人采取动作。

### 8.2 未观察部分

**UNKNOWN。** 候选人保存按钮、非空 Shortlist 的卡片/表格布局、排序、筛选、批量选择、移除和进入 Sequence 的流程未被当前页面覆盖。不能将 Juicebox 的 Table/Board、列配置和批量操作搬入后称为 Metix 实测。

证据：[Shortlist 完整空态（原始证据未公开）](PRIVATE-EVIDENCE.md)。

![Shortlist 空态（原始证据未公开）](PRIVATE-EVIDENCE.md)

## 9 Sequence

### 9.1 列表页

**LIVE。** `/hire/sequence` 标题是 Sequences，副文案 `Build reusable email workflows and track every enrollment.`。右上 New sequence。标题下提供 Active、Archived 胶囊式状态切换，Active 默认选中。当前列表为空，中心空态 `No sequences yet`、`Create a reusable email sequence to contact candidates.`，另有 New sequence 按钮。

**REQ。** 两个 New sequence 入口进入同一流程。Active/Archived 是 sequence 状态而不是候选人评级；归档列表不能影响已有 Inbox 历史。归档动作本身未观察，不自行添加该按钮的具体位置或确认文案。

### 9.2 邮箱前置弹窗

**LIVE。** 点击 New sequence 后显示遮罩和居中约 480 px 宽白色圆角弹窗。内容顺序：

| 顺序 | 组件 | 原文及状态 |
| --- | --- | --- |
| 1 | 图标、标题、说明、关闭 X | `Connect your mailbox`；`Connect your mailbox, or get started with Mira’s mailbox.` |
| 2 | Gmail 行 | `Connect Gmail (coming soon)`，禁用 |
| 3 | Microsoft 行 | `Connect Microsoft (coming soon)`，禁用 |
| 4 | IMAP 行 | `Connect IMAP`，可用，行右侧箭头 |
| 5 | 底栏说明 | `Use Mira’s mailbox for now. Replies appear in Inbox.` |
| 6 | 次要动作 | `Maybe later` |

早期即时快照曾暂留空列表；本次等待稳定页面后已确认 Maybe later 可进入 `/hire/sequence/new` 的 Tailor your sequence 上下文表单。进入表单不等于已保存 sequence 或已生成邮件步骤。

**REQ。** 禁用项不能触发授权；Maybe later 关闭邮箱选择并允许使用 Mira’s mailbox 进入新建上下文表单；在用户提交后续表单之前，不能报告已创建 sequence。关闭弹窗恢复页面和触发按钮的焦点。IMAP 下一步没有采集，不能虚构认证字段或保存机制。

证据：[Sequence 列表（原始证据未公开）](PRIVATE-EVIDENCE.md)、[邮箱弹窗（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Maybe later 之后（原始证据未公开）](PRIVATE-EVIDENCE.md)。

![Sequence 邮箱连接前置（原始证据未公开）](PRIVATE-EVIDENCE.md)

### 9.3 新建上下文表单

**LIVE 新证据。** Maybe later 后进入 `/hire/sequence/new`，页标题 New sequence，主标题 Tailor your sequence，说明 `Share the role and company details, and we’ll build the sequence around them.`。桌面和390手机均已采集；早期 `design-details/states/metix-sequence-empty-390` 文件实际就是此表单，不能当成手机空列表。

| 区块 | LIVE 组件和文案 | 交互 |
| --- | --- | --- |
| 顶栏 | Back to sequences、New sequence | 返回 `/hire/sequence` |
| Sender email | Connect a mailbox、Sender email: Mira’s mailbox | 可展开发送人菜单 |
| Role | Job title、Job posting URL Optional、Role description | 职位单行输入、URL单行输入、多行说明；截图Job title有必填星号 |
| Company | Change company、公司logo、Company name、Website (optional) | 当前账号公司名称和网站预填；Company name有必填星号 |
| 公司说明 | Show company description / Hide company description、Company description | 展开/收起多行说明；已验证展开，不修改文本 |
| 底栏 | Cancel、Continue to emails | Cancel返回列表；Continue已实测生成三封邮件并创建草稿，未Publish |

发送人菜单标题 `Sender for all steps in this sequence`；Mira’s mailbox 已选，标 `Assigned to your AI Agent`；Connected mailboxes 区域提示 `No mailbox connected`、`Mira is available. Connect your mailbox whenever you’re ready.`，另有 Connect a mailbox。没有连接自有邮箱也能填写此上下文；不能将邮箱连接当成绝对业务阻断。

**REQ。** 必填星号与实际校验一致；URL可选，不能强制杜撰URL。已有公司资料只作为当前账号预填，不能硬编码成默认公司的全产品常量。展开公司说明保留原值，不自动重写。Continue只推进新建流程；生成成功、保存成功和开始发送应分别确认，不能把任何一个页面跳转当成全部完成。

证据：[桌面上下文](design-details/states/metix-sequence-context-1440.txt)、[公司说明展开](design-details/states/metix-sequence-context-expanded-1440.txt)、[发送人菜单](design-details/states/metix-sequence-sender-menu-1440.txt)、[手机上下文](design-details/states/metix-sequence-context-390.txt)。精确组件标注见 [Metix 设计测量](design-details/METIX-DESIGN-ANNOTATIONS.md)。

### 9.4 生成后的 Sequence 编辑器与 Recipients

**LIVE。** 填写上下文并执行 Continue to emails 后，进入 `/hire/sequence/sample-object`。本次因此实际创建服务器草稿 `UI inspection draft — Backend Python Engineer sequence`，Recipients 0；未Publish，未发送。进入此编辑器已有持久记录副作用，不能继续称整个采集没有创建数据。

| 区域 | 真实组件与内容 | 行为/状态边界 |
| --- | --- | --- |
| 头部 | 返回、sequence名称、Editor、Recipients 0 | Editor与Recipients为独立视图 |
| 开始 | Start immediately after enrollment | 仅展示计划，尚未enroll |
| 三封邮件 | Introduction email、Follow-up 1、Follow-up 2 | 每封均含Sender email、Manage、Subject、Message |
| 主题 | 可编辑主题及变量chip、Insert variable | 示例We are hiring: {job_title} at {company_name}；未实测改值后的保存时机 |
| 正文 | 富文本、变量chip、独立正文滚动区 | Undo/Redo初始禁用；列表、粗/斜/删除线/下划线、链接、四种对齐、Insert variable |
| 两段等待 | Wait、数字2、增减按钮、days | 分别位于下一封follow-up前；不能将days擅改为工作日 |
| Favorite | Favorite sequence checkbox | 初始未选 |
| 名称 | Sequence Name必填，输入与计数 | 当前真实54/50；未验证长度校验，不能推断一定接受或拒绝 |
| 描述 | Sequence Description textarea | 当前0/100 |
| Delivery | Sending window 09:00–21:00、Timezone、Business days only | 时区可搜索城市；Business days only初始关闭 |
| Exit criteria | Reply received | 明确回复退出条件，不编造其他条件 |
| 底栏 | Cancel、Previous、Publish | 桌面Publish有快捷键提示；未执行Publish |

变量菜单八项：`{job_title}`、`{company_name}`、`{candidate_first_name}`、`{candidate_current_company}`、`{compensation_and_location}`、`{responsibility_list}`、`{sender_name}`、`{relevant_domain}`。本次打开菜单但未插入，不推断空变量填充策略。

Recipients视图左侧Search recipients/Search，All、Active 0、Paused 0、Exited 0；初始Active选中。左空态`No recipients in this status / Choose another status to view recipients.`，右空态`Select a recipient / Review their emails and sending progress here.`。没有非空收件人、联系人选择或批量动作证据。

手机390将桌面右侧设置排在三封邮件之后；顶部和底栏保留，标题省略。邮件正文自身320高可滚动。本次“scrolled”采集仅第一封正文scrollTop216，主编辑区scrollTop0，不能证明已滚到页面设置区。

**REQ。** 主题/正文编辑必须保持变量的完整边界；延迟只调整对应后续步骤；交付时间窗、时区、工作日选择应一致作用于实际计划。Publish必须采用真实校验和提交状态，避免重复发布；进入编辑器创建草稿、发布成功、enrollment和发信成功分别表达，不能混为同一完成状态。Previous不能无提示丢失草稿。这些是正确复刻所需约束，不代表已实测服务端行为。

**UNKNOWN。** 修改后的自动保存机制、名称超限校验、Publish结果、启停、联系人选择、enrollment、非空Recipients、执行统计与真实发送仍未观察。不能用角色Outreach或Juicebox对应界面替代这一编辑器的缺失证据。

证据：[编辑器](design-details/states/metix-sequence-editor-1440.txt)、[变量](design-details/states/metix-sequence-variables-1440.txt)、[设置](design-details/states/metix-sequence-editor-settings-1440.txt)、[时区](design-details/states/metix-sequence-timezone-1440.txt)、[Recipients](design-details/states/metix-sequence-recipients-1440.txt)、[手机](design-details/states/metix-sequence-editor-390.txt)、[正文滚动](design-details/states/metix-sequence-editor-scrolled-390.json)。尺寸、样式和截屏见[设计标注](design-details/METIX-DESIGN-ANNOTATIONS.md)。

### 9.5 角色 Outreach 执行工作区

该页与全局可复用 Sequences 列表不同。**LIVE。** 从角色顶部 Outreach 或聊天中的 Open the outreach workspace 可进入 `/hire/role/{roleId}?workspace=outreach`，显示 Back、Outreach 标题和刷新活动入口。

#### 已完成状态与统计

**LIVE。** 顶部白色/浅灰状态卡标题 `Outreach complete`，badge `Completed`，说明 `Automated outreach has ended. No more messages will be sent, but any late replies will still appear in Inbox.`。右侧 `Review 6 interested`，下方四个可点击统计区：

| 指标 | 当前样例 |
| --- | --- |
| Contacted | 261 |
| Replies | 19 |
| Interested | 6 |
| Failed | 17 |

这些指标与角色 Candidate List 的 Contact 303 不一致，故不能合并成同一口径或强行用总数做相减。计数的归因范围、去重、重试和时间窗口为 UNKNOWN；复刻应显示各自已有事实，不能用一套臆造公式把数字凑齐。统计点击后的详情未在本批证据中验证。

#### Email 工作流

**LIVE。** 内容标签 Email、Job Posting。Email 中以流程节点和连线呈现外联过程，左边纵向主链，右边收回复后的条件分支。已完成节点有完成标识及时间：

| 顺序 | 节点 | 观察内容 |
| --- | --- | --- |
| 1 | Introduction email | 邮件卡：Mira 头像、姓名、Senior Recruiter、主题、摘要、可折叠正文 |
| 2 | Wait 2 days | 时钟图标胶囊 |
| 3 | Follow-up 1 | 时间、邮件卡 |
| 4 | Wait 2 days | 与前段同样的等待胶囊 |
| 5 | Follow-up 2 | 时间、邮件卡 |
| 分支 1 | Waiting for reply | 明确文案 `Any reply stops their remaining follow-ups.` |
| 分支 2 | If interested | 条件菱形节点 |
| 分支 3 | Send job posting and collect details | 显示 `6 sent`，说明 `Sent after each interested reply.`，附邮件卡 |

**REQ。** 任意回复停止该人的后续自动跟进，与“只有有兴趣才停止”严格区分。有兴趣之后发送职位内容是单独条件分支；不把所有回复都归为 Interested。Completed 结束自动外联，但不得丢弃之后到达的邮件，晚到回复仍进入 Inbox。等待时间本次是 days，不能擅改为 business days。

**UNKNOWN。** 流程的编辑模式、启动前审批、个别失败详情、重试入口、工作日规则、每个统计项的过滤详情未恢复。页面中邮件正文在 AX 里标为可设置字段，不证明完成态页面允许编辑并持久化；本次没有修改正文。

#### Job Posting 标签

**LIVE。** 切换到 Job Posting 后显示 Role Info 与职位详情：公司、职位标题、地点、日期、薪酬区间/股权、资历、Full time、Onsite、Offers Equity；随后是招聘人员/公司身份、About the Role、Required 列表和 About the Company。

当前样例 Required 出现 5 to 7 years，另有 Python、NumPy/Pandas、数学/几何、PostgreSQL/Redis、GCP/AWS、Redwood City onsite；角色历史中又存在 7+ years 的沟通要求。复刻要保留不同内容来源与版本，不能在 UI 层自动重写旧发布内容来掩盖不一致。是否有发布版本锁定或同步提示为 UNKNOWN。

本页看见职位文本，不代表已访问候选人的个性化申请链接，也不证明链接的权限与收集表单逻辑。

证据：[Outreach 完成态与 Email 流程（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Job Posting（原始证据未公开）](PRIVATE-EVIDENCE.md)。

![角色外联工作流（原始证据未公开）](PRIVATE-EVIDENCE.md)

## 10 数据关系与全链路约束

本节是 REQ，描述已观察功能正确衔接所需的最小关系，不指定新数据库、服务或重构架构。

| 页面对象 | 最小关联信息 | 逻辑约束 |
| --- | --- | --- |
| 角色 | 稳定角色标识、名称 | 同名角色区分；查询范围明确 |
| 角色中的候选人 | 候选人标识、角色标识、评级、阶段 | 评级与阶段分别保存；不跨角色串值 |
| 资料 | 原始经历/教育/项目、关联评估 | 原始资料与平台评价分开展示 |
| Shortlist | 用户/团队范围、候选人、角色关联、是否保存 | 不由 Interested 推导 membership |
| 邮件线程 | 线程标识、角色、候选人、实际地址、消息 | 回复永远使用实际线程归属 |
| 邮件 | 发件人、主题、正文、时间、已读信息、引用/附件关联 | NEW、Replied、Resume、Availability 有各自来源 |
| Sequence | sequence 标识、Active/Archived、邮箱关联 | 列表不是邮件线程本身 |
| Interview | 事件标识、角色、候选人、时间、时区、邀请状态 | Availability 只说明有时间材料，不等于 confirmed 事件 |

### 10.1 已观察的跨页面连续性

- LIVE：同一角色候选人的姓名、评级、经历和材料提示在 Candidate List 与 Inbox 可对应。
- LIVE：Inbox 的 Profile 在当前页面打开抽屉，保留线程背景。
- LIVE：Inbox 的 Reply 开启同一候选人的介绍与回复编辑器，空编辑器可取消。
- LIVE：Sequence 弹窗说明回复出现在 Inbox；新 sequence 到实际回复的完整执行链尚未验证。
- LIVE：带 Availability provided 的 Inbox 线程可用 Schedule 打开选时间、定制邀请两步表单；没有发送，不能证明保存事件或阶段同步。
- LIVE：角色 Outreach 明确展示任意回复停止后续跟进、有兴趣后发送职位及收集资料的分支；Completed 后晚到回复仍归 Inbox。
- REQ：界面不应把“有回复”“有兴趣”“有可用时间”“面试已确认”折叠成一个成功状态。

### 10.2 异步与边界

- REQ：切换候选人、角色、阶段或筛选后，较早请求的迟到响应不能覆盖新选择。
- REQ：读取失败与真实零记录区分，避免把失败误报为空。
- REQ：回到列表时保留合理的选择与位置；是否与 Metix 原生跨页持久化完全一致为 UNKNOWN。
- REQ：邮件正文和链接在渲染边界验证，不把外部邮件内容视作系统指令。
- REQ：复制、折叠、查看和筛选不能发送邮件或改变候选人阶段。
- REQ：发信和排期只在对应提交动作后发生；不得为了达到视觉完成态伪造事件或邮件。

## 11 页面状态与复刻验收口径

| 模块 | LIVE 已见状态 | REQ 实现必须明确处理 | UNKNOWN 原站具体样式 |
| --- | --- | --- | --- |
| 候选人列表 | 角色加载、Interested 有数据、Worth Talking 子集、Match 分页 | 加载、成功、筛选无结果、读取失败 | 无结果文案、失败组件、分页请求策略 |
| 资料抽屉 | 开启、关闭、Finding email、Download 禁用 | 独立滚动、正确资料、关闭恢复焦点 | 联系信息完成态和计费 |
| Inbox | 多候选人、选中线程、折叠组、NEW、Replied、材料提示 | 当前选择与线程一致、读取失败、无线程 | 全局空态、标记已读触发时机 |
| 回复 | 空编辑器、发送禁用、取消、快捷键提示 | 校验、提交中防重、成功/失败明确、失败保留正文 | 服务端发送结果与后续介绍策略 |
| Interview | 当前/历史五日范围、状态菜单、空活动、Inbox 发起排期两步、退出确认 | 时区一致、时间有效、筛选组合、邀请防重、错误保留表单 | 邀请提交结果、已保存事件详情和改期 |
| Shortlist | 全局空态 | membership 独立、加载和失败区分 | 有数据时全部细节 |
| Sequence | 空列表、邮箱前置、上下文、三封邮件编辑器、变量、Delivery、零Recipients | 必填与发布校验、变量完整、编辑保存与发布状态准确 | 非空列表/Recipients、Publish结果、enrollment、执行状态 |

完整验收操作见 [METIX-ACCEPTANCE.md](METIX-ACCEPTANCE.md)。其中标为 REQ 的用例是交给实现方执行的验收项，不是本次对 Metix 的测试通过报告。

## 12 仍需补齐的原站观察

| 优先项 | 缺口 | 对完全复刻的影响 |
| --- | --- | --- |
| M1 | 非空 Shortlist 与保存/移除流程 | 不能确定卡片、表格、排序、批量动作 |
| M2 | Sequence发布、enrollment及非空Recipients | 已见三封生成邮件、变量和Delivery并创建草稿；尚未Publish，未验证执行与收件人进度 |
| M3 | 一次邀请提交结果、一个已保存 Interview 事件及改期流程 | 已见创建表单，尚无法确认事件卡、送达、确认和改期结果 |
| M4 | Reply 实际发送成功与失败结果 | 无法确认介绍邮件、回写、重试和草稿策略 |
| M5 | 评级生成规则与版本归因 | 已展开 Strong Match 九项和 Worth Talking 七项，但不能恢复私有判定规则 |
| M6 | 跨角色 Inbox/Interview 筛选完整结果与时区切换 | 当前仅入口和部分日期切换有证据 |
| M7 | 未覆盖机型、键盘、缩放、全部长文本和失败态 | 已采桌面/1024/768/390及600低高视口，仍不能据离散样本声称全部断点和异常态已验证 |

这些项目保持 UNKNOWN。可以依据本规格复刻已经观察到的 UI 和行为，但不能据此声称所有 Metix 功能、隐藏状态和后端算法已完整恢复。
