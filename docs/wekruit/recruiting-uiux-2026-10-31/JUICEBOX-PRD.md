> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# Juicebox：Sequence、Contacts、Shortlist、Analytics 复刻 PRD / UIUX

调研日期：2026-10-31（America/Chicago）。本文定义用户指定功能的页面、字段、交互和验收，不修改产品实现。竞品是已登录 `app.juicebox.ai`，当前项目为 `示例对象17`。图中人名、邮件和数量是现场示例，不是复刻产品必须内置的内容。

## 1. 证据使用规则

本文所有描述分四类：

- **LIVE**：本次浏览器现场实际显示/实际展开的界面，证据为同目录 `juicebox-*.txt` 和对应 `screenshots/*.jpg`。能证明显示和已操作的导航，不能证明没有提交过的服务端动作。
- **STATIC**：REA 6.8.0 分析 2026-10-14 保存 JavaScript 的补充事实，见 [rea/REPORT.md](rea/REPORT.md)。其字段、文案、条件语法不自动等同当前在线行为。
- **REQ**：为忠实实现上述界面并保持完整业务逻辑必须满足的约束。此类内容是复刻验收要求，不冒称已验证竞品内部实现。
- **UNKNOWN**：当前权限或样本未提供、没有执行到的行为。禁止直接填写虚构算法、响应、时限或成功状态。

以下每节以证据开头；节内同类事实继承该节标签。完整 UI 文件按 `manifest.json` 索引定位。评审、导出、发信、启动 enrollment、付费查询未提交，因此相应最终持久化与真实发信不属于本次已验证事实。打开profile时站点自动记录Viewed activity，详见8.7；不能因此说绝对零网站写入。

## 2. 用户目标与对象边界

**LIVE**：Juicebox 将全局 Contacts、Sequences、Analytics 放在主导航，将 Shortlist 放在 Current project 下。Contacts 页显示 `All Contacts (999)`，当前项目 Shortlist 显示 99；两者明确不是同一个候选人集合。[证据：juicebox-contacts.txt、juicebox-shortlist.txt]

**REQ**：

| 对象 | 用户需要回答的问题 | 不能混淆的对象 |
|---|---|---|
| Contact | 这是谁，联系方式与专业资料是什么，在哪些项目中，何时接触/回复？ | 同一人的某个项目入选状态 |
| Project Shortlist entry | 这个项目要跟进谁，当前阶段、归属、评审、序列结果是什么？ | 全局联系人、全局模型匹配档位 |
| Sequence | 按什么步骤、文案、发送账号和时间联系一组人？ | 某个联系人的具体执行进度 |
| Sequence run / enrollment | 某个人被加入哪个 sequence，执行到第几步，回复/打开/点击情况如何？ | 模板编辑器中的步骤 |
| Analytics | 在指定时间及筛选范围内，发生了多少联系、打开、回复和兴趣？ | 当前项目全量库存数 |

复刻页面不能通过“已联系”一个枚举代替 `pipeline stage`、`sequence run state`、`response interest`、`engagement`。例如同一个人可以处于 Shortlist 的 `Not Interested` 阶段、其 sequence run 为 `Replied`、回复意向为 `Not interested`，三个字段分别服务不同视图。

## 3. 共用 UI 外壳

**LIVE**：截图参考 [Contacts（原始证据未公开）](PRIVATE-EVIDENCE.md)、[Shortlist（原始证据未公开）](PRIVATE-EVIDENCE.md)。

- 固定左侧浅灰导航，桌面截图中约 240px 宽；顶部品牌图标、折叠按钮、Quick find `⌘K`、通知铃铛和未读角标。
- 一级导航顺序：Home、Projects、Sequences、Contacts、Analytics。Analytics 可展开 Usage、Projects、Outreach、Agents。
- 下方 `Current project` 标题、当前项目名与切换菜单，再是 Agent、Searches、Create intake、Shortlist（计数）。
- Network、Integrations、Support、用户和 workspace 固定在侧栏底部。
- 当前导航项用浅紫底和紫色图标/文本表示；普通项黑灰文本。主内容为白色，细浅灰边界、紧凑圆角按钮。
- Contacts/Shortlist 使用完整宽度的业务表格；表格多列保留横向滚动。页面工具条位于内容顶部；Shortlist 底部有固定分页条。

**REQ**：这里只把所列功能的外壳当作布局参照；Home、Agent、Network、Integrations 本身不因在侧栏存在就扩展为本次新增功能。复刻可以套用现有产品导航，但这几个模块必须共享明确的全局/项目作用域及当前选中态。图标按钮要有可访问名称，checkbox 要表达全选/部分选中/未选中，搜索框必须有标签或 placeholder。

尺寸从截图估计，非通过 CSS 提取的 token：正文约 13–14px、表头约 12–13px、工具按钮高约 32–36px、表格行高约 38–46px；文本过长单行省略，保留可访问全名。颜色/字体精确值、移动端断点、深色主题 **UNKNOWN**，不得声称已 pixel-perfect 验证。

## 4. Sequences 总览

