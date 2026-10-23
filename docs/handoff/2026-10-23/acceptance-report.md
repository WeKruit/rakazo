# WeKruit Headhunter 产品验收报告（2026-10-23）

测试人：独立验收（Claude，用户 Mac 上运行）
对象：线上产品 `https://wekruit-livekit-agents--wekruit-recruiting-recruiting.us-east.modal.direct`，计划 `docs/wekruit/PLAN.md`「当前交付状态（2026-10-22）」
时间窗：2026-10-23 04:45–04:55 UTC

## 最终确认（2026-10-23 14:47 UTC，最终版本 604d0ce3 = Modal v119）

| 项 | 结果 | 证据 |
|---|---|---|
| 发布安全 | **通过** | 迁移 112；候选 1,016、记忆文档 23 不变；未结束外部操作原有的 7/2/1/1 都还在，只多了 1 个待确认的 activate；没有真实外发；工具事件倒序 0/14；13/14 条用量记录有成本 |
| 统一候选列表（#38） | **通过** | Data Infra 和 Simulation 的 Results 都换成了新的统一表格（Name / Current role / Location / Activity / Fit / Shortlist·Email draft），不再有 Cards/Table 切换 |
| Data Infra 按分数排序 | **通过** | 默认 Match score：74、74、71、66、64…，共 134 人 |
| Simulation 按分数排序 | **失败** | 默认仍是 Name：45、35、45、65、82…；Fit 列里已经能看到分数。数据库只读核查：3 个页面（最新一页是 10-21 00:44）的 16 行都有 matchFields，分数也在，但存的是 `{"match_score":{"value":62,"source_id":…},"rank":{"value":8,…}}` 这种对象，读取代码没取出 `.value`，所以返回的分数是空。「最新一页没有分数」的猜测不成立 |
| 测试岗位 Sequence 卡片 | **通过** | 「Dyna Data Infra — Rakazo 内部测试 · Draft · admin1@wekruit.com · Active」 |
| **Instantly 第 5 步确认卡** | **通过（目标正确），待用户确认** | 14:42:37 effect `cmvl2x4zr001z1ifqnpge2idh` = activate_campaign `d4b1bc78`（intended）；卡片 `cmvl2x5o000201ifq3x0cqm2b` 待确认；14:44 部署重启后卡片和 run 都还在（恢复通过），没有重复的 effect |
| 确认卡文案 | 失败（体验） | 卡片只显示「Review before Instantly instantly activate campaign」和 campaign_id，没有 campaign 名称、收件人和邮件内容 |
| 503 | **失败** | v118 部署后采样 198/1,530 返回 503；最终版本部署时大约 2–4 分钟整站「no upstreams available」 |
| 第 5 步：启动并发出第一封 | **通过** | 14:54:34 用户点 Allow once → activate_campaign completed，只执行一次，campaign 状态 1（运行中）；15:02:18 admin1 收到 1 封（noah@perfectwekruit.org，「Rakazo 内部测试」，进收件箱，不在垃圾箱）；产品这边没有其他外发 |
| 第 6 步：admin1 在原线程回复 | **通过** | Gmail 线程 1a16948ccc471f3d，15:02:35 admin1 回复「收到 谢谢」 |
| 第 7 步：产品读回回复 | **通过** | Instantly 15:02:58 收录；产品用 list_emails（received, campaign d4b1bc78）→ get_email → get_thread_history 读到正文「收到 谢谢」和引用的原文 |
| 第 9 步：收到回复后停止跟进 | **通过** | lead admin1 的状态从 1 变成 3（已完成），campaign 的 stop_on_reply 已开，不会再有后续邮件 |
| 第 8 步：产品 Inbox 显示回复 | **失败** | 15:06 测试岗位的 Inbox 显示「Not checked yet」，Agent 读到的回复没有出现在页面上；另外在这个岗位打开 ?view=sequence 会跳到 Shortlist 页面并一直 Loading |
| 小问题 | 观察 | search_contact_emails 查 admin1 报错「No stored email for admin1@wekruit.com」（不是 CRM 联系人，不影响闭环） |

## 最终状态（2026-10-23 14:40 UTC，线上 v117）

| 项 | 状态 | 关键证据 |
|---|---|---|
| 发布安全（迁移、数据、未结束外部操作、外发） | **通过**（v106–v116 每次部署） | 迁移 112；候选 1,016 一直不变；executing 7 / intended 2 / approved 1 / uncertain 1 原样；外发 0 |
| Data Infra 候选列表（134 人，按分数排，逐项 Match/Unclear） | **通过**（v111 起） | listCandidates 200 |
| Simulation 默认按分数排序 | **失败** | sortAvailability 全是 false，每个候选的 match.score 为空，分数只在 latestSource.report 里 |
| 新的统一候选列表（#38） | **未见** | cd033406 上 Simulation 仍是旧样式（Cards/Table 切换） |
| Contacts 610 人 + Load more、Inbox 全文、Interview、右侧面板 | **通过** | — |
| Sequence 统计数 | **通过** | 32 / 262 / 316 = 610 |
| 内部测试岗位 Sequence 显示 campaign | **失败**（v114 时） | 只显示「No outreach files loaded」；后台映射正确 |
| 动作顺序 / 进度显示 / 成本字段 | **通过** | 倒序 0；有步骤列表和「Worked for …」；costUsd 大部分有值 |
| 禁止退回电脑操作 | **通过** | 0 次电脑、浏览器、接管或索要密码类调用 |
| 连接卡（HubSpot） | **通过**（v115/v116） | 弹出「Connect HubSpot」卡片，有 Connect / Not now |
| 按名字找人（Sumeet） | **部分** | 在岗位对话里能找到邮箱，但答案漏掉 10-22 的最新来信；在不带岗位的对话里因为 p_org 传错仍是 0 条 |
| 聊天面板关闭时输入丢失 | **失败（可能只影响自动化）** | 隐藏的输入框仍在可访问性树里，按 Enter 后文字消失、没有提示 |
| **Instantly 邮件闭环** | **失败（卡在第 5 步）** | 用户发「发第一封」后，Outreach 拒绝发送：「没有可用于展示并取得这封邮件一次性批准的原生审批流程」；没有确认卡、没有启动 campaign。第 1–4 步通过（只有一个 campaign d4b1bc78，lead 只有 admin1，回复即停已开） |
| 503 | **失败** | v115/v116 部署后的 3 分钟采样里 45%–55% 返回 503，部署间隔约 5 分钟，采样和下一次部署重叠；冻结期内也出现过 503 |
| 第二个真实用户 / 隔离 | **阻塞** | 产品库仍只有 1 个真人 |
| 浏览器验收工具 | 中断 | 14:36 起 Chrome 扩展断开，v117 的画面验收没做完 |

## J 线权威看板（持续更新；最新 2026-10-23 05:12 UTC）

