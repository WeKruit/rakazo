# Dyna：Grok 与 Rakazo 的有限离线对照

> 来源：已完整读取源所有者的脱敏比较报告及索引。下面保留其原件检查结论，删除私有路径、任务/账号/会话标识。原件仍由源所有者保管，本 checkout 未打开候选原件或检查生产。官方 Library 下载失败；全文经文本接口读完，并保存可读 rendered-text 副本，不声称原始字节 materialization 成功。最新代码版本见 [latest-main.md](latest-main.md)。

结论：目前证据能支持**输入版本、搜寻策略和验证责任不同**，以及 Rakazo 某次结果传递是否完整；不能支持 Grokbot 胜过 Rakazo 的因果结论。Grok 一侧有自述“实际发过”的 prompt 回顾，但缺少相同 run 的原始 HTTP receipt + raw output 对。Rakazo 一侧具备真实原生 MCP 请求及返回。LT044 和通用模板不混入本比较。

版本边界：父线程另告知当前 main 已到 `3f02c76a3bf25e5d2d5f7d1e639eb95908e3256b`，并有 Main 快搜校准 / Sourcer Autumn 扩量的新分工。本轮没有检查该 commit 或当前生产；下述路径、行为和缺陷均限于标注日期的历史证据。

## 请求归属与版本

Autumn task **`[private task identity]` 属于 Rakazo 原生 Main → Sourcer → MCP research 路径**，不是已找到的 Grok REST 请求。

- 人类输入冻结：2026-10-18 03:37:33.923Z，SHA256 `83a991a3a2201c0266fe92a154936e2187e93ad64956b73ef28917a63c97523d`。冻结说明记录唯一额外句子是由 Autumn 匹配排序，Sourcer 传递请求反馈并保存结果。
- Main handoff：03:38:45.491Z，effect `[private effect identity]`；Sourcer run `[private effect identity]`。
- 实际 research：03:40:10.340Z 发起、03:40:11.225Z 接受；effect `[private effect identity]`；route `toolName:research, connectorId:mcp, resourceRevision:1`；实际 args **只有 `prompt`**。
- Provider 返回 runtime `beanstalk`、opaque version **`v_b7d22371af`**。请求没有显式 `scout`/tier/clarify 字段，不能把它当成与 Grok Scout 相同配置。
- 原始 prompt 10005 bytes，SHA256 **`99d7ae424e71e2b5e19779ae195e794c2d8e4f18e11812e57d0c16e9f171d4b5`**；是所提供完整 JD + 明确新任务边界。这里未确认当时产品精确 Git commit；不能当作当前 main `f8740356...` 的执行证明。


## 并列表：保留每个 Grok 版本，不拼成一个“成功 prompt”

