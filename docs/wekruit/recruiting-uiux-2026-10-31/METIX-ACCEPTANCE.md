> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# Metix 功能复刻验收用例

本清单配合 [METIX-PRD.md](METIX-PRD.md) 使用。LIVE 表示本次登录态已有对应观察；REQ 表示复刻实现需要执行的检查；UNKNOWN 表示原站尚缺证据。这里没有将未实施的复刻代码或真实邮件发送标为通过。

## 1 候选人列表与评级

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MC01 | LIVE | 打开已采集角色的 Candidate List | 显示 Interview、Interested 6、Contact 303、Match 307，样例数据来自当前记录，不能硬编码 |
| MC02 | LIVE | 在 Interested 打开 Score | All scores 6、Strong Match 3、Worth Talking 3、Not Match 0；默认 All scores |
| MC03 | LIVE | 选择 Worth Talking | 结果仅三张 Worth Talking 卡；阶段标签总数仍 6；不改变评级或阶段 |
| MC04 | LIVE | 从所观察的 Interested 过滤结果切到 Match | 显示 All scores、Match 候选人和分页；第一页面积为 1–50 of 307，Page 1 of 7 |
| MC05 | REQ | 换两个同名但不同标识的角色 | 每个角色各自的候选人、计数和评级不会串值 |
| MC06 | REQ | 在过滤结果翻页后改变评级筛选 | 页码回到有效范围，分页与结果总数一致 |
| MC07 | REQ | 选择无结果评级 | 不改原始数据；结果区说明没有匹配记录；不是网络失败空态 |
| MC08 | REQ | 候选人同时具有 Worth Talking、Interested、Replied | 三个维度同时保留；任何一个不覆盖另外两个 |
| MC09 | REQ | 卡片姓名、学校或职位很长，头像缺失 | 布局不溢出；关键信息仍可辨认；头像使用占位 |
| MC10 | REQ | 旧筛选请求延迟返回，用户已选择新筛选 | 旧结果不覆盖新筛选 |
| MC11 | UNKNOWN | 判定 Strong Match/Worth Talking 阈值 | 原站算法未恢复，不能以自拟阈值验收为一致 |
| MC12 | LIVE | 确认 示例候选人 本人线程/Profile 后展开七项 | Worth Talking 与六项Met、一项Not met共存；Preferred保留；Not met解释是缺显式PostgreSQL与AWS/GCP证据 |
| MC13 | REQ | 展示缺证据的Not met解释 | 不改写为“确认不会”，不从六Met/一Not met推导评级公式 |

证据：[列表（原始证据未公开）](PRIVATE-EVIDENCE.md)、[筛选菜单（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Worth Talking 结果（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Match 分页（原始证据未公开）](PRIVATE-EVIDENCE.md)。

## 2 资料抽屉

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MP01 | LIVE | Inbox 当前线程点击 Profile | 从右侧打开 Profile，保留底层 Inbox 与当前线程 |
| MP02 | LIVE | 查看首屏 | 姓名/headline/地点/LinkedIn、Download、Mira's Recommendation、Contact details、段落导航按规格排列 |
| MP03 | LIVE | 查看 Inbox 当前样例 Recommendation | 默认三项条件、状态和解释；Show all 7 criteria 入口存在 |
| MP09 | LIVE | 打开已采集 Match 候选人并展开全部评价 | 显示九项条件，其中后四项有 Preferred；不同评估的数量不可硬编码为九或七 |
| MP04 | LIVE | 关闭 Profile | 返回原线程；未执行发信或阶段变更 |
| MP05 | REQ | 切换不同候选人再打开 Profile | 资料、链接、条件评价对应当前候选人和岗位 |
| MP06 | REQ | 键盘打开/关闭抽屉 | 焦点进入抽屉，关闭恢复到触发点；背景控件不被误触 |
| MP07 | REQ | 点击 Experience/Education/Skills/Projects/Courses | 定位对应真实内容；未提供的资料不伪造 |
| MP08 | UNKNOWN | Show phone 或 Finding email 完成 | 解锁、计费和完成态尚无本次证据，不当成已测通过 |