状态只用：通过 / 部分 / 失败 / 阻塞 / 未发布。每次核心线宣布部署后，按第 6 节和 §十一 重跑并更新本表。

| 检查 | 当前状态 | 最新证据 | 下次复测触发 |
|---|---|---|---|
| 线上版本 | 未变 | Modal v105（04:19 UTC）、容器 `ta-01M5KFSC…`、bundle `index-DshSOFBM.js`、/ready 200；main `356987cf` **尚未部署** | 核心线宣布 main 部署 |
| 内部邮件闭环 admin1 ↔ noah@perfectwekruit.org | 阻塞 | admin1 Gmail：种子邮件 04:21:29 只发过 1 次，线程仍是 1 封，无回复；产品库 04:37 后无新的邮件 effect，3 次联系人查询都是 0 | 开发者在 Noah 的 Instantly 工作区核实「非 lead 邮件收录」后；**不重发种子** |
| 动作显示顺序（B7） | 失败 | 49% 倒序（第 2.7 节） | FIFO/reducer 修复部署后，同一 SQL 目标为 0 |
| 503 / 冷启动（B8） | 部分 | 1 次 503 后 2,400 次请求全部 200 | 每次部署后立即采样 5 分钟 |
| 品牌残留（B4） | 部分 | 4 句 Rakazo | 下次部署后重新扫描 bundle |
| 统一岗位 / PR5 | 未发布 | PR5 冲突中 | PR5 合并并部署 |
| 双用户隔离 | 阻塞 | 产品库只有 1 个真人账号 | 出现真实新用户后 |
| 受控重启恢复 | 未测 | 需要部署窗口 | 下一次部署（recreate 本身就是重启） |
| 附件 | 截图通过；CSV 未实测；XLSX 不支持 | 第 3 节 | 用户上传占位 CSV 后 |
| Could not load candidates | 代码已修，未部署 | 核心线定位：候选页 / 研究绑定读取在 15 秒可重复读事务里扫全 Space 事件日志，占满 4 连接池（2026-10-22 23:23Z 出现 500）；修复是加 runId 过滤，在分支 `codex/wl-d-reads` | 部署后在 Data Infra 连续打开候选 5 次、两个标签页同时打开，看是否 500；board 的 toolErrors 里不应再有 "expired transaction" |
| main 发布 | 等待 | 核心线预计 06:30 UTC 开合并 PR，用户合并并授权后部署 | 收到部署时间后立即跑 postdeploy |

### 邮件闭环复查记录（只读，不重发）

| 时间 UTC | admin1 Gmail 种子线程 | 产品库邮件 effect | 新 run |
|---|---|---|---|
| 05:10 | 1 封（04:21:29 发出），无回复 | 最后 04:37，联系人查询 3 次均 0 | 无 |
| 05:32 / 05:52 / 06:12 | — | 无变化 | 无 |
| 06:40 | 仍 1 封，无回复 | 无变化 | 无 |

结论不变：阻塞在 Instantly 侧收录，需要开发者在 Noah 的工作区核实。线上仍是 v105（06:40 复核）。

### v106 部署后自动检查（12:46 UTC，只读）

Modal v106 于 12:44 UTC 部署，新容器 `ta-01M5MCP56SXHFGSVMHNG0FS86R`，bundle `index-BsS3QPuf.js`，/health 与 /ready 均 200。

| 检查 | 结果 | 证据 |
|---|---|---|
| A 迁移 | 通过 | 110 份，`20261019000000_recruiting_candidate_consideration` 已应用，新列存在 |
| A 数据保留 | 通过 | messages 1,220 / runs 485 / effects 2,940 / memdocs 23 / candidates 1,016 / roles 32，与部署前完全一致 |
| A 未结束的外部操作 | 通过 | executing 7 / intended 2 / approved 1 / uncertain 1 原样；pending 卡 10 张原样；没有重放，也没有外发 |
| B4 品牌 | **通过（已修）** | 43 个 chunk 中 Rakazo 文案为 0；标题 WeKruit Headhunter |
| B8 503 | 通过（本次） | 部署后 3 分钟采样 1,530/1,530 返回 200 |
| B11 版本标识 | 仍失败 | 容器 GIT_SHA 依旧是 00f9b6bb，无法据此确认部署的是哪个 commit |
| C 动作顺序 / D 候选读取 / I 成本 | 待流量 | 部署后还没有新 run，需要一次真实对话才能测 |
| H 隔离 | 基线通过 | 仍只有 1 个真人；跨用户归属不一致 0 |
| 部署版本 | 已确认 | 发布线核实 v106 = main `b918a01b`（含前端 #6/#7/#9–#13）；以容器内 `/app/.wekruit-source-revision` 为准，Secret 里的 GIT_SHA 旧值不作数 |
| E 文案已上线 | 通过（bundle 层） | 线上 43 个 chunk 中找到「Criteria」「All candidates」「Return to WeKruit Headhunter」以及 Contacts/Sequence/Inbox/Interview 页签文案；这只证明代码已发布，不能代替画面验收 |

**E 线上逐屏（等用户同意用其 Chrome）：** 打开一个真实岗位，依次截图 Contacts / Sequence / Inbox / Interview 和 Results 表格的 Criteria 列，存到 `/mnt/project-files/e-workbench-screens/live-*.png`。headhunter-agent #57/#65 未合、CRM edge function 未部署，所以 #11 的新读法目前走回退路径，按回退行为判定。

### 线上真实浏览器验收（13:17–13:27 UTC，用户 Chrome，v107 → v108 c779d80b）

截图在 `full-product-plan/e-workbench-screens/live-*.jpg`。