| 维度 | Grok batch 6/7：自述已发请求 [G6/G7] | Grok 10/14：复核后可复制稿 [G14] | Rakazo 实际请求 [R1] |
|---|---|---|---|
| 证据等级 | 聊天自述“exact prompt sent”；没有 wire receipt；batch7 未重复完整主 brief | 明确“ready to paste”，不证明执行 | 原生 `mcp__autumn__research` effect 与 provider 回执 |
| 目标/岗位 | 同 Dyna Data Infra，完整 JD 自述附入，随后叠加用户反馈 | 同岗位，以40个复核A为来源的收紧稿 | 同岗位，重新从完整 JD 开始，明确禁用旧角色/任务/结果/决定 |
| 公司与领域 | A 优先 robotics/AV：Cruise/Waymo/Zoox、Tesla、Foxglove等；B 接受 Databricks、Meta、Google 等泛 data/ML infra；batch7分9领域含游戏、医疗影像、视频、fintech | 首选 AV/robotics；第二层 camera/sensor/video，Samsara/Verkada等；强信号为sensor logs、数据湖、HIL/teleop、resim/eval、规模 | 没有目标公司清单；不把行业、公司 pedigree 变新增硬条件。完整JD保留机器人领域职责 |
| 负例 | 排 frontend/fullstack/product/mobile、无infra证据的泛SWE、学生/纯研究/BI、曾任manager及Staff+、现Dyna | 排无sensor/robot数据的ads/recsys/LLM serving、纯视频交付、AV公司非data工作、相关经历结束2年以上、manager/director/founder等 | 没有继承上述背景黑名单；不得把职责/bonus当新增拒绝规则；保留未知和不足 |
| 正例人物 | 5个校准人物：AV logs/Beam、labeling infra、robot-log search、3D/Ray/GKE、sensor-data lake；明说类型好但稍资深 | 5个样例：PB级sensor pipeline、robot data platform、AV video curation、data engine、HIL labeling。姓名/链接保留在原件，本报告不复制 | 首轮无人物样例；扩到200时只把既有人物的telemetry/cloud ETL/3D SLAM作为搜寻方向，明确不是资格批准 |
| 经验 | 主brief仍列JD 5+，但批次规则明确放宽为**3–10年 full-time engineering，排internship/PhD年**；理想5–7；另排曾任Staff/Principal/manager。这是内部冲突/覆盖，不能隐去 | **约5+，强证据4.5可接受**；IC，允许Staff；不再与batch6/7年限及Staff排除相同 | **5+ professional software experience**；明确不加full-time-only、post-degree-only、Staff/pedigree要求；无7+/84个月 |
| 地点/薪资 | **当前Bay Area为hard requirement**；Redwood City on-site | Bay Area **或**明确愿搬迁信号 | 当前所在地、on-site意愿、薪资分别保留；不能自创地理半径或由地点推愿意搬迁 |
| 任期/语言/学历 | batch6提到 **<9个月为soft**，非通用6个月；没有本岗位语言/学历要求 | 无六个月、语言或学历要求 | 无六个月、语言或学历要求 |
| JD硬软 | Python/backend、geometry、databases/cloud、debugging；React/TS按历史用户反馈忽略；额外IC/地理/infra限制 | 强化近期亲自做sensor/robot data；未逐字重载全部JD；按领域A/B/C | 五类 required qualifications；data-intensive/HIL理想；React/TS major plus；robotics multimodal、Airflow/Kubeflow、W&B/MLflow、early startup为bonus |
| OR/AND | 公司列表/分段领域是选择集，非要求所有公司；infra规则逐项检查；loosened bar允许明确infra团队/title | `MUST HAVE (all)`连4项；robot/AV/sensor/lidar/camera/video为备选数据类型；地点Bay Area OR relocate | 五类要求按合取评估；relational **and** NoSQL来自JD；GCP **or** AWS是替代平台；Airflow/Kubeflow、W&B/MLflow是bonus选择。**未发现此Dyna请求把OR改AND的直接证据** |
| 证据门槛 | 叙述说不能只有generic title，但分段尾句明确“clearly-infra team/title is enough”；团队级infra描述可算 | 不信title，逐个核实A；concrete project + data type + scale | 区分个人实现、团队/library exposure、推断；title不是证据；源引文、日期、未知逐项保存 |
| 数量/已看 | batch6 **7个独立搜索**，请求数15/15/15/20/15/15/12（合107），各有focus/ALREADY SEEN；batch7 **9×15**，各传285已看姓名；Grok自述有代码去重 | 引用520 LinkedIn URLs 的seen.csv，未在此稿给固定目标量；已看清单另附 | 新任务初始10；不继承旧seen排除；同任务累计100、200。身份去重而非仅姓名，旧100保留 |
| provider/评分 | 自述 cheaper **scout**；输出tier，另agent核实；没有相同run原始结果佐证 | A=全部must+robotics/AV；B=其他sensor/video或年限略少；C=其余；agent复核 | 实际args只prompt，provider版本opaque；Autumn owns ranking；最终Strong/Promising/Partial/Uncertain；数值score全null |

Grok 的 batch6/7 与后来的 G14 本身已经显著变化。不能把新稿“只信个人强证据”反向归给早期允许团队/title的搜索，也不能把早期3–10年搬给这条Rakazo5+请求。

## Rakazo feedback scope：实际发生了什么

