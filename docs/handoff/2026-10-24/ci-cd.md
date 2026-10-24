# CI/CD 与 staging 交接（2026-10-24）

目的：测试和发布验证在 GitHub Actions 上跑，不依赖维护者的电脑开机。本文是这个 PR 的交接说明，不是部署许可。

## 精确坐标

| 项 | 值 |
| --- | --- |
| 原交付基线 | `94a706a089710cea083192a126ab77a8f577e91c` |
| 原交付提交 | `b278c139ba99da2a1c04e4a8497d124eaeb83fa9`（原分支 `codex/pr-driven-release-reconciled`，从未推送到 GitHub） |
| 本 PR 基线 | `origin/main` = `5f677af7`（含 #89 #90 #91） |
| 本 PR 分支 | `claude/project-thread-oezrf5` |
| 导入方式 | 只用了 bundle（`git bundle verify` 通过，SHA256SUMS 全部匹配），没有再套 patch |
| 冲突 | 无。5 个提交在 `5f677af7` 上直接重放；`94a706a0..main` 改过的 28 个文件与本 PR 的 39 个文件没有交集 |

5 个提交（新 SHA 见 PR 提交列表）：

1. Add gated exact-source promotion and isolated staging checks
2. Verify real staging readiness and promotion execution boundaries
3. Add isolated hosted staging receipts and hold unsafe production cutover
4. Close release provenance and legacy cutover gaps
5. Keep core exports ordered after main reconciliation

产品交付（#84）是另一项工作，本 PR 不包含其改动，也不依赖它。

## 进度（三列分开记）

| 工作项 | 代码完成 | 本地/云端验证 | 线上验收 |
| --- | --- | --- | --- |
| PR 上的合成验证（`release-validation.yml`，无凭据） | ✓ | ✓ 云端容器重跑通过 | ✗ 需本 PR 在 GitHub Actions 上实际跑一次 |
| 固定测试提交与构建产物（main CI 成功后生成候选） | ✓ | ✓ 单元测试 | ✗ 需合并后 main 上跑一次 |
| 隔离 staging 流程（`staging.yml`，手动、默认关闭） | ✓ | ✓ 单元测试 + 本地 PostgreSQL 合成测试 | ✗ 没有 staging 环境，没有 staging URL |
| 部署版本与来源核验、就绪检查（`/ready` 查数据库） | ✓ | ✓ | ✗ |
| 有限监控 | ✓（发布流程内的冒烟与元数据比对） | ✓ | ✗ 未接入任何线上监控 |
| 生产发布（`promote-production.yml`） | ✓ 故意在切换前失败 | ✓ | ✗ 设计上不会执行 |
| 生产任务排空 / 维护暂停 / 零停机 | ✗ 只有方案（`docs/development/release-maintenance-proposal.md`），未选定 | ✗ | ✗ |

## 实际跑过的命令和结果（本容器，2026-10-24）

在 `claude/project-thread-oezrf5`（rebase 后的第 5 个提交）上运行。没有 Docker，没有任何真实凭据或 `.env`。

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过，锁文件无变化 |
| `prisma generate`（合成 loopback URL，不连库） | 通过 |
| `python3 -B -m unittest discover -s infra/release -p 'test_*.py'` | 62 项通过 |
| `vitest run` 包里列出的 11 个文件 | 11 个文件、512 项通过（main 多了 1 项回归测试，原包是 511） |
| `tsc --noEmit` api / worker / web | 全部通过 |
| `node scripts/bundle-server.mjs api worker` | 通过 |
| `biome check` 本 PR 改动的文件 | 通过 |
| `biome check .`（全仓） | 失败，14 个错误；当前 main 本身是 15 个，都在本 PR 未改动的文件里，本 PR 少了 1 个 |
| `bash -n infra/compose/deploy-main.sh`、`git diff --check` | 通过 |
| `python3 -B infra/release/validate.py --sha <head> --pg-bin <PostgreSQL 16>` | 通过：CRM 14、Pi 1、受限 HTTP 1；3 个一次性库全部迁移成功，测试库已停止并删除 |