| 项 | 结果 | 证据 |
|---|---|---|
| Results 表格 Criteria 列 | 通过 | 134 人，按 Match score 排序；逐项显示「✓ Match」「? Unclear」，来自 Autumn 原始规则值 |
| 候选详情（Autumn 匹配/缺口） | 通过 | Arunava Seal：分数 74、排名 1，6 项规则各自标注，长推荐语折叠在「Details」里（2.6 节由「未核验」改为通过） |
| Contacts | 通过（慢） | 610 人真实 CRM 联系人，包含邮箱、阶段、联系状态、外联状态；首次打开约 10–15 秒都显示 Loading |
| Sequence | 通过 | 真实外联状态：Replied 32 / Reached out 9 / Not contacted 9；「No stored campaign associations」如实显示为空 |
| Inbox（按岗位读全部邮件，#65 新读法） | 通过 | Sumeet Parekh 整个线程 5 封（发出和收到都有），正文和引用完整 |
| Interview | 通过 | 「No interviews in progress」如实显示为空；显示已保存的可用时间（America/Los_Angeles） |
| 右侧详情面板（#16） | 通过 | Contacts 点人后右侧打开，有 Emails / Profile / Interview 三个页签；按 Esc 关闭，列表不动 |
| 统一岗位列表 | 部分 | 左侧出现 CRM 岗位「MTS · Eragon」「Tech Lead · Eragon」，和 Agent 岗位在同一个列表里；Data Infra 只出现一次。页面标题在「SWE Data Infra」（CRM 名）和「Dyna Robotics — Software Engineer, Data Infra」（Agent 名）之间来回切换 |
| 品牌 | 通过 | 页面里没有 Rakazo |
| **B8 503（真实界面复现）** | **失败** | 13:17:26 UTC（v107 部署后 9 分钟，且不在部署窗口内）首屏 3 个 RPC 同时返回 503：`recruiting/getWorkspace`（x-request-id `494e7aa3-78f5-4a7d-857f-592adf97db9b`）、`threads/markRead`（`cb8735f5-…`）、`spaces/list`（`d5ab60ce-…`）。页面显示「Could not load recruiting」 |
| **新 bug：错误提示不消失** | **失败** | 503 之后数据自动恢复（134 人已经显示），但红色的「Could not load recruiting」一直留在页面上 |
| **新 bug：部署后左侧卡在 Loading** | **失败** | 13:21 v108 替换容器后，同一标签页左侧 Inbox 和「Loading roles…」一直不结束，聊天区正常；手动刷新后恢复 |
| C 动作顺序 | **通过（已修）** | v108 上这轮对话的 22 组工具事件中，倒序为 0（之前是 49%）；界面显示「Working…」「Preparing connected work…」 |
| 部署时的恢复 | 通过 | 13:19:11 发出的消息正好碰上 v108 重建容器；run 重新排队后在新容器里继续跑，只完成一次，没有重复建 campaign |
| I 成本字段 | **通过（已修）** | 13:18 之后 25 条用量记录里 23 条有 costUsd，合计 US$0.18 |
| 原生问题卡 | 通过 | Agent 问用哪个发件箱，给了 2 个选项加自定义输入；自定义回答「noah@perfectwekruit.org」后回到原卡继续 |

**Instantly 闭环：**
- **第 1 步 通过：** 只执行了 1 次 `instantly__instantly__create_campaign`（effect `cmvl02slh002l1ifqujxrhcyt`，completed）。campaign `d4b1bc78-5363-437a-bcb1-343ecc9c85ca`「Dyna Data Infra — Rakazo 内部测试」，status 0（草稿），主题和正文都对，没有弹审批卡（#15 生效）。从发出消息到回复约 4 分钟，其中包含部署恢复的时间。
  - 发现：Agent 一开始只列出 workwekruit.com 的两个邮箱，没有列出真正在用的发件箱 noah@perfectwekruit.org，是用户（我）手动指定的。
- **第 2 步起暂停：** 在用户 Chrome 里继续向 Instantly 写入时（重复建、加 lead），被本机的自动权限策略拦下（「Real-World Transactions」）。需要用户在本线程直接确认后才能继续。

### v112–v114 复测（14:02–14:17 UTC）

| 项 | 结果 | 证据 |
|---|---|---|
| Data Infra 不再挂错误 campaign | 通过 | Sequence 显示「No stored campaign associations」 |
| 内部测试岗位映射 | 通过（后台） | 新岗位 `ce604726-…` → campaign `d4b1bc78`；ensure_role_campaign 返回 created:false（没有再建），get_campaign 显示状态 0（草稿）、stop_on_reply 已开，lead 只有 admin1（状态 1） |
| 内部测试岗位 Sequence 页面 | **失败** | v112、v114 都只显示通用的「No outreach files loaded / Prepare drafts」，看不到 campaign `d4b1bc78` |
| Sequence 统计数 | **失败** | v112、v114 的 Data Infra 仍只显示「Replied · 25」，没有 32 / 9 / 9 |
| 按名字找 Sumeet（#27） | **失败** | CRM `list_crm_candidates` 仍返回 0 条；Agent 改试 Gmail（被 Google 预览计划拒绝），最后回答「无法确认」。这次没有再用猜的邮箱（有进步），但没有通过岗位联系人找到他 |
| 按名字找 Sumeet（岗位对话里，14:18） | **部分** | 能从岗位联系人里找到他的正确邮箱 sumeetparekh1@gmail.com（通过）；但 Instantly 读取报错「failed during REST contact page」，Agent 退回旧的保存记录，回答「最近一封来信是 10 月 21 日 7:14 PT」。实际上同一岗位的 Inbox 里有更新的一封：10 月 22 日 16:14 他说当天会发简历。**答案过时（失败）** |
| 不带岗位对话里找 Sumeet 的根因 | 已定位 | `list_crm_candidates` 的 p_org 传成了用户 ID（ae29fbad…），不是组织 ID（8a545110…）；p_client 写成「Dyna Robotics」、p_role 写成「Software Engineer, Data Infra」，和 CRM 里的「Dyna」「SWE Data Infra」对不上 |
| Sequence 统计数（14:23 复测） | **通过** | 页面加载完后显示 Replied 32 / Reached out 262 / Not contacted 316，合计 610，与 Contacts 总数一致（之前的 32/9/9 是 50 行子集） |
| crmData 分页 | 通过 | 直接请求第 0/50/100/150 页都返回 200，每页 50 条，总数 610，每页 2.1–2.6 秒；返回里没有按状态汇总的字段 |
| 进度显示 | 通过 | 聊天里能看到「Checking saved context ✓ / Asking a specialist ✓ / Reviewing candidates ✓ / Working on it…」，结束后显示「Worked for 1m 8s」 |
| 回复显示 Markdown | 失败（小） | 回复里直接显示「**…**」，粗体没有渲染 |
| 第 5 步确认卡 | 未出现 | 14:02 起持续监控启动 / 发送 / 回复 / 暂停类操作和等待确认的卡片，到 14:17 都没有 |
| 部署频率 | 问题 | 13:19–14:08 共上线 v108–v114 七个版本；14:15 前后这台 Mac 断网一次 |

### v111 线上复测（13:52–13:56 UTC，`a8d30be5`）

