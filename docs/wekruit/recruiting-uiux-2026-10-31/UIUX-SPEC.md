> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

> **组件级设计增补（本轮实测）**：尺寸、页面高度、响应式、组件状态与互动以 [设计交付入口](design-details/README.md)、[逐页标注](design-details/inspector.html) 为准。新增 99 个配对截图/DOM 状态。Metix Maybe later 可进入 Tailor 表单，Continue to emails 可进入三步邮件编辑器；旧记录中的“未进入编辑器/手机未测”仅表示当时的覆盖范围。本轮已创建一个 UI inspection 未发布草稿，0收件人，未发送。

# 招聘工作区 UIUX 复刻规格

本规格覆盖 Juicebox 的 Sequence、Contacts、Shortlist、Outreach Analytics，以及 Metix 的候选人评级、Inbox、资料抽屉、外联流程和 Interview。它与 [Juicebox PRD](JUICEBOX-PRD.md)、[Metix PRD](METIX-PRD.md) 配套，重点规定信息层级、视觉几何、组件、滚动、弹层和跨页连续性。Headhunter 自身左栏调整以 [精简导航规格](NAVIGATION-SPEC.md) 为准。

## 1. 证据与使用边界

- **LIVE CSS** 是从实际渲染 DOM 读取的 computed style / rect，原始记录为 [Juicebox measurements（原始证据未公开）](PRIVATE-EVIDENCE.md) 与 [Metix measurements（原始证据未公开）](PRIVATE-EVIDENCE.md)。数值只对应记录中的元素和采集视口，不是整站设计 token 清单。
- **LIVE 图像** 是本次登录态截图。下文注明“图像估计”的数值是按图观察的近似几何，不冒称 CSS 原值。
- **REQ** 是复刻产品实现约束。它使页面可操作、数据范围明确，并补齐键盘和窄屏等必需场景；不是竞品内部实现证明。
- 未点击的提交、未加载出的受限页、未观察的移动版/深色版/hover动画是 **UNKNOWN**。不凭 AX 中的隐藏副本、预渲染节点或字面字段推断它已在屏幕上显示。

现场截图宽 1806px。Juicebox 采集视口为 1806×1067、DPR 1；Metix 为 1806×1011、DPR 1。两者对同一组业务采用不同视觉体系，不能把某站任意尺寸写成另一站的真实 CSS。最终实现可沿用现有产品品牌，只要保留以下结构和功能语义；不能把“复刻”变成一组同名空卡片。

## 2. 两个参考的视觉骨架

| 维度 | Juicebox 实际参考 | Metix 实际参考 |
|---|---|---|
| 页面组织 | 紧凑表格、指标和筛选工具条，适合操作大量记录 | 卡片候选人摘要、邮件线程、流程与日历，适合沟通决策 |
| 侧栏 | 图像约240px；主功能加 Current project | CSS 243px；五个功能及 New Role 加 All Roles |
| 选中表达 | 浅紫底、紫色图标/文字 | 主导航浅灰底、深色文字；候选人卡黑色边框 |
| 主色使用 | 新建主动作紫色，图表可用青色，负增幅红色 | 主要提交黑色，紫色强调评级/新消息/时间段，Worth Talking绿框 |
| 字体 | 采到 Geist 为主，部分区域带系统字体 fallback | 侧栏采到 Inter；Inbox 内容标题/按钮采到系统 sans-serif |
| 空间 | 列表页内容接近满宽；总览图表内容居中并留大边距 | Inbox 三列；Interview 在浅灰背景上放白色日历和活动栏 |

**REQ**：内部同一个产品使用一套稳定的导航和基础控件；保留候选人评级、外联状态、回复状态、材料状态的独立视觉位置。不要为了“统一”而把全部状态染成同一紫色，也不要让相同颜色承担互斥语义。

## 3. 实测字体和控件样本

### 3.1 Juicebox CSS 样本

[来源（原始证据未公开）](PRIVATE-EVIDENCE.md) 取自 Talent Insights 页面。

