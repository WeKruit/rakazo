> **公开评审版本**：保留需求、交互、实测几何与样式；内容槽已匿名化。所有公开布局图均由 DOM 测量生成，**不是原始截图**。原始登录态截图、AX、媒体及完整历史静态证据单独保留，未公开。

# REA 6.8.0 静态证据补充

本报告为主 PRD 的补充证据，不是登录态 UI 观察的替代品。分析执行于本次调研，输入是 **2026-10-14 保存的 Juicebox 浏览器 JavaScript**；没有取得当前 Metix 打包代码，也没有在此子任务操作浏览器、发送请求、读取认证或运行目标应用代码。

## 工具与可复现性

- 官方来源： [morluto/rea](https://github.com/morluto/rea)；本地 npm 包 `rea-agents@6.8.0`。
- 执行 Node：`<LOCAL_PATH>`，版本 **v24.22.1**，满足 REA 6.8.0 的 Node 版本要求。系统默认 v24.3.0 不满足要求，本次没有使用它运行分析。
- 运行入口： [run-analysis.py（原始证据未公开）](../PRIVATE-EVIDENCE.md)，完整参数与输入 SHA-256 在 [metadata.json（原始证据未公开）](../PRIVATE-EVIDENCE.md)。证据输出不覆盖已有文件，因此重跑应改为新的 evidence_output 路径。
- CLI 执行成功：exit 0，44.72 秒；没有执行目标脚本。
- 完整导出： [juicebox-historical.evidence.json（原始证据未公开）](../PRIVATE-EVIDENCE.md)，81,065,712 字节；SHA-256 `2412ecf2cc585e5b4a02a43b7717199b03925a6f58b76f03f649c13088d83bf2`。
- 原始摘要 [summary.json（原始证据未公开）](../PRIVATE-EVIDENCE.md)；精简覆盖范围 [coverage.json（原始证据未公开）](../PRIVATE-EVIDENCE.md)；原始 stderr [stderr.log（原始证据未公开）](../PRIVATE-EVIDENCE.md)。
- 父证据 ID：`ev_d37e393790b7c308e2caf9ed8badc7528e06af778b720d3dc1140c556364ae33`。
- 摘要证据 ID：`ev_be89e81ee7569e26bba883eed4a2635fd2acccc3cf67f3a37b92e8cb4de52bcd`。

## 覆盖范围与正确解读

| 项目 | 本次实际结果 |
|---|---|
| 完整目录身份 | 152 个相关文件，根 SHA-256 `fef7a1dce1d7f18dfdbc9a90e76effac44c2b2438f33b7aff5430b747476244b` |
| 选择读取 | 5 个 JavaScript，1,061,612 字节 |
| 语法分析 | 5 个解析成功，0 解析失败，326,971 AST 节点 |
| 未选择文件 | 147 个，相关关系保持 unknown |
| application graph | partial |
| semantic graph | partial；节点/unknown 保留触顶 |
| 语义上限 | 全局 25,000 节点，单文件 5,000 节点；单文件 20,000 unknown |
| 源文件 examination | 2 complete、3 limited；这不是完整应用行为覆盖 |
| 当前网站一致性 | 未由本静态分析验证，须以主调研现场截图/交互证据为准 |

REA 的 `complete-within-view` 只说明摘要投影遍历完成，不意味着应用已完整逆向。保留 57,073 个语义 unknown，不能将未提取项说成不存在；静态路由候选不能证明可访问性、权限或运行调用。

## 能用于核对 PRD 的历史前端事实

以下均为保存脚本中直接存在的 UI 字符串、字段配置或语法。42 个精确位置和上下文见 [static-findings.json（原始证据未公开）](../PRIVATE-EVIDENCE.md)，带 source、行、列、UTF-8 字节范围、snippet 和 `runtime_called:false`。这些事实不自动等同于当前产品已显示的界面。

### Shortlist

来源：`0rklzc5x88wle.js`。

历史字段配置：`Full Name`、`Profiles`、`Review status`、`Status`、`Sequence`、`Added to ATS`、`Network`、`Owner`、`Date`、`Current Role`、`Organization`、`Education`、`Location`、`Tags`。

历史交互入口：`Display columns`、`Request review`、`Copy to Project`、`Change Status`、`Add Tag`、`Log Activity`；存在表格/看板相关代码、联系人按 status 读取的 hook，以及邀请 Hiring Manager、选择 Reviewer、附 Note、Review summary、`Add approved profiles to sequence` 的评审流程文案。

状态文案明确区分：

- `No shortlisted profiles in this project`：项目本身没有 Shortlist。
- `No profiles found for the selected filters`：筛选结果为空。
- `Error loading contacts` + `Retry`：读取失败。
- `Loading profiles...`：读取中。
- `Load More`：存在后续列表加载入口。

语法中 `updateShortlistedContact` 的结果先检查 `permissionDenied`，并且只在 `r?.ok` 后处理对应本地列表。这是历史源码的条件结构，不能称为本次权限 E2E 验证。

### Contacts

来源：`1duod40uh9pmp.js`。

历史表格配置：`Full Name`、`Profiles`、`Projects`、`Tags`、`Current Role`、`Organization`、`Education`、`Location`、`Date Created`、`Last Enrolled in Sequence`、`Last Enrolled by`、`Last Contacted`、`Last Replied`。

历史批量入口包括 `Add to Sequence`、`Import Contacts`、`Export`、`Shortlist in Project`；添加到项目调用共享 `updateShortlistedContact`。`Full Name` 可排序、可缩放，初始 width 160、maxWidth 300；这仅对本历史配置成立。

有 `e.length > 100` 的条件结构，但不能仅凭这一处推断所有批量操作上限都是 100。需要依对应 action 上下文及当前界面确认。

### Analytics

来源：`2onm9arq_iykc.js`。

历史 usage 表格字段：`Current Seat`、`Searches`、`Profiles Viewed`、`Shortlisted`、`Contacted`、`Replied`、`Interested`、`Exported`、`Contact Credits`；存在 Name/User 维度，以及 `Customize Columns`、`Show all`、`Hide all`、`Apply`、`Cancel`。

这说明历史实现有 usage 维度与可定制列；它不证明 outreach analytics 与 usage analytics 共用相同分母、时区、过滤或统计口径。PRD 必须分别描述当前现场观察到的两个视图。

### Sequence / enrollment 线索

来源：`2ucq44qjyp6yu.js`。

历史选择器文案 `Search sequences...`，并区分 `No sequences with a connected sender` 与 `No sequences found`。这是可用序列选择器中“存在序列但无已连接 sender”和“没有匹配序列”的不同空态线索；是否在当前 enrollment 表单出现由现场验证。

来源：`0u36gltmbazyi.js` 中存在 `Auto-enroll with fallback email after bounce` 设置文案。这只记录源码包含此项；**不要求在本次复刻里新增自动兜底业务逻辑**。是否属于本次明确范围，以及当前是否可见，须以主 PRD 的范围和现场证据裁定。

## 没有由本分析证明的内容

- Metix `Worth Talking` / `Strong Match` 的后端评分算法、阈值及校准方式。
- 当前 Metix Shortlist 的满数据态、未展示的 Interview 事件详情、发送/排程成功后的所有状态。
- 当前 Juicebox/Metix 的网络请求分母、状态真值来源、自动重试、速率限制、AI 生成策略、去重边界。
- 本地产品代码已支持这些字段或流程；本次没有修改产品代码。
- 未分析文件里的路由、控制流、按钮、业务能力不存在。

## 最小证据检查

运行 `python3 <LOCAL_PATH>`。检查版本、命令成功、父证据身份、选择范围、文件哈希、摘要覆盖范围及字符串字节位置；这是文件完整性检查，不是竞品业务 E2E 测试。