| 项 | 结果 | 证据 |
|---|---|---|
| Data Infra 候选列表 | **通过（P0 已修）** | listCandidates 返回 200，134 人，默认按 Match score 排序，每行逐项显示 Match / Unclear |
| Simulation 默认排序 | **失败** | 仍然默认按 Name 排序（Aditya Dutt 45 分排在 Akshay 35 分前面，是按字母顺序） |
| Sequence 统计数 | **失败** | 状态统计数整块消失（Replied / Reached out / Not contacted 都没有），列表仍是 25 行加「Load more」 |
| Sequence 显示 campaign | **部分** | 现在能显示 campaign 卡片了，但显示的是新的空 campaign，不是测试 campaign（见下行）；名称里带内部 role UUID，普通用户能看到 |
| 部署安全（自动检查） | 通过 | 迁移 112 份；各项计数只增不减；未结束的外部操作 7/2/1/1 原样；外发 0；工具事件倒序 0/38；44 条用量记录里 42 条有成本；部署就绪后 3 分钟采样中有 12/1,530 次 503 |
| 连接卡（未接入的服务） | **失败** | 13:57 问「帮我看看我们 HubSpot 里 Dyna Robotics 的记录，只读」，只回了一段文字「当前连接中没有可读取 HubSpot 公司记录的入口」，没有弹出连接卡、Connect 按钮，也没有 Integrations 链接；没有去接管电脑 |
| 聊天面板关闭时输入丢失 | **失败（新）** | 13:56 聊天面板关着时，在输入框里打字再按 Enter，消息没有发出去，也没有任何提示，文字直接没了（数据库里 13:54–13:57 没有这条用户消息） |
| artifact_read 报错 | 观察 | v111 上 2 次「Artifact is unavailable.」 |
| **重复建 campaign** | **失败（P1）** | 13:45:46 `ensure_role_campaign` 又新建了 campaign `6a1364c1-e377-4921-952c-99245c6860ba`「Dyna Robotics — Software Engineer, Data Infra [role 55eb90bd-…]」（created:true，adopted:false，没有 lead）；前一次调用 13:45:40 报错「Pass eaccount」。带 admin1 lead 的测试 campaign 仍是 `d4b1bc78`。同一个岗位现在有两个 campaign，第 5 步启动哪一个必须先确认 |

### v109 / v110 线上复测（13:24–13:41 UTC；v110 = `85f33153`，部署冻结期内测试）

| 项 | 结果 | 证据 |
|---|---|---|
| **Data Infra 候选列表** | **失败（P0，v109 引入，v110 仍在）** | `/rpc/recruiting/listCandidates` 等 24.2 秒后返回 500（x-request-id `c4661f71-dd76-42e2-82c6-0436b380fe6d`，traceparent `00-e7b3f53c8034b155f9e67a70988a2287-…`，13:33:57Z）；v110 重新打开仍是 500。Results 显示「Could not load candidates」，134 人看不到 |
| Simulation 候选列表 | 通过 | 16 人；Criteria 有 Match / Unclear / Does not match |
| 按匹配分排序 | **部分** | Data Infra（v107/v108）默认按 Match score 排；Simulation 默认按 Name 排，不是按分数 |
| B 禁电脑接管（4 个旧 bot） | **通过** | 「帮我看看 Sumeet 最近有没有回邮件，只看不要回」：Main → Outreach，只调用 CRM / Instantly 连接器工具，0 次电脑、浏览器、接管或 request_secret 调用，0 个 takeover 事件 |
| **业务流：按人找邮件** | **失败（P1）** | 同一轮里，CRM `list_crm_candidates` 两次都返回 0 条，但 Contacts 里有 Sumeet Parekh（sumeetparekh1@gmail.com），Inbox 里也有完整往来。Outreach 改用猜出来的地址 sumeet.parekh@gmail.com 和 admin1@wekruit.com 去 Instantly 查，都是 0。最后如实回答「无法确认」，没有编造，但找人的路径是错的 |
| 问题卡追问 | 通过 | Agent 先追问「是哪位 Sumeet」，我在原卡里回答后同一 run 继续，只回复了一次 |
| Contacts 分页 | 通过 | 「Load more」能加载下一页 |
| Inbox | 通过 | v110 上 Sumeet 的整段往来正常显示 |
| **Sequence** | **部分** | 外联状态显示「Replied · 25」——已核实是分页造成的：第一页正好 25 行，后面是「Load more」，状态统计只算了已加载的行，「Reached out · 9」「Not contacted · 9」两项也跟着消失；真实数是 32（v107 未分页时显示 32，10-22 产品自己的 CRM 汇总也是 32）。前端 bug：统计应该用服务端总数；campaign d4b1bc78 已经存在，Role campaigns 仍显示「No stored campaign associations」；没看到 lead 状态或 stop-on-reply 提示 |
| **B8 503（冻结期内）** | **失败** | 13:38:40 UTC，没有任何部署，`roleCampaign`（`48fde42e-d6d5-41e3-9d83-819f69027473`）和 `crmData`（`df0690b4-…`）在约 42 毫秒内返回 503，Sequence 显示「Could not load CRM records」，刷新后才恢复。说明 503 不只出现在部署窗口里 |
| CRM 数据请求频率 | 通过 | 页面停着时 60 秒内 3 次 crmData 请求 |
| 动作顺序 / 成本 | 通过 | v109 上 48 组工具事件倒序 0；57 条用量记录里 52 条有 costUsd |
| Instantly 第 2–4 步（核心线执行） | 通过 | 只有一个 campaign `d4b1bc78`；add_leads 1 次 → lead `01a168f2-1dda-7128-ad95-0262d2373e59`，状态 1 |
| Instantly 第 5 步 | 未开始 | 13:40 只读查询：最近 3 小时没有任何 waiting_input 的 run，产品里还没有「发第一封」的确认卡。之前我以为是第 5 步卡片的那个 run，其实是我自己的 Sumeet 追问卡（已更正） |
| 部署节奏 | 问题 | 13:19–13:34 连续 3 次部署（v108/v109/v110），两次测试跑到一半被换容器打断；已申请 20 分钟冻结 |

### v107 部署后自动检查（13:09 UTC，只读）

v107 = main `0590e1fe`（含 PR #14 Instantly 写工具），13:08 UTC 部署，容器 `ta-01M5ME0H3XS3NDCDGR6TEG3S3R`。CRM MCP 同时升到版本 10（headhunter-agent `3ac9306e`，含 #57、#65）。

| 检查 | 结果 |
|---|---|
| ready / 迁移 | 通过：110 份，没有新增迁移 |
| 数据保留 | 通过：各项计数与 05:12 基线完全一致 |
| 未结束的外部操作 / pending 卡 | 通过：原样保留，没有重放，也没有外发 |
| 品牌 | 通过：Rakazo 文案为 0 |
| 503 | 通过：1,530/1,530 返回 200 |
| 电脑事件 | 4 条 `computer.status`，是预热状态，不是接管；没有 takeover 请求，也没有调用禁用工具 |
| 动作顺序 / 候选读取 / 成本 | 待流量：部署后还没有任何 run |

**浏览器验收受阻（13:15 UTC）：** Claude in Chrome 扩展没有连接（已连接浏览器 0 个）；Chrome 未开启「Allow JavaScript from Apple Events」（这是浏览器安全设置，我不能替用户打开）；屏幕截图授权被拒。所以 E 逐屏、发测试消息、Instantly 9 步闭环这几项现在都没法由我操作。

### 邮件闭环：为什么 Instantly 看不到种子邮件（12:45 UTC）