| 元素 | 实测值 |
|---|---|
| Searches 行 | 223×28px；14px / 20px；weight400；圆角8px |
| Create intake 行 | 223×28px；14px / 20px；左右 padding12/8px；gap8px；圆角8px |
| 折叠侧栏按钮 | 32×32px；x199,y16；圆角6px |
| 项目切换按钮 | 24×24px；x203,y316；圆角4px |
| Export Insights | 高32px；14px / 20px；weight500；padding0 10px；圆角8px；1px浅灰边框 |
| Copy takeaways | 32×32px；14px / 20px；圆角8px |
| Talent Insights 标题 | 16px / 18.672px；weight500；不是整个产品所有H1的统一大小 |
| 解释图标的紫色 | `rgb(118,0,188)`；仅该被采样元素已确认 |
| 普通正文深色样本 | `rgb(23,23,23)` 或 `lab(2.75381 0 0)`，按具体元素来源保留 |

原始采样包含 Cookie 工具的 `Manage Preferences` / `Close this consent banner`，其 Helvetica 及灰色按钮不属于招聘业务组件，不能混进复刻 token。

### 3.2 Metix CSS 样本

[来源（原始证据未公开）](PRIVATE-EVIDENCE.md) 取自 Inbox 未选择候选人状态。

| 元素 | 实测值 |
|---|---|
| Sidebar | 宽243px，白底；Inter / system；基础文字`rgb(16,13,53)` |
| 主功能行 | x8、宽227、高34px；相邻行起点间隔38px；圆角8px |
| 普通主导航文字 | 14px / 20px；weight500；`rgb(98,98,98)` |
| 选中 Inbox 文字 | 14px / 20px；weight600；`rgb(34,34,34)` |
| 岗位行 | 宽227、高36px；14px / 20px；weight400 |
| 底部账户按钮 | x8,y947；227×56px；圆角8px |
| Inbox H1 | x264,y19.5；24px / 24px；weight600；`rgb(17,17,17)` |
| All Roles 筛选 | x264,y76；459×44px；13.5px / 20.25px；weight500；圆角10px；1px`rgb(220,221,225)`边框 |
| All / Unread 筛选 pill | 高32px；13px /19.5px；weight500；左右padding16px；胶囊圆角 |
| 选中 All pill | 黑底、白字、1px黑边 |
| 未选中 Unread pill | 白底、深灰字、1px`rgb(229,229,229)`边 |
| Select a candidate 空态标题 | 19px /27.55px；weight550；`rgb(52,59,70)` |

**REQ**：字号和行高按 rem 实现以支持文字放大；不要把 viewport 坐标硬编码成所有屏幕尺寸。相同按钮使用同一套现有组件，不引入新 UI 依赖来重做这些基础样式。

## 4. Juicebox Sequence 总览

