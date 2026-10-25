# Grok UI、方法说明与用户模板

已通过 Library 文本接口完整读取六份源所有者脱敏报告/索引（v0）。原始 UI 是源所有者通过受支持原生界面观察，本 checkout 没有查看像素、唤醒 Computer 或读取原始候选文件。下载 helper 失败后没有重试；本地可读文本副本不等于原始字节下载。

## 实际 UI 观察（2026-10-25）

真实会话标题为 **Connect frontend to Grok agent**；私有 thread/project ID 与本机路径不公开。最新可读会话内容是云端开发交接，不是 Autumn 搜索本身。

| UI 显示时间 | 源所有者看到的内容 | 证据边界 |
| --- | --- | --- |
| 11:43:57 AM | 用户提交 LT044 技术产品经理 JD | 时间区未知，不转换 UTC |
| 11:44:21 AM | Sourcer 描述半导体视觉芯片、Irvine、产品定义/路线图、EE、5+；普通话和南加州为优先 | 这是当轮方向，不能泛化为全部岗位硬规则 |
| 11:56:14 AM | 自述首轮 11 人、5A/6B，并承认多人过于资深、地点偏湾区、resume unknown | agent 自述，不是独立资格核验；未拿到该 run receipt |
| 11:58:50–11:59:09 AM | 反馈后改为 3–8 年、Irvine → Orange County → Southern California；展示“第一批 prompt”回顾 | 限这个岗位，不是 Dyna |
| 12:00:45 PM | 通用模板以 role/job title 开始，解释 A/B 和约十人校准后扩量 | 可见开头与父线程提供的用户模板一致；AX 长文本截断，未逐字核验末尾 |
| 12:05:55 PM | 自述新版仍在跑 | 缺 task/body/full prompt/raw output，不能称成功执行案例 |

Computer 显示 asleep / Wake，未唤醒。近期 CSV 附件的可见列表未给出此 LT044 的执行输出；没有点击候选 profile。

## 用户模板与当前实现

必须分开：
1. 用户提供的通用模板及其适用角色/反馈；
2. Grok UI 中可见的模板与 draft/self-report 状态；
3. #115 在 `5c210b626c22ab2f1ecd34836c216b52e197bcd6` 合入的 [Rakazo 模板](https://github.com/WeKruit/rakazo/blob/5c210b626c22ab2f1ecd34836c216b52e197bcd6/packages/core/src/recruiting-defaults.ts#L19)。

当前代码模板涵盖 title/adjacent title、公司类型、2–4 项核心工作引文、年限范围、地点优先级、语言证据、排除项、A/B 和逐人输出。它是可复核的实现版本，不冒称完整逐字转录用户模板或 Grok 已执行 HTTP body。六个月、语言、学历和年限必须保留各自来源/强度；Dyna G6/G7/G14 自身也有不同规则，见 [并列比较](dyna-offline-comparison.md)。

## Grok 的方法自述与 dry-run

源所有者读取的历史材料中，Sourcer 自述使用 REST wrapper `autumn_search.py`，以 `POST /task/start` 提交 `task.brief/rules/output`、`clarify:false`、`version:scout`；同条件扩量调用 continue，条件变更通常重写 prompt/new task。**本次没有打开或执行该远端脚本，也没有据自述确认实际每次 HTTP 行为。**

另一个 Crew 样例明确是依据旧运行参数用 `--dry-run` 重建并匿名化的请求，不是 live receipt；长 brief 本身还被截断。样例的十人、Bay Area、8+ 和十五列不能作为 Dyna 的输入。去重代码、agent 复核、A 数变化同样属于来源自述，不能拿复核后的 A 数代表原 provider 质量。

## 缺少 Grok raw trace：最后有界检查与拒绝

源所有者检查一个 Sourcer 导出：645 entries，415 send-message、218 message、6 user-attachment、6 notice。未见独立 tool-call/tool-result 类型或顶层工具/任务/回执键。G6/G7 都是 send-message；消息封装 requestId 不能当 Autumn task ID。此结论只覆盖该导出，不证明整个服务没有内部日志。

2026-10-25 17:23 UTC 的最后定位报告覆盖了旧报告“无审批阻塞”的表述：
- 动作：Grok Bot 已打开 Search 输入框的 `setValue(..., 'batch06')`。
- 自动审批拒绝原因：输入可能执行/触发搜索，超出“不得运行搜索”的授权。
- 状态：**denied，已知未执行，未重试，已 Escape 关闭；不是 pending/uncertain。**
- 没有换入口绕过、唤醒 Computer 或新跑 Autumn。

本研究不继续该被拒动作。若日后需要更多既有 trace，只能在明确授权“仅检索历史消息/工具记录”或由所有者提供已有 request/result 文件之后再考虑；当前 PR 不需要等新搜索。

另一次会话读取因单个 oversized turn 超出工具容量而失败，属于容量错误而非权限拒绝。没有直接读私有 sessions 或伪造 cursor。上述失败不会升级聊天自述为真实请求证据。