证据：[Profile（原始证据未公开）](PRIVATE-EVIDENCE.md)。

## 3 Inbox 与 Reply

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MI01 | LIVE | 打开 Inbox | 固定侧栏、候选人列表、线程三块布局；All Roles、All/Unread 可见 |
| MI02 | LIVE | 查看有回复候选人的卡片 | 评级与职位/履历可见；New reply/Replied 与时间位于状态条；材料提示可共存 |
| MI03 | LIVE | 查看已采集线程 | 发件人、时间、主题、正文、引用文本入口；外联和跟进用折叠组摘要 |
| MI04 | LIVE | 点击 Reply | 线程内插入富文本编辑器，显示 Mira 先介绍的说明和当前招聘人员身份 |
| MI05 | LIVE | 保持正文为空 | `0 / 10000`，Send introduction & reply 禁用，显示 ⌘+Enter 提示 |
| MI06 | LIVE | 空编辑器点击 Cancel | 关闭编辑器并显示原线程，不发信 |
| MI07 | REQ | 在线程 A 打开编辑器，随后尝试切到 B | 不允许把 A 的正文无提示发给 B；提交始终绑定正确线程和收件人 |
| MI08 | REQ | 输入纯空白或超过 10000 字符，触发按钮及快捷键 | 两种提交入口遵循同一校验 |
| MI09 | REQ | 连续点击发送或重复快捷键 | 一次用户提交不会重复发送 introduction 或 reply |
| MI10 | REQ | 发送失败 | 展示失败并保留正文，不显示假成功，不修改他人线程 |
| MI11 | REQ | 请求失败而非无消息 | 错误与真实空列表区分，不渲染 No more messages 冒充成功 |
| MI12 | REQ | 切换 All Roles/具体角色、All/Unread | 候选人列表和线程选择关系明确；不存在列表与右侧静默错配 |
| MI13 | REQ | 查看外部邮件 HTML、链接和引用内容 | 安全展示；外部内容不能执行脚本或变成代理操作指令 |
| MI14 | UNKNOWN | 真实发送后检查两封邮件顺序和回写 | 本次未发送，需单独授权的受控业务验证；不能在文档中写“已通过” |
| MI15 | UNKNOWN | 已读状态、未读角标和跨页持久化 | 本次界面有观察，触发与计数算法尚未完整验证 |
| MI16 | LIVE | 打开All Roles菜单 | checkbox All Roles1与当前职位项1，显示当前选中态；菜单数字不得解释成当前六人列表的候选人数 |

证据：[Inbox（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Reply（原始证据未公开）](PRIVATE-EVIDENCE.md)。

## 4 Interview

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MV01 | LIVE | 打开 Interview | 浅灰背景、白色五日时间网格、右侧 All Activity；标题行有 All Roles 和 All Status |
| MV02 | LIVE | 当前捕获日期范围 | Oct 31–Nov 4 共五列；Today 禁用；时区按钮显示 Chicago、时间、GMT-5 |
| MV03 | LIVE | 打开日期选择器选择 Oct 21 | 范围更新 Oct 21–Oct 25；列头同步；Today 可用 |
| MV04 | LIVE | 打开 All Status | All Status、Invited、Confirmed、Declined、Expired 初始全部选中 |
| MV05 | LIVE | 无事件的当前/历史范围 | 网格保留，居中 No interviews this week / Try another week；活动栏 No activity yet |
| MV06 | REQ | 从历史范围点击 Today | 返回当前日期范围；不是创建事件 |
| MV07 | REQ | 组合角色与状态过滤 | 仅显示关联角色及选中状态；计数、网格和活动范围一致 |
| MV08 | REQ | 跨夏令时或更改显示时区 | 日期列、事件时间、当前时间线统一转换，不固定使用 GMT-5 |
| MV09 | REQ | 候选人只有 Availability provided | 不出现伪造 Confirmed 面试 |
| MV10 | REQ | 面试查询失败 | 展示读取错误，不能使用 No interviews this week 隐藏错误 |
| MV11 | UNKNOWN | 邀请提交结果、确认、已保存事件的改期/取消和详情 | 已采集创建邀请表单，但没有提交或非空保存事件证据 |