| 阶段 | 实际请求与来源 | 作用域 | 是否改变岗位条件 |
|---|---|---|---|
| 初始10 | `stage-01-research-receipts.json` / `stage-01-actual-provider-prompt.txt` | fresh research，initial10，停下来等反馈 | 新任务刻意不用历史业务决定；输入定义如上 |
| 原10复核 | `stage-02-actual-provider-feedback.txt` / reply effect `[private effect identity]` | 只复核原10的叙述/结构字段矛盾、HIL歧义与日期；禁止增人 | 声明不改原JD；HIL解释为people而非hardware；新增明确当前日期2026-10-18 |
| 扩到100 | `stage-02-expansion-actual-provider-feedback.txt` / reply effect `[private effect identity]` | 后续明确确认后同task扩量，留原10、最多加90、停100 | 相同JD，传播复核修正；不是100个替换者 |
| 扩到200 | `stage-03-actual-provider-feedback.txt` / `stage-03-actual-provider-reply-receipts.json` | 一个既有人的实现细节作为正例；显式扩量授权，留100加最多100 | 声明不改条件；不是单人纯纠错请求偷偷增人 |
| 保存恢复 | `stage-03-save-recovery-frozen.txt` / `independent-stage03-recovery-all200-original-artifact-manifest.json` | 读取已完成200结果并补存；保留失败记录 | 0新research、0reply；不改JD/排序 |
| 现有Top20/10展示 | `stage-04-existing-ranking-request-frozen.txt` / `stage-04-top-format-all-reply-receipts.json` | 2次display-only reply；第二次纠正connector截断/仍返回200源序的问题 | 禁重搜、取新源、复评、改rank。仅既有updated_rank 1–20，前10打标 |

此例不能证明“反馈默认增10人”的现行问题；这些扩量均在请求文本中单独明确。Grok 跨岗位的“改条件通常新开task”是另一个自述方法，不可拿来判此处同条件续跑错误。

实际 reply 回执时间/版本（均为2026-10-18 UTC）：原10复核03:50:37.130Z / `v_f6472d2bee`；扩到100为03:55:09.547Z / `v_86357144c3`；扩到200为04:10:58.112Z / `v_90e4510847`。这些是provider opaque版本，不是产品Git SHA或可直接解释的model tier。

## 200 partial → 原件 → Top20/Top10 → UI

1. 2026-10-18 04:23:37.194Z，`stage-03-provider-200-terminal-receipt.json`：task completed、200 rows、**outcome partial**；provider说20人有五项引文证据，其余51 Promising /103 Partial /26 Uncertain。这是provider报告。
2. 原失败run其实已返回完整200行：`external-effect-result-[private effect identity]-diagnostic.json`。后来保存恢复成10页、每页20行。**本次离线重新比较：所有行、单元格、顺序与该原始返回完全相等；10页SHA也全部匹配当时manifest。**
3. 本次机械计数：200个非空distinct LinkedIn身份；旧100全部在；新增100；updated_rank恰好1–200。provider五个rule值全`match`的20行恰好等于Strong20。200个score全null。这只证实标签/数据结构，不证实引文真实或候选合格。
4. provider rank13/15 是关键反例：两人仍Strong且五规则match，但原始reasoning承认backend只在skills出现/实施未明、DB仅skills或没有明确relational/NoSQL implementation。此处没有重新评人；只是记录provider内部标签与说明的张力。
5. 11:59:12Z /12:00:40Z 的display replies返回opaque versions `v_a49a51234e` / `v_27a12f100c`。最后4份`stage-04-top-original-view-artifact-*.json`共20行。**本次重新比较：姓名、profile URL、rank、tier、score、resume值与原200中的累计rank1–20逐项相同；top10 flags正确。** 没有把源返回顺序的前20误当Top20。
6. 本次对 `v77-rendered-top20-restart-proof.json`（12:18:16.457Z）重新比较：两表共20行的姓名/profile/rank和前十星标全部与原200一致。它是历史UI捕获，不是当前生产检查。
7. `stage-04-top-final-chat.txt`明确保存partial限制、LinkedIn自述来源、缺resume/score、HIL未建立、Strong不等于verified qualification，并点名保留rank13/15对应的证据矛盾。最终展示没有宣称200全合格。
8. 历史展示问题：compact20输出全都遗漏title/company/location，曾把latest-source资料卡相关字段变空。v77捕获显示profile header修复；应称历史缺陷已见修复证据，不称当前main仍有问题。