**LIVE**：[juicebox-sequence-overview.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[screenshots/juicebox-sequence-overview.jpg（原始证据未公开）](PRIVATE-EVIDENCE.md)，与用户提供的第三张截图一致。单序列详情和编辑器另见后续证据。入口 `/project/{currentProject}/sequences`；路径包含 currentProject，页面中的序列跨当前项目样本出现两个不同职位，不能凭路径认定列表只属于当前项目。

### 4.1 页面布局

1. 顶部 `Overview` 标题，旁边日期范围（现场 `Last 30 days`）；右侧 `View analytics`、紫色 `New sequence`。
2. 六个横向 KPI：Contacted、Active、Opened、Clicked、Replied、Interested。每卡展示标题、主数值、相对变化百分比；负向变化为红色向下指示。现场近 30 天数值均为 0。
3. `Schedule` 卡：左上周期（`7 day period`）、右上 sent/scheduled 图例；横轴从过去一周延伸到未来一周，Today 有垂直虚线，纵轴显示数量。
4. 下方序列表格：搜索、All Owners、Filter by contact、Show archived；表格可按名称、数量、日期等字段排序。

### 4.2 字段与行

| 列 | 内容 |
|---|---|
| Sequence name | 状态小圆点、序列名；次行创建者头像/姓名与步骤数；长标题省略 |
| Privacy | 隐私/共享锁形图标 |
| Total | 该序列 enrolled/run 数量 |
| Active | 数量 + 百分比 |
| Opened / Clicked / Replied / Interested / Bounced | 各自数量 + 百分比 |
| Created | 创建日期 |
| 行尾菜单 | 三点展开：Pin、Star、Edit、Clone、Archive |

**LIVE**：[juicebox-sequence-row-menu.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)已展开单行菜单，按顺序Pin、Star、Edit、Clone、Archive。仅展开，没有执行这些选项。**REQ**：Pin（固定位置）、Star（收藏标记）、Archive（归档可见性）应分别保存与展示，不能用同一个favorite字段兼任全部；Edit进入模板编辑，Clone产生新模板而不覆盖原模板。这里是菜单文字所要求的语义区分，Pin具体排序位置、Star筛选位置、Archive确认/恢复、Clone复制范围与最终提交结果仍UNKNOWN。

现场样例：SDR/BDR 序列 99 人、2 steps、98 opened、5 clicked、7 replied、5 interested、1 bounced；Photon 序列 140 人、3 steps、140 opened、21 clicked、9 replied、5 interested、0 bounced。

**REQ**：总览 KPI 必须由选中时间范围生成，表中历史累计结果不能为了“看起来一致”强行改成同样值。现场“近30天 KPI=0、历史序列累计非0”不是数据矛盾。点击名称进入单序列执行列表；`View analytics` 应带着相应范围进入 Analytics。筛选/排序只改变呈现与查询范围；归档是独立的序列管理动作，可能持久化归档状态，但不等于发送/删除联系人；搜索或切换视图本身不触发发送。New sequence 的入口已展开，见下节；进入创建分支后的初始空编辑器、最后启动/保存动作 **UNKNOWN**。

### 4.3 New sequence 入口

**LIVE**：[juicebox-new-sequence.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。点击 New sequence 后保留总览背景，在 `?step=start` 打开 New sequence 对话层，顶部有 Close。文案为 `Generate a sequence for one of your projects`，显示最近项目快捷按钮 示例对象17、Helium、New Project，以及 `Choose project` 下拉。分隔 `Or` 下方提供 `Build from scratch` 和 `Clone existing sequence` 下拉。

**REQ**：三种入口是同一序列创建流程的不同起点：从项目生成、空白搭建、克隆已有序列。已有项目按钮与下拉必须指向真实项目identity，不能用按钮文本代替identity。克隆必须产生新的模板identity，原序列已有run的identity和历史不能被覆盖。竞品克隆是否复制收件人、是否创建新的run，实际行为 **UNKNOWN**。本次没有选择项目生成、调用AI、创建空白模板或执行克隆；此处完整覆盖创建选择层，后续生成与保存仍应单独验收。

## 5. 单序列详情与执行列表

**LIVE**：[juicebox-sequence-detail-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-sequence-after-done.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 5.1 页面结构

- 顶部面包屑 `Sequences > {sequenceName}`，主标题为序列名。
- 右侧按钮 `View sequence`、`Add contacts`。
- 七个统计按钮：Contacts、Active、Opened、Clicked、Replied、Interested、Bounced；首项显示总数，其余数量和百分比。它们是按钮，不能渲染成完全无交互的文字卡。
- 下方同样有 Schedule，周期下拉、sent/scheduled 图例和时间轴。
- 列表工具：`Search sequence runs`、`Add filter`；左上全选 checkbox。

### 5.2 每行字段

| 字段 | 展示 | 现场样例 |
|---|---|---|
| Full name | 姓名 + 公司图标 + 当前职位/公司次行 | 人名、Account Executive at ... |
| Step | 已到达/总步骤 | `2 of 2` 或 `1 of 2` |
| Status | 执行状态 + 可能的终止说明 | `Finished No reply`、`Replied` |
| Response | 独立下拉值 | `No response`、`Not interested`、`Interested` |
| Engagement | 档位 + 打开/点击计数 | Low、Medium、High；`4+` 等 |
| Added by | 添加者/Agent，下面日期 | Agent / Sep 21, 2026 |
| Actions | 行级图标按钮 | Re-enroll contact、Export sequence run |

**REQ**：`Step=1 of 2` 但 `Status=Replied` 是合法结果，不能继续执行第2步仅为了达到总步数。该推导是复刻业务约束；本次未触发新回复，停止后续发送的实时机制仍 **UNKNOWN**。Response与Add filter已实际展开，完整选项见下节；仅Re-enroll的确认/重复入列规则、run export文件内容、KPI点击后的列表结果和筛选执行后的查询结果仍UNKNOWN。菜单入口存在不等于提交成功，其写入逻辑需在后续开发验收时补测。

### 5.3 Run筛选与单行Response菜单

**LIVE**：[juicebox-sequence-run-filter.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-sequence-response-filter.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-run-response-menu.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

Add filter菜单6个维度，按顺序为Sequence status、Response status、Added by、Opened & clicked、Engagement、Added on；它们均带子菜单展开指示。Response status已展开，仅显示Interested和Not interested。其他5个维度子项未展开，完整枚举/数值运算符/日期range UNKNOWN。

实际打开第一行No response的下拉，3个选项为No response、Interested、Not interested。这与“Response status筛选菜单只含两个有意向分类”是两个不同菜单，不能为了共用组件而强行删掉单行No response或在筛选菜单中虚构未出现项。

**REQ**：筛选仅改变列表，不写入run；单行Response选择是对明确run的分类动作。No response不等于负向意向；Not interested也不等于没有回复。选择/保存成功后，UI需更新对应行，统计若受影响应依实际服务契约刷新；保存失败不得悄悄保留一个未持久化的新值。筛选状态和单行分类值应分开保存，不能打开某类筛选时批量修改所有行Response。由于本次只展开而没有选择任何选项，实际分类保存、撤销、interest统计更新和同步时机UNKNOWN。

## 6. Sequence 编辑器

**LIVE**：[juicebox-sequence-editor-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[screenshots/juicebox-sequence-editor-loaded.jpg（原始证据未公开）](PRIVATE-EVIDENCE.md)。点击 `View sequence` 进入 `?step=edit&createdSequenceId={id}` 的编辑器，Done 返回详情。

### 6.1 桌面布局

- 近全屏白色圆角编辑层，后方背景模糊；左侧 Composer 约 373px，可折叠，边界有可拖动 splitter。
- Composer 顶部标题和最小化按钮；底部固定多行输入、语音按钮、发送按钮。空态说明“Ask the Composer to draft this sequence, or to rewrite a step you have open.”；空输入时 Send disabled。
- 右侧顶部序列名可编辑；次行创建日期、创建者、visibility；右上 `Last saved ...`、Done。
- 主画布浅网格；左中为步骤索引小卡：序号、渠道、sender、预计执行时间；下方加号 Add step。
- 右侧为纵向步骤内容卡，中间细线将时间条件连接到步骤。长内容独立滚动。

### 6.2 Email 步骤

| 部位 | 必须呈现的元素 |
|---|---|
| 步骤头 | 序号、渠道 combo（现场 Email）、Preview、Delete |
| sender | `From` 下拉 |
| 首步 subject | Subject editable，Cc/Bcc 展开按钮 |
| 后续 subject | 现场第二步显示 `Reply to Step 1`，并非强制新主题 |
| AI/变量工具 | AI command；First Name、Current Company、Job title、Education、Sender first name、Last Name；Show all variables |
| 富文本栏 | Undo/Redo、Bold/Italic/Underline、Bulleted/Numbered list、Link、Image、Font、Font size、Text color、Background color |
| 内容 | 富文本 Message body；变量以可区分的 chip/高亮表示；AI instruction 段落紫色 |
| 底部 | Sender signature（现场 Noah）、签名说明、Snippet、Add attachment、Include unsubscribe checkbox |

现场可见 attachment 提示支持 PDF、DOC、XLS、PPT、TXT、CSV、images。未上传文件，大小限制、恶意文件处理及上传失败态 **UNKNOWN**。附件支持格式为界面文案，不能仅因该文案认定服务端已验证文件类型。

### 6.3 时间条件

**LIVE**：[juicebox-step-schedule.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

- 首步条件现场 `Start immediately`，是可展开的时间入口。
- 第二步条件 `Wait 2 business days`、`Send at 9:00AM PDT`。
- 展开后有 Delay 数值、单位下拉（现场 business days）、Send at 时间按钮、Timezone 下拉（现场 Pacific Standard Time）。
- 步骤索引同时显示 Oct31 PDT 与 Nov3 PST，不应把某个固定 UTC offset 硬编码成整个序列时区。

**REQ**：保留数字、时间单位、当地时间与 IANA 时区的真实语义。Business days 不能直接等同 `48小时`。编辑模板/保存模板与执行 enrollment 是不同动作。点击 Done 只应退出当前编辑器，不应凭此把联系人加入序列。自动保存的写入频率、失败提示、并发覆盖行为、假日定义、无效/缺失变量、日期选择器完整选项、其他渠道类型和 AI 生成运行态 **UNKNOWN**；本次没有改写邮件内容或调 AI。

## 7. Add to sequence：enrollment 配置

**LIVE**：从 Contacts 选择1人，经 Actions > Add to Sequence 打开。[juicebox-add-to-sequence.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-enrollment-email-preference.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-enrollment-details.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 7.1 弹窗结构

桌面为约514px宽居中白底弹窗，深灰遮罩，内边距约32px。

1. 标题 `Adding {N} profiles to sequence`。
2. 黄色提示：enrolling 将同时把该 profile 加入**当前项目** Shortlist，并明确显示项目名称。现场选择的 sequence 名含 Photon，而当前项目为 示例对象17；产品必须显式说明这层作用域，不能从序列标题猜测目标项目。
3. 问句 `Which sequence would you like to add these profiles to?` + Select sequence 下拉。
4. 问句 `Which email addresses do you prefer to contact?` + 信息提示 + email preference 下拉。
5. `When should this sequence start?` + `Start immediately (Sequence default)` 下拉。
6. 辅助说明：Follow-up step timing can be adjusted in the preview。
7. contact credits 预估/说明；More Details 可展开。
8. 底部右对齐 Cancel、紫色 `Preview Steps →`。

### 7.2 邮箱偏好枚举

| 值 | 语义 |
|---|---|
| Prefer personal emails, fallback to work emails | 优先个人邮箱；没有时使用工作邮箱 |
| Prefer work emails, fallback to personal emails | 优先工作邮箱；没有时使用个人邮箱 |
| Only use work emails | 只使用工作邮箱 |
| Only use personal emails | 只使用个人邮箱 |

这些选项是竞品现场明确提供的业务选项，不得在复刻时自行增加其他 fallback；只用某一类时也不能私自回退另一类。

### 7.3 Credits 文案与动作边界

展开 More Details 后显示：仅必要时使用 contact credits；已经 reveal、手动添加、队友已经 reveal/添加的联系方式不再重复收费。现场最终显示 `This will not use any contact credits.`，初次加载时有 loading，而非立即显示0。

**REQ**：费用预估未知时不能按0展示。已进入配置并不等于 enrollment 已保存。Preview Steps 的后续预览、最终 enroll 按钮、联系人缺邮箱处理、重复入列限制、真实 credit debit、真实发送结果 **UNKNOWN**；本次没有点击 Preview Steps，也没有提交 enrollment。由此可完整复刻已观察的配置层，最终业务提交需另有测试数据与服务契约验证。

## 8. Contacts

**LIVE**：[juicebox-contacts.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-contact-filter.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-contact-status.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-contacts-actions-selected.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 8.1 页面与表格

- 顶栏面包屑式标题 `All Contacts ({total})`，右侧/邻近 refresh。
- 次行左侧 `Search by name, company, etc.` 输入、Filter；Actions 在最右。
- 第1列页内选择 checkbox；表头 `Select all on page`。选择1行后全选呈部分选中（AX value2），选中行 checkbox value1。
- 列次序：Full Name、Profiles、Projects、Tags、Current Role、Organization、Education、Location、Date Created、Last Enrolled in Sequence、Last Enrolled by、Last Contacted、Last Replied。
- 明确以 button 暴露的排序列：Full Name、Date Created、Last Enrolled in Sequence、Last Contacted、Last Replied；不能凭此声称其余文本表头都可排序。
- Profiles 为图标按钮集合：LinkedIn、Email Outreach、Phone Number、GitHub、Personal Website、Twitter 等按实际可用资料显示；溢出可以 `3 more profiles` 收纳。
- Projects 为项目 chip/按钮；Tags 为标签 chip、加号或 Add Tags；Organization/Education 有 logo；无资料示例为 `N/A`。

### 8.2 Filter 菜单

现场完整选项如下，按展示顺序实现：Status、Owner、Project、Tags、Location、Current Company、Current + Past Company、Job Title、Current + Past Job Title、School / University、Major、Skills、Date Contact Created、Date Last Enrolled in Sequence、Last Enrolled in Sequence by、Date Last Contacted、Date Last Replied、Contacted (True/False)、Replied (True/False)、Contact Info Revealed (True/False)、Flagged Profile (True/False)。

实际展开 Status 后，工具条新增 `Filter by Status` chip；下拉包含搜索和9项：Not Contacted、Pending、Contacted、InMail Sent、Interested、Interviewing、Hired、Rejected、Not Interested，以及 `Edit Status List`。chip 旁有 `Remove Status filter`。本次只展开，没有选择某个过滤值，组合条件 AND/OR、autocomplete 的值集、日期运算符等 **UNKNOWN**。

### 8.3 Actions

选择1人后实际展开菜单：Import Contacts `⇧I`、Export `⇧E`、Add Tag、Shortlist in Project、Add to Sequence、Log Activity。本次只继续查看 Add to Sequence；其余弹窗字段、导入映射、导出格式、标签提交、活动类型没有验证。

**REQ**：列表选择与行点击必须分离，点击 checkbox 不应同时进入详情。批量动作必须以明确选中集合执行；当前证据只支持“select all on page”，不能悄悄变成全999人。切换筛选/项目后是否保留选择是 **UNKNOWN**，实现时需给出一致且可测试的作用域。相同 contact 在不同项目的 stage 和 sequence 不应相互污染。profile 图标的 reveal/打电话/发信可能有业务副作用，不能把所有图标都做成无说明的“打开资料”。

### 8.4 候选人详情：资料与工作记录并排

**LIVE**：[juicebox-shortlist-contact-detail.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[screenshots/juicebox-shortlist-contact-detail.jpg（原始证据未公开）](PRIVATE-EVIDENCE.md)。从Shortlist姓名打开候选人侧面板，当前样例为示例对象4；原列表在遮罩后保留当前位置。面板覆盖大部分视口，桌面截图中约从x445延伸到右边缘。不是导航到一个抛弃原列表状态的独立页面。

面板左右两栏：左栏资料约700px，右栏业务记录约600px；栏内各有自己的内容滚动。顶行左侧Previous/Next箭头、`Shortlisted Profiles`标题，右侧Collapse Profile、More options、Close。以上布局尺寸为截图读数近似，实际响应式宽度规则UNKNOWN。

#### 资料头部与快捷动作

| 区域 | LIVE内容 |
|---|---|
| 身份 | 姓名、LinkedIn按钮、所在地；公司logo/公司名、教育logo/学校简称 |
| Shortlist | Shortlisted主按钮，旁边下拉入口 `Shortlist in a different project` |
| Sequence CTA | 紫色 `Add to {sequenceName}`，长名省略，旁有Open dropdown；现场推荐Photon序列 |
| 隐藏 | 独立Hide profile眼睛按钮 |
| 资料导航 | Overview / Experience / Education / Skills tabs，当前Overview紫色下划线 |

**REQ**：Shortlisted表示当前项目关系，另一个项目的Shortlist动作应显式选择项目；Sequence CTA显示的是预先选中的目标模板，不能因它存在就认定当前人已参加那个序列。打开dropdown/切换tab不能误触发送。Hide profile与Unshortlist必须是不同语义，不能用一个删联系人动作实现两者。Hide、More options、Prev/Next跨页行为、折叠后尺寸与各动作确认策略未执行，UNKNOWN。

#### Overview信息与资料长页

左栏Overview按信息行显示：Status（现场Contacted，可打开）、Email（已知邮箱，旁有Copy email）、Phone（Reveal phone和Add manually）、Activity（Last contacted on日期、项目数、note数）、Tags（已有标签和+）。本次没有Reveal phone、Add manually或复制邮箱，不能把图标存在当成已取得号码。

随后是Experience节：总经验/平均任职概览，Likely to Switch、Growth Stage、Top50USUni等badge，三张小统计卡Avg tenure、Current tenure、Total experience。现场分别1yr5mos、1yr5mos、7yrs3mos，而标题概括约7years total/1year average tenure；开发应支持简略摘要与精确单位并存，不能把摘要整数重新当原始数据。

每段履历有公司logo、职位、公司、起止日期、时长、地点，可能有融资阶段badge和Read more。当前岗位出现Estimating Compensation，是计算中显示，不能补成0或伪造薪酬数。Education展示学校链接、学位/专业、日期、活动社团说明。Skill Map包含技能chip；有技能旁 `Inferred by Juicebox AI` 标识，表明它是模型补充，与明确资料技能的来源不同；有+8溢出入口。

**REQ**：这些模型标签/年限计算/薪酬估计要保留来源与不确定性，不把“Likely to Switch”写成候选人本人求职意向。不能把AI推断技能悄悄改成自报。详情页的专业资料与note中的评估可以同时可见，帮助招聘者核对依据，但UI标签不证明评估算法正确。

### 8.5 候选人 Notes

**LIVE**：[juicebox-contact-notes.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。右栏顶部5个tabs固定为Notes、Sequences、Activity、Projects、Tasks；Notes默认选中。顶部是note输入卡，placeholder `Type your note here`，支持Attach files或drag and drop，空白时Add note disabled。

已有note卡显示头像/作者Agent、相对时间、标题Agent Assessment、完整多段评估内容，底部项目名称。评估按条件列出 `Good match`（绿色对勾）、`Not a match`（红叉）、`Potential match`（灰色天平），每段包含条件文本与理由；这套标签与Metix的Worth Talking / Strong Match不同，不应混成同一字段。

**REQ**：note必须保留作者、时间、项目归属和正文；列表摘要不能替代完整note。条件级评估与profile级匹配档位分别呈现。若资料不足，应保留来源输出的缺口，不把“没有证据”自动写成确定不满足的自有判断。UI复刻应显示原评估内容，并明确Agent作者；本次只记录结构，没有重新评估该候选人。

本次未输入/保存note或上传附件；编辑、删除、mention、附件预览、保存失败、字符限制、note历史版本与跨项目可见范围UNKNOWN。读到已有note不等于本次Agent产生或验证了这份评估。

### 8.6 候选人 Sequences

**LIVE**：[juicebox-contact-sequences-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。切到Sequences后右栏显示当前联系人的既有序列记录：

- 顶部序列名为按钮，可辨认完整标题；`Sequence name`、`Current status`摘要，现场Finished(No Reply)。
- `Mark as Replied`按钮，与实际收到一封回信是两个不同概念。
- Send emails from的sender姓名/邮箱、Added on绝对日期时间、Added by（现场Agent）。
- `Reply to {firstName}`按钮。
- 下方按最近在前显示历史邮件卡，包含Expand email、sender to recipient、收件地址、Sent状态、绝对发送时间、正文截断摘要。现场2封分别为初次邮件及follow-up。

**REQ**：Contact-level历史必须来自该contact的run/message，不得显示当前模板最新内容冒充历史发送正文。实际发出邮件与模板后续改写要可区分。Mark as Replied可以是人工标记入口，但人工标记不应捏造一封来自候选人的新邮件；如果业务允许人工设置run状态，其来源须保留。Reply to进入回复编辑器，不能点击即发送。序列名跳转应落到同一run所属序列，保持筛选可追溯。

本次没有Mark as Replied、Reply to、Expand email或重新enroll，详情展开后的完整邮件布局、回复编辑器、人工mark持久化和run更新后统计口径UNKNOWN。这里看到了历史Sent记录，证明已有发送结果可读，不证明本次新发信链路成功。

### 8.7 候选人 Activity

**LIVE**：[juicebox-contact-activity.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。Activity顶部Add activity、`All activity(7)`；下方时间线含：Viewed by {user}、某人打开某序列某步邮件、加入email sequence、Contact info unlocked。事件有相对时间与项目来源 `In {project}`，打开事件包含Step1of2/Step2of2。存在多次打开同一步的独立事件。

当前页面还显示 `Viewed by 示例对象16 / a few seconds ago`，因此打开profile会留下浏览活动。此为站点自动行为，本次没有手动创建活动，不能将调研描述为“网站绝对没有发生任何写入”。

**REQ**：时间线是事件列表，不能把每次open都当独立已联系profile。KPI的unique计数与timeline重复事件要分别理解；打开事件应对应sequence/run/step，不止一段无关联文字。actor、项目、事件时间须可追溯，不能把所有自动事件归给当前查看人。Add activity表单字段和最终保存未展开，UNKNOWN。

### 8.8 候选人 Projects

**LIVE**：[juicebox-contact-projects.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。Projects tab显示项目卡：项目名及Current、Status Last Updated（现场Sep21st2026）、Owner（Agent）、阶段按钮（Contacted）、Unshortlist下拉、View Shortlist。

**REQ**：此处是联系人所属项目关系，不是把候选人简历里的个人项目放进此tab。点击View Shortlist应打开该项目的Shortlist；Unshortlist只解除明确项目关联，不删除全局contact或其他项目历史。Current标识来自当前导航context，不能由最近联系时间推断。跨项目多张卡、Owner编辑、Unshortlist确认和取消后的恢复路径未操作，UNKNOWN。

### 8.9 候选人 Tasks

**LIVE**：[juicebox-contact-tasks.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。Tasks tab顶部Create Reminder，Overdue Tasks(0)与Upcoming Tasks(0)两区，View all your tasks入口；空态分别No overdue tasks for this contact、No upcoming tasks for this contact。

**REQ**：候选人任务列表必须与全局任务视图区分作用域；两个0代表该联系人没有相应任务，不应显示全账户总任务数。逾期与即将发生的分类依实际due time与用户时区。Create Reminder表单、通知频率、completion流程与全局任务页未展开，UNKNOWN。本次不将提醒创建或自动发消息纳入已经完成的竞品操作。

## 9. Shortlist

**LIVE**：[juicebox-shortlist.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-shortlist-more.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-shortlist-columns.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

### 9.1 项目作用域与表格态

- 面包屑 `Projects > {project} > Shortlist ({N})`；项目名本身是切换入口。
- 工具条：Search by name/company、Sort by Date (Newest)、Filter；右侧 View insights、Request review、More actions。
- 默认可见列：选择、Full Name、Profiles、Status、Sequence、Owner、Date、Current Role、Organization。
- 名字行有上次联系图标/提示、Remove from Shortlist、Add to Favorites。
- Status 是带颜色圆点的 combo，可显示 Contacted、Not Interested、Interested 等；Sequence 独立显示 No Reply 或 Replied 色块。
- Owner 显示 Agent 图标/人名；Date 以“a month ago”显示，AX 还暴露完整日期时间；无开始时间时 Current Role 附 `Start date not known`。
- 现场总99条，分页 `1–40 of 99`，页码1/2/3和 Previous/Next。第1页 Previous disabled。

### 9.2 More actions 与列显示

More actions：`View Table` 子菜单、Import `⇧I`、Export `⇧E`、Smart report、Create search（副文案 Custom search based on the profiles shortlisted）。

View Table 子菜单顶端为 Table / Board 两按钮，下方 Display columns checkbox。现场勾选 Profiles、Sequence、Added to ATS、Owner、Date、Current Role、Organization；未勾选 Education、Location、Tags。Added to ATS 虽勾选但主表并未在该样本明显呈现列，可能受连接条件影响，不能据此强制显示空列。

**REQ**：保留 Full Name 与阶段信息以确保候选人身份可识别；其余列可按已观察菜单显示/隐藏。切换 Table/Board 应作用于同一项目、同一批候选人，不能因为视图切换修改业务数据。列偏好保存位置、跨设备同步、拖动列顺序、列宽持久化 **UNKNOWN**。

### 9.2.1 选中后的底部批量操作栏

**LIVE**：[juicebox-shortlist-selected-toolbar.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-shortlist-selected-actions.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。在Shortlist勾选1人后，页面底部出现`1 selected`批量栏，包含Add to Sequence、Request Review、Find similar profiles、Export selected、More actions、Clear selection。它与页面右上未选中状态的More actions不是同一菜单。

批量More actions展开后的完整顺序：Shortlist Search(1)、Unshortlist、Smart Report、Add to favorites、Reveal Email、Reveal Phone、Refresh Contact Info、Copy to Project、Change Status、Add Tag、Log Activity。其中后四项带可继续展开的子菜单指示；本次未展开子菜单，也未执行reveal、refresh、remove、导出或提交。

**REQ**：selected计数、所有批量动作、Request Review的待评人数、Shortlist Search括号数必须来自同一个明确选择集合。Clear selection解除勾选并收起批量栏，不改变候选人业务状态。Find similar/Shortlist Search是搜索入口，不能在只选择联系人时直接开启付费研究；Reveal Email/Phone/Refresh Contact Info必须保留实际账号credit与访问规则。这里仅复刻原有入口，不把新增搜索/计费策略扩展为已授权的业务操作。选择跨页是否保留、全选作用于当前页还是全99条、各子菜单字段、所有操作确认及提交成功态UNKNOWN。

### 9.3 Board

**LIVE**：[juicebox-shortlist-board-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[screenshots/juicebox-shortlist-board-loaded.jpg（原始证据未公开）](PRIVATE-EVIDENCE.md)。实际切换并等待加载后，得到9个横向阶段列：Not Contacted、Pending、Contacted、InMail Sent、Interested、Interviewing、Hired、Rejected、Not Interested。每列头有选择控件、阶段颜色点、阶段名、计数、settings 三点入口。

| 列 | 本项目现场数量 |
|---|---:|
| Not Contacted | 0 |
| Pending | 0 |
| Contacted | 92 |
| InMail Sent | 0 |
| Interested | 5 |
| Interviewing | 0 |
| Hired | 0 |
| Rejected | 0 |
| Not Interested | 2 |

92+5+2=99，与项目Shortlist总数一致。Board没有把No Reply/Replied作为阶段列，回复状态仍属于卡片内的Sequence信息。

卡片为白色细边框，所在列浅灰底，列间距约8px，每列宽约328px。卡片内容按顺序为：姓名、最近联系小邮件图标、hover时可见的favorite/remove；职位（长文本省略）、公司logo与公司名；Owner/Agent chip、`Updated {N} days ago`；底部No Reply浅黄色或Replied浅绿色chip。卡片本身是按钮，内含独立选择checkbox。Contacted列中逐卡纵向滚动；看板整体可横向滚动，空列仍占列宽。该状态中Contacted92不要求屏幕同时渲染92个卡片。

初次切换截图 [juicebox-shortlist-board.txt（原始证据未公开）](PRIVATE-EVIDENCE.md) 曾显示9列0，这是加载瞬间；已由loaded证据补齐真实计数。**REQ**：复刻不能把未加载当空集合，也不能因为某列未渲染完而改写列总数。点击卡片打开当前候选人详情；点击选择、favorite、remove不应同时误触卡片主动作。横向滚动需保留列标题可识别，切回Table后仍是同一项目与集合。拖放跨列、settings菜单、列选择是否覆盖完整列所有页面、修改阶段后的真实持久化、卡片懒加载边界 **UNKNOWN**，不虚构“已验证拖拽”。

### 9.4 Review

**LIVE**：[juicebox-request-review.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[screenshots/juicebox-request-review.jpg（原始证据未公开）](PRIVATE-EVIDENCE.md)。未选单行时点击工具条Request review，打开居中约514px宽的白色圆角弹窗，后面列表仍可辨认并模糊。顶栏为Request review与关闭×，下方分隔线。

弹窗实际字段：

| 顺序 | 元素 | 现场状态 |
|---|---|---|
| 1 | 说明 | Send a request to your hiring manager or team member to review the profiles that you've shortlisted. You'll be notified once profiles have been reviewed. |
| 2 | Profiles to review | 大号数字99，表示本次待评人数 |
| 3 | Select who to request a review from | `Select...` reviewer下拉 |
| 4 | Add note (optional) | 副文案说明可给reviewer提供context，多行textarea，placeholder Add a note for the reviewer... |
| 5 | 底部 | Cancel、Request review；未选reviewer时后者disabled |

本次没有选reviewer、填note或提交，没有邀请/通知任何人。**REQ**：该弹窗必须先确认待评集合，不能把“没有勾选”误当0人，也不能在选中一个子集时静默扩大到全Shortlist。默认99的来源须与当前作用域一致；已有99并不证明所有用户/筛选状态下默认都评审全项目。note可选，reviewer必选；焦点进入弹窗，关闭/取消回到原Shortlist并保留列表上下文。

**STATIC**：[rea/static-findings.json（原始证据未公开）](PRIVATE-EVIDENCE.md)及[rea/REPORT.md](rea/REPORT.md)中的历史流程还包括：邀请新Hiring Manager（email、note）、查看Requested by/Requested on/Note/Profiles reviewed/Completed on的summary、`Add approved profiles to sequence`。这些是未在本次现场展开的下游，保持STATIC；不能由现有Request review表单推断邀请发送成功。

**REQ**：如果实现完整review，下游结果只属于请求的候选集合与项目；把approved profiles加入sequence应进入同一个enrollment配置/预览流。reviewer空、邮箱无效、提交失败、重复邀请、对方无权限等需按实际服务契约处理，原竞品的具体失败文案、notification位置、评审者页面布局与邀请有效期 **UNKNOWN**。

### 9.5 Talent Insights

**LIVE**：[juicebox-shortlist-insights-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[screenshots/juicebox-shortlist-insights-loaded.jpg（原始证据未公开）](PRIVATE-EVIDENCE.md)。点击View insights并等待后，面包屑 `Projects > project > Shortlist(99) > Insights`；顶部Back to shortlist箭头、`Talent Insights (99)`、右侧Export Insights。之前 [juicebox-shortlist-insights.txt（原始证据未公开）](PRIVATE-EVIDENCE.md) 的Loading已被此loaded证据补齐。

布局是向下滚动的分析画布。首行左侧宽卡约占2/3，右侧Key Takeaways约占1/3；卡片浅灰背景、圆角约16px，卡间约16px。下面左侧为统计小卡，右侧宽图表；其后是多个分布模块。它与Analytics Outreach的“触达效果”不同，分析的是当前99人的人才构成。

#### 地理与AI摘要

- Top Locations：标题和“Top cities for your search pool”，左边城市+人数列表可独立滚动，右边地图上以紫色气泡表示城市聚集，地图带+/- zoom和地图服务署名。
- 现场地点计数：Los Angeles76、Santa Monica8、Long Beach3、Manhattan2、Newport Beach2、Alhambra/Burbank/Cypress/Hermosa Beach/Redondo Beach各1、Other3，合计99。
- Key Takeaways：副标题“Takeaways from your insights, curated by AI”，右上复制图标。文本强调Crexi雇主集中、software/SaaS环境、商业地产相关公司标签；关键数字/实体以浅紫inline highlight突出。
- 这些摘要是竞品AI输出的展示证据，**不是已核实所有候选人实际能力或职业背景的真值**。本次没有执行重新生成或复制动作。

#### 经验与任职时长

| 模块 | 现场主值 | 现场分位 |
|---|---|---|
| Years of Experience | AVERAGE4.6years | P25 3.5years、MEDIAN4.6years、P75 5.7years |
| Average Tenure | AVERAGE1.4years | P25 10months、MEDIAN1.2years、P75 1.6years |
| Number of Profiles by Experience | 紫色面积曲线 | 横轴experience年数，纵轴人数 |

P25/P75旁信息按钮分别解释“25%/75% of profiles have this many years of experience or less”，Average Tenure也有对应解释。经验字段的精确full-time识别、重叠履历去重、兼职/学生经历排除规则 **UNKNOWN**，不能据展示数字反向发明算法。

#### 分布模块清单

以下模块标题和辅助文案在同一loaded AX证据中存在，图形/值仅在有实际读数处记录：

| 模块 | 展示内容与交互 |
|---|---|
| Skills | Most common skills；Expand按钮；例如Communication49(49%)、Customer Service38(38%)、Sales37(37%) |
| Current Employers | Top current employers；标题注明covers48%；Expand、More info；Crexi34(34%)、Sunbit3(3%)等 |
| Past Employers | Most common past employers；Expand；Crexi15(15%)等 |
| Job Titles | Top job titles；covers75%；Expand、More info；SDR41(41%)、BDR13(13%)、AE12(12%)等 |
| Job Title Level | Seniority levels模块标题存在；具体分类/值未由当前可见截图验证 |
| Job Title Role | Departments模块标题存在；具体分类/值未由当前可见截图验证 |
| Gender Distribution | 标题和Gender diversity文案存在；当前未读取值，身份信息来源/完整性UNKNOWN |
| Company Industries | Top industries，covers88%；Expand、More info；Computer Software60(61%)等 |
| Company Type | 当前雇主公司类型模块标题；具体分类/值未验证 |
| Private Company Funding Stages | Expand；Pre-seed、Seed、Series A到Series H横轴 |
| Company Tags | Expand；Software and Technology73(74%)、SaaS56(57%)、Enterprise Software47(47%)等 |
| Universities | Expand；学校logo、名称、数量/百分比；USC8(8%)、LMU8(8%)等 |
| Minimum Education Level | 学历层次模块标题；具体分类/值未验证 |
| Majors | Expand；Management25(25%)、Business Administration24(24%)等 |
| Languages | Expand；English11(11%)、Spanish5(5%)等 |

**REQ**：同一模块内的条形、数量、百分比、top-N覆盖率要对应同一集合。Skills、Past Employers、Company Tags、Majors等可能一人多值，不能为了让总和等于100%而强行按互斥分组。Other与unknown也不能混成同义项；本次不推导原后台的缺失值/分母规则。身份分布字段只能使用有明确来源的已提供数据，不能从姓名/图片/简介猜测或产生新的敏感身份标签；此为数据真实性约束，不添加新评估业务。

地图、AI摘要、分布图应使用当前项目真实数据。不能把这99人的城市或职业分布内置成所有项目的默认图。Export Insights的输出格式、展开模块后的完整列表、More info弹层的完整定义、地图点击后筛人、是否根据当前Shortlist筛选子集计算、生成成本和刷新策略 **UNKNOWN**。

### 9.6 Shortlist排序与筛选

**LIVE**：[juicebox-shortlist-sort.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-shortlist-filter.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

排序菜单7项：Date(Newest)、Date(Oldest)、Status、Company(A-Z)、Company(Z-A)、Name(A-Z)、Name(Z-A)。排序不应修改候选人的阶段或创建时间；字符串排序中空值位置、同名tie-breaker、是否跨页服务端排序 **UNKNOWN**，复刻实现需选择确定且可测试的规则。

Shortlist Filter菜单9项：Status、Owner、Location、Current Company、Current+Past Company、Job Title、School/University、Manually Imported、Date Added。它比全局Contacts的Filter更短，**不要机械共用完全相同的菜单**。同名Status可以复用既有阶段定义，Project不在此菜单是因为页面已经有当前项目作用域。Manually Imported是来源过滤，不等于所有非Agent；来源定义与选项未展开，UNKNOWN。

## 10. Analytics

### 10.1 导航与权限

**LIVE**：[juicebox-analytics-loading.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-analytics-projects-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-analytics-agents.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-analytics-outreach-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

Analytics 展开 Usage、Projects、Outreach、Agents。当前账号进入 Usage、Projects、Agents 三页均受到Business权限限制，当前Projects证据显示 `Usage Analytics`、Analytics helps you understand how your team is using Juicebox、This feature is only available on the Business plan、Upgrade to Business。该路径虽然为 projects，显示的权限页标题为 Usage Analytics；照实记录，不能杜撰解锁后的 Projects 功能。

**STATIC**：历史 usage 表格包含 Search、Profiles Viewed、Shortlisted、Contacted、Replied、Interested、Exported、Contact Credits、Current Seat 等；定制列包含 Show all / Hide all / Apply / Cancel。没有当前解锁态证据，不能当作已登录实际看到的 paid analytics。

### 10.2 Outreach 过滤区

**LIVE**：[juicebox-analytics-outreach-loaded.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

页面标题 Outreach，面包屑 Analytics / Outreach，并有页面切换下拉。过滤区：Sequence（All sequences）、Project（All projects）、Started by（Started By）、Inboxes（All inboxes）、Date range（现场 Last1year）、Grouped by（现场 Months）。所有筛选应作用于同一统计集合，不能只改表格而不改 KPI。

### 10.3 KPI 与可核对的真实样例

| 指标 | 现场值 | 页面分子/分母 |
|---|---:|---|
| Profiles Contacted | 239 | 239 sequence runs |
| Open Rate | 99.6% | 238/239 |
| Click rate | 10.9% | 26/239 |
| Reply Rate | 6.7% | 16/239 |
| Interest Rate | 4.2% | 10/239 |
| Bounce Rate | 0.4% | 1/239 |

KPI 同时显示相对变化（现场 +100%、+11%、+7%、+4%、+0%）。**LIVE** 能确认显示这些分母，不能证明跨序列同一个人的全局去重规则。标题 Profiles Contacted 与副文案 sequence runs 需要一起保留，避免开发擅自转为去重Contact数。

**REQ**：百分比由同一查询范围的真实计数得到；需要保留分子分母用于核对。分母0时不除零，不用静态假数填补。变化的基期、时区、延迟事件归属、隐私打开邮件对open的影响和唯一用户/唯一run规则 **UNKNOWN**；本次不推导竞品内部统计算法。

### 10.4 图表

两个独立模块 `Profiles contacted by user` 与 `Profiles contacted trend`；每个都有 Agents checkbox、用户 checkbox、Download CSV。现场 Agents未勾、示例对象16勾选。横轴按月份，纵轴数量。复刻应保留图例独立开关与CSV入口；未实际下载，CSV列、编码、是否遵循当前图例选择 **UNKNOWN**。

### 10.5 可切换聚合表

**LIVE**：[juicebox-analytics-metric-options.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)、[juicebox-analytics-group-options.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)。

- 区块标题随指标和group生成，现场 `Profiles enrolled by Sequence`。
- 顶部 search outreach、Metric（Emails sent / Profiles enrolled，现场后者选中）、Group by（User / Project / Sequence，现场Sequence）、Breakdown（None / User / Project，现场None）、Download CSV。
- 表头：Sequence、Profiles enrolled、Month Average、Best Month、This Month、Opens、Clicks、Replies、Interests；表头可排序，列边有resize splitter。
- 行前有 Inactive sequence 指示；序列名为按钮。两行140和99，底部Total239；Opens总238，Clicks总26，Replies16/6.7%，Interests10/4.2%。
- 现场 Month Average 单行11和8，总计18；不能用显示后四舍五入的11+8计算Total，因为总计可能基于原始数据重新计算。真实算法 UNKNOWN。

**REQ**：切换 Metric 必须同时更新表标题、主数值与列标签。Group by 是聚合维度而不是把当前序列表按用户字段排序。Breakdown完整选项已展开为None/User/Project，见[juicebox-analytics-breakdown-options.txt（原始证据未公开）](PRIVATE-EVIDENCE.md)；实际切换后的矩阵布局未执行，UNKNOWN。CSV、序列下钻、筛选组合/复位、图表hover、日期range全选项未执行，保持UNKNOWN，验收必须有相应可追踪测试。

## 11. 跨页逻辑与最小数据要求

以下为 **REQ**，目的是让复刻界面真实工作，字段名称是逻辑概念，不要求新建平行数据库或服务。

| 页面所需信息 | 必须可追溯到 |
|---|---|
| 全局Contact | 稳定contact identity、资料链接、联系方式来源、关联项目集合、创建/最近联系/回复时间 |
| 项目Shortlist | 项目identity + contact identity、入选时间、stage、owner、favorite、review关联 |
| Sequence模板 | 名称、visibility、creator、steps顺序、channel、sender、subject/thread关系、body、变量、signature、attachments、unsubscribe、time condition |
| Enrollment | sequence + contact + 当前项目、email preference、start timing、选定地址、执行进度/状态、response、engagement、添加者/日期 |
| Analytics | 对应run/event、发生时间、project、sequence、actor、sender inbox、计数/分母与聚合范围 |

关键逻辑链：

`Contacts / Shortlist 选择明确集合 → Add to Sequence 配置 → Preview Steps（本次未查看）→ 最终提交（本次未执行）→ Sequence runs → 接触/打开/点击/回复事件 → Shortlist的Sequence标记 / Contacts最近时间 / Analytics同范围计数`。

不得用“点击了配置按钮”写入已发送时间；不得用已生成邮件模板伪造sent；不得用加入Shortlist推断联系人Interested；不得用AI匹配档位推断已回复。事件未到、数据失败、确实0条应是不同状态。

## 12. 开发验收清单

以下是复刻实现后的 **REQ**，本次调研不声称已在我们产品执行。

| ID | 场景 | 可验收结果 |
|---|---|---|
| JB01 | 全局Contacts与当前项目Shortlist不同人数 | 两处正确显示本作用域的数量，切项目不会清空全局联系人 |
| JB02 | Contacts选1人 | 该行选中、页内全选为indeterminate；批量动作只作用1人 |
| JB03 | Contacts打开Status筛选 | 9个阶段和Remove入口存在；筛选无匹配与读取错误分开 |
| JB04 | 切换项目 | 新请求/迟到响应不能把旧项目候选人写进新项目页面 |
| JB05 | Shortlist默认表格 | 身份、阶段、Sequence结果、owner、日期、当前工作可扫描 |
| JB06 | Shortlist99条 | 第1页1–40，第2页41–80，第3页81–99；边界按钮正确 |
| JB07 | Table切Board再返回 | 项目、候选集合及状态一致；加载中0不冒充真实空态 |
| JB08 | 列显示 | 用户能独立显示/隐藏已观察列；姓名与阶段仍可识别 |
| JB09 | Remove/Favorite | 只有服务成功后显示确认结果；失败不悄悄丢资料 |
| JB10 | Sequence总览日期范围 | KPI依范围更新，历史累计序列表保留自己的口径 |
| JB11 | Sequence详情 | Step、Status、Response、Engagement分列；1/2+Replied可正确显示 |
| JB12 | View sequence | 打开编辑器，Done返回同一详情，联系人未被自动enroll |
| JB13 | 编辑Email | Subject、From、变量、body、签名、附件、unsubscribe可呈现/编辑，保存状态真实 |
| JB14 | 模板第二步 | 可显示Reply to Step1；不会错误生成独立主题 |
| JB15 | 等待business days且跨DST | 预计时间按相同地点时区正确显示，不按固定offset计算 |
| JB16 | 无AI输入 | Composer发送按钮disabled；AI运行状态与最终模板保存分开 |
| JB17 | Add to Sequence | 弹窗显示人数和实际当前项目，明确附带Shortlist关系 |
| JB18 | Only work / Only personal | 不私自使用另一类型邮箱；偏好与地址选择可核对 |
| JB19 | Credit估算pending | 显示计算中而非0；已reveal信息不重复计费符合实际服务契约 |
| JB20 | Cancel enrollment | 返回原列表，不添加Shortlist、不创建run、不发送 |
| JB21 | Preview与最终提交 | 预览能显示实际个人变量和预计执行时间；最终动作才建立真实run |
| JB22 | 重复最终点击 | 同一次提交不能产生两次同人同序列重复发送；不能靠隐藏重复结果掩盖 |
| JB23 | 回复到达 | run显示reply，后续发送按明确契约停止；Contacts/Shortlist/Analytics一致 |
| JB24 | 统计239样例 | 238/239=99.6%、26/239=10.9%、16/239=6.7%、10/239=4.2%可核对 |
| JB25 | Analytics筛选 | Sequence/Project/Actor/Inbox/日期同时作用KPI、图表、聚合表与导出 |
| JB26 | Emails sent↔Profiles enrolled | 指标名与数据变化，不只是切换标题 |
| JB27 | Group by User/Project/Sequence | 真正重新聚合，无重复累计或错误分母 |
| JB28 | Analytics未知/加载失败 | 不展示假0；已记录的业务结果不因失败被删除 |
| JB29 | 没有Business权限 | 呈现明确权限态，与“没有数据”分开；解锁内容不捏造 |
| JB30 | Review结果到Sequence | 只带approved集合进入同一个enrollment配置，未审/拒绝者不混入 |
| JB32 | Contact详情tab切换 | Notes/Sequences/Activity/Projects/Tasks始终属于当前contact，旧请求不覆盖新选中的人 |
| JB33 | 历史邮件 | 正文/收件人/时间来自真实历史message，模板后改不篡改已发内容 |
| JB34 | 人工Mark as Replied | 保留人工状态来源，不凭标记捏造收件邮件 |
| JB35 | Contact项目关联 | Unshortlist只移除目标项目关系，不删全局资料和历史 |
| JB36 | Talent Insights99样例 | 地理总数99、stage92+5+2=99可核对，多值技能不强迫总和100% |
| JB37 | Notes资料来源 | AI推断与显式资料标记分开，缺失资料不变成确定事实 |
| JB31 | 可访问性 | 菜单键盘可达、焦点顺序正确、弹窗焦点受控、图标有名称，状态不只靠颜色 |

## 13. 尚未补齐的竞品观察边界

本文给出已观察界面的字段与交互规格，同时留下以下真实缺口：New sequence选择分支后的编辑器与保存；enrollment Preview Steps及最终提交；Sequence run Response保存与Re-enroll；Review邀请/接收方/结果summary；Board拖放持久化与settings；Talent Insights图表展开/统计缺失值算法/导出；Business解锁后的Usage/Projects/Agents；CSV实际内容、日期range全选项和筛选统计内部算法。已补齐的Board92+5+2、Talent Insights99和Request review表单不再列为缺口。

这些不能靠历史bundle或图示推断为已验证。后续实现的REQ可以验收，但不得把尚未观察的界面细节写成竞品既有事实。
