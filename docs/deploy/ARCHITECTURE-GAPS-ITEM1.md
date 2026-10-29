# 架构差距清单第 0、1 项（2026-10-27 摘录）

摘自 2026-10-27 的架构差距清单（基于 rakazo main `374d2cc5` 代码核对），只保留和发布停机、多容器有关的两项。之后的进展见 [MULTI-CONTAINER-PLAN-20261027.md](./MULTI-CONTAINER-PLAN-20261027.md) 和 [../wekruit/ARCHITECTURE-WORKPLAN.md](../wekruit/ARCHITECTURE-WORKPLAN.md) 的 C5 项。

## #0 数据库连接预算：15 个会话撑全部流量

- **现状：** API 6 + worker 5 + 2 个 LISTEN = 13/15，走 Supabase 会话模式连接池（`infra/modal/app.py` 的 `SERVICE_ENV`）。发布重建时旧容器的会话没关掉就被杀，残留在池里，当晚 15/15，新聊天报 500。
- **行业做法：** 普通查询走事务模式池（6543），只有 LISTEN 和 advisory lock 用会话连接；容量按"发布时两个容器同时在线"算。
- **进展：** #257（池满不再重启循环）、#258（关机 4 秒内主动断开）、#259（事务模式）。完整方案见 [DB-POOL-ARCHITECTURE-20261027.md](./DB-POOL-ARCHITECTURE-20261027.md)。

## #1 整个产品只有一个容器，状态存在本地卷上（严重，工作量 L，1–2 周）

- **现状：** `app.py` 里 `min_containers=1, max_containers=1`，web、API、worker 三个进程在同一容器。仓库 README 写明"一个容器是为了避免多个容器写同一个本地文件存储，扩容要先改存储"。实测卷上：文件附件 217 MB（生产没配对象存储）、bot 工作目录 `homes/` 114 MB、其他私有文件 3 MB、手机推送 token。卷只在容器退出时显式 commit。
- **行业做法：** 应用实例无状态、至少 2 个；文件进对象存储；API 和 worker 分开扩缩；滚动发布零停机。
- **风险：** 任何崩溃或发布都是全站停机（实测一次 93 秒）；正在跑的回合被杀，要等 5 分钟租约过期才被接手；全系统同时最多 10 个回合；被强杀时卷上未提交的写入可能丢。
- **修法：**
  1. 文件附件走对象存储（代码已支持 `ARTIFACT_STORAGE_*`，只差配置，属 Secret 改动，需用户同意）；
  2. 推送 token 改存数据库；
  3. bot 工作目录写一个数据库/对象存储版 `AgentHomeStore`（接口已有）；
  4. 拆成 web+API 服务和 worker 服务，各自 `max_containers>1`；
  5. 然后才能做滚动发布。
- **进展：** ① 的代码已合并（#260）：配好对象存储后新文件进 bucket，旧文件继续从卷上读；`pnpm --filter @rakazo/api artifacts:copy` 把旧文件拷过去并逐个校验。② ③ 由 #262 合并：推送 token 进数据库，工作目录每次写入同步到同一个桶。**以上都要等用户同意建存储桶和 3 个 Secret 值后才生效，目前仍关着。**
