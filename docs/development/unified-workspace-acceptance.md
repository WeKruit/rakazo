# 统一招聘工作台交付验收清单

本次范围是把 **CRM、Instantly、email 沟通、interview timeblock** 打通到 **Contacts、Interview、Sequence、Inbox、Overview** 五个页面及共用候选人详情中。功能和 UI 均为交付要求：不仅要能用，还要紧贴已提供截图学习布局、密度、间距、字体、卡片、时间线和日历；不能以“功能已做”代替视觉验收。

本文件是需求和验收标准，不是完成报告。**所有勾选项默认待验收；未附证据，不得声称已实现、已测试或线上已验收。** 截图中的候选人资料、数量、时间、邮件内容均不得复制为业务数据。

## 交付与责任

| 交付线 | 负责人标识 | 交付责任 |
| --- | --- | --- |
| CRM 与功能 | `01a16988` | 统一身份及旧 CRM role、五页数据联动、Instantly 和 email 关联、排期全流程、权限和错误状态；与 Profile 线共同负责产品跨页 E2E |
| Profile 与视觉 | `01a16a16` | 五页及详情视觉还原、照片和 logo、资料与技能证据、交互、桌面和移动端实机对照；与 CRM 线共同负责产品流程及 UI E2E |
| CI/CD 与验证 | `01a16a09` | 构建与基础设施验证、测试运行和证据采集接口、CI 回归及部署就绪证据；不代替产品两线负责跨页 E2E，不自行合并或发布 |

- [ ] 交付五个真实可导航的页面、复用的候选人详情、统一的数据关联和状态；不能只做单页演示或孤立假数据组件。
- [ ] 每项记录：需求编号、负责人、代码版本、环境、实现状态、测试状态、线上验收状态、证据位置、阻塞项。
- [ ] 状态分别记录：实现 `待核实 / 未实现 / 已实现`；测试 `待执行 / 未通过 / 已通过`；线上验收 `待授权或待验收 / 未通过 / 已验收`。初始均为待核实、待执行、待授权或待验收，禁止以其中一个代替其他两个。

## 统一身份和数据契约

以下 `contact_id`、event/timeblock ID 等表示**逻辑身份与关联**，优先复用现有系统的数据契约和标识；不要求另建同名表、重复 ID 或替换既有模型。实现方须提供现有字段到这些逻辑概念的映射。

- [ ] **旧 CRM roles 是一等业务对象**：保留原 role ID、名称、真实状态及来源，可被五页共同筛选和关联；不得仅作为装饰标签，不得按同名重建重复 role，不得编造迁移前历史。
- [ ] 同一联系人使用稳定 `contact_id`；保留旧 CRM ID 和可核实的外部 ID。姓名相同不能自动合并；邮箱、账号、外部 ID 冲突须进入可见的待确认状态。一个人可属于多个 role，但 role 关系和沟通上下文不能串线。
- [ ] 明确关系链：`workspace/account → role → contact-role association → sequence/campaign membership → mailbox/thread/message → interview/timeblock/calendar event`。所有页面使用同一条关系链和同一状态来源。
- [ ] Instantly 保留真实 workspace/account、campaign ID、lead/member ID、step ID 和 provider 状态；一个 contact 多 campaign 时能明确选择。链接必须打开**当前记录对应的 campaign/lead**，不能全都指向平台首页。
- [ ] 邮件保留 provider、mailbox ID、thread ID、message ID、发件人、收件人、方向、主题、时间及可用的回复关联头；不能仅按姓名、主题或邮箱猜测同一线程。
- [ ] 排期保留 contact、role、原邮件 thread、参会人、calendar ID、event ID、slot/timeblock ID、起止时间、IANA timezone、状态及来源。未创建的 event 不得伪造 provider ID 或显示为已预约。
- [ ] 时间统一保存可比较的 UTC 时间，并保留显示时区及来源；相对时间由真实事件时间计算。缺失字段显示未知或暂无，不以当前时间伪装历史时间。
- [ ] 同步具备去重、幂等、更新顺序、冲突及失败处理；重复 webhook、刷新、重试不能重复联系人、消息、activity 或日历预约。标明最近成功同步时间与错误，不能把过期数据显示成实时。
- [ ] Workspace 隔离、角色访问权、写操作权限和敏感资料可见性有明确测试；日志及验收证据不泄漏邮箱正文、候选人 PII 或密钥。

## 页面功能验收

### Contacts

