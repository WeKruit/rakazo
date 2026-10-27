# 架构工作计划（2026-10-27）

这份文件是架构优化的总清单。每一项写清楚四件事：查到的现状、做法、状态、验收指标。多人协作时，开工前把自己的名字写进「负责」，做完把状态改成「已合并」，并写上 PR 号。

状态明确区分实现、合入位置和验收：`本分支`/`代码已合并` 仅描述代码；`本地门禁通过` 不代表线上验收完成；`阻塞` 必须写明待授权动作；`进行中`/`待做` 不作完成声明。本轮小 PR 只合入 #263 的 `claude/project-thread-f1cbzk`，不合入 main。

验收指标分两种。一种是代码检查，本地就能跑。另一种是线上实测，要部署之后用真实流量或压测去量。

## 总览

| # | 方向 | 项目 | 状态 | 负责 |
|---|---|---|---|---|
| A1 | 数据库 | 查询走事务模式连接池，会话名额只留给监听和锁 | 已有上线记录（#259）；50 并发验收未测 | — |
| A2 | 数据库 | 账号隔离：在应用层过滤之外再加数据库行级安全（RLS） | 招聘首批隔离通过；本地性能未稳定达标，线上门禁未测，整体未完成 | Adam |
| A3 | 数据库 | 列表接口都分页、有上限 | 进行中 | Adam |
| A4 | 数据库 | schema 和迁移文件不一致 | 阻塞（线上外键元数据待核实，[#268](https://github.com/WeKruit/rakazo/pull/268)） | Adam |
| A5 | 数据库 | 对话开头到第一次搜索的查询次数（现 150–220 条，约 3–5 秒）：合并重复读取，缩短对话行锁 | 进行中 | Claude（工具出错率线程） |
| B1 | 任务队列 | 给对话预留任务槽，定时任务不能占满 | 本分支；本地回归通过，线上未测 | — |
| B2 | 任务队列 | 每分钟记录一次排队情况 | 本分支；部署后分钟日志未测 | — |
| C1 | 多容器 | 附件放对象存储 | 代码已合并（#260）；存储配置阻塞 | — |
| C2 | 多容器 | 电脑工作目录放对象存储 | 代码已合并（#262）；存储配置阻塞 | — |
| C3 | 多容器 | 手机推送 token 放数据库 | 本地门禁通过（[#272](https://github.com/WeKruit/rakazo/pull/272)），线上未测 | Adam |
| C4 | 多容器 | 应用内模型订阅登录的状态不能只存在进程内存里 | 本地验收通过（[#274](https://github.com/WeKruit/rakazo/pull/274)，线上未测） | Adam |
| C5 | 多容器 | web/API 和 worker 拆成两个服务，开多个容器，做滚动发布 | Adam 已认领；本地实现进行中，线上部署仍禁止 | Adam |
| C6 | 多容器 | 生产环境不用 `vite preview` 提供网页 | 本地门禁通过（[#265](https://github.com/WeKruit/rakazo/pull/265)），线上验收未完成 | Adam |
| D1 | 前端 | 首屏 JS 太大，要按需加载 | 进行中：第一步已在本分支（593 → 561 KB，见 D1） | Adam |
| D2 | 前端 | 服务端数据的缓存是手写的，要统一 | 本地验收通过，已合入 [#301](https://github.com/WeKruit/rakazo/pull/301) | Adam |
| D3 | 前端 | 长列表虚拟滚动 | 部分实现（候选人目录已本地验收，[#276](https://github.com/WeKruit/rakazo/pull/276)；消息及旧结果视图后续已本地验收，[#300](https://github.com/WeKruit/rakazo/pull/300) 待串行集成） | Adam |
| D4 | 前端 | 拆分超大组件文件 | 进行中 | Adam |
| F1 | Agent | 招聘逻辑写死在执行器代码里 | 部分实现（[#269](https://github.com/WeKruit/rakazo/pull/269)；业务验收未测） | Adam |
| E1 | 可靠性 | 告警 | 阻塞（禁止云日志平台配置与触发） | |
| E2 | 可靠性 | 压测：20 和 50 个并发对话 | 阻塞（缺获准的部署测试环境和在线压测范围） | |
| E3 | 可靠性 | 数据库备份恢复演练 | 阻塞（缺备份访问及隔离恢复目标授权） | |
| E4 | 可靠性 | 模型服务只有一个提供方 | 阻塞（禁止生产连接配置/停用主连接） | |
| F2 | Agent / 可靠性 | 回合守卫二期（#65 留下的 5 项） | 复查后 4 项已上线，1 项建议保持现状 | Claude（架构线程） |

---

## A. 数据库

### A1 连接池分流 — 已上线

- **现状：** `DATABASE_URL` 走 6543 事务模式连接池，`REALTIME_DATABASE_URL` 走 5432 会话模式。每个容器固定只占 6 个会话名额（API 1 个，worker 5 个）。任务槽从 10 个增加到 50 个。
- **验收（线上实测）：** 50 个并发对话时，`db.pool.wait` 的 `maxMs` 小于 500，并且没有 `EMAXCONNSESSION`。前一条要等 E2 压测来量。

### A2 账号隔离加数据库层保护

- **现状：** 隔离全靠应用层。每个查询都带 `spaceId`/`userId` 条件，隔离测试 268 项全过。92 张表里没有一张开了 RLS。目前没有暴露：`anon`/`authenticated` 两个数据库角色没有任何表权限，数据 API 连的也不是这个库。风险在于将来哪个查询漏写了条件，数据库这一层不会拦。
- **做法：** 先给存用户数据的表加 RLS 策略，按 `current_setting('app.user_id')` 过滤，从招聘相关表、消息表和附件表开始。连接身份用一个不带 `BYPASSRLS` 的角色，每个事务里用 `SET LOCAL` 设置当前用户（事务模式连接池支持这种写法）。后台任务和迁移用单独的角色。分批上线，每批先跑隔离测试。
- **验收（代码检查）：** 现有隔离测试全过。新增一个测试：故意漏掉 `userId` 条件查询别人的数据，结果必须是 0 行。
- **验收（线上实测）：** 开启 RLS 前后，RPC 的 p95 延迟变化小于 10%。

- **本地审计（2026-10-27，认领 `7fbaf515e`）：** 在全新、仅含合成数据的本地 PostgreSQL 16 数据库重放现有迁移，得到 92 张应用表、0 张启用 RLS、0 张 FORCE RLS、0 条 policy。以本地 fixture 的 superuser/BYPASSRLS 连接执行事务内 `set_config('app.user_id', synthetic_user_id, true)` 后，直接查询另一个合成账号的附件和招聘岗位仍分别返回 5 行和 1 行，**不满足漏过滤条件必须 0 行的验收**。这不是线上角色权限检查，也不证明生产账号可绕过应用层。
- **现有隔离基线：** 运行原 `infra/acceptance/account-isolation.mjs`，由原 testkit harness 启动本地 API、scripted runtime、fake sandbox 和 emulated email；只把 Docker 数据库启动替换为独立本地 PostgreSQL。报告为 `isolated`，143 项 `ok`、0 leak、0 warning；另有 99 项因测试副本缺少对应数据未触达。不能把这个结果写成历史 268 项全过，也不能当作新增 RLS 验收通过。`pnpm --filter @rakazo/db check` 通过（包含 cross-package tests 类型检查）。
- **真实数据库回归未全过：** 在未修改产品代码的 `e6b8446de` 上，`VERIFY_DATABASE=1` 的 recruiting 与 space-membership PostgreSQL 测试为 271 通过、12 失败；只把本地数据库默认时区设为 UTC 并重连后仍是 271/12。失败涉及 native source/role recovery、排序、calibration 和候选页可见性；不能把这些已有失败归因于尚未实现的 RLS，也不能忽略为已通过。数据库回归门禁仍未满足。
- **首次审计时的实现缺口（后续首批实现见下）：** `createDb` 返回共享 Prisma client；`createApp` 把它传给 auth、RPC 和后台回调，RPC context 有 actor 但没有绑定数据库事务身份。`recruiting.ts` 当前有 70 处 `$transaction` 调用，不能通过给整个 RPC 包一层长事务安全替代。还需明确并实现按调用传递的用户数据库 client、嵌套事务复用、流式订阅与后台操作的生命周期边界，以及消息通过 thread 归属访问的策略；然后加入非 superuser/非 BYPASSRLS 测试、漏条件 0 行测试、提交/回滚后身份不残留测试和全量隔离回归。没有加入未接线 helper、没有启用会阻断现有身份的 RLS 迁移。
- **确切权限阻塞：** 生产 API/worker/迁移角色分离、非 BYPASSRLS 运行身份和对应连接凭据的配置，需要数据库角色/授权及云配置变更；当前禁止这些操作，也禁止部署，所以没有尝试这些写入，状态为**待授权、未执行**，不是工具拒绝或结果不明。线上开启策略前后 RPC p95 <10% 的测量同样待部署授权。不能仅以本地 fixture 的角色配置替代生产身份验证。
- **连接预算：** 此审计未改应用、池或角色；生产约束仍是 `DATABASE_URL` 6543 transaction pooler、`REALTIME_DATABASE_URL` 5432，每容器 session 连接不超过 6。后续身份实现须使用事务内 `SET LOCAL`/`set_config(..., true)`，不能新增每用户常驻连接或把 SSE 生命周期变成长数据库事务。首批实现的本地验证见下，不替代生产池实测。

A2 本地审计复现（全新合成数据库，不能替换为生产 URL）：

```sh
# 已有只监听 loopback 的本地 PostgreSQL 16，创建独立空数据库。
createdb -h 127.0.0.1 -p 55434 -U postgres rakazo_a2
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @rakazo/db generate
# 临时 runner 保留原 testkit fixture/验收逻辑，仅替换数据库启动；完成后删除。
python3 - <<'PYRUNNER'
from pathlib import Path
source = Path('packages/testkit/src/cli/account-isolation.ts').read_text()
source = source.replace('import { PostgreSqlContainer } from "@testcontainers/postgresql";\n', '')
source = source.replace('const container = await new PostgreSqlContainer("postgres:16-alpine").start();', 'const container = { getConnectionUri: () => "postgres://postgres@127.0.0.1:55434/rakazo_a2", stop: async () => {} };')
Path('packages/testkit/src/cli/.a2-local-isolation.ts').write_text(source)
PYRUNNER
API_PORT=3194 pnpm exec tsx packages/testkit/src/cli/.a2-local-isolation.ts --out /tmp/rakazo-a2-isolation.json
rm packages/testkit/src/cli/.a2-local-isolation.ts
pnpm --filter @rakazo/db check
# 以下回归基线未全过：271 passed / 12 failed。
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a2 VERIFY_DATABASE=1 pnpm test packages/db/src/recruiting.postgres.test.ts packages/db/src/space-membership.postgres.test.ts
psql postgres://postgres@127.0.0.1:55434/rakazo_a2 -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) FILTER (WHERE c.relname <> '_prisma_migrations') AS application_tables,
       count(*) FILTER (WHERE c.relrowsecurity) AS rls_enabled,
       count(*) FILTER (WHERE c.relforcerowsecurity) AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r';
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user;
SELECT count(*) AS policies FROM pg_policies WHERE schemaname='public';
BEGIN;
SELECT set_config('app.user_id', (SELECT id FROM "user" WHERE email='b@isolation.test'), true) IS NOT NULL AS synthetic_actor_context_set;
SELECT count(*) AS foreign_artifacts_visible_without_filter FROM artifacts WHERE "userId" <> current_setting('app.user_id');
SELECT count(*) AS foreign_roles_visible_without_filter FROM recruiting_roles WHERE "userId" <> current_setting('app.user_id');
ROLLBACK;
SQL
```


### A2 首批实现（默认关闭，尚未上线）

- 新增独立受限角色的 `ACTOR_DATABASE_URL`，仅用于已认证 RPC 的 Prisma、events 和 memory composition；auth、webhook、worker 和迁移继续使用原有明确的系统身份。受保护 client 缺 actor 时直接报错，绝不退回系统 client。启动拒绝 superuser、BYPASSRLS、受保护表 owner/owner 成员及附加 permissive policy。
- 通过 Prisma 原生 driver-adapter 边界在每个短查询事务或原生 batch/callback 事务中 `set_config(..., true)` 绑定 user/space；事务提交/回滚恢复身份，异步迭代器每次拉取重新绑定同一 actor，不为整个 SSE 持有事务。RPC 使用已有原语，没有第二套业务服务。
- 首批策略明确覆盖 `artifacts`、`messages`、`recruiting_roles`；用户、Space 和当前 membership 都须匹配。脚本 `packages/db/prisma/rls/first-batch.sql` 只显式执行，不混入自动迁移。其他用户数据表仍待分批策略覆盖；不把这三张表的验收当成全部 92 张表的数据库级隔离。
- 本地真实 PostgreSQL：新增 6 项通过，覆盖省略所有应用层 owner 条件仍不见他人行、跨用户写入拒绝、membership 撤销、缺 actor 拒绝、权限过大角色/额外宽松策略拒绝、native batch/callback 事务回滚后不残留身份，以及同一连接上并发 actor 和延后消费流的隔离。每个 actor client 测试池只有 1 条连接，流等待期间连接处于 idle。
- 启用该路径后的原 API synthetic isolation：143 项 OK、0 leak、0 warning、99 项未触达，与关闭时相同。db/api/testkit 类型检查通过；db 单测 1,216 通过 / 362 跳过；API 单测 1,322 通过 / 50 跳过。上述历史真实数据库 12 个回归失败仍需集成修复后复验，未被此处掩盖。
- 可复现本地 artifact RPC benchmark：同一个合成数据库与账号，先预热 20 次，再每种配置请求 200 次，并发 5；关闭时 p50/p95/max = 6.84/11.71/15.04 ms，开启后 = 7.45/12.06/20.50 ms，错误均为 0，p95 增幅 **2.99%**。仅为 loopback 本地测量，不是线上 p95 <10% 验收。
- 池影响：默认不开启时无变化；启用时新增受限身份的 transaction-pooler pool（上限同 `DB_POOL_MAX`），API 最大 transaction checkout 客户端数从 N 增至 2N。生产 `ACTOR_DATABASE_URL` 强制 6543；原 `DATABASE_URL` 6543、`REALTIME_DATABASE_URL` 5432 不变，不新增 LISTEN/session pool，每容器原 6 条 session 预算不变。两个 API pool 都参与退出清理。实际生产后端并发占用和连接等待还没测。
- 完整首批配置与命令见 [A2-RLS-PILOT.md](./A2-RLS-PILOT.md)。生产角色、grants、凭据、策略启用和发布均未执行；这些依然需要当前范围之外的授权。

- **后续本地策略批次（未发布）：** 扩至 6 表，新增岗位版本、候选人选择、校准轮次；组织成员撤销与跨父记录写入增加真实 PG 验证，8/8 通过；db/api/testkit 类型检查通过。全部 92 表已分类，86 表仍待实现和各自验收，见 [A2 覆盖清单](A2-RLS-COVERAGE.md)。六表 API 隔离复测 143 OK、0 leak/warning、99 owner-empty 未触达；原三表延迟数字不代表此扩展批次复测；A2 整体仍未完成。远端 push/PR/merge 按父线程通知暂停，未重试。

- **招聘首批完整边界（本地、未发布）：** 全部 22 张 recruiting 表及消息/附件/线程/任务/运行/事件/回执依赖，共 29 表；11/11 真实 PostgreSQL 测试通过，每表双账号非空、漏过滤无外账号数据、合法 own 写入、15 类跨父关联 RLS 拒绝、双 Space 成员及组织撤销。增强 API fixture 为 144 OK、0 leak/warning、98 owner-empty 未触达；db/api/testkit 类型检查通过。其他 63 表属于后续个人数据批次或独立认证/共享/系统语义，不全部计作本批缺口。首轮完整批次本地 p95 9.32→16.25 ms（+74.36%，0 errors），**性能尚未达标**；统一静默窗口 B/R/R/B/B/R 六轮中三对 p95 +19.51%/+60.52%/+42.72%，全部未达 <10%；不能沿用历史三表 +2.99%。见 [边界及证据](A2-RLS-COVERAGE.md)。线上激活和 p95 尚未测，发布暂停；整体不标完成。

- **策略规划窄优化（未发布）：** 重复 membership 联结改为接线的 STABLE / SECURITY INVOKER 函数，固定 search_path，禁止跨请求身份/权限缓存；startup 拒绝 DEFINER/IMMUTABLE。15 类跨父写入与 29 表非空/撤销/双 Space 验证保留，12/12 真实 PG 测试通过。修正 callback/Promise 完成计时后，同一业务 SQL 平均 2.2746→1.1078 ms，EXPLAIN planning 1.724→0.411 ms；不是 HTTP p95 达标证明。第二次静默 HTTP 六轮完整保留，三对 p95 +58.16%/+5.93%/+16.52%，仅一对 <10%，本地对照未稳定达标，须上线前性能评审。正式线上 <10% 门禁因禁止部署仍是「还没测」，与本地开销证据分别记录。

- **继续性能定位（本地）：** membership helper 改为静态 PL/pgSQL RETURN EXISTS，保留 INVOKER/STABLE/固定 search_path，只复用查询计划、不缓存 actor/权限结果。12/12 安全测试通过；200 次微基准 RLS business mean 1.1078→0.8169 ms，总 286.181→220.614 ms；EXPLAIN execution 0.566→0.181 ms。后续统一静默 HTTP 六轮三对 +16.17%/+48.85%/+74.33%；保留全部 raw trace 后真实 pooled p95 8.183625→13.029083 ms（+59.21%，600/600 请求，0 errors），仍未达本地目标。并发5/pool4诊断指出 checkout p95 0.5642→1.2461 ms及3条额外事务命令；不加连接预算、不缓存权限、不降低指标。正式线上门禁仍未测。

- **最新集成门禁：** 普通合入 #263 `8188c88f3c58299030b8dbfb2ea128144c2a8755`，保留分页与 actor middleware。db/api/testkit 类型检查通过；DB 单元 1216 pass/373 skip、API 单元 1377 pass/51 skip、真实 PG RLS+recruiting+membership 298/298。最终 API 合成隔离 144 OK/0 leak/0 warning/98 owner-empty 未触达。发布仅为 Draft 审查，性能未达与线上未测状态不变，不自行合并。

- **发布操作结果：** 普通 push 在进程启动前再次被自动审批拒绝（未识别该次外部发布的可信用户授权），已知未执行；未换路径、未创建 Draft PR、未合并。保留本地提交与上述实测，待可被审批识别的新授权；性能门禁状态不因此改变。

- **公开 pipeline 后续（仅本地）：** actor 专用池使用 pg 8.23 公共 pipeline，将参数化事务内 SET 与业务查询顺序入队；全部结算后才提交或回滚，不缓存身份/权限。30 项针对性测试通过（18 PG +12 client），包含取消、断连、SET 失败、解码失败回滚。两套独立静默六轮原始样本已保存：串行预热 pooled600/600 p95 8.700708→9.427667 ms（+8.36%），并行预热 9.117208→9.345500（+2.50%）；局部 pooled <10%，但配对仍有超限，不能称稳定/线上达标。查询池均显式 max4；预热差异及完整记录见 pilot 文档。生产 pooler/线上门禁未测，发布被审批拒绝后未重试。

- **发布状态更新：** 新授权后普通 push 成功，首批实现 Draft PR [#296](https://github.com/WeKruit/rakazo/pull/296)，base 为 `claude/project-thread-f1cbzk`；尚未合并。此前审批拒绝记录保留为历史，当前不再是发布阻塞。线上门禁及稳定性能限制不变，A2 仍未完成。

### A3 列表分页

- **现状（已查）：** 消息（`thread-message-pages.ts`）、候选人（`listRecruitingCandidates`，每页 25 条，游标分页）、反馈都已经是游标分页。用量记录取 100 条，电脑命令历史也有上限。`router.ts` 里 38 处 `findMany` 没写 `take`，查下来基本都是单个用户自己的设置列表，量很小。还剩两处要改：
  - `recruiting.ts` 联系人视图会一次读出整个岗位的全部 `candidateKey`。
  - 机器人列表和群组列表是一次全部读出。
- **验收（代码检查）：** 任何列表 RPC 单次返回不超过 200 行。
- **验收（线上实测）：** 有 1,000 个候选人的岗位，联系人视图的 RPC p95 小于 300 ms。
- **Adam 实施记录（仍进行中）：** [PR #277](https://github.com/WeKruit/rakazo/pull/277) 覆盖机器人/群组、导航/bootstrap、联系人有界读取及 Web/Mobile 自动续页；为另外 31 个数组列表与 5 个结构化列表增加明确 offset，认证后的 RPC 响应每个列表最多 200 条，客户端完整续页。没有截断写操作的回执。后续已将其中 28 个读接口分页下推到数据库（稳定排序、take/skip 或 SQL LIMIT/OFFSET），其余 8 个为静态/外部 provider 目录或已有 10/100 条上限的集合，边界区别见验收记录。
- **实测与限制：** 见 [A3 本地验收记录](./A3-PAGINATION-VALIDATION.md)。合成 PostgreSQL 数据 1,000 候选人，100 次采样：原全岗位查询 1,000 行、p95 0.88 ms；按已观察身份查询 20 行、p95 0.49 ms。机器人 1,000 条在 `200/200/200/200/200/0` 六页中无遗漏、无重复。真实本地 HTTP+PostgreSQL 的 1,000 人联系人 RPC：首轮 p95 32.44 ms，此前复测 p95 26.37 ms，F1 合入后发布门禁复测 p95 26.58 ms（各 100 samples/10 warmups）；固定合成 session actor，其余授权和 DB 查询真实。实际浏览器 contacts 1×1000→5×200 请求，JS gzip 625,224→626,840 bytes。后续整份 recruiting PostgreSQL 回归 285 passed、候选人单元 425 passed、DB 含 cross-package 类型检查通过。**线上联系人 RPC p95 还没测，不标完成**。没有部署、云配置变更或真实岗位/候选人测试。


### A4 schema 和迁移不一致 — 阻塞，尚未通过验收

- **纠正现状（2026-10-27 本地实测）：** 在独立 PostgreSQL 16.15 空库重放全部 129 个迁移成功。四个外键**都存在**，不是缺失；差异是迁移默认的 `ON UPDATE NO ACTION` 与 Prisma 未显式指定 `onUpdate` 时的 `CASCADE`：
  - `computer_updates_computerId_fkey`
  - `recruiting_crm_sync_progress_userId_fkey`
  - `recruiting_crm_sync_progress_spaceId_fkey`
  - `recruiting_crm_workspace_attachments_roleId_fkey`
- **两个独立比较：** 已迁移的本地数据库 → `schema.prisma`，以及迁移目录（使用独立 shadow database）→ `schema.prisma`，都返回相同的 4 个 `DROP CONSTRAINT` 和 4 个 `ADD CONSTRAINT ... ON DELETE CASCADE ON UPDATE CASCADE`。Prisma 的 `--exit-code` 为 2（差异不为空；pnpm 包装进程退出 1），因此 A4 的空 diff 验收**未通过**。
- **阻塞与边界：** 已通过现有 Supabase 连接执行只读 `current_database()` / `to_regclass()`；工具连接的是 `postgres`，两张目标表均不存在。产品实际使用独立 `rakazo` 数据库，当前工具没有数据库选择参数，故尚未取得该库四个外键的线上元数据。需要现有授权的 `rakazo` 只读元数据连接或维护者提供同一查询结果；不需要读取任何用户行。未尝试猜测、提取或输出凭据，未修改线上数据库。操作因连接目标不匹配而阻塞，不是权限审批拒绝。
- **决定：** 不依据错误的“缺外键”假设新增或替换外键，也不擅自把 schema 改成假定的线上状态。拿到正确元数据后，明确保留 `NO ACTION` 还是迁移为 `CASCADE`，再改 schema 或生成经验证的替换迁移。当前仅更新证据，没有数据库/连接池代码变更，新增会话连接为 0；生产的 `DATABASE_URL` 6543 事务池与 `REALTIME_DATABASE_URL` 5432 会话池预算未改。
- **本地检查：** Node 24.19.0、pnpm 9.15.0；`pnpm --filter @rakazo/db generate` 与 `pnpm --filter @rakazo/db check` 通过（仓库类型检查脚本是 `check`）；`pnpm --filter @rakazo/db test` 为 1,216 通过、356 跳过，39 文件通过、12 文件跳过。跳过项不作已验证声明。未部署、未改云配置、未读取真实岗位/候选人，CI 保持关闭。
- **认领：** Adam 认领提交 `45da1c8d1` 已先推入 #263 分支，随后才进行上述本地核对。

本地复现（仅指向新建的可丢弃本地库，禁止将 shadow URL 指向生产）：

```sh
createdb -h 127.0.0.1 -p 55434 -U postgres rakazo_a4
createdb -h 127.0.0.1 -p 55434 -U postgres rakazo_a4_shadow
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a4 pnpm --filter @rakazo/db exec prisma migrate deploy
DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_a4 pnpm --filter @rakazo/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code
pnpm --filter @rakazo/db generate
pnpm --filter @rakazo/db check
pnpm --filter @rakazo/db test
```

迁移目录比较使用临时 `packages/db/prisma.a4.config.ts`（核对完删除，不提交备份）：

```ts
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: "postgres://postgres@127.0.0.1:55434/rakazo_a4",
    shadowDatabaseUrl: "postgres://postgres@127.0.0.1:55434/rakazo_a4_shadow",
  },
});
```

```sh
pnpm --filter @rakazo/db exec prisma migrate diff --config prisma.a4.config.ts --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script --exit-code
```

所需线上只读检查（当前 Supabase 工具只完成第一条；外键查询仅在本地执行）：

```sql
SELECT current_database() AS database_name,
       to_regclass('public.computer_updates') IS NOT NULL AS has_computer_updates,
       to_regclass('public.recruiting_crm_contacts') IS NOT NULL AS has_crm_contacts;

SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'f'
  AND conrelid IN ('computer_updates'::regclass,
                  'recruiting_crm_sync_progress'::regclass,
                  'recruiting_crm_workspace_attachments'::regclass)
ORDER BY conrelid::regclass::text, conname;
```

## B. 任务队列

### B1 给对话预留任务槽 — 本 PR

- **现状：** 一个 agent 回合从头到尾都占着一个任务槽，等模型回复的时候也占着。定时任务、webhook、工单和云端 agent 的运行跟对话共用同一组槽，之前只是排得靠后（priority 10）。一旦槽全被占满，招聘者的对话就要排队。
- **做法：** 在 `run.continue` 的处理里加一道限制：每个进程里，定时类运行最多占 3/5 的槽。超过上限时，这个任务 5 秒后再试。交接（`bot_message`）和研究结果（`recruiting_research`）不受限制，因为这时候有人在等。
- **验收（代码检查）：** 新增的单元测试覆盖三点：超过上限的定时运行会延后，对话运行不受影响，有槽空出来后定时运行能接着跑。
- **验收（线上实测）：** 定时任务集中触发的时候，`jobs.queue.readyChats` 一直是 0。

### B2 排队指标 — 本 PR

- **做法：** worker 每分钟写一条 `jobs.queue` 日志，字段有 `slots`、`ready`、`readyChats`、`oldestReadySeconds`、`running`、`exhausted`。
- **验收：** 部署后，日志里每分钟都有一条。E1 的告警就用这几个字段。

## C. 多容器

C1–C3 的代码已经合并。存储配置（一个存储桶加 3 个 Secret 值）生效之后，执行 `pnpm --filter @rakazo/api artifacts:copy`，把卷上已有的附件和工作目录拷进桶里。

### C3 推送 token 持久化 — 本地回归修复

- **2026-10-27 实测发现：** 本地 PostgreSQL 会话时区为 America/Chicago 时，已过期会话仍能注册 token。Prisma 的 UTC 无时区 `expiresAt` 与 `now()` 隐式比较会引入数据库时区偏移；已有真实 PostgreSQL 测试出现 1 失败 / 9 通过。
- **修复：** 比较 `expiresAt > (now() AT TIME ZONE 'UTC')`，保留事务内行锁与 token 唯一归属。新增 UTC、America/Chicago、Asia/Tokyo 下过期拒绝和有效接受的 PostgreSQL 测试。运行时新增连接为 0，连接池预算不变。
- **结果：** `DATABASE_URL=postgres://postgres@127.0.0.1:55434/rakazo_root VERIFY_DATABASE=1 pnpm test packages/adapters/src/expo-push.postgres.test.ts packages/adapters/src/expo-push.test.ts apps/api/src/artifacts.postgres.test.ts`：35/35 通过；`pnpm --filter @rakazo/adapters check`、两文件 Biome 和 `git diff --check` 通过。全是本地合成用户/会话/token，无真实设备推送。
- **记录：** 认领 `9c967a3bb`，实现 `9d28721fd`，[PR #272](https://github.com/WeKruit/rakazo/pull/272) base 为 #263 的分支。真实跨容器推送、生产部署尚未测。

### C4 应用内模型订阅登录

- **现状：** `pi-oauth.ts` 里的 `PiOAuthLogins` 把整个登录流程放在进程内存里，包括设备码轮询、等用户粘贴授权码，以及登录结果。如果用户的 `complete`/`submit` 请求落到了另一个容器，就会报「找不到登录会话」。MCP 授权和令牌刷新已经通过数据库协调，没有这个问题。
- **做法：** 登录流程继续留在发起它的容器里跑（流程由 pi 库驱动，不重写），但把会话状态写进数据库：状态、错误和归属的容器。拿到凭证以后，由发起登录的那个容器自己保存，不再等客户端来取。任何容器收到 `complete` 都去读数据库里的状态。用户粘贴的授权码先加密存进数据库，再用 Postgres `NOTIFY` 通知发起登录的容器。
- **验收（代码检查）：** 新增测试：两个 `PiOAuthLogins` 实例共用一个数据库，在 A 上开始登录，在 B 上粘贴授权码并完成，凭证只保存一次。

- **实现与认领：** Adam 认领已先提交并推送（`995ec0ede`）；实现 `dcf40ab3b`、旧收据替换修正 `48eccac6c`，Draft [#274](https://github.com/WeKruit/rakazo/pull/274) base 为 `claude/project-thread-f1cbzk`。保留原 Pi 流程，新增持久化协调器和 `model_oauth_sessions` 加法迁移；发起进程自动保存凭证，其他进程只读结果收据。授权码使用现有 SecretStore 的 ephemeral 加密，NOTIFY 只含不透明会话 ID，复用现有 realtime LISTEN；丢失通知由仅针对本进程活跃登录的轮询补查。
- **本地实测（Node 24.19.0 / pnpm 9.15.0 / PostgreSQL 16）：** 12 个新 PostgreSQL 场景和 108 个既有 OAuth 测试，共 120/120 通过。A 开始、B 提交并完成；保存回调 1 次、凭证行 1 行；重复和并发 finish 不重复保存。覆盖用户/空间隔离、远程取消和保存竞态、provider 全空间取消、设备码自动保存、过期、替换、丢失 NOTIFY、owner 丢失时不重放不确定写入、错误脱敏；America/Chicago 和 Asia/Tokyo 连接下未过期会话成功、已过期会话拒绝。所有 SQL 时间比较和初始过期时间以 UTC 计算；持久化结果经现有 ModelCredentialSchema 过滤，只保留公开模型 DTO，不保存 access/refresh 或多余 credential 字段。API 1,321 通过 / 50 跳过；adapters 全包当次 5,125 通过 / 52 跳过（包含当时 8 个 C4 DB 场景，已另行实跑；之后另加 2 场景并纳入上述 118 个实跑）。db/adapters/api 类型检查、API bundle、Biome 和 diff 检查通过。
- **连接预算：** 没有创建新连接池或 LISTEN 客户端；查询走现有事务池，通知复用现有 listener。保持 `DATABASE_URL` 6543 transaction pooler、`REALTIME_DATABASE_URL` 5432 和现有 API 1 + worker 5 = 6 会话预算。预算未因本项改动，线上连接数还没测。
- **限制：** 仅本地合成用户和凭证，未部署、未变更云配置/Secret/资源/CI。实际多容器路由、真实 OAuth 提供方、线上会话数、硬杀进程后的恢复还没测。owner 死亡不会重跑不确定保存，也不会接管 pi 库登录流程；会话到期后用户重新登录，成功收据在有效期内可从任何实例读取。迁移尚未在线上执行。既有跳过场景未验证。

```sh
pnpm --filter @rakazo/db generate
DATABASE_URL=postgres://postgres@127.0.0.1:55484/rakazo_c4 pnpm --filter @rakazo/db migrate
VERIFY_DATABASE=1 DATABASE_URL=postgres://postgres@127.0.0.1:55484/rakazo_c4 pnpm test packages/adapters/src/pi-oauth-durable.postgres.test.ts packages/adapters/src/pi-oauth.test.ts
pnpm --filter @rakazo/adapters test
pnpm --filter @rakazo/api test
pnpm --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/db check
node scripts/bundle-server.mjs api
pnpm exec biome check apps/api/src/app.ts apps/api/src/router.ts packages/adapters/src/index.ts packages/adapters/src/pi-oauth.ts packages/adapters/src/pi-oauth-durable.ts packages/adapters/src/pi-oauth-durable.postgres.test.ts
git diff --check
```


### C5 拆服务、多容器、滚动发布

- **本地基础实现（仍未完成）：** 认领 `558f876037ae931f8a8a47508adf06d3075fe756` 普通 push 后，提取可独立启动 API/worker 的进程生命周期，增加 SIGUSR2 非取消排空、只读健康状态和超时拒绝替换工具。真实本地 PostgreSQL/Graphile 双 worker：旧任务完成一次，新任务由另一个 worker 执行；21 个 TS 测试、62 个 Python 测试通过，worker 类型检查和 API/worker 打包通过。详细命令和边界见 [C5-LOCAL-DRAIN.md](./C5-LOCAL-DRAIN.md)。真实 Modal 双服务定义尚未实施，不添加占位入口；现有生产入口/资源/Secret/发布保护不变。
- **全局预算与剩余：** API 1、worker 5 会话；各两容器稳定 12，新增一个替换 worker 就到 17，整代重叠 24，超过既有总额 15。6543/5432 验证和预算检查已实现，线上 high-water 未测。共享 home 权威指针迁移及旧写者排除、逐 worker 排空替换发布控制器尚未完成；没有用本地通过冒充线上滚动/对话不中断验收。

- **现状：** `infra/modal/app.py` 只有一个服务，设置是 `max_containers=1` 加 `nonpreemptible`，发布方式是 `--strategy recreate`。所以每次发布都会中断服务。
- **做法：** 拆成 web/API 和 worker 两个服务。worker 本来就靠租约和 fencing 处理多实例，可以直接开多个容器。API 无状态之后，`max_containers` 改成大于 1，再换成滚动发布。
- **验收（线上实测）：** 发布期间每秒探测一次首页和一个 RPC，失败数为 0，并且发布期间对话没有中断。

### C6 生产环境不用 `vite preview`

- **现状：** 线上网页由 `vite preview` 提供，`/rpc` 和 noVNC 屏幕也是它代理的。
- **做法：** 网页静态文件改由 API 进程或 CDN 提供，屏幕代理（HTTP 和 WebSocket）移到 API。这部分涉及安全，要带测试。
- **验收：** 生产镜像里不再运行 `vite`。首页 TTFB p95 小于 200 ms。

- **实现（C6，2026-10-27）：** Modal 改为仅启动 API 和 worker 两个 Node 进程。API 进程提供静态网页、公开 API/RPC 路由和 HTTP/WebSocket 屏幕代理，内部路由保持 loopback。屏幕代理抽入共享 core 模块，保留授权复查、撤权断流和响应隔离。没有新建数据库池或会话连接；现有连接池配置未改。
- **认领与 PR：** Adam 先把认领提交 `d1cdbb74d64fe289fa74b79b7ade010fe7f1ddbc` 普通 push 到 `claude/project-thread-f1cbzk`，再实现 `f7c4ae4501f91cb2d96d5f3e011ad127b978ff94`；Draft [#265](https://github.com/WeKruit/rakazo/pull/265) 的 base 为该集成分支。
- **本地实测：** Node 24.19.0、pnpm 9.15.0。core 1,231 通过 / 5 跳过，API 1,321 通过 / 50 跳过，web 1,649 通过；三个包类型检查通过。屏幕浏览器测试 12/12 通过（development、preview、production 各 4 项），包含直接导航、iframe 隔离、资产重试、WebSocket 和撤权。生产网页构建、API 打包、Biome、diff 检查通过。Modal 源码 AST 检查：2 个 Node 服务，0 个 Vite 运行命令。
- **TTFB 前后对比：** 同一个本地生产网页构建，每种实现先预热 20 次，再 200 次请求、并发 20、gzip、keepalive。Vite preview 的 p50/p95/max 为 3.17/5.26/6.77 ms；API 网页监听器为 4.07/7.49/9.89 ms；两者错误均为 0。新实现本地 p95 7.49 ms < 200 ms，不把此次变更说成延迟改善。
- **补充前端量测：** 相同构建、全新浏览器 context、登录初始页、同一组本地 API 假响应，阻断外部资源；实际第一方页面请求 **23 → 23**，JS 请求 **16 → 16**，加载 JS 原始字节 **2,060,246 → 2,060,246**，逐文件 gzip 合计字节 **627,429 → 627,429**。这些是页面加载的真实请求计数，不是 TTFB 压测样本数；C6 没有减少 JS 负载，D1 单独负责。未测试已登录岗位页面。
- **还没测 / 范围：** 未部署，线上区域 TTFB、实际 Modal 镜像启动、真实屏幕提供方/TLS、生产流量中的进程退出还没测；55 个已有跳过测试未验证。此次目标是 WeKruit Modal，其他 Compose/desktop preview 启动方式未迁移。仅用本地假服务，没有真实岗位/候选人、外发消息、云配置或 Secret 变更；CI 保持关闭。这里的「完成」指实现和本地门禁完成，不代表上线验收完成。

复现命令（仓库根目录，使用 Node 24.19.0；仓库类型检查脚本名是 `check`，没有 `typecheck`）：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @rakazo/db generate
pnpm --filter @rakazo/api --filter @rakazo/core --filter @rakazo/web check
pnpm --filter @rakazo/api --filter @rakazo/core test
pnpm --filter @rakazo/web test
PLAYWRIGHT_BROWSERS_PATH=/tmp/rakazo-c6-browsers pnpm --filter @rakazo/web exec playwright install chromium --only-shell
PLAYWRIGHT_BROWSERS_PATH=/tmp/rakazo-c6-browsers pnpm --filter @rakazo/web exec playwright test -c playwright.screen-proxy.config.ts
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build
node scripts/bundle-server.mjs api
PLAYWRIGHT_BROWSERS_PATH=/tmp/rakazo-c6-browsers RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec tsx scripts/measure-public-page.ts
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec tsx scripts/benchmark-public-web.ts
pnpm exec biome check apps/api/src/public-web.ts apps/api/src/public-web.test.ts apps/api/src/index.ts apps/web/vite.config.ts apps/web/e2e/screen-proxy-isolation.spec.ts apps/web/scripts/benchmark-public-web.ts packages/core/src/node/novnc-proxy.ts packages/core/src/node/screen-proxy.ts packages/core/src/node/screen-proxy.test.ts packages/core/src/node/novnc-html.ts packages/core/src/node/novnc-html.test.ts packages/core/package.json
git diff --check
python3 - <<'CHECK'
import ast
from pathlib import Path
p = Path('infra/modal/app.py')
tree = ast.parse(p.read_text())
services = next(n.value for n in ast.walk(tree) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'services' for t in n.targets))
value = ast.literal_eval(services)
assert [name for name, _ in value] == ['api', 'worker']
assert all('vite' not in ' '.join(cmd) for _, cmd in value)
assert 'env["WEB_STATIC_DIR"] = "/app/apps/web/dist"' in p.read_text()
print('2 Node services; 0 Vite runtime commands; static root configured')
CHECK
```


## D. 前端

### D1 首屏 JS

- **独立后续本地验收：** 以 D4/D2/D3 独立依赖为基线的 D1-only 重放已完成；中文合成已登录聊天实际首屏 JS 529,849 → 325,964 gzip B，完整 Web 1,676 测试、五包类型检查及冷加载即时反馈检查通过。350 KB 第一阶段通过；250 KB 最终目标和线上 LCP 尚未完成。依赖顺序、逐提交映射、其他页面限制与复现命令见 [D1-INDEPENDENT-FOLLOWUP.md](./D1-INDEPENDENT-FOLLOWUP.md)。暂未发布该后续 PR。

- **现状（本地 `vite build` 实测）：** 首屏要加载的 JS 合计 594 KB（gzip 后）。主包 1.18 MB（未压缩），gzip 后 338 KB。主包里占得最多的是：react-dom 171 KB、`Shell.tsx` 147 KB、`RecruitingPanel.tsx` 113 KB、`ModelSettingsOverlay` 29 KB、`RecruitingCorrespondence` 24 KB、`RoutineEditor`、`InterviewCalendar`、`SchedulingPlan`、`DetailPanel`、markdown 解析器。路由页面已经是按需加载的。
- **本 PR 已做：** 本地设置页、集成设置页和 MCP 授权回调页改成按需加载，联系人、面试、邮件往来这几个视图也改成按需加载（`recruiting/LazyViews.tsx`）。另外把 `PersonAvatar` 移进 `ProfileImage.tsx`，断开了 DetailPanel 和 CandidateDirectory 之间的循环引用。首屏 JS（gzip -9）从 592,955 字节降到 561,040 字节。
- **剩下的做法：** 第一屏用不到的面板改成 `lazy()` 加载：设置浮层、例行任务编辑器、邮件序列编辑、面试日历、排期计划、候选人详情。markdown 解析器在第一条消息渲染时再加载。打开这些面板时要有加载占位，不能出现空白。
- **验收（代码检查）：** 用 `vite build` 计算首屏 JS，gzip 后不超过 350 KB（第一阶段），最终目标 250 KB。
- **验收（线上实测）：** 在 Lighthouse 的移动端模拟环境（Fast 4G）下，LCP 小于 2.5 s。
- **本地阶段结果（未完成）：** 认领 `f28310991` 后实现 `57a037621`：按需加载 Shell/本机设置路由、可选面板、例行任务编辑器和首条消息渲染器；首次 Markdown 加载期间仍显示安全的纯文本。设置/面板用局部 Skeleton，不让冷加载清空整个 Shell。共享 contracts/core 模块标为无导入副作用，ui-web 保留 CSS 副作用，允许构建器移除未用模块。没有修改验证逻辑或删 schema。
- **实测口径：** Node 24.19.0、生产 `zh-CN` 构建，gzip 为每个实际 JS 文件 gzip 字节之和。静态入口闭包 594,217 → 238,200 B；入口加 Shell 静态依赖 594,217 → 397,601 B，**仍大于 350 KB**。真实本地 Chromium 冷启动：登录页 629,622 → 273,491 B、总请求 26 → 56、JS 请求 16 → 49；合成已登录单条消息聊天 626,677 → 504,041 B、总请求 47 → 101、JS 请求 15 → 69。更多小分块增加请求数；不能把静态入口达标当成已登录聊天达标。页面请求统计到目标内容出现后 1 秒，全部 API/auth 都是合成响应，不含真实岗位/候选人。
- **本地门禁：** web 1,650、chat-ui 143、contracts 296、core 1,231 测试通过（core 5 既有跳过）；web/chat-ui/contracts/core/ui-web 的 `check` 全通过，Biome 和生产构建通过。新测试覆盖局部 Skeleton、消息冷加载时文本可见和安全、现有测试等待真实动态模块完成。
- **第一阶段发布前复验：** 普通合并最新 #263 基线 `8188c88f3`（包含 A3 分页和 D3 候选虚拟列表），保留原始 lazy 实现；没有混入 D2/D4 或后续 D1 优化。修复合并后的重复 lazy 导入，Shell 测试等待真实冷加载按钮。web **1,655/1,655**、chat-ui **143/143** 通过；web/chat-ui/contracts/core/ui-web 五包 `check`、生产 zh-CN build、Biome 和 diff 检查通过。相同基线 dist 和浏览器脚本复测：登录页 **629,622 → 268,915 B gzip**，总请求 **26 → 48**、JS **16 → 40**；合成已登录聊天 **626,677 → 501,396 B gzip**，总请求 **47 → 97**、JS **15 → 65**。此组数字包含当前集成基线变化，不能归因全部来自 D1；最终 250 KB 和线上验收仍未达到/未执行。
- **剩余：** D1 尚未完成：已登录 350 KB 门槛、最终 250 KB 目标、Lighthouse Fast 4G LCP 均未验收；后续继续结合 D4 拆分降低初次真正加载字节及请求数。阶段小 PR 尚未发布，不得标完成。

D1 本地复现命令（从仓库根目录；浏览器需要已安装匹配的 headless Chromium）：
```sh
pnpm --filter @rakazo/web --filter @rakazo/chat-ui --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/ui-web check
pnpm --filter @rakazo/web --filter @rakazo/chat-ui --filter @rakazo/contracts --filter @rakazo/core test
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web build --manifest
node apps/web/scripts/measure-initial-js.mjs
RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web exec tsx scripts/measure-first-load.ts "$BASELINE_DIST" dist
```
`BASELINE_DIST` 是从认领前相同构建命令保存的独立 dist 目录；脚本输出完整逐请求列表和两种静态依赖口径。


### D2 数据缓存

- **现状：** 服务端数据都靠组件里的 `useEffect` 加手写缓存来取，例如 `Shell.tsx` 里的 `recruitingReadCache`。`Shell.tsx` 一个文件里就有 51 个 `useEffect`、109 个 `useState`。没有统一的请求去重、过期和失效机制。
- **做法：** 引入 TanStack Query 管理服务端数据。实时事件到达时，只让相关的查询失效。先迁移招聘面板的读取，再迁移其他部分。
- **验收（代码检查）：** 打开一个岗位页面时，同一个 RPC 带同样参数的重复调用次数为 0（在 e2e 里统计）。

- **D2 独立验收：** 基于 D4 `e0eb80130`；Query 缓存、带授权/新鲜绑定校验的 readView 与 A3 分页均保留。生产合成浏览器前后各三次：重复 RPC 4 → 0，总 RPC 21 → 17，JS gzip 515,958 → 526,190 字节（增加 10,232），JS 请求 70 → 70。web 1,664/1,664、API/readView+招聘合同 76/76、web/API/contracts 类型检查通过。详见 [D2 独立验收](D2-INDEPENDENT-RELEASE.md)。本地门禁通过，发布/合并尚待父任务串行操作，未声称线上验收。

### D3 长列表虚拟滚动

- **现状：** 消息和候选人列表都会把每一项渲染成 DOM，没有用虚拟滚动。
- **验收：** 有 1,000 个候选人的列表，渲染出来的行节点不超过 100 个，滚动时没有超过 50 ms 的长任务。

- **实现范围：** `ContactsTab` 使用的主 `CandidateDirectory` 表格/卡片超过 80 人后使用固定版本 `@tanstack/react-virtual` 3.14.23，测量实际高度、保留焦点行和稳定 key，支持 Home/End/上下箭头、响应式卡片分组，以及切换表格/卡片时恢复测量缓存和滚动位置。原有加载、选中和 shortlist 状态仍由调用者维护，不丢弃已加载候选人。没有新增用户可见文案。
- **认领/实现：** Adam 先推送认领 `09d5070b2`，实现提交 `0950da29b0a89243a08665d1a247174cb109f80e`，Draft [#276](https://github.com/WeKruit/rakazo/pull/276) 指向 #263 分支。
- **实测（Node 24.19.0，本地 Chromium，1440×900，生产构建的真实组件加 1,000 个合成人员）：** 表格初始行节点 1,000 → 14；30 个滚动位置的最大行节点 1,000 → 19；新卡片模式 30 个滚动位置最多 36 人，390px 响应式卡片也不超过 100 人。两次表格测量及新卡片测量均未记录到 >50 ms long task。键盘首尾导航、点击选中、shortlist 滚出/滚回后保持、滚动时焦点行保留、布局切换后恢复滚动全部通过。
- **前后成本：** 同一个冷启动 fixture 页面实际请求尝试数 5 → 5，其中 JS 请求 1 → 1（不是滚动采样次数；原有外部字体请求被测试拦截，计入尝试数）。fixture JS 原始字节 895,559 → 932,535，gzip 字节 286,325 → 297,386。完整应用静态入口及静态 imports 闭包为 14 个 JS，原始字节 1,987,089 → 2,024,057，gzip 字节 594,217 → 605,997（增加 11,780）。这是 D1 合入前的隔离对比，最终集成需重测，不作首屏减包声明。
- **门禁：** `pnpm --filter @rakazo/web check` 通过；web 141 个测试文件、1,649 个测试全通过；生产 build、Biome、`git diff --check` 通过；浏览器验收 1/1 通过（包含上述多项断言）。
- **尚未完成/未测：** 旧 `RecruitingPanel` 结果视图和带流式更新的聊天消息列表尚未虚拟化，因此整项 D3 未标完成。部署环境、真实页面/API 集成、其他浏览器、CPU 降速和辅助技术人工检查未测。仅本地合成数据，未调用真实岗位/候选人或外部服务；CI 保持关闭，故没有 CI 截图。

```sh
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web test
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest
PLAYWRIGHT_BROWSERS_PATH=/tmp/rakazo-c6-browsers D3_BASE_REF=5e99915aa pnpm --filter @rakazo/web exec playwright test -c playwright.candidates.config.ts
PLAYWRIGHT_BROWSERS_PATH=/tmp/rakazo-c6-browsers pnpm --filter @rakazo/web exec playwright test -c playwright.candidates.config.ts
pnpm exec biome check apps/web/src/pages/recruiting/CandidateDirectory.tsx apps/web/src/pages/recruiting/CandidateWindow.tsx apps/web/src/pages/recruiting/latency.test.tsx apps/web/e2e/candidate-virtualization.spec.ts apps/web/e2e/fixtures/candidates.tsx apps/web/playwright.candidates.config.ts apps/web/package.json
git diff --check
```


### D3 #276 发布前刷新（候选列表独立范围）

- 普通合并 #263 最新分支 `168fcaacc`，合并提交 `600d11f7b`；头像导入冲突保留新的 ProfileImage 模块与虚拟窗口 hooks。没有引入 D1/D4 的 Shell 拆分或聊天 Transcript 实现。
- 相同生产 fixture 对当前 base 的前后重测：1,000 合成人选初始/最大表格 DOM **1,000/1,000 → 14/19**，卡片最大 **36**；两侧均没有 >50ms 的测量滚动长任务。实际冷页面请求 **5 → 5**、JS 请求 **1 → 1**。fixture 原始 JS **895,401 → 932,377 B**，gzip **286,363 → 297,393 B**（增加11,030 B）；不是完整应用首屏或线上性能。键盘、选中项、布局切换和滚动恢复断言通过。
- 刷新门禁：web **141文件/1,649测试通过**（28.10s）；相关 latency **16/16**；web 类型检查、中文生产 build、5文件 Biome、diff检查通过。前后浏览器各 **1/1**（5.4s/8.3s）。
- 范围边界：整项 D3 仍未标完成。旧 RecruitingPanel 和真实 Transcript 的后续本地实现依赖 D1/D4，保留在独立 followup 提交中，由主线程在这些依赖合入后串行集成；不能夹带进本候选列表 PR。线上、其他浏览器、CPU降速、人工辅助技术仍未测。

```sh
pnpm exec vitest run apps/web/src/pages/recruiting/latency.test.tsx --maxWorkers=2
pnpm --filter @rakazo/web test
pnpm --filter @rakazo/web check
RAKAZO_ALLOW_DEV_SECRETS=1 VITE_DEFAULT_UI_LOCALE=zh-CN pnpm --filter @rakazo/web exec vite build --manifest
D3_BASE_REF=168fcaacc pnpm --filter @rakazo/web exec playwright test -c playwright.candidates.config.ts
pnpm --filter @rakazo/web exec playwright test -c playwright.candidates.config.ts
pnpm exec biome check apps/web/src/pages/recruiting/CandidateDirectory.tsx apps/web/src/pages/recruiting/CandidateWindow.tsx apps/web/e2e/candidate-virtualization.spec.ts apps/web/e2e/fixtures/candidates.tsx apps/web/playwright.candidates.config.ts
git diff --check
```

### D4 拆分超大组件文件

- **现状：** `Shell.tsx` 有 9,793 行，`RecruitingPanel.tsx` 有 6,737 行。
- **验收：** 单个组件文件不超过 1,500 行。

## E. 可靠性

### E1 告警

- **现状：** 只有日志，没有告警。
- **做法：** 在现有日志平台上配置监控，需要先得到同意：
  - `jobs.queue.readyChats` 大于 0，并且持续 2 分钟。
  - `db.pool.wait.maxMs` 大于 2000。
  - 出现 `EMAXCONNSESSION`。
  - API 5xx 比例超过 1%。
  - 运行失败率超过 5%。
  - 健康检查失败。
- **验收：** 每条告警都人为触发一次，确认能收到。

### E2 压测

- **验收（线上实测）：** 在副本岗位上跑 20 个和 50 个并发对话，不用真实岗位。要求第一个问题 p95 小于 10 s，前十个人选 p95 小于 20 s，`readyChats` 一直是 0，没有 5xx。

### E3 备份恢复演练

- **验收：** 把最新备份恢复到一个临时库，记下恢复用了多长时间（RTO）和最多丢失多长时间的数据（RPO），并写进运维文档。

### E4 模型服务的备用方案

- **现状：** 部署时只配置了一个模型提供方，它出问题的时候没有备用。
- **做法：** 用现有的按机器人设置的连接配置，再配一个备用连接，并定好什么情况下切换过去。
- **验收：** 把主连接停掉以后，对话还能完成。

## F. Agent 运行时

### F1 招聘逻辑写死在执行器代码里

- **现状：** `executor.ts` 有约 14,000 行，其中 482 处和招聘有关。按 AGENTS.md 的原则，招聘相关的行为应该写在机器人指令和技能里，不应该写在执行器代码里。
- **验收：** 执行器里和招聘有关的引用每一轮都在减少，招聘验收流程不退步。

- **F1 本轮（2026-10-27，[#269](https://github.com/WeKruit/rakazo/pull/269)）：** 移除 executor 对澄清问题强制携带四条搜索计划的业务门槛，以及与原生 intake skill 重复的逐轮筛选/下一步指令。已有 intake skill 负责已存搜索结果复用和后续选择；executor 只补充该部分的已存岗位/搜索事实。没有把同一决策代码挪进新的模块，保留授权、账号隔离、已答问题复用及提供方执行边界。
- **量化：** 本轮前后 `wc -l packages/adapters/src/executor.ts` 为 14,351 → 14,327；`rg -i -c recruiting packages/adapters/src/executor.ts` 为 482 → 481。仍有大量招聘工具适配与业务逻辑，不能据此说 F1 整项已完成。
- **认领和实现：** 先以 Adam 认领并推送 `e6b8446de`，实现提交 `888e5dfd05c07a4bd07f2d209076bc1e6b938cd7`，小 PR base 为 `claude/project-thread-f1cbzk`。
- **本地实测：** Node 24.19.0、pnpm 9.15.0。core 1,232 通过 / 5 跳过；adapters 单独重跑 5,128 通过 / 44 跳过；聚焦回归 238 通过；招聘默认配置安装/升级测试 55 通过；core/adapters 类型检查、Biome 和 diff 检查通过。新用例证明无计划、空计划、单条计划都能提交实质澄清且不调用提供方/不产生效果。用原始 executor 跑同一新回归：2 失败 / 1 通过；修改后 3 通过。
- **初次失败记录：** 首次全 adapters 测试为 5,127 通过、1 失败（computer-idle 的固定临时 marker 建 symlink 遇到 EEXIST）；恢复原始 F1 源码后单独运行该测试文件 59/59 通过，随后独立全量重跑 5,128/5,128 通过。未修改无关生产代码掩盖问题。
- **未完成的验收：** 真实提供方支持的测试副本岗位 → 10 人校准 → 人工反馈 → 同任务继续的业务不退步尚未测；现有本地假服务测试不替代该证据。因此 F1 只记部分实现，不记完成。未在真实岗位/候选人上测试，无部署、云配置、Secret、资源、外发或 CI 改动。

F1 复现命令（仓库根目录，Node 24.19.0）：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @rakazo/db generate
pnpm --filter @rakazo/core --filter @rakazo/adapters check
pnpm --filter @rakazo/core --filter @rakazo/adapters test
pnpm --filter @rakazo/adapters test
pnpm test packages/adapters/src/executor-effect-idempotency.test.ts packages/adapters/src/executor-planned-searches.test.ts packages/core/src/recruiting-defaults.test.ts
pnpm test packages/db/src/recruiting-bootstrap.test.ts
pnpm exec vitest run packages/adapters/src/computer-idle.test.ts
pnpm exec vitest run packages/adapters/src/executor-effect-idempotency.test.ts --testNamePattern 'intake questions follow'
pnpm exec biome check packages/adapters/src/executor.ts packages/adapters/src/executor-effect-idempotency.test.ts packages/core/src/recruiting-defaults.ts packages/core/src/recruiting-defaults.test.ts
wc -l packages/adapters/src/executor.ts
rg -i -c recruiting packages/adapters/src/executor.ts
git diff --check
```

- **F1 PostgreSQL 跟进：** 在专用本地合成库 `rakazo_f1` 修复两处实际回归：原始输入与最新人类输入引用相同时优先最新有效来源；取消 run 的已完成读取由后续 run 记录后，按原 owner 和产物记录 run 查询凭据，仍完整验证作用域、绑定及回执。四处测试断言/夹具显式携带已有证据引用，不恢复隐式推断来源。认领前基线 12 失败；本次负责的 7 项全部通过，全文件 277 通过 / 5 失败（282 项），余下五项由集成负责人独立修正，不能称全套通过。DB/adapters 类型检查通过。

```sh
VERIFY_DATABASE=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55434/rakazo_f1 pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts --testNamePattern 'atomically recovers native role|rejects native role identity|verifies native human authorship|uses the actual native|recovers an actually bound completed read'
VERIFY_DATABASE=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55434/rakazo_f1 pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts
pnpm --filter @rakazo/db --filter @rakazo/adapters check
```

- **F1 第二轮审查：** executor 招聘匹配行 481 → 477（相对起点 482），总行数 14,327 → 14,231（起点 14,351）。移除基于美国地名/多数候选人位置的通勤距离筛选及州/国家级位置自动拒绝：地理匹配属于现有 agent/skill 的证据判断，不能由执行器在不知道岗位实际地域范围时替代判断。删除失去调用者的 location 模块、地名表及其旧算法测试。移除已显示部分候选人/已记录一轮之后禁止实质澄清的两处时序门槛；展示回执只报告 `shown` 和 `roundRecorded`，不强制四查询或下一工具步骤。
- **保留边界逐类审查：** (1) 当前 role/thread/actor 绑定、revision CAS、候选人必须来自该岗位的已存来源：保留，属于身份与事实完整性；(2) 候选人评估 source、精确人类引用、已答卡复用、历史 run 回执和付费读取重放：保留，删除会伪造证据或重复外部效果；(3) outreach/email/calendar 精确批准请求、recipient/account 匹配、预算和提供方任务所有权：保留，属于授权；(4) 正式 calibration 提交的十人完整性、真实反馈与批准记录：保留，未把 display-only 的选中人数当作已完成校准；(5) 工具 DTO/持久化与 chat 展示：保留，不通过改名或搬文件减少计数；(6) planned-search 调度、brief 自动保存、next-step card、turn-end 自动续跑、approval-stage 拦截仍包含业务时序，尚未完成剥离。它们涉及原生等待卡、恢复和实际人类决策，不能只删除后宣称工作流无回退，须有相应业务验收再继续。
- **本轮反例与实测：** 新增六个运行时反例：美国/州/英国/缺失位置的已存人选可展示且可提出实质澄清；未知候选人仍拒绝；完成轮次后的澄清仍进入带作用域的 assessment 验证，验证拒绝照常传播。无提供方执行或外发。相关三文件共 244 测试通过；这些实现证据不替代真实提供方测试副本的全流程验收。F1 仍为部分实现，不标完成。
- 第二轮全 adapters 实测：5,118 通过 / 44 跳过（删除 16 个失去生产调用者的地域算法测试、增加 6 个运行时反例；第一轮 5,128）。`pnpm --filter @rakazo/adapters check` 通过。初次沙箱运行因本地 socket/网络夹具权限失败，随后允许本地服务的完整运行通过；未把权限失败当作产品失败或忽略未过测试。
- **最终分支刷新验收：** 普通 merge 最新 #263 分支 `9b2705c66`，并加入集成负责人的五项旧夹具修正（`41f98a52d`，来源 `5ecdb59c9`）。专用合成 PostgreSQL 全文件 **282/282 通过**（31.11 秒），原先五项失败已解决；全 adapters **5,118 通过 / 47 跳过**（230 文件通过 / 6 跳过，25.78 秒）；core/adapters/db 类型检查全部通过。当前 executor 14,231 行、招聘匹配行 477；这些计数只是审计指标，不表示全部业务逻辑已移除。47 项跳过及真实提供方全流程均不宣称已验证。此项仍为部分实现。

最终复现命令（Node 24.19.0，`DATABASE_URL` 指向专用本地合成库）：

```sh
pnpm --filter @rakazo/core --filter @rakazo/adapters --filter @rakazo/db check
pnpm --filter @rakazo/adapters test
VERIFY_DATABASE=1 pnpm exec vitest run packages/db/src/recruiting.postgres.test.ts
wc -l packages/adapters/src/executor.ts
rg -i -c recruiting packages/adapters/src/executor.ts
```

### F2 回合守卫二期（#65 留下的项目）

#65 合并了回合守卫的一期：回合结束时没有交付物，就自动继续下一步。下面是它列为二期、当时没有做的部分，每项都对着 main 检查过。

| 项目 | main 上的现状 | 状态 | 验收 |
|---|---|---|---|
| 隐藏自动继续的消息 | `sendUserMessage` 收到以 `autocontinue:` 开头的 nonce 时，会把消息标成 `internal`（`packages/db/src/events.ts`）；消息列表、群组列表和招聘读取都会过滤掉它 | 已上线 | 在 e2e 里，自动继续之后聊天中没有出现「继续下一步：…」 |
| 10 分钟后提醒还没回答的问题 | 已有：`recruiting-question-nudge.ts` 会在问题卡片等了 10 分钟后，把原来那张卡片重新标成未读并推到前面，每张卡片只做一次，不新发消息，也不会代替用户回答。`stuck-work.ts` 另外会发手机推送提醒 | 已上线（复查时发现之前写成待做是错的） | 一张问题卡片 10 分钟没人回答，线程变成未读，同一张卡片不会提醒第二次；回答以后不再提醒 |
| 崩溃后自动接着做 | `job-reconciler.ts` 会把租约过期的 `leased`/`running` 运行重新排队，由原来的运行接着做 | 已上线 | 在一个回合中途杀掉 worker：重启后 2 分钟内同一个运行继续，不重复发消息 |
| 唤醒时无事可做就保持沉默 | 已有，名字叫 `NO_RESPONSE`（`silent-reply.ts`）。定时任务的唤醒会被告知「没有新内容就只回 `NO_RESPONSE`」，最终回复只有这个词时，聊天里不出现消息。工单类唤醒的回复本来就是空的 | 已上线 | 一次定时唤醒没有新内容时，聊天里没有新消息，运行正常结束 |
| 预算用完时给出总结 | `runBudgetStopText` 会发一段固定文字，带上已保存的人数和下一步 | 保持现状（建议关掉这一项）：预算用完时如果再调用一次模型来写小结，就会超出预算；现在的文字已经说明了已保存多少人和下一步 | 预算用完的那个回合里，最后一条消息写明已保存的人数和下一步 |

## 整体验收边界与阻塞台账（2026-10-27）

本轮仅使用本地独立工作区和合成数据。以下动作尚未执行，原因是本轮明确禁止部署、云端配置/Secret/资源变更或真实岗位候选人测试；没有为获得一个“通过”而用本地假结果替代线上指标。它们不是自动审批拒绝，也没有不确定的线上执行结果。

| 项目 | 已有证据 | 尚未执行的准确动作 / 目标 | 继续所需条件 |
|---|---|---|---|
| A1 | 源码分流：worker session pool 上限 4 + worker realtime 1 + API realtime 1 = 每容器 6；查询池走独立 DATABASE_URL。未新增会话连接。 | 在部署环境跑 50 并发，量 db.pool.wait.maxMs <500 且无 EMAXCONNSESSION；核实实际6543/5432配置 | 获准的隔离在线环境、只读运行配置证据、压测授权；当前未测 |
| B1 | 本地 background handlers / Graphile publisher 回归通过，覆盖槽位限制/对话优先级 | 在线定时任务集中触发时 readyChats 始终为0 | 同上，不能以单测替代调度压力下实测 |
| B2 | 源码 reporter 每60秒记录 slots/ready/readyChats/oldestReadySeconds/running/exhausted | 部署后连续观察每分钟日志 | 部署与目标日志读取范围；当前未测 |
| C1 | 本地 artifact adapter 与上传nonce回归通过 | 配置对象存储并迁移现有附件后做跨容器读取 | 现有桶/Secret配置及迁移授权；本轮禁止，未尝试 |
| C2 | 本地 computer-workspace adapter 回归通过 | 配置共享对象存储并迁移工作目录后跨容器验证 | 同上；不创建桶或更改Volume/Secret |
| C5 | C6 已把网页进程合并到API；C4单独推进 | 拆分部署服务、启用多个容器、滚动发布并每秒探测首页/RPC与不中断对话 | C1/C2配置和C4验证完成，另需部署/资源配置授权；未执行 |
| E1 | 已有队列/连接池/运行日志，告警清单保留 | 在现有日志平台创建6类告警，并逐一触发确认送达 | 云日志配置及测试通知目标授权；本轮禁止配置与外发，未执行 |
| E2 | 本地单测不等于20/50并发对话压测 | 在隔离部署的副本岗位运行20/50并发，测首问<10s、前10人选<20s、readyChats=0、无5xx | 提供获准的测试副本、内部账号、在线服务调用/额度范围；不得用真实岗位或本地模型假响应冒充 |
| E3 | 无恢复演练证据 | 获取最新备份，在获准隔离目标恢复并记录真实RTO/RPO | 备份访问与恢复目标授权；不自行建立云资源，也不复制真实候选人到未批准测试库 |
| E4 | 原有每机器人连接边界可复用，无需新路由框架 | 配置备用模型连接、停用主连接并证明对话完成 | 备用服务/凭据和连接切换的明确授权；本轮禁止云配置，不触碰生产连接 |

已有功能本地回归命令（Node 24.19.0、pnpm 9.15.0）：

```sh
pnpm test packages/adapters/src/background-job-handlers.test.ts packages/adapters/src/wakeup-graphile-host.test.ts packages/adapters/src/computer-workspace.test.ts packages/adapters/src/artifacts.test.ts packages/adapters/src/expo-push.test.ts apps/worker/src
pnpm --filter @rakazo/worker --filter @rakazo/adapters check
```

结果：7 个文件、85 个测试通过；两个包类型检查通过。C3 在额外真实本地 PostgreSQL 测试发现时区回归，已单独通过 #272 修复并列出35项实测，不把此前漏测说成已验证。


### D3 独立后续本地验收

基于 D4 `e0eb80130b7c64b5c3cb55ff23925dd1c071678b` 移植消息窗口与旧结果视图窗口；仅本地提交，尚未发布/合并。没有带入 D1 后续 lazyLiveWork/windowinglazy 或 D2 缓存改动。完整命令与范围见 [D3-INDEPENDENT-FOLLOWUP.md](D3-INDEPENDENT-FOLLOWUP.md)。Web 类型检查、1,656 项单测、生产构建通过；Chromium 三项合成浏览器测试通过。1,000 消息首屏 DOM 1,000→17，滚动最大 1,030→24（含自动加载 30 条旧消息）；候选目录最大 19 行/36 卡片，滚动无长任务。整项保持待集成，线上和人工辅助技术检查还没测。
### C4 refreshed independent branch

Ordinary merge of #263 through `8188c88f3` into C4 succeeded without conflicts (`4406d0e134a5c2a26fa961ec2ebbb8075d3eaa5b`). `pnpm --filter @rakazo/api --filter @rakazo/db --filter @rakazo/adapters check` passed. Local synthetic `VERIFY_DATABASE=1 pnpm exec vitest run packages/adapters/src/pi-oauth-durable.postgres.test.ts packages/adapters/src/pi-oauth.test.ts`:120/120 passed in7.89s. `pnpm --filter @rakazo/api test`:1376 passed/51 skipped in17.41s. No provider or multi-container acceptance is claimed. This refresh is local only while remaining-item publication confirmation is pending; #274 has not been merged.

### 串行发布核对（2026-10-27）

D1初始#295、A2#296、C4#274、D4#298、D2#301、D3后续#300均已合入本集成分支。上文各阶段“待发布/待合并”是当时记录，以本段和总览最新状态为准。D1后续生产冷入口实测联系人347,938B/7JS/35总请求、17RPC/0重复；聊天310,672B/8JS/39总请求；登录203,469B/7JS/15总请求。最终250KB和线上LCP仍不达/未测。A2本地部分配对超过10%，整体未完成。F2保留Claude所有权；仅复核已有reconciler/turn-end-guard/question-nudge59/59单测，未替代其崩溃/上线业务验收。新增A5保留Claude认领。
