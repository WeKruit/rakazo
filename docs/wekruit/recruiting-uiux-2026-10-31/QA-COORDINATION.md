# QA 协调反馈与实施边界

通过项目的 Claude App 会话询问了正在推进的线程能否并行，并收到了回复。以下是反馈摘要，不是生产状态验收，也不是外部动作授权。

## 可以独立推进（QA回复）

- ranking / Worth Talking：当前没有其他线程修改评分/标签；沿用现有Reviewer结果。
- Analytics口径与Sequence零收件人草稿：当前没有其他线程实施。
- Profile头像与logo展示细节：复用现有PersonAvatar/CompanyLogo且不修改组件本身，可以独立推进。
- QA表示Sequence、应用未读状态和排期字段没有其他已完成未合并实现；实施前仍需核对最新分支。

## 必须对齐的现有工作

| 领域 | QA报告的当前负责人/工作 | 本工作边界 |
|---|---|---|
| Contacts同步/读取/排序 | “Build filterable global contacts page”线程正在重新同步及准备增量同步 | 等其合并或先明确文件接口；不并行覆盖AllContacts或相关查询 |
| shell/导航/三栏标题 | #743统一64px header及分隔线；通知/叠加面板由“Check Google Calendar and Gmail integrations”线程推进 | 使用最新stage；精简导航复用shell，不重写pane机制 |
| 全局候选人卡片/Profile投影 | “Launch global agent with role sub-agents”的#748包含深链、问题卡和候选人卡片 | 卡片格式、Profile投影与其统一，避免第二套展示合同 |
| 创建岗位/首问 | #741/#742已调整role identity与首问streaming | 不改这一轮创建岗位服务 |
| schema/事件格式 | QA报告现有版本已到9 | 任何版本变化先核对当前代码与负责人，不能直接使用历史文档中的下一版本号 |

## QA concern

**阻塞实施的约束**：只走stage评审与隔离staging验收；生产发布由既有统一流程管理。新schema不能破坏现有数据读取，不能在真实用户对话构造测试消息，产品UI不暴露供应商名称。

QA提到迁移兼容性和部署方式。这些是协调意见，**本PR未采纳任何具体迁移、双写、兼容层或部署命令**。用户要求不做兼容补丁方案，实施时须提出最短且数据完整的整体变更与验证，不能将QA反馈当作新增架构或生产执行授权。

**非阻塞建议**：实现按页面/能力拆小PR，遵循现有UI guidelines；基于最新stage同步共享shell变更。

**建议验收**：保存→投影→读取→展示完整链路；1440与移动端两种布局；每个实现PR分别自测，最后汇总测试清单。具体测试身份与环境信息不写入公开PR。

## 下一步

本PR仍只有规格与证据。可以据此拆出独立实现PR，但必须保留上述Contacts、shell、全局卡片接口的交接边界。未知provider操作、评分映射、阅读状态粒度与统计口径不因“可以并行”而被视为已确定。