- [ ] 列表含真实头像或明确的缺失占位、姓名、当前职位、公司、学校、地点、role/project、标签、沟通及面试状态；支持搜索、过滤、排序、选择、分页或长列表加载。
- [ ] 公司和学校 logo、公司链接及个人 profile 链接在列表和详情中均可见且可点击；每个链接来自已验证记录，不拼猜 URL，不拿无关 logo 或照片补位。缺失时保留一致占位，不影响布局。
- [ ] 打开详情能看到真实 Experience、Education、Skills 及有数据的其他资料；经验时间、公司、学校及来源一致，标签能展开或跳转到证据。
- [ ] 技术要求逐项展示 `Match / Partial / Concerns`，高亮对应技能和技术标准；每项附可点击证据及来源。无足够证据明确为未知，不能用照片、总体分数或生成的断言替代技术判断。
- [ ] 可查看并准确跳转到此 contact 的 role、Instantly campaign、email thread、interview/timeblock；返回列表保留筛选、选中项和滚动上下文。

### Inbox 和 email

- [ ] Role 筛选、All/Unread、真实未读数、候选人卡片、选中态、无选中态、邮件线程和 profile drawer 完整可用。
- [ ] 展示真实收发消息与完整沟通历史，按正确 thread 归组；可展开历史 outreach/follow-up，数量与内容一致，不用概括文本假装已经发送的邮件。
- [ ] Reply composer 明确显示发件账号、真实收件人、当前 thread 及关联 role/campaign；草稿、待审批、发送中、已发送、失败、收到回复均分开表示。发送成功只能由 provider 回执及读回确认。
- [ ] Instantly 链接和状态可从 Inbox 追溯到准确 campaign/lead/step；能从 Sequence 返回同一 contact 的准确沟通线程。
- [ ] 从线程发起排期能携带当前 contact、role、邮件上下文及已有可用时间；预约结果和后续变更能返回**原线程**，不得另起无关线程。
- [ ] 真正的已读/未读与应用查看 activity 分开定义；应用内“Viewed by”只表示谁看过资料，**不是锁定、占用或发送许可**，不得阻止他人正常查看。

### Sequence 和 Instantly

- [ ] 展示真实 campaign/sequence 列表、owner、关联 role、步骤、成员、状态和时间；支持搜索与 owner/contact/role 筛选，正确展示归档状态。
- [ ] Contacted、Active、Opened、Clicked、Replied、Interested、Bounced 等指标有明确 provider 来源、去重口径和时间窗口；不支持或未启用的追踪标记不可用，不能伪装成 0 或成功。
- [ ] 每个 sequence 可查看步骤与真实 send schedule、联系人 membership、发送/回复状态，并跳转准确的 Instantly 页面和 Inbox thread。
- [ ] 回复、退订、退信、暂停及已预约等状态按明确规则反映到后续外联计划；“本地建议暂停”与“provider 已暂停”必须区分。批量或单条真实发送、启动和修改 campaign 仍受审批边界约束。

### Interview 和 timeblock

- [ ] 日历提供 Today、前后翻页、日期范围、role/status 过滤、timezone 切换、时间刻度、当前时间线、预约卡片和右侧 activity；空周、无权限、未连接及加载失败不是同一种空状态。
- [ ] 在实际 provider 能力和已授权读取范围内，完整呈现符合条件的 slots/timeblocks，而非只给一个推荐时间；支持多日、多 slot、时长、工作时间、buffer、忙闲冲突和已失效 slot。显式显示日历来源、查询日期范围、分页/更多结果和未覆盖部分；来源不完整时不得宣称穷尽所有可用时间，未知不能显示为空闲。
- [ ] 展示候选人和面试方的本地日期、时间、时区及 UTC offset；测试跨日与 DST 切换，禁止把固定 offset 当作时区或把歧义时间静默解释。
- [ ] 形成可审阅预约方案：contact、role、thread、参会人、时长、地点或会议方式、目标 calendar、slot、双边时区；**获明确批准前不创建、修改或取消真实事件，不发送邀请或邮件**。
- [ ] 获授权执行时，在写入前重新检查 slot 冲突；防重复提交，并读回真实 event 的 ID、起止时间、时区、参会人、状态及会议链接。仅有 API 请求成功或本地卡片不足以认定 booked。
- [ ] 确认邮件经相应授权后在**原 email thread**发送，并读回 message/thread ID；预约成功但确认邮件失败须显式区分，可安全重试，不能重复预约。
- [ ] 改期、取消、冲突、过期、provider 失败及部分成功有明确状态；五页同步反映真实结果，不丢失原关联和审计记录。

### Overview

- [ ] 聚合五页的真实 CRM、外联、回复和预约数据；日期、role/project 过滤统一作用于指标及图表。
- [ ] 展示 shortlist 趋势、outreach conversion、待处理回复、即将到来的 interviews/timeblocks、recent activity 及需要处理的任务；数字口径可解释，未知与零分开。
- [ ] 每个关键数字、任务和 activity 可下钻到带相同筛选的 Contacts、Sequence、Inbox 或 Interview，不能是无响应装饰卡片。

### 共用 Activity