完整源所有者机械校验结果见 [offline-verification.json](offline-verification.json)，无候选 PII。该校验没有重新访问候选来源或重新评分；本 checkout 没有重跑原件比较。

## 最多三个优先建议（不实施）

1. **先把比较的输入合同固定到一版，再评质量。** 同时保留原JD和明确接受的role feedback，并逐条标硬条件/偏好/例子/排除。以G6/G7/G14与R1的实际差异为检查清单；不要让历史3–10年、Staff排除、Bay Area硬限制或6个月模板默默进入新5+任务。缺少Grok wire-level request/output pair时，标“不足以判胜负”。
2. **不要把provider的Strong或五个match直接升级为“验证合格”。** rank13/15提供了直接反例。把结构verdict与supporting reasoning的不一致显示为待核实，明确source-read覆盖及自述来源；若未来获准核实，应定向处理冲突，不自动换人或增人。本次未作任何招聘决定。
3. **把展示投影与原始候选记录分开，并保留partial/版本链。** compactTop20曾使基础资料字段变空，证明这种混用会损伤体验。当前只建议对现有实现做离线回归核查：展示视图不覆盖200池，基础字段可回溯原页，rank/tier/未知不被展示“补齐”。v77已有修复证据，不建议未经检查重复改代码。

## 原件位置、时间、hash


| 引用 | 原件locator / UTC时间 | SHA256 |
|---|---|---|
| G6 | `G: owner-held message, entryId=[owner-held message locator]`；2026-10-09 00:25:36.532Z；7824 bytes | `1515a2eccda1d2b5286cc55bc4c16079f342ba7286f6c0e5d7ffff2008c115fa` |
| G7 | `G: owner-held message, entryId=[owner-held message locator]`；2026-10-10 20:23:31.896Z；2486 bytes | `1efcc5d4e9f13945599dea259605988a1345a950dcfd9a4beee7f0c10da6cd11` |
| G14 | `G: owner-held message, entryId=[owner-held message locator]`；2026-10-14 00:26:04.228Z；3362 bytes | `3e8d379a06ba92fabcb76d2ebfa7b493a8ccfde00e2828d33980959aa351e153` |
| R1 | `D/stage-01-actual-provider-prompt.txt`；实际接受03:40:11.225Z；本地保存03:41:27Z | `99d7ae424e71e2b5e19779ae195e794c2d8e4f18e11812e57d0c16e9f171d4b5` |
| R2复核 | `D/stage-02-actual-provider-feedback.txt`；本地保存2026-10-18 03:51:55Z | `8d651fed81a3960148c8805731534ee6dcd61699cc1a84b295ac7c819198b84d` |
| R2扩量 | `D/stage-02-expansion-actual-provider-feedback.txt`；本地保存03:55:54Z | `00f94bbc33164ede38a99a9d86fb6a7ad039d579cd55a58875b50740c56f4c8e` |
| R3 | `D/stage-03-actual-provider-feedback.txt`；本地保存04:12:11Z | `b21115f4a66280f7d4d8cf476c422817ef4cdc518c3ea1e3e107f0505ef62387` |
| 200 receipt | `D/stage-03-provider-200-terminal-receipt.json`；provider返回04:23:37Z | `0fc9273bcdd363e81076ff795f5bba925ce5d2f056a822c9ed531fe56d52e35a` |
| Top replies | `D/stage-04-top-format-all-reply-receipts.json`；本地保存12:02:46Z | `f21ad2bef4781d49feabd0ee7df2db0956506589fcc75a306f85b5573badc1db` |



## 更新的边界

源所有者最后一次有界 Grok UI 定位操作被自动审批拒绝，已知未执行、未重试且已关闭，没有 pending。它覆盖原报告较早的“没有审批阻塞”状态；详细理由见 [grok-ui-and-template.md](grok-ui-and-template.md)。Grok 同 run 的原始 request/output 对仍缺失，不为补证据新跑 Autumn。

原件公开安全元数据见 [source-metadata.json](source-metadata.json)：保留 byte count、SHA256、mtime 和聊天文本 digest；不发布绝对路径或原始候选行。统计 23/33 个索引项有重叠，不能相加为独立样本量。