参考：[截图（原始证据未公开）](PRIVATE-EVIDENCE.md)、[AX（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 4.1 画面层级

```text
[侧栏240] | 48px左右顶部 breadcrumb
          | Overview [Last30days]       [View analytics] [New sequence]
          | [Contacted][Active][Opened][Clicked][Replied][Interested]
          | Schedule [period]                      sent / scheduled
          | 时间图，Today虚线
          |
          | [Search sequence] [Owner] [Contact filter]   Show archived
          | name | privacy | total | active | opened ... | created | …
```

图像估计：正文总览从x326开始到x1718结束，宽约1392px；顶部标题起点y82；六指标卡y132–225，高约93px，卡间距约10px，圆角约14px。Schedule卡y249–554，宽约1393px。列表卡y606开始。白背景搭配很浅的灰卡面与细边框，标题与数字清楚，图表不依赖大面积品牌色。

### 4.2 组件规范

- KPI 卡文字标题在左上，数值在左下，相对变化在右上。完整数值和比较区间的解释在可访问文本中保留。
- Schedule 左上标题和周期在同一行；右上sent/scheduled使用两个可分辨的点加文字。横轴过去/未来，Today单独虚线。空数据仍保留轴线与图例，不能画假波形填空。
- 序列名称两行：首行加粗名称可省略；次行头像、owner和步骤数。数值列右/中对齐，数值与百分比上下两行，创建日期次级灰。
- 表头排序图标尺寸小于正文，只有实际可排序列可聚焦；名称列的 resize 分隔器与排序按钮是两个操作，不抢同一点击区。
- `New sequence` 是该页唯一品牌色主按钮；View analytics和筛选为描边次按钮。行三点属于低频动作。
- 新建选择弹层有项目生成、Build from scratch、Clone existing sequence三个入口，不能在点开入口时直接生成并发送。

## 5. Juicebox 单序列与编辑器

参考：[运行列表（原始证据未公开）](PRIVATE-EVIDENCE.md)、[编辑器（原始证据未公开）](PRIVATE-EVIDENCE.md)、[步骤时间（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 5.1 运行列表

保留总览的标题—指标—Schedule—表格结构。七项统计为可点击按钮。每条 run 把 Full name、Step、Status、Response、Engagement、Added by、Actions 明确分列。`Finished No reply` 不使用与 `Replied` 同样的成功色；`Response` 是意向下拉，不能当作run状态。Engagement档位及打开/点击数是信息，不当作录用建议。

### 5.2 编辑器

- 图中左侧 Composer 独立面板，中间有 resize splitter；不是把聊天组件放在每封邮件下重复出现。
- 右侧编辑区顶端保留序列名、创建者、共享状态、最后保存状态、Done。
- 步骤导航概括Email、发件人、执行时间；正文按步骤卡展示，可以折叠/聚焦，不同邮件不是拼成一个长文本框。
- 每步From、Subject（首封）或Reply to Step1（后续）、变量按钮行、富文本正文、签名、Snippet、附件、unsubscribe按固定顺序。
- 两步之间的延迟条概括`Wait 2 business days / Send at 9:00AM PDT`，展开后显露Delay、单位、时刻、Timezone。
- 插入变量使用可识别token，不把未渲染的`{{First Name}}`与普通文案混成相同编辑状态；Preview与真实发送分开。
- 保存状态在页头有唯一位置。现场点击Done出现Sequence saved；没有修改字段也可能触发保存提示。复刻不能把点击Done当作开始发送。

### 5.3 加入序列对话框

参考：[加入序列（原始证据未公开）](PRIVATE-EVIDENCE.md)、[邮箱偏好（原始证据未公开）](PRIVATE-EVIDENCE.md)、[更多说明（原始证据未公开）](PRIVATE-EVIDENCE.md)。

顺序必须为“加入人数和项目影响 → sequence选择 → 邮箱偏好 → 开始时间 → credits说明 → Cancel/Preview Steps”。邮箱偏好的四选项逐字参照PRD。`More Details`为就地展开，不跳走丢掉选择。费用说明与会同时加入当前项目Shortlist的影响靠近动作，在点击最终提交之前可见。最终实际预览及发信结果未提交验证，不得在视觉稿里把成功toast作为已实测事实。

## 6. Juicebox Contacts 与 Shortlist

参考：[Contacts（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Shortlist（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Board（原始证据未公开）](PRIVATE-EVIDENCE.md)、[选中工具栏（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 6.1 Contacts

Contacts是填满可用宽度的密集表格，面包屑`All Contacts (999)`并带刷新图标；其下左侧搜索、Filter，右侧Actions。图像估计：工具条起点y60，表头y104，数据行高约44–45px。头几列依次checkbox、Full Name、Profiles、Projects、Tags、Current Role、Organization、Education、Location，其余历史时间列通过横向滚动访问。

- 不把每人一行改为多层大卡片；高频扫读需要名字、职业、公司、项目在同一水平视线内。
- Profiles用LinkedIn/Email/GitHub等小图标，未知或不存在的渠道不占空按钮。
- 单元格的“Add Tags”和已有tag可区分；项目标签与来源标签不能都无标签地呈现为同一种chip。
- 选择框列稳定；全选、部分选中、未选中视觉和语义齐备。Actions在未选择时只激活适用动作；不靠点了以后报错来告诉用户必须先选人。

### 6.2 Shortlist Table

图像估计：breadcrumb高约48px；搜索/排序/Filter在左，View insights/Request review/More在右；表头y103–142；行高约38px；底部分页条高约52px，显示1–40of99和页码。

- Full Name格内保留来源/最近联系图标和favorite动作；文字省略但完整名称可获得。
- Status使用小圆点和文字；Sequence用短结果chip，例如米黄色No Reply和浅绿色Replied。两列不合并。
- Owner、Date、Current Role、Organization并列；选择Display columns时只改变显示列。
- 列表滚动区域独立；工具条、表头和底部分页避免一起消失。横向滚动必须看得见，不把超出列静默裁掉。
- 选择后出现批量工具栏：人数、Add to Sequence、Request Review、Find similar、Export selected、More actions、Clear selection。主工具条和选中工具条的两个More必须有不同上下文语义和焦点顺序。

### 6.3 Board

九个阶段横向排列：Not Contacted、Pending、Contacted、InMail Sent、Interested、Interviewing、Hired、Rejected、Not Interested。各列标题加计数及settings，下面候选人卡。现场满态Contacted92、Interested5、Not Interested2，其他0。初次转换的全0是加载中快照，不能当最终空池。

**REQ**：Table和Board是同一Shortlist的两种视图；切换保留范围与筛选，不能复制数据生成另一个集合。是否支持拖动及拖动后保存未实测，不能因采用Board就自动新增拖拽改状态业务。

### 6.4 候选人资料扩展面板

参考：[候选人资料（原始证据未公开）](PRIVATE-EVIDENCE.md)、[序列历史（原始证据未公开）](PRIVATE-EVIDENCE.md)。

- 保留上一个/下一个、当前集合说明、展开/收起和关闭；翻人只改变当前记录，不能重置列表。
- 专业资料区有Overview / Experience / Education / Skills导航；业务历史区有Notes / Sequences / Activity / Projects / Tasks。
- 两套标签有不同作用域，不应排成一行让用户以为Experience与Tasks是同类数据。
- Notes有输入和附件入口，以及Add note禁用态和已有作者/时间/内容；不写内容时不可生成空注释。
- Sequences显示序列名、Finished(NoReply)、发件人、加入时间/加入者、Mark as Replied、Reply入口及邮件历史；真实发送、手动改状态不在调研中执行。
- Activity显示行为流。打开详情可能自动留下Viewed记录，复刻规格不可宣称查看绝对无服务端影响。

## 7. Juicebox Outreach Analytics 与 Talent Insights

参考：[外联统计（原始证据未公开）](PRIVATE-EVIDENCE.md)、[人才画像（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 7.1 Outreach Analytics

布局顺序为：面包屑/标题 → 全局筛选 → 六KPI → 两张并排趋势图 → 汇总表。筛选含Sequence、Project、Started by、Inboxes，右侧Date和Grouped by。图像估计标题x326,y76；筛选y112；KPIy172–298；并排图y322–733；汇总表y758起。

- KPI包括Profiles Contacted、Open Rate、Click rate、Reply Rate、Interest Rate、Bounce Rate。比例显示大数、百分号、比较变化、小字分子/分母，不只渲染一个百分比。
- 图表白灰底，细水平参考线，清楚坐标轴；按user颜色区分，图例支持状态表达。下载按钮位于图表右上。
- 表格工具支持Search、Metric、Group by、Breakdown和独立下载；Total行与普通行不同底色/字重。行与总计共享当前筛选口径。
- Usage / Projects / Agents本次账户显示Business升级墙；不能拿Outreach画面当作这三页内容，也不需为了本产品复刻自行增加同款付费墙。

### 7.2 Talent Insights

这是Shortlist样本画像，顶部Back/人数/Export；正文呈Top Locations与地图、Key Takeaways、经验和任期分位数、分布、技能、公司/学校/专业/语言等模块。它与Outreach的发送/打开/回复统计不同。每张图标明样本范围与分母；AI takeaways不改变候选人事实或评分。加载中不能把99写成0后展示空态。

## 8. Metix Inbox 与候选人摘要

参考：[Inbox（原始证据未公开）](PRIVATE-EVIDENCE.md)、[简历与时间（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Reply（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 8.1 三列骨架

图像估计：侧栏x0–243；候选人列表x243–744，宽约501；邮件内容从x744延伸到右边。列表工具区与邮件顶部对象栏各自水平对齐，约64px高。列表和邮件线程可独立纵向滚动，选择候选人不把整页滚回顶部。

候选人列表顶部为Inbox标题、All Roles选择、All/Unread。其下每人是一张摘要卡：头像/姓名/评级、岗位、地点、两段最近工作+日期、教育、底部消息与材料状态条。列表与邮件线程是同一选中对象，不能先显示新人名字却短暂留下旧人正文。

### 8.2 摘要卡

图像估计：卡片x264起，宽约448；卡间距约10px，圆角约15–16px。选中卡约2px深色外框，普通卡细浅灰边。头像约40px；未读在头像附近紫点和底部New reply中重复表达；姓名约16px加粗，岗位/地点/履历正文约13–14px。

状态应占据固定语义位置：

| 位置 | 语义 | 参考视觉 |
|---|---|---|
| 姓名旁 | 评价档位 | Strong Match紫框小星；Worth Talking绿框小星 |
| 角色/工作摘要 | 专业事实 | 深灰文字、公司logo、浅灰日期 |
| 底部左 | 回复新鲜度 | New reply紫色；Replied灰色；相对时间 |
| 底部右/后续chips | 已取得材料 | Resume provided、Availability provided灰底短标签 |

评级不是兴趣、未读或招聘阶段。Worth Talking不能解释为“候选人已经愿意聊”；Interest也不能替代模型评价。评级生成阈值未知，不在复刻稿里发明评分公式。

### 8.3 邮件线程

- 顶部固定头像/姓名/邮箱、岗位与地点，右侧Profile、Reply，适用时Schedule。
- 单封消息卡包括头像、发件人、NEW、时间、主题、正文、引用折叠、Reply。
- 多封自动外联压缩为灰底折叠条，例如“3 candidate outreach emails were sent”；展开后仍保持真实顺序，不把自动汇总文案当原始邮件正文。
- No more messages为历史终点，不作为“无数据”的标题。
- Reply在当前线程中展开富文本区：引介提示、发信身份、格式工具、0/10000、Cancel、Send introduction & reply及快捷键。发信操作固定与当前收件人绑定，按钮禁用态可读。

## 9. Metix Profile 与评级说明

参考：[Profile（原始证据未公开）](PRIVATE-EVIDENCE.md)、[示例候选人完整评价（原始证据未公开）](PRIVATE-EVIDENCE.md)。

图像估计：右侧抽屉从x1086到1806，宽720px；顶部Profile标题和关闭，高约63px；底层Inbox变暗且仍可辨认。内容左右padding约24px，正文独立滚动。

- 抽屉先显示候选人姓名、职位、地点、外部专业链接、Download/Resume和适用的Schedule。
- Mira’s Recommendation用紫色小标题；默认三条criterion，每条有结果图标、条件名、解释。Show all N criteria就地展开剩余条件；Preferred标识是条件类型，不能只用轻颜色隐藏其性质。
- Contact details为浅灰可折叠区域；Email查找态、Phone的Show phone与已知值区分。未查询不渲染假邮箱。
- Experience/Education/Skills/Projects/Courses等按该人实际材料呈现，不补空tab。履历是公司logo+职位+公司+日期/任期+描述；长文本支持展开。
- 关闭返回原线程；焦点回到Profile按钮。页面内不能有两个同时可交互的相同人资料副本。

## 10. Metix 外联流程

参考：[Outreach（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Job Posting（原始证据未公开）](PRIVATE-EVIDENCE.md)。

角色顶部进度区把Describe role、Find Candidates、Outreach、Interview串起来；Outreach工作区包含Back、状态横幅、Contacted/Replies/Interested/Failed四项、Email/Job Posting标签。Email以纵向流程展示Introduction email、等待、Follow-up 1、等待、Follow-up 2、Waiting for reply、If interested、Send job posting and collect details。步骤需要清楚区分“已完成”“条件节点”和“发送内容”，不能画成相同样式的待办列表。

- 完成态横幅清楚说自动外联已结束，晚到回复仍进Inbox；不是成功绿勾后把其余流程全部隐藏。
- 首封/跟进正文以真实内容预览；每步发信人、主题、时间、完成状态可读。
- 等待/条件节点使用较轻视觉；“Any reply stops remaining follow-ups”紧邻Waiting for reply。
- Job Posting为职位预览，展示地点、薪资、level、全职/onsite、职责、Required与公司；它不是额外的新营销页需求。

## 11. Metix Interview 与安排面试

参考：[Interview（原始证据未公开）](PRIVATE-EVIDENCE.md)、[选时（原始证据未公开）](PRIVATE-EVIDENCE.md)、[定制邀请（原始证据未公开）](PRIVATE-EVIDENCE.md)、[高级（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 11.1 日历页面

图像估计：主背景浅灰；日历白卡x364–1369宽约1005；右侧AllActivity白卡x1385–1685宽约300；间距约16px。两卡顶部y72、底部接近991。页头Interview在x364,y31，右上All Roles和AllStatus。Calendar工具栏含Today、前后箭头、五天日期段、Timezone；下方五列日期和纵向小时格。今天文字和当前时间线用紫色。

空态在日历中间浮出小白卡，图标、No interviews this week、Try another week；AllActivity有独立No activity yet。不能把没有本周事件解释为全站从未有面试。

### 11.2 安排抽屉

图像估计：整个安排层占右侧约1150px；左侧日历约709px，右侧表单约441px。底层Inbox暗化。表单区域浅灰底、白输入控件；底部操作固定，主要提交黑底白字。日历可单独滚动，表单不可被日历长时间轴一起带走。

Step1：Scheduling mode两张大选项卡，Single time 与 Multiple options，右侧radio。选中后Times区域出现Start/End日期和时间、候选人时区换算、Remove、Add time range。默认单slot约30分钟是现场观察，不得据此发明所有meeting的固定时长。

Multiple options额外显示Duration、slot数量、Preview、Advanced。Advanced展开Minimum Notice、单位、Avoid conflicts和Connect Calendar说明。最低slot数量及Next启用条件以PRD已观察为界，不将单次disabled推断成完整验证规则。

Step2：Guests chips（Candidate和You）/附加邀请邮箱；Online/InPerson分段选项；地点或meetinglink输入；可选Notes、上限1000、计数；Back和Send invitation。选中时段继续显示在日历，防止第二步失去上下文。

### 11.3 时间语义和退出

选中块紫边/浅紫底；候选人preferred窗口浅紫大区域，二者用图例和边界区分。界面出现Chicago与candidateGMT-7换算，但现场菜单offset存在疑点，截图只是显示事实。**REQ**：按IANA时区与事件发生日期计算DST，保存唯一UTC时刻和必要timezone，不能硬编码截图offset。

有未保存编辑时关闭显示Exit editing this event?，说明changeswillnotbesaved，Back to Edit / Exit。整个弹层可关闭且恢复焦点；不发邀请的操作不改变Interview计数。

## 12. 复刻产品共用交互约束

以下均为 **REQ**。

1. **对象连续性**：范围、标签、选中人、详情、邮件、邀请始终属于同一个上下文。切换A→B时迟到A请求不能覆盖B。
2. **状态连续性**：筛选、排序、分页、列设置、滚动、面板宽度在从详情返回时恢复。直接链接的显式状态优先于上次浏览记忆。
3. **错误与空态**：loading、空集合、筛选无结果、权限不足、请求失败分开。失败不能显示0；空态有准确下一步，不能在未授权时自动新建/发信填充。
4. **保存与发送**：编辑保存和真正发送是不同动作，标题、按钮、toast分开。发送前明示当前人、范围、发件身份、时间和内容。
5. **层级**：页面、详情抽屉、业务表单、确认对话框层级清楚；最上层捕获焦点，Escape与关闭遵循未保存保护。
6. **键盘**：排序/筛选/checkbox/菜单/tab/日历控件可聚焦，焦点可见；打开面板后焦点进入，关闭回到触发源。resize不能只支持鼠标。
7. **可访问文本**：图标要有名称；状态不仅靠颜色；省略文本的完整内容可获得；错误靠近字段并能被辅助技术关联。
8. **长内容**：长姓名、公司名、序列名不撑破布局；完整邮件正文和原始材料不因摘要而丢失；不把服务端分页误当列表末端。
9. **统计口径**：图表和表格范围相同，人数与run数分开；聚合比例用分子总和/分母总和，不能平均百分比。
10. **已有组件**：沿用仓库已有drawer/dialog/table/editor/date组件和数据模型。此文不是新依赖、新任务引擎或新CRM的需求。

## 13. 窄屏与文字放大

原站响应式断点、手机布局、深色模式未观察，不能声称已完整复刻。为使本产品同一业务可用，规定以下必要行为：

- 左栏隐藏为抽屉，页面标题和当前岗位范围常驻可见，一级五项顺序保持一致。
- Contacts / Shortlist 保留关键姓名和状态，其他列可以横滚；不可把隐去字段变成永久删除数据。
- Inbox 先列表后线程，打开线程有明确Back到列表；Profile再叠一层时关闭回到线程。
- 安排面试的日历和表单按步骤串行显示，仍保留选中时间和时区摘要，底部Next/Back/Send不遮住最后字段。
- 200%文字放大时控件标签不截断，按钮允许增高；日历横向空间不足时可滚动，不把日期列缩成不可点的窄缝。
- 不在未知断点上扩展新的移动产品流程；实现用现有响应式约束，补做上述业务可用性验收。

## 14. UIUX 验收矩阵

| ID | 场景 | 验收 |
|---|---|---|
| UX01 | 同一视口对照截图 | 页面骨架、模块顺序、主要留白和列关系一致；不只比较颜色 |
| UX02 | Sequence总览 | 六KPI、Schedule、过滤、历史累计表完整，近30天0不覆盖累计数 |
| UX03 | Sequence编辑 | Composer与steps层级明确；文案变量、延迟时区、保存状态有独立位置 |
| UX04 | Add to Sequence | 人数/项目影响/邮箱偏好/开始时间/credits在最终动作前可读 |
| UX05 | Contacts | 数据表横滚、选择/部分选择、可用动作、长文本都正确 |
| UX06 | Shortlist | Table与Board同一集合，计数不因加载先置0形成假空态 |
| UX07 | Contact详情 | 专业资料与业务历史两组tab区分，返回列表位置保留 |
| UX08 | Analytics | 筛选范围、图例、数字与分母、Total、下载入口完整 |
| UX09 | Inbox卡片 | 评级/回复/未读/简历/availability各自可读，不混成单status |
| UX10 | 线程切换 | 邮件正文和头部绑定正确的人，异步竞态不串人 |
| UX11 | Profile | 默认三criteria/Show all、Contact details、资料导航和close工作 |
| UX12 | Reply | recipient/引介说明/字数/disabled/send身份清楚，未保存保护有效 |
| UX13 | Interview空态 | 本周无事件和全局无activity分开，切日期不改为全站空态 |
| UX14 | 单时间安排 | 选中块、Start/End、candidate时区、Next→Guests/Location/Notes完整 |
| UX15 | 多时段安排 | Duration/slots/Advanced可读，规则校验不只禁用而无解释 |
| UX16 | DST边界 | 使用事件日期验证时区，不能以截图示例offset为oracle |
| UX17 | 弹层与键盘 | 顶层焦点/背景不可误点/关闭恢复焦点；未保存确认可取消 |
| UX18 | 网络失败 | 明确错误与retry，保留用户输入，不将未知计数显示0 |
| UX19 | 窄屏与200%文字 | 所有核心业务可完成，控件不被遮挡、滚动可理解 |
| UX20 | 新侧栏 | 按NAVIGATION-SPEC五项一级与完整入口映射验收 |

## 15. 仍属未知的视觉范围

本次未取得Business受限三页、Metix非空Shortlist/通用Sequence编辑器、实际邀请成功后的event详情与候选人选择时段页面、竞品手机/深色版以及所有hover/动画时长。相关页面不能在设计评审中标记“已逐像素核对”；受限部分的精确复刻需要对应可访问页面或后续样例。已有截图、AX、CSS样本足以核对本文已列的页面与交互层级，完整覆盖范围见主索引。