- [ ] 使用真实 `viewed / sent / replied / status changed / updated` 事件，显示 actor、发生时间、来源及关联 contact、role、campaign/message/event；可用时提供精确跳转。
- [ ] `Viewed by` 使用眼睛与查看记录语义；email opened 是 provider 追踪事件，不能与应用查看混同。无历史就显示无历史，不生成“一个月前”等假时间。
- [ ] 手工新增备注或 activity 明确标注为手工记录，不能冒充 provider 已执行动作；同一事件跨页一致且不重复计数。

## 截图逐页视觉验收

以下参考已逐张查看。V01–V12 是可跨会话使用的参考编号和描述；括号内为当前本地文件位置，转交时保留编号并附对应图片，不依赖收件人拥有同一目录。只学习产品区域，**不复制浏览器工具栏、调试横幅、个人资料、参考产品品牌或无关商业推广**。保留当前产品品牌，贴近参考的信息层级和视觉结构；所有必要差异要显式列出，不接受默认套一个通用 dashboard 代替。

| 参考 | 必须学习和核对的 UI |
| --- | --- |
| V01 Contacts 表格（`flow-refs/page1/image(4).png`） | Contacts 的窄侧栏、紧凑顶栏、搜索/筛选工具条、密集但清晰的表格、细分隔线、profile 图标、公司/学校 logo、浅色标签、行选中态 |
| V02 Interview 周历（`flow-refs/page2/image(5).png`） | Interview 的大面积圆角日历容器、顶部日期/时区导航、纵向时间网格、当前时间线、独立右侧 activity 栏、居中空状态卡片 |
| V03 Inbox 未选中（`flow-refs/page3/image(6).png`） | Inbox 左侧筛选和候选人卡片列、照片与公司/学校信息、匹配 badge、未读点、回复摘要条；右侧无选中引导与充足留白 |
| V04 Inbox 展开线程（`flow-refs/page4/image(7).png`） | Inbox 选中候选人边框、对话顶部身份栏、Profile/Reply 操作、消息卡片、可折叠 follow-up 分组及竖向历史线 |
| V05 Inbox Profile 抽屉（`flow-refs/page5/image(8).png`） | 右侧 Profile drawer、背后遮罩、身份/照片/链接、技术标准推荐列表、联系信息分组、页签、带 logo 与日期的工作经历 |
| V06 Inbox 收起历史（`flow-refs/page6/image(9).png`） | 不同线程切换后保留一致卡片及消息结构、收起的历史组、状态/时间层级、线程结束标记；内容短时不硬塞假历史 |
| V07 Sequence 指标与列表（`flow-refs/page7/image(10).png`） | Sequence 顶部横排指标卡、send schedule 图、搜索/筛选条、细线列表、二级 owner/steps 信息、对齐的数量和百分比列 |
| V08 Overview 总览（`flow-refs/page8/image(20261023-185417).png`） | Overview 居中内容宽度、标题与操作区、同卡内的趋势图和 conversion 分区、下方 recent/task 卡片、疏密节奏 |
| V09 人物头像与 logo 卡片（`logo-ref/image(20261023-185452).png`） | 人物卡片的圆形照片、明确缺失头像、公司小 logo 与 profile 图标行、职称弱化、统一圆角和间距；不是授权制作假人像 |
| V10 详情与 Activity 双栏（`ref1/image(1).png`） | 详情与 activity 双栏、顶部身份/公司/学校、状态与动作行、页签、联系字段、时间线卡片及真实事件来源 |
| V11 Experience 详情（`ref2/image(2).png`） | Experience 的 logo 列、职位/公司/地点层级、右对齐日期与时长、Read more、底部操作区与清晰留白 |
| V12 Profile 经历与教育（`ref3/image(3).png`） | Profile 的头部/头像/外链、联系信息卡、操作按钮、下划线页签、工作与教育分组、经历 logo 和日期对齐 |

- [ ] 五页共用一致的侧栏、当前页高亮、标题字号、字体权重、色彩、圆角、细边框、卡片 padding、图标尺寸、hover/focus/selected 状态；参考中的紫色强调应与现有品牌协调，不随意重新设计整体布局。
- [ ] 桌面宽度下核对侧栏宽度、列表/详情比例、drawer 宽度、内容最大宽度、行高、时间线间隔和图表密度；滚动区域与固定头部/操作区正确，不遮内容。
- [ ] 移动端保留相同信息优先级：侧栏可收起，列表到详情有明确返回路径，drawer 不越界，表格/日历能有控制地横向查看，按钮可触达；不能靠缩小整张桌面页完成适配。
- [ ] 提供**真实浏览器截图**，逐页将实现与对应参考并排对照；至少覆盖桌面 `1440×900` 和移动端 `390×844`，并记录实际 viewport、route、commit 和环境。桌面须另按参考图有效内容区比例核对，不用设备尺寸差异掩盖布局偏差。
- [ ] 截图覆盖 Contacts 列表及详情、Inbox 未选中/已选中/展开历史/打开 Profile、Sequence、Interview 空/有事件、Overview；只用脱敏真实数据或明确隔离的测试数据，勿对外分发原始候选人 PII。
- [ ] 同时验收真实交互：筛选、搜索、排序、切换候选人、展开/收起、返回、外链、页签、日历导航、时区、键盘焦点、Escape 关闭及 drawer 焦点管理。静态截图或 build 成功不能证明交互通过。
- [ ] 加载、空、缺字段、错误、未授权、断线、同步过期和部分成功状态有设计；无截断关键信息、重叠、越界、不可读小字或错误图片。

