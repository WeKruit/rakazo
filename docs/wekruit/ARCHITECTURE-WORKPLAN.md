# 架构工作计划（2026-10-27）

这份文件是架构优化的总清单。每一项写清楚四件事：查到的现状、做法、状态、验收指标。多人协作时，开工前把自己的名字写进「负责」，做完把状态改成「已合并」，并写上 PR 号。

状态：`已上线`、`已合并`（代码在 main 上但还没部署，或者要等配置）、`本 PR`、`进行中`、`待做`。

验收指标分两种。一种是代码检查，本地就能跑。另一种是线上实测，要部署之后用真实流量或压测去量。

## 总览

| # | 方向 | 项目 | 状态 | 负责 |
|---|---|---|---|---|
| A1 | 数据库 | 查询走事务模式连接池，会话名额只留给监听和锁 | 已上线（#259） | — |
| A2 | 数据库 | 账号隔离：在应用层过滤之外再加数据库行级安全（RLS） | 首批实现及本地验收通过；整体未完成，线上角色/配置和 p95 验收受限 | Adam |
| A3 | 数据库 | 列表接口都分页、有上限 | 进行中 | Adam |
| A4 | 数据库 | schema 和迁移文件不一致 | 进行中 | Adam |
| B1 | 任务队列 | 给对话预留任务槽，定时任务不能占满 | 本 PR | — |
| B2 | 任务队列 | 每分钟记录一次排队情况 | 本 PR | — |
| C1 | 多容器 | 附件放对象存储 | 已合并（#260），等存储配置 | — |
| C2 | 多容器 | 电脑工作目录放对象存储 | 已合并（#262），等存储配置 | — |
| C3 | 多容器 | 手机推送 token 放数据库 | 已合并（#262） | — |
| C4 | 多容器 | 应用内模型订阅登录的状态不能只存在进程内存里 | 进行中 | Adam |
| C5 | 多容器 | web/API 和 worker 拆成两个服务，开多个容器，做滚动发布 | 待做（依赖 C1–C4） | |
| C6 | 多容器 | 生产环境不用 `vite preview` 提供网页 | 完成（本地验收，[#265](https://github.com/WeKruit/rakazo/pull/265)，待发布） | Adam |
| D1 | 前端 | 首屏 JS 太大，要按需加载 | 进行中 | Adam |
| D2 | 前端 | 服务端数据的缓存是手写的，要统一 | 待做 | |
| D3 | 前端 | 长列表虚拟滚动 | 待做 | |
| D4 | 前端 | 拆分超大组件文件 | 待做 | |
| E1 | 可靠性 | 告警 | 待做（要在日志平台上配置，需要同意） | |
| E2 | 可靠性 | 压测：20 和 50 个并发对话 | 待做 | |
| E3 | 可靠性 | 数据库备份恢复演练 | 待做 | |
| E4 | 可靠性 | 模型服务只有一个提供方 | 待做 | |
| F1 | Agent | 招聘逻辑写死在执行器代码里 | 进行中 | Adam |

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

### A3 列表分页

- **现状（已查）：** 消息（`thread-message-pages.ts`）、候选人（`listRecruitingCandidates`，每页 25 条，游标分页）、反馈都已经是游标分页。用量记录取 100 条，电脑命令历史也有上限。`router.ts` 里 38 处 `findMany` 没写 `take`，查下来基本都是单个用户自己的设置列表，量很小。还剩两处要改：
  - `recruiting.ts` 联系人视图会一次读出整个岗位的全部 `candidateKey`。
  - 机器人列表和群组列表是一次全部读出。
- **验收（代码检查）：** 任何列表 RPC 单次返回不超过 200 行。
- **验收（线上实测）：** 有 1,000 个候选人的岗位，联系人视图的 RPC p95 小于 300 ms。

### A4 schema 和迁移不一致

- **现状：** 对着迁移文件跑 `prisma migrate diff`，结果显示 `computer_updates` 和 `recruiting_crm_*` 几张表缺外键。这些外键在 `schema.prisma` 里有，但迁移里没有，所以新环境建出来的库和 schema 不一样。
- **做法：** 先确认线上库里有没有这些外键，再补一个加法迁移，或者把 schema 改成和线上一致。
- **验收（代码检查）：** 迁移文件和 `schema.prisma` 之间的 `prisma migrate diff` 结果为空。

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

### C4 应用内模型订阅登录

- **现状：** `pi-oauth.ts` 里的 `PiOAuthLogins` 把整个登录流程放在进程内存里，包括设备码轮询、等用户粘贴授权码，以及登录结果。如果用户的 `complete`/`submit` 请求落到了另一个容器，就会报「找不到登录会话」。MCP 授权和令牌刷新已经通过数据库协调，没有这个问题。
- **做法：** 登录流程继续留在发起它的容器里跑（流程由 pi 库驱动，不重写），但把会话状态写进数据库：状态、错误和归属的容器。拿到凭证以后，由发起登录的那个容器自己保存，不再等客户端来取。任何容器收到 `complete` 都去读数据库里的状态。用户粘贴的授权码先加密存进数据库，再用 Postgres `NOTIFY` 通知发起登录的容器。
- **验收（代码检查）：** 新增测试：两个 `PiOAuthLogins` 实例共用一个数据库，在 A 上开始登录，在 B 上粘贴授权码并完成，凭证只保存一次。

### C5 拆服务、多容器、滚动发布

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

- **现状（本地 `vite build` 实测）：** 首屏要加载的 JS 合计 594 KB（gzip 后）。主包 1.18 MB（未压缩），gzip 后 338 KB。主包里占得最多的是：react-dom 171 KB、`Shell.tsx` 147 KB、`RecruitingPanel.tsx` 113 KB、`ModelSettingsOverlay` 29 KB、`RecruitingCorrespondence` 24 KB、`RoutineEditor`、`InterviewCalendar`、`SchedulingPlan`、`DetailPanel`、markdown 解析器。路由页面已经是按需加载的。
- **做法：** 第一屏用不到的面板改成 `lazy()` 加载：设置浮层、例行任务编辑器、邮件序列编辑、面试日历、排期计划、候选人详情。markdown 解析器在第一条消息渲染时再加载。打开这些面板时要有加载占位，不能出现空白。
- **验收（代码检查）：** 用 `vite build` 计算首屏 JS，gzip 后不超过 350 KB（第一阶段），最终目标 250 KB。
- **验收（线上实测）：** 在 Lighthouse 的移动端模拟环境（Fast 4G）下，LCP 小于 2.5 s。

### D2 数据缓存

- **现状：** 服务端数据都靠组件里的 `useEffect` 加手写缓存来取，例如 `Shell.tsx` 里的 `recruitingReadCache`。`Shell.tsx` 一个文件里就有 51 个 `useEffect`、109 个 `useState`。没有统一的请求去重、过期和失效机制。
- **做法：** 引入 TanStack Query 管理服务端数据。实时事件到达时，只让相关的查询失效。先迁移招聘面板的读取，再迁移其他部分。
- **验收（代码检查）：** 打开一个岗位页面时，同一个 RPC 带同样参数的重复调用次数为 0（在 e2e 里统计）。

### D3 长列表虚拟滚动

- **现状：** 消息和候选人列表都会把每一项渲染成 DOM，没有用虚拟滚动。
- **验收：** 有 1,000 个候选人的列表，渲染出来的行节点不超过 100 个，滚动时没有超过 50 ms 的长任务。

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