- **现象：** 12:40 用户截图显示，Noah 的 Unibox 里 noah@perfectwekruit.org 收件箱搜 admin1@wekruit.com，结果为「No emails found」（左侧 Lead 过滤处于选中）。记为「Instantly 未收录非 campaign 邮件」。
- **原因：** Instantly 的 Unibox 只保存 campaign lead 的往来。admin1 不是任何 campaign 的 lead，种子邮件又是从 Gmail 直接发到发件邮箱的，所以默认不收录。
- **证据：** 旧 CRM（`crm-stage-mcp`）的 Instantly 镜像表就是 campaigns → leads → emails 结构，邮件按 campaign 和 lead_email 绑定。产品此前成功读到的 1,742 字符旧回复，也是 campaign lead 的邮件。所以读取接口本身没问题，问题出在测试方式：拿一封「非 lead 直发」的邮件去测。
- **Grok bot：** 导出的 Grok 对话里没有 Instantly 收件或回复的调用记录（只有 4 处「Instantly agent」字样），不存在一个「它能看到、我们看不到」的不同接法。
- **修正后的闭环（二选一，需要用户确认）：**
  - ① 新建一个内部测试 campaign，把 admin1@wekruit.com 加为唯一 lead。由 Instantly 发出第一封，admin1 在原线程回复，然后 Agent 读回、Inbox 显示、campaign 自动停止跟进。这是推荐方案，和真实候选的路径一致。
  - ② 打开 workspace 设置「Save Non-Instantly Emails in Unibox」后，重发一次直发种子。只能证明收录，不能证明停止跟进。
- **核心线 1 小时内给出确认后的根因；我按选定方案跑完整闭环。**
- **12:42 用户决定：** 走方案①，但建 campaign 和加 lead 都由 Agent 通过 Instantly 接口完成，不靠人工在界面上点。由核心线负责补接工具、建内部测试 campaign 并发出第一封；J 线不另外建 campaign。
- **补充：** 官方 Instantly MCP 本身就有 `create_lead`、`add_leads_to_campaign_or_list_bulk`、`activate_campaign` 等工具（PLAN 任务 8 已记录，按设计必须由真人确认一次才执行）。我们缺的是把这些工具分配给 Agent，并接上确认流程，不是 Instantly 不支持。
- **J 线验证步骤（admin1 回复之后）：**
  1. 库里能看到 create campaign / add lead / activate 的 effect 各 1 次，状态 completed，没有重复。
  2. admin1 的 Gmail 收到 1 封来自 noah@perfectwekruit.org 的邮件，只有 1 封。
  3. admin1 在原线程回复后，产品用 `list_emails` / `get_email` 读到这封回复，正文完整。
  4. 产品 Inbox 显示这封回复（浏览器截图）。
  5. 该 lead 在 campaign 里已停止后续跟进：lead 状态为 replied 或已停止，之后不再有新的发信。
  6. 全程没有第二封外发，也没有结果未知后的重发。

### 全量闭环验收范围（12:40 UTC 扩展；PeopleSearchBench 除外）

触发：后台每 2 分钟检查一次线上版本（Modal 版本号或首页 bundle 变化）。一旦不是 v105，等 ready 200 后自动跑 postdeploy，不等通知。12:37 复核仍是 v105；main 已合并 #6/#7/#8/#9，尚未部署。

| 线 | 步骤 | 通过标准 | 谁能做 |
|---|---|---|---|
| A 发布 | postdeploy：版本、ready、迁移账本、保护计数、非终态 effect | 迁移 110 份且含 consideration，新列存在；messages/runs/effects 只增不减；executing 7 / intended 2 / approved 1 / uncertain 1 原样；pending 卡 10 张还在 | 我（自动） |
| B 禁电脑回退 | ①库里查部署后 `computer.*` 事件和 computer/browser/open_path/launch_app/request_takeover/request_secret 工具调用；②在邮件协调对话里说「帮我看看 Sumeet 最近有没有回邮件」 | ①为 0；②Agent 走已授权邮件工具，或明确说缺哪个连接；不出现电脑接管卡，也不要密码 | ①我；②需要浏览器发消息 |
| C 动作显示 | 事件倒序 SQL + 浏览器看动作标签 | 部署后倒序 0 组；标签先「进行中」后「完成」，没有卡住的标签 | SQL 我；画面需要浏览器 |
| D 候选读取 | Data Infra 候选连续打开 5 次 + 两个标签页同时打开；库里看 recruiting_candidates 耗时和错误 | 0 次「Could not load candidates」；无 expired transaction；p50 < 3 秒（基线约 11.9 秒） | 打开需要浏览器；数据我 |
| E 前端逐屏 | 下方 7 项 | 见下 | 需要浏览器 |
| H 新人 + 隔离 | 第二个真实账号注册/登录 → 自动出现 Main/Sourcer/Outreach/Scheduling 和共享 skills → 正常问一句招聘问题 → 退出重登；两个账号各写一条偏好，互相问对方的偏好 | 新账号不用配模型或 Autumn 就能用；重登不重复安装；`users` 查询里两人 bots/skills 各自独立；crossUser 三项为 0；问对方偏好答不出 | 账号必须由真人注册（我不能建账号）；数据核对我 |
| I 成本与预热 | 部署后 usage_records 的 costUsd；首页冷加载 503 采样 | 新记录 costUsd 非空，能按天汇总；部署后 3 分钟采样 0 个 503 | 我（自动） |
| 附件 CSV | 上传 5 行占位 CSV（example.com 链接），问「这几个人里谁已经在 Data Infra 候选里了？先别保存」 | 读出 5 行并逐行回答；不新增候选或外发 effect | 上传需要浏览器；结果我核 |
| G 邮件闭环 | Instantly 从产品发出 → admin1 收到 → admin1 原线程回复 → Instantly 读回 → Inbox 显示 → Agent 跟进 | 每一步有供应商回执；同一封只发一次 | 卡在 Instantly 收录；需要用户授权外发方案（A/B）和开发者核实 Noah 工作区 |

### E 线前端复测清单（PR #6–#13 合并并从 main 部署后执行；目前只有假数据截图，不算验收）

后台自动部分（postdeploy 覆盖）：品牌扫描 Rakazo 文案应为 0；Contacts/Inbox 读取期间 toolErrors 无 500 / expired transaction；部署前后保护计数一致，没有新的外发 effect。

