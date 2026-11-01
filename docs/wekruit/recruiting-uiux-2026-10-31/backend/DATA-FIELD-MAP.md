> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# 字段、内容与关联补齐清单

本清单配合 [后端变更方案](BACKEND-CHANGE-PROPOSAL.md)，依据同一 [主线快照](baseline.json)。不是生产数据库已完成迁移的报告。

## 先复用已经存在的实现

主线已有 [PersonAvatar / ProfileImage](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/apps/web/src/pages/recruiting/ProfileImage.tsx)、[CompanyLogo](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/apps/web/src/pages/recruiting/CompanyLogo.tsx)、[profileAssets 字段提取](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/apps/web/src/pages/recruiting/profileAssets.ts)、[CandidateDirectory](https://github.com/WeKruit/rakazo/blob/55fadc80c7c6105dfd2e10fdfe7c76ac29f0d17d/apps/web/src/pages/recruiting/CandidateDirectory.tsx)。已有公司网站/logo批量查询与 `OrganizationLogo` 缓存；不得再写第二套头像、logo组件或组织查询服务。

但本轮打开的 stage 全局 Contacts 首屏只有两张 WeKruit 品牌图片，联系人行是 LinkedIn 文字链接，未渲染候选人头像和公司/学校图标。[当前页面实例（原始证据未公开）](../PRIVATE-EVIDENCE.md)、[截图（原始证据未公开）](../PRIVATE-EVIDENCE.md)。因此“源码已有组件”和“这个页面已显示完整”是两件事；实际接线路径/部署版本仍需核对。

## 数据合同与补齐动作

| UI 内容 | 已有存储或字段 | 确认到的缺口/边界 | 最短补齐方式 | 完成检查 |
|---|---|---|---|---|
| 候选人头像 | SavedProfile.profile.profileImageUrl；报告 Profile photo/image/avatar URL；来源 Artifact | PersonAvatar已支持图片；当前全局Contacts未显示；不是每条结果都有头像 | 优先投影已保存头像并接PersonAvatar；检查早期已保存结果能否通过已有fill/keepSearchHistory补回，无需重新付费查同一资料 | 同一候选人在列表和详情同图；刷新不丢；不串人 |
| 当前公司logo | 报告Company logo URL；结构化经历company_logo_url；OrganizationLogo | 模型与组件已有；文字搜索行转结构化时明确company_logo_url=null | 保留来源实际返回URL；复用CompanyLogo与组织缓存；组织对应关系核对后再显示 | 公司名称、网站、图标属于同一组织 |
| 历任公司logo | 结构化experience每项company_logo_url/company_linkedin_url | 不能把当前公司logo套给所有经历 | 每条经历独立传组织媒体；已有ProfileTimeline复用 | 多段经历每段logo对齐、日期与标题不乱 |
| 学校logo | school_logo_url、报告School/University logo URL、组织缓存 | 文本教育解析可无URL；不能根据学校名拼出未经证实的资源地址 | 保留已返回结构化学校媒体；通过已有组织服务补可确认logo | 每段教育对应正确学校 |
| LinkedIn图标与个人链接 | 个人linkedinUrl、已有报告/CRM链接；静态UI资源 | 图标不应是来自候选人的“数据字段”；当前页面只有文字链接 | 用现有静态品牌资源呈现15/16px图标入口，链接仍用个人记录URL | 点A的图标只能打开A的资料；有可访问名称；不触发邮件 |
| Email/Phone/GitHub/个人站点 | Correspondence.contacts、CRM contact email/phone、报告来源字段 | 单行Profile按钮与真实可用联系资料不能混淆；未返回不代表可联系 | 投影已保存/当前已核实的字段与来源；区分展示链接和发送动作 | 值正确、点击行为正确、作用域正确 |
| 工作/教育详细内容 | SavedProfile JSON、保留的source report、结构化timeline | 摘要headline不是完整履历；当前字符串可能只是抓取片段 | 复用已有结构化投影；已保存原始内容优先复用，缺什么补什么，不清空已有完整资料 | 职位/公司/起止日期/学位/学校逐项保留；不把整段抓取文案塞Current role |
| Worth Talking | match.score/rank/tier；source/result identity | 已有数字不证明跨结果可比；现有跨源行只带分数可能不足以判断口径 | 展示排序复用原分；接口保留明确result/source关联；标签阈值待确定，不新增评估器 | 排名稳定、缺分独立、计数与查询同口径 |
| 人工Shortlist | RecruitingCandidate roleId+candidateKey，shortlisted/At/revision | 全局联系人不能只有一个覆盖所有职位的收藏位 | 每次写入明确目标role，复用现有操作并返回新revision | 同一人A职位入选不改B职位 |
| 独立Sequence草稿 | 目前内容Artifact格式与provider campaign观察 | OutreachSequence只是内容Artifact；现有原生draft campaign已支持0收件人 | 直接编辑现有原生draft campaign；不建Sequence表、不复制步骤/发送窗口状态 | 保存/重开/修改/发布与回读完整 |
| Inbox阅读状态 | provider unread只是观测 | 缺应用用户自己的已读持久状态 | 用户×space×来源邮件线程lastReadAt游标 | 跨刷新一致、不串账户、不改历史正文 |
| 面试表单内容 | 原生plan已有candidate/interviewer/单calendar slot；回执已有booking与confirmation | 多时段属于提议邮件；Cal.com地点由event type决定，Google支持location | 保持单时段booking；复用已有来宾、Google description/location与Cal.com预约类型能力 | 来宾/时间/时区/地点/notes与实际邀请内容一致 |
| Analytics | campaign.stats(sent/opened/replied)、lead观察、Shortlist时间 | clicked/bounced、时间桶、去重分母和完整覆盖不足以从3个总数推出来 | 接真实来源字段/事件，授权范围内按时间与职位聚合 | 每个数字能下钻，unknown不填0 |

## 既有媒体实现的实际约束

- `profileAssets`已经识别头像/公司/学校媒体字段，并支持自身已保存的data:image；`profileImageUrl`筛选允许的显式HTTPS地址。不能为“图片不显示”直接绕开URL验证。
- `ProfileImage`已处理图片裁切、lazy loading、加载失败与既有占位；本次复用它，不新增另一套失效处理。
- `CompanyLogo`已有组织网站批量查询、缓存与站点图标读取；接线前核对真实组织关系，不能拿竞品的logo.dev调用参数当成我们的授权配置。
- `recruiting-profiles`已保留结构化工作/教育媒体；`factsFromSearchRow`由文字履历构造数据时，company/school logo为空是明确现状。需查看原始已存结果是否含图，再决定补投影或做新的查询。

## 数据补齐执行顺序

1. 只读统计当前授权范围内有头像/经历/教育/组织logo的记录数量、原始source有值但投影为空的数量，保留样例与版本。
2. 先修同一字段的保存→读取→展示路径；用已有保存结果补齐遗漏。不要一开始重新调用LLM/JEV或全量重新抓取。
3. 对真实缺失的媒体/资料，复用现有Profile/CompanyLogo工具与授权；只处理选定范围，保留来源、获取时间和持久记录。
4. 对Sequence草稿、用户阅读状态等真正新业务状态，才做schema变更与迁移；内容展示缺口不自动变成新表。
5. 核对原有记录数、身份关联、附件与职位关系，再按同一候选人列表→详情→Shortlist→Sequence→Inbox→Interview走完整链。

本轮只完成代码与当前页面的证据核对和方案，未执行客户数据回填、迁移或新付费查询。