## 跨页面端到端验收

- [ ] **旧 CRM → Contacts → Detail**：选择一个已有 role，确认无重复 role/contact；列表和详情的身份、资料、公司/学校、technical criteria 证据和 activity 一致。
- [ ] **Contacts → Sequence → Instantly → Inbox**：同一 contact-role 的准确 campaign、membership、step、消息、thread 可往返；另一个同名 contact 或同一 contact 的其他 role 不串线。
- [ ] **Inbox → Interview**：选定原线程，查看完整 slots，切换时区及跨 DST 日期，生成包含所有关联的待审批方案；未获批准无 provider 写入、邀请或邮件。
- [ ] **批准 → Booking → 原线程确认**：用隔离测试验证状态机、冲突复查、幂等及故障重试；真实 provider 流程只有另获授权后才执行，并凭 event 和 message 的读回证据验收。
- [ ] **Interview → Overview → 各页回查**：预约/改期/取消及邮件结果准确反映在五页；未读数、回复数、预约数和 activity 口径一致，下钻返回同一记录。
- [ ] 覆盖刷新、深链接、浏览器返回、跨账号权限、缺外部 ID、多 role、多 campaign、多 thread、重复 webhook、provider 断连、分页和空结果；测试不得向真实候选人发送测试消息。

## 证据与连接依赖

| 类别 | 当前可作为依据的内容 | 验收还需要的证据 |
| --- | --- | --- |
| 已有视觉参考 | 本文件列明的 12 张截图 | 实现后的真实浏览器并排截图及交互记录；参考图不是已实现证据 |
| 既有 CRM 与当前代码 | 本清单未审计代码或数据库，不能断言已完成 | 原 role/contact ID、可复现的读回、字段映射、权限测试与迁移/去重验证 |
| Instantly 与 email | 用户要求关联；本清单不证明已连接 | 已授权连接、scope、真实 campaign/lead/thread/message 读回、同步及错误证据；无连接时明确标注待 provider |
| Calendar 与 booking | 用户要求 timeblock；本清单不证明能写入 | 日历读取及忙闲能力、IANA timezone、写权限边界、获授权后的 event/消息读回；写入权限缺失不影响先交付只读及待审批 UI |
| CI 和线上 | 本清单没有运行或发布结果 | 对应 commit 的测试报告、浏览器证据、环境与部署记录；CI 通过不等于线上验收 |

测试 fixtures 必须明确隔离、可重置，不能混入真实业务页面或冒充真实历史。未具备 provider 时，可证明本地功能和 UI 已测试，但集成与线上验收仍保持待验证；不得以“接口预留”宣称完整打通。

## 授权与最终交付门槛

- [ ] **当前没有授权执行真实 email 发送、campaign 启动、calendar 预约/改期/取消或同线程确认邮件。** 本清单要求把这些流程做完整，不代表现在可以执行。
- [ ] 新建外部资源、增加 provider 权限、连接新账号、购买/升级/付费 enrichment、产生额外成本、生产迁移及生产 rollout 均需单独确认；现有授权不足时明确记录阻塞，不以自动重试绕过。
- [ ] 参考截图上的 Send Email、Unlock、Upgrade、New sequence 等文字只是 UI 参考，不构成发送、收费、解锁个人资料或新增商业功能的授权。
- [ ] 最终交付附五页功能矩阵、字段与关联契约、视觉并排验收、E2E 报告、provider 能力/权限清单和未完成项；只有对应证据齐全的项目才勾选通过，所有未授权的 live 验证单列，不隐藏为“已完成”。
- [ ] 将交付返回**原交接会话进行独立审查**，附精确 PR 链接及 commit SHA、实际执行的命令和结果、失败项、未运行项、对应浏览器证据和阻塞。审查方复核功能、UI、数据安全及本清单，不以实施方自报完成代替独立验收。
- [ ] 列明启用前提：现有 provider 能力与已批准 scope、必要配置、数据/迁移检查、回滚条件、审批和未完成的 live 验证。独立审查或 CI 通过**不自动授权 merge、deploy、生产启用或对外发送**；这些动作按各自明确授权执行。