浏览器部分（真实账号，逐项截图）：
1. **统一工作台**：左侧岗位列表里，旧 CRM 岗位和 Agent 岗位在同一个列表、同一套页签；打开一个从没聊过的旧 CRM 岗位，右侧是空白对话、可以直接输入；Data Infra 只出现一次，不出现第 2.2 节那些重复的历史角色。
2. **四个页签用真实 CRM 数据**：Contacts 的人数、姓名、邮箱与旧 CRM 一致（抽 3 人核对）；Sequence 显示真实 campaign 关联，不是假步骤；Inbox 点开一封旧邮件，正文完整；Interview 显示已保存的可用时间或预约，空就显示空态，不编造。
3. **右侧 chat 带上下文**：在 Contacts 选中一人后问「这个人之前跟我们聊过什么？」，不提姓名，Agent 应自动知道是谁；选中一封邮件后问「这封说了什么，先别回」。
4. **Agent 写入后左侧刷新**：让 Agent 做一次内部保存（如「把这个人标成先放一放」，不外发），左侧状态不刷新页面就自动更新；第二个标签页同步。做完后改回原状态。
5. **重连不闪烁**：断网 10 秒再恢复，或让电脑休眠后唤醒；页面不应闪成空白或回到 Loading，已显示的数据保持。
6. **窄屏、加载态、截断**：浏览器宽度拉到约 390px，岗位列表、页签、抽屉、输入框可用，没有横向滚动；长岗位名和长邮箱用省略号，悬停能看到全文；首次打开有骨架或 Loading，不是白屏。
7. **品牌**：页面标题、Logo、OAuth 回跳页、模型设置里都看不到 Rakazo。

结果按本报告格式追加到看板：通过 / 失败 / 阻塞，附截图路径和对应 run 或 effect。

### 部署前基线（05:12 UTC，物理只读）

迁移 109 份，`20261019000000_recruiting_candidate_consideration` **未应用**，`recruiting_candidates.consideration` 列不存在。新 main 的读路径依赖该列，必须先迁移再启动。保护计数：messages 1,220 / runs 485 / effects 2,940 / memory docs 23 / candidates 1,016 / roles 32 / 活跃 Routine 0 / 真人 1。遗留非终态 effect：executing 7、intended 2、approved 1、uncertain 1，部署后必须原样保持。pending 卡 10 张。04:19 以来工具事件倒序 14/39。

### 部署后一键复测（只读）

`scratchpad/ro/postdeploy.sh <部署时间UTC>`：版本 / ready、迁移账本与新列、保护计数对比、事件倒序、排队、工具错误、takeover 事件、外发 effect、品牌扫描、3 分钟 503 采样。

### 两个 Dyna 对话的自然语言消息（部署后由浏览器发送，复用已付费结果，不触发新研究）

Data Infra（134 人池）：
1. 「这个岗位现在候选人里，谁有机器人或自动驾驶公司的经历？先别重新找人。」→ 期望：只读已保存池，有来源，动作标签先「进行中」再「完成」。
2. 「排名前三的这几个人，各自哪些要求符合、哪些还不清楚？」→ 期望：逐项 match/miss/unclear 来自 Autumn 原值，不重算。
3. 「给第一个人起草一封邮件，先别发。」→ 期望：只出草稿 / 确认卡，没有外发 effect。

Simulation（16 人池）：
1. 「这个岗位的薪资还没公开对吧？其他要求帮我总结一下。」→ 期望：标「未公开」，不编造范围。
2. 「这几个人里谁做过仿真或者物理引擎？」→ 期望：只读已保存结果。

每条消息之后：刷新、开第二个标签页、切换到另一个岗位再切回来，确认消息、候选和卡片一致。

## 0. 结论速览（首轮，04:45–04:55 UTC）

| # | 项目 | 结论 | 一句话 |
|---|---|---|---|
| 1 | 岗位 Inbox 合并原生邮件 + CRM 往来 | 部分通过 | 后台读取链路有真实回执；合并后的界面只能人工看 |
| 2 | 旧 CRM 岗位与 Agent 岗位统一 | 未发布 / 发现数据问题 | 同一岗位在库里有 8 份（Data Infra）和 3 份（Simulation）角色记录 |
| 3 | 候选详情 / 聊天 Dashboard 可读性 | 未发布 | 只能人工看 |
| 4 | 品牌改为 WeKruit Headhunter | 部分通过（有残留） | 标题/图标/manifest 已改；4 句界面文案仍写 "Rakazo" |
| 5 | 按联系人查 Instantly 邮件 | 不通过 | 3 次真实查询全部 0 封，其中 1 次把发件账号当成联系人去查 |
| 6 | Autumn 逐项匹配/缺口展示 | 代码通过，数据未核验 | 只读生产读取在第二阶段被权限拦截，需人工看 |
| 7 | 普通对话显示真实执行动作 | 不通过 | 近 3 天 49% 的工具事件"完成"排在"开始"之前 |
| 8 | Waiting in line / 历史卡 / 间歇 503 | 部分通过 | 复现到 1 次 503（no upstreams available）；之后 2400 次请求全部 200 |
| 9 | 邮件回复 / 面试邀请闭环 | 不通过（未闭环） | 库里零条发送/预约写入；Gmail 被 Google 预览计划拒绝 |
| 10 | 附件：截图 / CSV / XLSX | 截图通过；CSV 部分；XLSX 不支持 | 详见第 3 节 |
| 11 | 任务 1–9 | 1–4 基本通过（按计划记录）；5–9 未完成 | 详见第 4 节 |

本轮零外发、零付费模型调用、零 Autumn 调用、零数据库写入，未改产品代码，未碰核心工作线的 worktree。

## 1. 测试方法与证据边界

- **页面与静态资源**：匿名 `curl` 抓取首页、manifest、全部 45 个 JS chunk。
- **503 采样**：04:47:20–04:51:51 UTC，每秒并发拉取首页全部模块 + `/health`，共 2,400 次请求。
- **数据库**：沿用既有方式，在线上容器 `ta-01M5KFSC44DQ538A4R8A95QC2R` 内用 `default_transaction_read_only=on` + `BEGIN READ ONLY` 执行，每次读回 `transaction_read_only=on`，结束 ROLLBACK 并关闭连接池。只取元数据和计数；为核对附件理解，读了 2 条用户自己附件消息的说明和回复前 500 字。没有读取凭据。
- **限制**：第二轮在容器内读源码时被本机自动权限策略拦截（生产读取）。之后的源码核对改为在本地仓库只读执行 `git show 94cff4c6:...`。Autumn 原始结果文件内容也因此没有读到。
- **没做的**：没有登录态 Cookie，不用浏览器就无法以本人身份调用 API，所以没有在两个 Dyna 对话里发新消息，也没有做真实上传。下面的「人工检查」列出了需要人在浏览器里做的步骤。

## 2. 逐项结果

### 2.1 岗位 Inbox 合并原生邮件 + CRM —— 部分通过

- 验收标准：同一岗位 Inbox 同时出现 Instantly 原生邮件和 CRM 历史往来；正文完整；不按姓名猜归属。
- 证据（近 3 天 external_effects，均 completed）：`list_crm_candidate_correspondence` 1 次（01:25:55）、`mcp__instantly__get_email` 2 次、`list_emails` 12 次、`list_accounts` 5 次。
- 没有发现按姓名猜归属的写入。合并展示属于 UI，无法从后台证明。
- **人工检查**：打开「Dyna · Data Infra」→ Inbox，确认同一列表里能同时看到 Instantly 和 CRM 来源；点一封 CRM 旧邮件，正文与 quoted reply 完整；刷新后仍在。