注意：`validate.py` 中的 `initdb` 不能以 root 运行，本地复现要用普通用户；Node 需 ≥22.22.2（CI 用 24）。

没跑：完整 monorepo CI、Web E2E、任何托管 staging、Modal 部署或冒烟、生产查询/迁移、真实 CRM 同步、邮件。

## Workflow 副作用审查

PR 阶段（本 Draft PR 打开后会触发）：

- `ci.yml` 新增 `release-safeguards` 任务，只跑 Python 单元测试。
- `release-validation.yml` 在 `pull_request` 上跑合成 PostgreSQL 测试，不拿凭据、不产出可发布候选、不部署。
- `staging.yml`、`promote-production.yml` 只能手动触发，且限定 `main`。

**合并到 main 后会改变现有行为（需要负责人知情）：**

1. `ci.yml` 里旧的 SSH Compose 生产部署任务被永久关闭（`if: false`）。之前它由仓库变量 `PRODUCTION_DEPLOY_ENABLED` 控制。
2. 移动端 OTA 发布（`publish-mobile-update`）改为需要新变量 `MOBILE_OTA_PUBLISH_ENABLED == 'true'`。没设这个变量，合并后 main 就不再自动发 OTA。
3. 服务端镜像发布（`publish-server-image.yml`）改为需要新变量 `SERVER_IMAGE_PUBLISH_ENABLED == 'true'`。没设就不再发镜像。
4. 合并后每次 main CI 成功都会触发 `release-validation.yml` 的 `workflow_run` 分支：跑合成测试并上传一个候选产物（只读权限，无部署）。

这些都是“少做事”的方向，但第 2、3 条是否保留旧行为，要负责人决定后设置变量（设置变量属于仓库设置变更，本 PR 不做）。

**合并后对下一次生产部署的影响**（生产部署仍走 `release-main.sh` + `modal deploy --strategy recreate infra/modal/app.py`）：

- `infra/modal/app.py` 现在在模块顶部 `from infra.modal.release_config import ...`。本地 Modal CLI 会把当前目录加入 `sys.path`，在仓库根目录执行可以导入。容器内 `/app` 有完整源码（`.dockerignore` 未排除 `infra/`），但容器启动时 `/app` 是否在 `sys.path` 上没有实测。**第一次带这个改动部署前必须先在 staging 或一次性 App 上确认容器能启动**，否则生产容器会在导入阶段失败。
- Volume 改为 `create_if_missing=False`：名字写错时会直接失败，不会悄悄新建空卷。现有生产卷不受影响。
- API `/ready` 新增 `SELECT 1` 数据库检查；`release-main.sh` 的探测如果只看 `/health` 不受影响。
- 非 staging 配置下 API/worker 启动路径不变（`RAKAZO_RELEASE_PROFILE` 不是 `staging` 时照旧加载 `.env`、照旧 `createApp`）。

本 PR 不新增 Prisma 迁移。

## 部署前条件（任何一条没满足都不能激活 staging）

- 独立的 Modal staging App / Secret / Volume，名字与生产不同。
- 专用合成数据库、专用角色、TLS；不能指向生产库或 CRM 库。
- GitHub `staging` 环境：仅 `main`、开启保护规则、检查管理员绕过。
- 仓库 Secret：`STAGING_MODAL_TOKEN_ID`、`STAGING_MODAL_TOKEN_SECRET`、`STAGING_RELEASE_APPROVAL`、`ENVIRONMENT_AUDIT_TOKEN`（范围最小、可过期）。
- 费用评估。

以上都需要负责人亲自创建和授权；本 PR 没有创建任何资源、Secret、变量或订阅。

## 环境隔离要求