证据：[日历（原始证据未公开）](PRIVATE-EVIDENCE.md)、[状态（原始证据未公开）](PRIVATE-EVIDENCE.md)、[日期选择器（原始证据未公开）](PRIVATE-EVIDENCE.md)、[历史结果（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 4.1 Inbox 发起排期表单

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MV12 | LIVE | 在带 Resume provided/Availability provided 的候选人 Inbox 查看线程头 | Profile、Reply、Schedule 三个入口 |
| MV13 | LIVE | 点击 Schedule | 大抽屉保留 Inbox 背景，左日历、右侧 Step 1: Pick times；候选人姓名正确 |
| MV14 | LIVE | 初态不选时间 | Single time 选中；提示 Pick a time on the calendar to get started；Next 禁用 |
| MV15 | LIVE | 选择 Nov 2 11:00 AM | 已采集 UI 生成 11:00–11:30 的块，右侧出现 Start/End 与候选人本地时间、Remove time、Add time range |
| MV16 | LIVE | 有单一时段后点击 Next | 进入 Step 2: Customize invite；日历与所选时段持续可见 |
| MV17 | LIVE | 查看第二步 | Guests (2)、Candidate/You、额外邮箱输入、Online/In Person、位置输入、Notes 最大1000、Back、Send invitation |
| MV18 | LIVE | Back 后选择 Multiple options | Duration 30 min、Times 1 slot、Preview、Advanced；当前一条范围时 Next 禁用；本次未确立禁用原因 |
| MV19 | LIVE | 展开 Advanced | Minimum Notice=2 hours，Avoid conflicts 勾选；Only checks Metix AI meetings；Connect Calendar 提示 |
| MV20 | LIVE | 打开时区菜单 | 搜索输入和城市/当地时间/GMT 偏移列表；未改变所选时区 |
| MV21 | LIVE | 有已选时间后 Close | Exit editing this event?；Your changes to this event will not be saved.；Back to Edit 与 Exit |
| MV22 | REQ | 选择结束早于开始、重复或无效范围 | 不允许进入无效邀请；错误在相关时间字段呈现，不静默改时间 |
| MV23 | REQ | 跨夏令时生成双方显示时间 | 用具体事件日期的真实时区计算；不能照搬截图 Chicago/GMT-7 的样例偏移 |
| MV24 | REQ | 未连接外部 Calendar，Avoid conflicts 打开 | 仅声称检查 Metix AI meetings，不声称检查完整日程 |
| MV25 | REQ | Notes 超1000、重复来宾邮箱、无效邮箱 | 明确字段校验；不能静默截断、重复邀请或绑定错人 |
| MV26 | REQ | 在第二步点 Back，再前进 | 当前候选人、时间和合理已填内容保留；不发送邀请 |
| MV27 | REQ | 点 Exit / Back to Edit | 前者放弃未保存表单，后者回到已有编辑内容；两者都不发送邀请 |
| MV28 | REQ | Send invitation 多次点击或请求失败 | 防重复；失败保留时间及表单；不伪造日历事件或成功状态 |
| MV29 | UNKNOWN | Multiple options 的最少时段、上限、Preview 与完整提交结果 | 只有入口和当前状态，不能套用其他排期服务的规则 |

证据：[排期初态（原始证据未公开）](PRIVATE-EVIDENCE.md)、[单时段（原始证据未公开）](PRIVATE-EVIDENCE.md)、[定制邀请（原始证据未公开）](PRIVATE-EVIDENCE.md)、[多选（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Advanced（原始证据未公开）](PRIVATE-EVIDENCE.md)、[时区（原始证据未公开）](PRIVATE-EVIDENCE.md)、[退出确认（原始证据未公开）](PRIVATE-EVIDENCE.md)。

## 5 Shortlist

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MS01 | LIVE | 当前账号打开 Shortlist | No shortlisted candidates yet；Save candidates from a search and they will show up here；Start Search |
| MS02 | LIVE | 检查 Start Search 链接 | 指向 /hire |
| MS03 | REQ | 角色有 Interested 候选人但无人保存 | Shortlist 仍按保存关系显示，不能把 Interested 自动当 Shortlist |
| MS04 | REQ | 数据加载或失败 | 不提前宣告 No shortlisted candidates yet |
| MS05 | UNKNOWN | 非空 Shortlist 及保存/移除流程 | 当前界面未覆盖，不能将 Juicebox 表格/看板当成 Metix 实测 |

证据：[Shortlist（原始证据未公开）](PRIVATE-EVIDENCE.md)。

## 6 Sequence

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MQ01 | LIVE | 打开当前 Sequence | 标题、副文案、Active/Archived、顶部及空态 New sequence；No sequences yet |
| MQ02 | LIVE | 点击 New sequence | Connect your mailbox 弹窗；Gmail/Microsoft coming soon 禁用；IMAP 可用；Maybe later |
| MQ03 | LIVE | 点击 Maybe later并等待稳定导航 | 弹窗关闭，进入/hire/sequence/new的Tailor your sequence上下文表单；没有生成邮件或发送 |
| MQ04 | REQ | 点击禁用的 Gmail/Microsoft 行 | 不触发授权、创建或外部跳转 |
| MQ05 | REQ | 在上下文提交前关闭邮箱弹窗或取消新建 | 不保存 mailbox，不生成草稿或发送邮件；已进入编辑器的草稿不能据此断言不存在 |
| MQ06 | REQ | 从两个 New sequence 入口进入 | 使用同一前置逻辑 |
| MQ07 | LIVE | 已填写上下文后Continue to emails | 创建服务器草稿并显示三封邮件编辑器；Recipients 0，未Publish或发送 |
| MQ08 | LIVE | 查看Tailor your sequence桌面及手机 | Sender email、Role、Company纵向结构、Cancel/Continue底栏存在 |
| MQ09 | LIVE | 展开Sender email菜单 | Mira’s mailbox选中且标Assigned to your AI Agent；No mailbox connected；Connect a mailbox入口 |
| MQ10 | LIVE | 展开公司说明 | Show变Hide company description并出现Company description；未修改文本 |
| MQ11 | REQ | 提交必填为空/URL无效/公司预填 | 必填星号和校验一致，URL可选；预填属于当前账号；不在前端硬编码公司 |
| MQ12 | REQ | Cancel退出或切换侧栏/视口 | 取消不开始外联；布局重排不替换字段值或发送人 |
| MQ13 | LIVE | 查看生成邮件步骤 | Introduction email、Follow-up 1、Follow-up 2；各含发送人、主题、富文本正文；两段Wait2days |
| MQ14 | LIVE | 打开Subject的Insert variable | 按实测八项呈现变量；不将菜单打开当成已插入 |
| MQ15 | LIVE | 查看设置 | Favorite、必填Name、Description、Sending window09–21、Timezone、Business days only关闭、Reply received |
| MQ16 | LIVE | 查看名称计数 | 本次54/50如实展示；超限发布校验未测试 |
| MQ17 | LIVE | 打开Timezone | 可搜索城市列表；列表本身滚动，与页面滚动区分 |
| MQ18 | LIVE | 点击Recipients 0 | Search、All/Active0/Paused0/Exited0，Active选中；列表和详情两种空态 |
| MQ19 | LIVE | 390手机编辑器滚动第一封正文 | 正文320高、scrollTop216；主页面scrollTop0；不声称已到设置区 |
| MQ20 | REQ | 修改正文/变量/延迟/交付设置后Publish | 数据与实际计划一致、校验和提交状态真实、防重复发布；该路径尚未实测 |
| MQ21 | UNKNOWN | 发布、启停、入序列、非空Recipients、真实发送及自动保存时机 | 没有此次提交与执行结果，不能宣称端到端发送验收完成 |

证据：[列表（原始证据未公开）](PRIVATE-EVIDENCE.md)、[弹窗（原始证据未公开）](PRIVATE-EVIDENCE.md)、[稳定新建上下文](design-details/states/metix-sequence-context-1440.txt)、[发送人菜单](design-details/states/metix-sequence-sender-menu-1440.txt)、[手机上下文](design-details/states/metix-sequence-context-390.txt)。早期取消后快照是即时状态，不代替稳定页面。新增[编辑器](design-details/states/metix-sequence-editor-1440.txt)、[变量](design-details/states/metix-sequence-variables-1440.txt)、[时区](design-details/states/metix-sequence-timezone-1440.txt)、[零Recipients](design-details/states/metix-sequence-recipients-1440.txt)、[手机编辑器](design-details/states/metix-sequence-editor-390.txt)。

### 6.1 角色 Outreach 工作区

| 编号 | 依据 | 前置与操作 | 预期 |
| --- | --- | --- | --- |
| MO01 | LIVE | 打开已采集角色 Outreach | Outreach complete/Completed、自动外联已结束且晚回复仍到 Inbox 的文案 |
| MO02 | LIVE | 查看顶部统计 | 样例261 Contacted、19 Replies、6 Interested、17 Failed；Review 6 interested |
| MO03 | REQ | 与 Candidate List Contact303 对照 | 允许不同事实口径并列，不能用臆造公式凑成相同数字 |
| MO04 | LIVE | 查看 Email 流程 | Introduction、Wait2days、Followup1、Wait2days、Followup2；右侧 Waiting for reply、If interested、Send job posting and collect details |
| MO05 | LIVE | 查看分支文案 | Any reply stops their remaining follow-ups；Interested分支6sent；Sent after each interested reply |
| MO06 | REQ | 收到任意候选人回复 | 只停止该人的剩余自动跟进；回复不自动等于Interested |
| MO07 | REQ | Outreach已Completed后有晚回复 | Inbox仍能呈现回复，不因工作流结束丢消息 |
| MO08 | LIVE | 切换Job Posting | 显示Role Info、公司/职位/地点/薪酬/工作模式、招聘人员、About the Role、Required、About the Company |
| MO09 | REQ | 评价条件与发布JD有版本差异 | 保留来源，不在UI层把旧JD自动改写成当前评估条件 |
| MO10 | UNKNOWN | 点击统计详情、修改邮件、启动或重试失败 | 未验证行为不标成通过 |

证据：[Outreach（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Job Posting（原始证据未公开）](PRIVATE-EVIDENCE.md)。

## 7 交付检查

| 编号 | 检查 | 完成条件 |
| --- | --- | --- |
| MD01 | 所有页面规格区分 LIVE/REQ/UNKNOWN | 未执行发信、排期、保存或私有算法不标成 LIVE 成功 |
| MD02 | 状态维度独立 | 评级、阶段、已读、材料和面试邀请状态不互相推导 |
| MD03 | 图文一致 | 关键截图与对应文案、布局及当前状态一致 |
| MD04 | 隐私与示例 | UI 不硬编码真实邮箱、邮件正文或候选人数 |
| MD05 | 页面范围 | 不发明 Metix Contacts/Analytics 页面；引用 Juicebox 规格时注明来源 |
| MD06 | 完成声明 | 非空 Shortlist、Sequence发布/enrollment结果和非空面试仍缺证据时，不宣告原站全部功能逆向完成 |