### 2.2 统一旧 CRM 岗位与 Agent 岗位 —— 未发布，发现数据问题

- 计划状态为「已开始，未发布」（本地只有 `unified-role-frozen-706dbeaa.patch`）。
- **问题 B2（数据重复）**：`recruiting_roles` 里 "Dyna Robotics — Software Engineer, Data Infra" 有 **8** 条记录（含 2 条 "Software Engineer, Data Infra — Dyna Robotics"），"Research Scientist, Simulation" 有 **3** 条。只有 `55eb90bd…`（当前 Data Infra 对话，134 人）带 CRM 绑定；当前 Simulation 对话的角色 `92ea41ba…`（16 人）**没有 CRM 绑定**。另有 `e2ad9b63…`（Simulation，190 人）、`9df4c6f0…`（Data Infra，200 人）等旧角色挂在已归档对话上。
  - 影响：统一界面如果按岗位名聚合，会混入多份历史池；如果只取当前绑定，Simulation 岗位看不到 CRM 数据。
  - 建议：统一前先确定每个 CRM 岗位对应唯一 canonical 角色，并给 Simulation 补 CRM 绑定（不靠名称猜）。

### 2.3 Dashboard 可读性 —— 未发布

- **人工检查**：候选详情第一屏先显示匹配/缺口，长反馈和历史默认折叠、可展开；证据不丢。

### 2.4 品牌 WeKruit Headhunter —— 部分通过

- 通过：`<title>WeKruit Headhunter</title>`、description、apple 标题、`/wekruit-icon.svg`、`/wekruit-logo.png`、`site.webmanifest` 的 name / short_name 均已更新（HTTP 200）。
- **问题 B4（品牌残留）**：线上 bundle `messages-jrzMZQ1m.js` 仍有 4 句用户可见文案写 Rakazo，并且已翻译到全部 11 种语言（中文如「返回 Rakazo」「选择 Rakazo 使用的已连接模型」）：
  - `apps/web/src/pages/McpOAuthCallback.tsx:66` "Return to Rakazo"（连接应用 OAuth 回跳页，用户一定会看到）
  - `apps/web/src/pages/ModelSettingsOverlay.tsx:1073 / 1138 / 1257`（模型设置）
  - 复现：任意连接一个应用走完 OAuth，回跳页按钮显示 "Return to Rakazo"。
- localStorage 键 `rakazo.uiAppearance` 属于计划允许保留的内部键，不算问题。

### 2.5 按联系人查 Instantly 邮件 —— 不通过

- 证据：`native_instantly_search_contact_emails` 共 3 次，全部 completed、`returnedCount=0`、`pageExhausted=true`：
  - 04:25:32 account=noah@perfectwekruit.org，contact=admin1@wekruit.com → 0
  - 04:25:38 account=空，**contact=noah@perfectwekruit.org** → 0
  - 04:36:55 account=noah@perfectwekruit.org，contact=admin1@wekruit.com → 0
- **问题 B5**：第 2 次把发件账号本身当联系人去查，说明 Agent 对「账号 / 联系人」两个参数理解有误。三次都是 0，目前无法区分「Instantly 没收录这封非 campaign 邮件」和「查询方式不对」。
- 下一步建议：先找一封 Instantly 界面里确实存在的联系人邮件，用这个联系人做一次只读查询作正样本；正样本查得到之后，再判断内部测试邮件为何是 0。

### 2.6 Autumn 逐项匹配/缺口 —— 代码通过，数据未核验

- 代码（94cff4c6 `packages/core/src/recruiting-candidates.ts:200-240`）：只有 `rule_*` 字段且值为 match/miss/unclear 时才带 `providerStatus`，不重算，符合计划。
- 数据：两个当前岗位的 `recruiting_candidate_occurrences.issues` 全部为空数组（Data Infra 938 行、Simulation 48 行），`recruiting_assessments` 全库只有 4 条。说明匹配/缺口只能来自 Autumn 原始结果文件；读文件这一步被权限拦截，未核验。
- **人工检查**：打开 Data Infra 任一候选详情，看是否出现带 ✓/✗/? 图标的逐项规则；再找一个历史只有文字证据的候选，确认它显示原文、不出现伪造图标。

### 2.7 普通对话显示真实执行动作 —— 不通过（问题已量化）

- **问题 B7（事件顺序）**：近 3 天按 executionId 配对的 1,457 组 `agent.tool.called` / `agent.tool.completed` 中，有 **721 组（49%）completed 的 seq 和时间都早于 called**，涉及 126 个 run、34 种工具（task_catalog、skill_read、handoff_to_bot、connectors_load_tool、read_file、Autumn、CRM 等），不只是快工具。另有 8 条 completed 没有对应 called，1 条 called 没有 completed。
  - 最新样例：run `cmvkhg3id000a1hfqhcknagzx`（04:41–04:42）的 task_catalog 899<900、skill_read 902<903、handoff_to_bot 908<909、search_history 917<919。
  - 影响：前端如果按事件顺序渲染，会出现「已完成」先于「开始」、或动作标签卡在进行中的情况。
  - 建议：与计划一致，交给 Pi FIFO / 共享 reducer 责任线；修复后可以用同一条 SQL 复测（目标是倒序 0 组）。

### 2.8 Waiting in line / 历史卡 / 间歇 503 —— 部分通过

- **复现到 503（问题 B8）**：04:46:59 UTC 首次加载页面时，`/assets/user-error-fReLjXa8.js`、`primitives-DFsniqad.js`、`use-model-oauth-signin-oaE4gxt6.js` 三个静态模块同时返回 `503 {"error":"no upstreams available"}`，几秒后重试恢复。这是 Modal 路由层没有可用上游，不是应用代码错误。浏览器里表现为白屏或某个面板加载失败。
- 后续采样：2,400 次请求全部 200，p50 0.32s，p99 1.73s，最大 3.52s。说明 503 是短暂窗口，与「单写入容器、冷启动窗口」吻合。
- 排队（近 3 天 runs 的 startedAt−createdAt）：completed 132 个，p50 1.5s、p90 4.0s、**最大 559s**；cancelled 5 个，p90 299.5s；failed 4 个。
- 当前有 10 张 pending 卡，其中「Dyna · Simulation」有 1 张。
- **人工检查**：连续 5 次硬刷新首页，记录是否出现白屏；打开 Simulation 对话，确认那张待答卡是有意保留的。

### 2.9 邮件回复 / 面试邀请 —— 不通过（未闭环，符合计划自述）