- staging 进程设置 `RAKAZO_RELEASE_PROFILE=staging` 时不加载 `.env`，API 只开放 health/readiness 并拒绝业务路由，worker 空转，不跑 agent、不做 CRM 同步、不发邮件。
- staging 启动前检查数据库是合成库且没有 dotenv 文件，否则拒绝迁移。
- 不得复用生产 Modal App、Secret、Volume、数据库或任何 OAuth 凭据。

## 迁移顺序

本 PR 无新迁移。staging 首次部署会对合成库跑全部迁移（与 Compose 入口相同：先迁移后起 API）。生产迁移仍按现有发布流程，且生产发布暂停未解除。

## 回滚边界

- 代码回滚：重新部署上一个已验收 SHA。回滚不撤销已执行的迁移。
- staging 失败不影响生产；生产 workflow 不会执行切换。
- 回滚到更早没有 revision 标记的版本，需要负责人手动核对 SHA、文件哈希和 health/readiness。

## 验收步骤

1. 本 Draft PR 上 `ci` 与 `release-validation` 全部通过（GitHub Actions，无需任何人电脑开机）。
2. 负责人决定第 2、3 条变量是否设置，以及是否接受旧 SSH 部署任务被关闭。
3. 合并（需负责人授权）后，确认 main 上 `release-validation` 生成候选产物。
4. 负责人创建隔离 staging 资源后，手动触发 `staging.yml`，确认容器能启动（同时验证上面的 `infra.modal` 导入问题）、`/ready` 通过、业务路由被拒绝、收据上传。
5. 生产发布继续暂停，直到排空/维护方案被选定并实现。

## 已定的默认做法（2026-10-24，用户要求不等确认）

- 移动端 OTA 和服务端镜像发布：保留新变量开关，默认关闭。main 以前几乎从不跑 CI（合并带 `[skip ci]`），合并后若不加开关，第一次 main CI 就可能对外发布。要恢复发布时由负责人设置变量。
- 旧 SSH Compose 部署任务：保留在文件里，但保持停用（生产发布暂停未解除）。
- `infra/modal/app.py`：先把 `ROOT`（本地为仓库根目录，容器内为 `/app`）加入 `sys.path` 再导入 `release_config`。已用 Modal 1.6.2 在只有 `infra/modal` 在路径上的条件下模拟导入成功。仍需在 staging 上实际启动一次。

## 已知失败与阻塞

- 本 PR 顺手修了：updater 测试的严格类型、Web E2E 无法加载（spec 引入了带 Lingui 宏的模块）、usage-accounting 测试的上下文窗口过小、全仓 Biome 格式。
- **main 上原有的测试失败（不是本 PR 引入，已在 `origin/main` 上复现）**：`pnpm test` 有 60 个失败，集中在 `packages/db/src/recruiting-brief.test.ts`（28）、`packages/testkit/src/pi-offline.test.ts`（6）、`history-context.test.ts`（4）、i18n 目录、`apps/api` router/memory-revisions、adapters 工具 schema 等；Postgres 集成测试有 7 个套件失败（history-retrieval、history-short-product、history-followup-product、history-product-loop、authorization、executor-lifecycle、memory commit），多为模型 fixture 与当前提示/工具不一致。原因是 main 的合并普遍带 `[skip ci]`，测试漂移没人发现。需要单独修。
- 原包审计 `GET /repos/WeKruit/rakazo/hooks` 与 `/actions/permissions` 返回 403，外部触发器（如 Vercel）未能核实。
- 生产排空机制未实现、未选定方案；零停机方案待用户确认。

## 下一步负责人

| 事项 | 负责人 |
| --- | --- |
| 看本 PR 的 GitHub Actions 结果并修 PR 自身导致的失败 | 本线程（云端） |
| 决定 OTA / 镜像发布变量、是否合并 | 仓库负责人 |
| 创建 staging 资源与 Secret、费用审批 | 仓库负责人 |
| 选定维护暂停 / 零停机方案 | 用户 |
