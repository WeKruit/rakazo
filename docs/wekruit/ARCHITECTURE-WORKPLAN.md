# 架构工作计划（2026-10-27）

这份文件是架构优化的总清单。每一项写清楚四件事：查到的现状、做法、状态、验收指标。多人协作时，开工前把自己的名字写进「负责」，做完把状态改成「已合并」，并写上 PR 号。

状态：`已上线`、`已合并`（代码在 main 上但还没部署，或者要等配置）、`本 PR`、`进行中`、`待做`。

验收指标分两种。一种是代码检查，本地就能跑。另一种是线上实测，要部署之后用真实流量或压测去量。

## 总览

| # | 方向 | 项目 | 状态 | 负责 |
|---|---|---|---|---|
| A1 | 数据库 | 查询走事务模式连接池，会话名额只留给监听和锁 | 已上线（#259） | — |
| A2 | 数据库 | 账号隔离：在应用层过滤之外再加数据库行级安全（RLS） | 进行中 | Adam |
| A3 | 数据库 | 列表接口都分页、有上限 | 进行中 | Adam |
| A4 | 数据库 | schema 和迁移文件不一致 | 阻塞（线上外键元数据待核实，[#268](https://github.com/WeKruit/rakazo/pull/268)） | Adam |
| B1 | 任务队列 | 给对话预留任务槽，定时任务不能占满 | 本 PR | — |
| B2 | 任务队列 | 每分钟记录一次排队情况 | 本 PR | — |
| C1 | 多容器 | 附件放对象存储 | 已合并（#260），等存储配置 | — |
| C2 | 多容器 | 电脑工作目录放对象存储 | 已合并（#262），等存储配置 | — |
| C3 | 多容器 | 手机推送 token 放数据库 | 回归修复中（#262，过期会话时区边界） | Adam |
| C4 | 多容器 | 应用内模型订阅登录的状态不能只存在进程内存里 | 进行中 | Adam |
| C5 | 多容器 | web/API 和 worker 拆成两个服务，开多个容器，做滚动发布 | 待做（依赖 C1–C4） | |
| C6 | 多容器 | 生产环境不用 `vite preview` 提供网页 | 本地门禁通过（[#265](https://github.com/WeKruit/rakazo/pull/265)），线上验收未完成 | Adam |
| D1 | 前端 | 首屏 JS 太大，要按需加载 | 进行中 | Adam |
| D2 | 前端 | 服务端数据的缓存是手写的，要统一 | 进行中 | Adam |
| D3 | 前端 | 长列表虚拟滚动 | 进行中 | Adam |
| D4 | 前端 | 拆分超大组件文件 | 进行中 | Adam |
| E1 | 可靠性 | 告警 | 待做（要在日志平台上配置，需要同意） | |
| E2 | 可靠性 | 压测：20 和 50 个并发对话 | 待做 | |
| E3 | 可靠性 | 数据库备份恢复演练 | 待做 | |
| E4 | 可靠性 | 模型服务只有一个提供方 | 待做 | |
| F1 | Agent | 招聘逻辑写死在执行器代码里 | 部分实现（[#269](https://github.com/WeKruit/rakazo/pull/269)；业务验收未测） | Adam |

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

### A3 列表分页

- **现状（已查）：** 消息（`thread-message-pages.ts`）、候选人（`listRecruitingCandidates`，每页 25 条，游标分页）、反馈都已经是游标分页。用量记录取 100 条，电脑命令历史也有上限。`router.ts` 里 38 处 `findMany` 没写 `take`，查下来基本都是单个用户自己的设置列表，量很小。还剩两处要改：
  - `recruiting.ts` 联系人视图会一次读出整个岗位的全部 `candidateKey`。
  - 机器人列表和群组列表是一次全部读出。
- **验收（代码检查）：** 任何列表 RPC 单次返回不超过 200 行。
- **验收（线上实测）：** 有 1,000 个候选人的岗位，联系人视图的 RPC p95 小于 300 ms。

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

- **F1 本轮（2026-10-27，[#269](https://github.com/WeKruit/rakazo/pull/269)）：** 移除 executor 对澄清问题强制携带四条搜索计划的业务门槛，以及与原生 intake skill 重复的逐轮筛选/下一步指令。已有 intake skill 负责已存搜索结果复用和后续选择；executor 只补充该部分的已存岗位/搜索事实。没有把同一决策代码挪进新的模块，未改授权、账号隔离、已答问题复用、效果回执或提供方执行边界。
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
