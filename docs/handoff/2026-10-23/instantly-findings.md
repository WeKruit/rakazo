# Instantly 集成核查 · 2026-10-23 12:50 UTC

来源：Instantly 官方 v2 OpenAPI 规范与开发者文档、帮助中心、三个公开 Instantly MCP 源码（bcharleson/Instantly-MCP、kristianvast/instantly-mcp、beschenbach/instantly-mcp-server），以及我们 `packages/adapters/src/mcp-connector.ts`、`instantly-reply.ts`、`apps/api/src/recruiting.ts`。没有发送任何邮件，没有动线上。标「未验证」的是没拿真实账号点过的。

## 一、结论

**为什么 admin1 那封信看不到（按可能性排序）**
1. 最可能：admin1@wekruit.com 不是任何 campaign 的 lead，而工作区没开「Save non-Instantly emails in Unibox」。官方帮助文档：非 lead 的来信默认不保存，开了这个设置才进 Unibox 的 Others。设置没开 = Instantly 根本没存这封信 = 任何 API、任何 MCP 都读不到。
2. 截图里左侧 Status 选了「Lead」。「Lead」是 lead 的兴趣状态，非 lead 邮件没有这个状态，选中它就看不到（推断，UI 未验证）。另外非 lead 邮件在 Others 不在 Focused。
3. 检测延迟 10–15 分钟（早已超过，可能性低）。
4. 邮箱本身暂停/报错或邮件被挪走（未验证）。

**「别人的 MCP 为什么能」：其实也不能。** 三个公开 MCP 全都只是把参数透传给同一个 `GET /api/v2/emails` 和 `POST /api/v2/emails/reply`，没有任何别的端点能读到 Instantly 没保存的信。GitHub 上没有叫 grokbot 的 Instantly MCP；验收线程查过 Grok 导出里没有 Instantly 收件/回复调用；旧 CRM 按 campaign→lead→email 镜像，我们之前成功读到的那封 1,742 字邮件就是 campaign lead 的回复。结论：这是测试设计问题（用了非 lead 发件人），不是「我们接入做错了」。

**我们现在能做什么**
- 读：远端官方 MCP 的 list_emails / get_email / reply_to_email；本地直连 REST 三个工具：按 lead 查、按线程查、按邮箱+时间窗查（新，PR #8 已合 main 待部署）。三个都固定 `mode=emode_all`（Focused + Others 都查），比公开 MCP 覆盖面更宽。
- 回：`POST /api/v2/emails/reply`，只能回复 Instantly 里已存在的邮件。
- 我们比公开 MCP 严格的地方（正确，不放松）：逐条校验 eaccount / lead / thread_id / organization_id；reply 强制显式 to；只接受 API key 并前后重新鉴权。公开 MCP 没有任何作用域校验。

**我们现在不能做什么（正在补，分支 codex/wl-g-instantly-tools）**
- 建 campaign、加 lead、查/改 lead、启动/暂停 campaign：远端 MCP 的允许列表和我们的本地工具都没有。
- 一个岗位一个 campaign、shortlist 候选 = lead 的映射。
- Inbox 投影之前丢掉无 campaign_id 的邮件（已修，在 main 待部署）；按邮箱查的结果还没接入 Inbox 投影。

**「收到回复自动停跟进」用什么实现**
- Instantly v2 没有按单个 lead 停/暂停的端点（lead.status 只读；update-interest-status 是后台任务，文档没承诺会停序列；campaigns/{id}/pause 停的是整个 campaign）。
- 原生机制是 campaign 设置 `stop_on_reply`（还有 stop_on_auto_reply、stop_for_company）。所以：建 campaign 时必须设 `stop_on_reply: true`，复用时若为 false 则 PATCH 打开。已实现：读邮件时检查该 campaign 的 stop_on_reply，关着就在结果里给出警告（分支 codex/wl-g-stop-on-reply，已推送）。
- 兜底可选：`POST /api/v2/leads/update-interest-status`（写操作，需审批）。

## 二、操作步骤

**方案 1（零成本，先做）**：Unibox 左侧 Status 选 All，切到 Others，再搜 admin1@wekruit.com。出现 = 设置早就开着，是我们按 lead 查的问题（已修）；没出现 = 转方案 2。

**方案 2（只对之后的邮件生效）**：头像 → Settings → Preferences（app.instantly.ai/app/settings/preferences）→ 打开「Save non-Instantly emails in Unibox」→ Save。再从 admin1 发一封新信，等 10–15 分钟。预期进 Others；API 用 eaccount + 时间窗能查到（campaign_id 为 null、ue_type=2）。副作用：这个邮箱所有非 lead 来信都会进 Unibox。04:21 那封大概率回不来（未验证）。

**方案 3（推荐的真正闭环，也是产品形态）**：内部 campaign + admin1 为唯一 lead。
1. 建 campaign：只放发件账号 noah@perfectwekruit.org，`stop_on_reply=true`，序列 ≥2 步（第 2 步隔 1 天）。
2. 加 lead：`POST /api/v2/leads`（email=admin1@wekruit.com, campaign=X）。
3. 启动：`POST /api/v2/campaigns/{X}/activate`。预期 `GET /emails?campaign_id=X` 出现 1 封 ue_type=1 的发出邮件。——真实发信，需要用户在确认卡上点同意。
4. 用 admin1 的 Gmail 回复，等 10–15 分钟。预期：按 lead 查返回 2 条（ue_type 1 和 2，同 thread_id）；按 campaign 查同样 2 条；Inbox 显示该线程；UI 里 Status=Lead 能看到。
5. 回复：`POST /api/v2/emails/reply`（reply_to_uuid=回信 id，eaccount=noah@…）。预期 admin1 同线程收到；再 list 多一条 ue_type=3。
6. 验证停跟进：第 2 步时间过后 `GET /emails?campaign_id=X&email_type=sent` 不应出现第 2 步邮件。

## 三、代码差距（按改动从小到大）
1. 按 lead 查为空时提示「可能不是 lead，改用按邮箱查并确认设置已开」（一行文案）。
2. 暴露 `email_type`（received/sent/manual）过滤（约 3 行）。
3. `mode` 保持固定 emode_all，不动。
4. 按邮箱查的结果接入 Inbox 投影（唯一非小改动；若产品定义只有 campaign 线程算候选人往来则可不做）。
5. 建 campaign / 加 lead / 查改 lead / 启停 campaign 的工具 + 岗位↔campaign 映射（正在做）。

## 四、引用
- 官方：https://api.instantly.ai/openapi/api_v2.json ；developer.instantly.ai 的 email list/get/reply、lead create / bulk / update-interest-status、campaign create / patch / activate / pause 页面。
- 帮助中心：https://help.instantly.ai/en/articles/6248525-why-are-replies-not-detected-in-unibox
- 公开 MCP：https://github.com/bcharleson/Instantly-MCP ；https://github.com/kristianvast/instantly-mcp ；https://github.com/beschenbach/instantly-mcp-server