- 全库 external_effects 中，`reply_to_email / send / create_booking / create_draft / activate_campaign / add_leads` **0 条**，只有只读的 `cal-com__get_bookings`、`get_availability`、`get_event_types`。没有误发，但也没有闭环。
- 阻塞：`mcp__gmail__search_threads / list_drafts` 今天 03:56 仍报「Google Workspace Developer Preview Program」未加入（项目 876479962995）。`connectors_load_tool` 3 次 "Unknown tool ID or name"（03:55），对应计划里排期专员拼错工具名的问题。
- 需要用户决定：Gmail 正式发送走 Gmail REST 原生 grant，还是只用 Instantly 回复。

### 2.10 其他发现

- **问题 B10（成本不可追踪）**：10-15 以来全部 5,205 条 `usage_records` 的 `costUsd` 都是 NULL。产品内无法核算 US$150 共享预算，只能依赖供应商账单。
- **问题 B11（版本标识陈旧）**：容器环境变量 `GIT_SHA=00f9b6bb`（2026-10-15 的提交），而计划写的线上版本是 `94cff4c6`。00f9b6bb 是它的祖先，所以只是标识没更新；但按 GIT_SHA 排查问题会被误导。
- 近 3 天失败 run：2 次 Prisma 事务过期/冲突（10-20、10-21），1 次 "Codex stream idle timeout"（10-21），其余为人工停止。今天没有新的 run 失败。

## 3. 附件能力（截图 / CSV / XLSX）

用户问题：「我们可以处理附件，比方说截图 / csv 各种吗？」

| 类型 | 能上传 | Agent 能读懂 | 线上证据 | 结论 |
|---|---|---|---|---|
| 截图 PNG/JPG/WebP/GIF | 能 | 能，图片直接送进模型 | 10-22 22:57 用户上传产品截图，Agent 准确列出 Shortlist/Contacts/Sequence/Inbox/Interview 五个导航，并原样回传文件 | **可用** |
| PDF | 能 | 能，内嵌文字抽取（不支持 OCR/加密） | 库里有 3 份 PDF | 可用（扫描件不行） |
| CSV | 能 | 只能间接读：模型先只看到「[file: x.csv, N bytes]」，需要调用 artifact_read 或把文件写进沙箱用 shell 解析 | 10-16 两份 Dyna CSV 已上传，但当时明确要求不解析；**从未在线上解析过 CSV 行** | **部分可用，未实测** |
| JSON / Markdown / TXT / HTML | 能 | 能，通过 artifact_read | 10-21~22 三次 JSON 上传后 Agent 用 artifact_read 读取 | 可用 |
| XLSX / Excel | **不能**，上传白名单里没有 | — | — | **不支持**，需另存为 CSV |

- 限制：每条消息最多 4 个文件，单个 10 MiB；最近 3 轮的图片会保留给模型。
- 当前两个模型（openai-codex gpt-6.1-sol / gpt-6-luna）在模型目录里都声明支持图片。
- 缺口：CSV「转成结构化行 → 和已保存候选去重 → 落库关联」这条链没有专门工具，也没有线上实测；XLSX 完全不支持。
- **人工检查（最小、无副作用）**：在「New role」对话上传一个 5 行的假名单 CSV（姓名 + LinkedIn URL，用公开占位值，例如 example.com），说「这份名单里有哪些人已经在 Data Infra 候选里了？先不要保存」。期望结果：Agent 读出 5 行，逐行回答是否重复，不写库。

## 4. 任务 1–9 验收标准与状态

| 任务 | 验收标准（摘自计划） | 状态 | 本轮补充证据 |
|---|---|---|---|
| 1 记忆跨对话召回 | 真实 remember、持久 revision、跨对话召回 | 通过（计划已勾选 5/5） | 未复测 |
| 2 选择/自定义 input 原卡续跑 | 原卡跨重启继续，不伪造卡 | 通过（5/5）；远端 MCP 多字段卡未接 | ask 卡：69 answered / 10 pending |
| 3 一次性审批与恢复 | 同 payload 只执行一次 | 7/8；「外部写入结果未知时不重复」未验 | 未复测 |
| 4 Grok 导出与服务盘点 | 所有 session 完整或明确失败 | 通过（6/6） | — |
| 5 原生配置迁入能力 | 服务可见、凭证隔离、记忆可用 | 2/8 | — |
| 6 Autumn→证据→反馈→同任务续搜 | 同一外部 task 有真实回执 | 1/7 | Autumn 最近一次调用在 10-21 23:22（reply 10 次、research 1 次） |
| 7 Supabase 身份/组织/CRM | 获准写读一致、越权拒绝 | 1/4 | CRM 只读调用正常；产品库只有 1 个真人账号，**越权无法测** |
| 8 Instantly 审批发送与回复停止 | 一次批准对应一次发送 | 0/5 | 发送类效果 0 条（2.9） |
| 9 P6 全链路 | 网页完成全链路 | 0/6 | 依赖 6、7、8 |

## 5. 问题清单（给路由）

| 编号 | 严重度 | 问题 | 复现 |
|---|---|---|---|
| B7 | 高 | 49% 工具事件 completed 早于 called | 第 2.7 节 SQL；run `cmvkhg3id000a1hfqhcknagzx` |
| B5 | 高 | 联系人查邮件 3 次全为 0，且有 1 次参数用反 | effect `cmvkgvp7c00281ifqgoyi4ky7` |
| B2 | 中 | Dyna 岗位重复角色记录；Simulation 当前角色没有 CRM 绑定 | 2.2 节 |
| B8 | 中 | 首次加载静态模块 503 "no upstreams available" | 04:46:59 UTC，3 个模块同时出现 |
| B4 | 低 | 4 句 Rakazo 文案残留（OAuth 回跳页、模型设置） | 2.4 节 |
| B10 | 中 | usage_records.costUsd 全为 NULL，无法核预算 | 2.10 节 |
| B11 | 低 | 容器 GIT_SHA 停在 00f9b6bb | 2.10 节 |

## 6. 只能由人完成的浏览器检查（汇总）

1. Data Infra → Inbox：同一列表同时有 Instantly 和 CRM 来源，正文完整，刷新保留。
2. 候选详情：匹配/缺口图标优先显示，长内容折叠；只有文字证据的历史候选不出现伪造图标。
3. 走一次「Connect an app」OAuth，确认回跳页文案（当前预期仍显示 Rakazo，用来确认 B4 修复）。
4. 连续 5 次硬刷新首页，记录是否白屏（B8）。
5. 普通对话问一个需要 2–3 个工具的问题，看动作标签是否先「进行中」再「完成」、有没有卡住的标签（B7）。
6. 附件：按第 3 节上传 5 行占位 CSV 做只读去重问答。
7. Simulation 对话里那张 pending 卡是否需要保留。
8. 任务 7/9 的越权测试需要第二个真人账号，目前产品库只有 1 个。

## 7. 本轮花费

付费模型调用 0、Autumn 0、外发 0、数据库写入 0。容器内只读查询 5 次，匿名 HTTP 请求约 2,500 次（静态资源）。
