# InkOS Docker 部署（服务器1 `/opt/docker-dir/inkos/`）

镜像来源：`github.com/nebofeng/inkos` 分支 `deploy/docker`（基于 `deploy/server3` 的 `34b3213b`，只加了 Docker 相关文件），InkOS 版本 1.8.0。
当前镜像 tag：**`inkos:1.8.0-34b3213b-d14a99d9`**（tar.gz：`inkos-1.8.0-34b3213b-d14a99d9.tar.gz`，sha256 `86734f3a816c56ced7068fbedbca4aa66bbb8ba47c25ec5641b534153914c4b4`）。
镜像里只有构建产物和生产依赖，**没有 .env、密钥、inkos.json、小说数据**；这些都在运行时从 `./data` 和 `.env` 进来。

> **命令写法**：服务器1 只有独立版 **`docker-compose` v2.26.1**（没有 `docker compose` 插件）。下面每条命令都写两种：
> 第一种 `docker-compose ...` 用于服务器1；`# 插件版：docker compose ...` 用于装了插件的机器（如服务器0）。参数完全相同。
> compose.yml 只用 v2.26 已支持的语法（已用 docker-compose v2.26.1 `config` 校验）。

## 1. 目录结构

```
/opt/docker-dir/inkos/          # 700
├── compose.yml                 # 本目录的 compose.yml
├── .env                        # 从 .env.example 复制后填值，chmod 600
├── data/                       # = 服务器3 的 /workspace/inkos-data 整个目录，挂到容器 /data（属主必须 1000:1000）
│   ├── inkos.json              # 项目配置（模型服务、daemon 调度、modelOverrides…）
│   ├── .env                    # InkOS 项目级 .env（服务器3 上只有注释，照搬即可）
│   ├── .inkos/                 # secrets.json（模型 key，600）、sessions/（Studio 对话记录）
│   ├── books/<书ID>/           # 三本书：book.json、chapters/、story/（memory.db、state/、snapshots/…）
│   ├── radar/                  # 雷达扫描结果
│   ├── inkos.log               # daemon 写的运行日志（Studio“日志”页读它）
│   └── 其他：daemon.log、studio.log、*.pid、repair-*.log、logs-oct3/ 等（历史文件，可留可删）
└── backup/daily/               # 运维备份目录，容器不挂载
```

InkOS 只需要**一个**数据目录：项目根目录（有 inkos.json 的那个），所有书、配置、key、会话、日志都在它下面。
所以 compose 只挂 `./data:/data`，没有命名卷、没有匿名卷（镜像里也没有 `VOLUME` 声明）。
`./data` 用了 `create_host_path: false`：目录不存在时 compose 直接报错，不会自动建一个 root 属主的空目录。

## 2. 两个容器

| 服务 | 容器名 | 命令 | 作用 |
|---|---|---|---|
| `inkos` | inkos | `studio` | Studio Web，容器内 4567，宿主机绑 `${INKOS_BIND}:${INKOS_PORT}`（默认 `172.17.0.1:4567`） |
| `inkos-daemon` | inkos-daemon | `daemon` | 写作守护进程，等同服务器3 的 `inkos up`（writeCron/radarCron 按 inkos.json） |

- 两个容器挂同一个 `./data`，和服务器3 上 Studio、daemon 两个进程共用 `/workspace/inkos-data` 一样。
- 都加入 sub2api 的 docker 网络：服务器1 上是 **`sub2api_sub2api-network`**（外部网络，`.env` 的 `SUB2API_NETWORK`）。
  sub2api 容器在这个网络里的别名是 `sub2api`、容器端口 `8080`，所以模型地址写 **`http://sub2api:8080/v1`**（写在 data/inkos.json 里，不在镜像里）。
- `mem_limit` 各 1g（`INKOS_MEM_LIMIT`、`INKOS_DAEMON_MEM_LIMIT`）。服务器3 实测常驻内存：Studio 约 110MB，daemon 约 150MB。
- 日志 json-file，`20m × 5`。
- 重启策略 `restart: on-failure:5`（`INKOS_RESTART`），见第 6 节。

**注意**：Studio 页面上的“守护进程”开关控制的是 Studio 进程内的调度器，看不到 `inkos-daemon` 容器，会显示“未运行”。**不要在 Studio 里再点“启动”**，否则会有两个调度器同时写书（服务器3 现在也是这样，规矩不变）。

## 3. .env 变量（只列名字/默认值，不写任何密钥）

| 变量 | 说明 |
|---|---|
| `INKOS_IMAGE` | 镜像 tag，默认见 .env.example |
| `INKOS_BIND` / `INKOS_PORT` | Studio 在宿主机的绑定地址/端口，默认 `172.17.0.1` / `4567`，NPM 从这里转发。**不要绑 0.0.0.0** |
| `SUB2API_NETWORK` | sub2api 所在 docker 网络名，服务器1 = `sub2api_sub2api-network` |
| `TZ` | 默认 `Asia/Shanghai`（cron 按这个时区算，和服务器3 一致） |
| `INKOS_UID` / `INKOS_GID` | 容器运行用户，默认 1000:1000，要和 `./data` 属主一致 |
| `INKOS_RESTART` | 重启策略，默认 `on-failure:5` |
| `INKOS_MEM_LIMIT` / `INKOS_DAEMON_MEM_LIMIT` | 内存上限，默认 1g |
| `INKOS_LOG_MAX_SIZE` / `INKOS_LOG_MAX_FILE` | 容器日志轮转，默认 20m / 5 |
| `INKOS_SECRETS_FROM_ENV` | **推荐 0**（已定）：key 用 data/.inkos/secrets.json，见下 |
| `CUSTOM_SUB2API_API_KEY` | 只有 `INKOS_SECRETS_FROM_ENV=1` 时才需要 |
| 可选 `INKOS_SKIP_LLM_CHECK`、`TAVILY_API_KEY`、`INKOS_STORY_GRAPH` | 跳过 daemon 启动前的模型配置检查（不建议）；网页搜索 key；知识图谱开关（默认关） |

### key 的管理方式（已定：继续用 secrets.json）

- **推荐模式 `INKOS_SECRETS_FROM_ENV=0`**：key 就是从服务器3 迁过来的 `data/.inkos/secrets.json`（服务 `custom:sub2api`），
  容器原样读取；**不需要** `CUSTOM_SUB2API_API_KEY`，`.env` 里也不放 key，`.env` **不会覆盖** secrets.json。
  以后改 key：在 Studio「服务」页保存（写回 secrets.json），或停容器后编辑 secrets.json（保持 600、属主 1000）。
- 备选 `INKOS_SECRETS_FROM_ENV=1`：容器每次启动用 `.env` 里的 `<服务ID转大写>_API_KEY`（如 `CUSTOM_SUB2API_API_KEY`）覆盖 secrets.json 里同一服务的 key；留空则不改。
- 不要设 `INKOS_LLM_BASE_URL` / `INKOS_LLM_API_KEY` / `INKOS_LLM_MODEL`：它们会覆盖 Studio 选好的服务，可能让 daemon 换模型。
- secrets.json 在 data 里，会进运维的 `backup/daily/`，备份目录要按密钥级别管权限。

## 4. 权限（uid）——首次启动前必须做

- 容器以 `node` 用户运行：**uid 1000 / gid 1000**；镜像里的 `/app` 属 root、只读。
- `./data` 是 `create_host_path: false` 的 bind mount，**属主必须是 1000:1000**，否则容器以 65 退出并提示 chown。首次启动前执行：
  ```sh
  chown -R 1000:1000 /opt/docker-dir/inkos/data
  ```
- 从服务器3 迁移时用 `tar -p --numeric-owner`（或 `rsync -a --numeric-owner`）打包/解包，属主保持 1000:1000；解包后仍建议再执行一次上面的 chown。
- 如果必须用别的属主，就把 `.env` 里 `INKOS_UID/INKOS_GID` 改成实际属主。
- `/opt/docker-dir/inkos` 本身 700（root）不影响容器：docker 以 root 解析 bind 源路径，容器里只看到 `/data`。

## 5. 健康检查

- Studio：镜像自带 `HEALTHCHECK`，每 30s 请求 `http://127.0.0.1:4567/api/v1/daemon`，2xx 为 healthy（启动宽限 40s）。
- daemon：compose 里覆盖为检查 `/data/inkos.pid` 里的进程还活着（60s 一次）。
- 手动：
  ```sh
  docker-compose ps            # 插件版：docker compose ps   —— STATUS 应为 healthy
  curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1:4567/    # 应为 200
  ```

## 6. 退出码与重启策略

| 退出码 | 含义 | 处理 |
|---|---|---|
| 64 | 容器里 `/data` 不存在 | 检查 `./data` 挂载 |
| 65 | `/data` 对 uid 1000 不可写 | `chown -R 1000:1000 data` |
| 66 | `/data/inkos.json` 不存在（数据目录挂错/为空） | 挂正确的数据目录；确实要新建空项目设 `INKOS_ALLOW_INIT=1`（只由 Studio 初始化） |
| 78 | **daemon 的模型配置不可用**（例如 inkos.json 没有 `llm.services`、没有 key → `INKOS_LLM_API_KEY not set`） | 看 `docker-compose logs inkos-daemon` 里 `[llm-check]` 的原因，配好后 `docker-compose up -d inkos-daemon` |
| 143 | 被 `docker stop`/宿主机关机停止 | 正常 |

- daemon 启动前会用 InkOS 自己的配置解析检查模型配置（只读文件，不发请求），不可用时打印原因、以 78 退出。Studio 不做这个检查（空项目也要能打开 Studio 去配置服务）。
- `restart: on-failure:5`：非 0 退出自动重启（带退避），**最多 5 次**；配置类错误（64/65/66/78）重试 5 次后容器停在 `Exited (78)` 之类的状态，不会无限重启。
  docker 没有“按退出码跳过重启”的策略；`docker-compose` 非 swarm 模式会忽略 `deploy.restart_policy`，所以用的是 `restart:` 键。
- daemon 被 `docker stop`/宿主机关机时以 143 退出（`inkos up` 本身会以 0 退出，entrypoint 改成 143），所以**宿主机重启后 on-failure 也会把两个容器拉起来**。
- 代价：docker 的重启计数在 dockerd 重启或手动 `up`/`start` 前不清零，累计 5 次异常退出后不再自动重启 —— 需要监控 `docker-compose ps`。
  想要“永远重启”可在 `.env` 设 `INKOS_RESTART=unless-stopped`（代价是配置错误会每分钟重启一次）。
- 用 `docker-compose stop` 停掉的容器，宿主机重启后仍会被 on-failure 拉起（143 非 0）；要长期停用请用 `docker-compose rm -sf inkos-daemon`（插件版：`docker compose rm -sf inkos-daemon`）。

## 7. 安全（必须看）

**Studio 没有任何登录认证**，而且有 `GET /api/v1/services/<服务>/secret` 这样的接口能直接读出模型 key。
服务器3 以前靠 Basic Auth 挡在前面。服务器1 上 NPM 的这个 Proxy Host **必须加 Access List（Basic Auth 或 IP 白名单）**，端口只绑 `172.17.0.1`，不要暴露到公网。

## 8. 首次部署 / 空数据试跑

```sh
cd /opt/docker-dir/inkos
sha256sum -c inkos-1.8.0-34b3213b-d14a99d9.tar.gz.sha256
docker load -i inkos-1.8.0-34b3213b-d14a99d9.tar.gz
cp .env.example .env && chmod 600 .env && vi .env      # 确认 INKOS_IMAGE、SUB2API_NETWORK=sub2api_sub2api-network、INKOS_SECRETS_FROM_ENV=0
docker network inspect sub2api_sub2api-network >/dev/null && echo net-ok
docker-compose config >/dev/null && echo compose-ok    # 插件版：docker compose config >/dev/null && echo compose-ok

# 空数据试跑（不碰正式 data/）
mkdir -p /tmp/inkos-try/data && cp compose.yml .env /tmp/inkos-try/ && chown -R 1000:1000 /tmp/inkos-try/data
cd /tmp/inkos-try
docker-compose -p inkos-try run --rm --no-deps inkos inkos init --lang zh      # 插件版：docker compose -p inkos-try run --rm --no-deps inkos inkos init --lang zh
INKOS_BIND=127.0.0.1 INKOS_PORT=14567 docker-compose -p inkos-try up -d inkos  # 插件版：INKOS_BIND=127.0.0.1 INKOS_PORT=14567 docker compose -p inkos-try up -d inkos
docker-compose -p inkos-try ps                                                 # 插件版：docker compose -p inkos-try ps
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:14567/               # 应为 200
docker-compose -p inkos-try down && rm -rf /tmp/inkos-try                      # 插件版：docker compose -p inkos-try down && rm -rf /tmp/inkos-try
```

- 试跑时 container_name 仍是 inkos，要在正式容器起来之前做。
- 空项目没有模型服务，所以试跑只起 Studio；如果也起 `inkos-daemon`，它会打印 `[llm-check] 模型（LLM）配置不可用` 并以 78 停下（重试 5 次后不再重启），这是预期行为。

## 9. 从服务器3 迁移

### 9.1 要迁的东西

**整个** `/workspace/inkos-data` 目录（约 23MB）→ `/opt/docker-dir/inkos/data/`，包括隐藏文件 `.inkos/`（secrets.json、sessions）、`.env`、`.gitignore`、`.nvmrc`。不要只拷 books/。
不需要迁：`/workspace/inkos-runtime`（旧的 node + npm 包，镜像已替代）、`/workspace/bin/socks-fwd.py`（旧的 8012 转发，服务器1 直接走 docker 网络）。

### 9.2 迁过去后要改的配置（data 里，不进镜像）

1. 模型地址：服务器3 的 inkos.json 里是 `http://127.0.0.1:8012/v1`，容器里必须改成 `http://sub2api:8080/v1`：
   ```sh
   docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/set-baseurl.mjs http://sub2api:8080/v1
   # 插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/set-baseurl.mjs http://sub2api:8080/v1
   ```
   会同时改 `llm.baseUrl` 和 `llm.services[custom:sub2api].baseUrl`，并备份成 `inkos.json.bak-<时间>-baseurl`。
2. key：保持 `INKOS_SECRETS_FROM_ENV=0`，直接用迁过来的 `data/.inkos/secrets.json`，`.env` 里不放 key。
3. 残留的 `inkos.pid`（服务器3 daemon 的 pid 文件）不用管，daemon 容器启动时会自动删掉。`daemon.pid`、`studio.pid` 是旧 shell 脚本留下的，无影响。
4. 旧的 `start-*.sh` / `stop-*.sh` / `restart-after-*.sh` 写死了 `/workspace/inkos-runtime` 路径，容器里不能用，留着当历史即可。

### 9.3 切换步骤（时间由小说管家定在没有章节正在写的时候）

准备（不停机，提前做）：服务器1 `docker load` 镜像、写好 `.env`、`docker-compose config` 通过、空数据试跑通过、NPM 的 Proxy Host + Access List 准备好（目标 `http://172.17.0.1:4567`）。

停机窗口：
1. 服务器3：停 daemon（`cd /workspace/inkos-data && ./stop-daemon.sh`），确认没有 `inkos up` 进程；再停 Studio（`./stop-studio.sh`）。
2. 服务器3：`tar -C /workspace -czpf /tmp/inkos-data-cutover.tgz --numeric-owner inkos-data`，记 sha256。
3. 传到服务器1，校验 sha256。
4. 服务器1：
   ```sh
   cd /opt/docker-dir/inkos && mkdir _in && tar -C _in -xzpf /path/inkos-data-cutover.tgz --numeric-owner
   mv data data.empty-$(date +%Y%m%d) && mv _in/inkos-data data && rmdir _in
   chown -R 1000:1000 data && ls data/books && ls -l data/.inkos/secrets.json   # 三本书；secrets.json 属主 1000、600
   ```
5. 改 baseUrl（9.2-1），然后：
   ```sh
   docker-compose up -d inkos              # 插件版：docker compose up -d inkos
   docker-compose ps                       # 插件版：docker compose ps   —— 等 healthy；NPM 打开页面能看到三本书
   ```
6. 确认模型连通（会发一次很小的模型请求）：
   ```sh
   docker-compose run --rm --no-deps inkos inkos doctor     # 插件版：docker compose run --rm --no-deps inkos inkos doctor   —— API Connectivity: OK
   ```
7. 启动 daemon：
   ```sh
   docker-compose up -d inkos-daemon       # 插件版：docker compose up -d inkos-daemon
   docker-compose logs -f inkos-daemon     # 插件版：docker compose logs -f inkos-daemon   —— 看到 [llm-check] 模型配置 OK、Starting InkOS daemon...
   ```
8. 服务器3 保留原目录不删，作为回滚点。

容器切换本身：停服务器3 进程 <1 分钟，打包+传输 23MB 1~3 分钟，解包/改配置/启动到 healthy 约 1 分钟，验证 3~5 分钟，**合计约 10 分钟**。

### 9.4 回滚

- 切换后出问题：服务器1 `docker-compose down`（插件版：`docker compose down`）；服务器3 重新 `./start-studio.sh`、`./start-daemon.sh`（服务器3 的数据没动过；若服务器1 上已经写了新章节，要先把服务器1 的 `data/books` 拷回去再起）。
- 镜像升级失败：`.env` 里 `INKOS_IMAGE` 改回旧 tag，`docker-compose up -d`（插件版：`docker compose up -d`）。

## 10. 日常命令

```sh
cd /opt/docker-dir/inkos
docker-compose up -d                          # 插件版：docker compose up -d                 启动（Studio + daemon）
docker-compose ps                             # 插件版：docker compose ps                    状态/健康
docker-compose logs -f --tail 100 inkos-daemon  # 插件版：docker compose logs -f --tail 100 inkos-daemon
docker-compose exec inkos inkos status        # 插件版：docker compose exec inkos inkos status     只读命令都在 /data 下执行
docker-compose exec inkos inkos book list     # 插件版：docker compose exec inkos inkos book list
docker-compose restart inkos-daemon           # 插件版：docker compose restart inkos-daemon  重启 daemon（会中断正在写的章节，先确认）
docker-compose stop inkos-daemon              # 插件版：docker compose stop inkos-daemon     暂停自动写作（宿主机重启后会被拉起，见第 6 节）
docker-compose rm -sf inkos-daemon            # 插件版：docker compose rm -sf inkos-daemon   长期停用 daemon
docker-compose down                           # 插件版：docker compose down                  全停（数据在 ./data，不受影响）
```

- 升级：`docker load -i <新 tar.gz>` → `.env` 改 `INKOS_IMAGE` → 先备份 `data/` → `docker-compose up -d`（插件版：`docker compose up -d`）。
- 回滚：`.env` 改回旧 tag → `docker-compose up -d`（插件版：`docker compose up -d`）。

## 11. 和服务器3 现状的区别

| 项 | 服务器3 现在 | 本镜像 |
|---|---|---|
| 运行方式 | 不在容器里：盒子上直接跑 node（Node 22.20.0），`nohup inkos studio -p 4567` + `nohup inkos up` 两个进程，靠 shell 脚本启停 | 两个容器 inkos / inkos-daemon，on-failure:5 自动重启，有健康检查 |
| 包来源 | `npm install` artifacts 里的三个 tgz（core/cli/studio，`deploy/server3@34b3213b`） | 同一提交 `34b3213b` 源码 pnpm 按 lockfile 构建（Node 22.20.0） |
| 用户 | box（uid 1000） | node（uid 1000） |
| 模型地址 | `http://127.0.0.1:8012/v1`（socks 转发到服务器1 sub2api） | `http://sub2api:8080/v1`（docker 网络 `sub2api_sub2api-network` 直连） |
| key | `data/.inkos/secrets.json` | 同（推荐 `INKOS_SECRETS_FROM_ENV=0`） |
| 模型配置错误 | daemon 报错退出，需人工发现 | daemon 打印 `[llm-check]` 原因、退出码 78，重试 5 次后停下 |
| 残留 pid | 手工删 | daemon 启动自动清理 |
| 时区 | 盒子本地 Asia/Shanghai | `TZ=Asia/Shanghai` |
| Studio 访问 | 原 inkos.nebofeng.com（8013 + Basic Auth），公网路由已断 | NPM → 172.17.0.1:4567，需配 Access List |
| 备份 | `/workspace/inkos-backup/daily-backup.sh`（02:47） | 服务器1 运维备份 `backup/daily/`（容器不管） |

## 12. 构建（开发机）

```sh
git checkout deploy/docker
docker build -t inkos:1.8.0-34b3213b-$(git rev-parse --short=8 HEAD) --build-arg VCS_REF=$(git rev-parse --short=8 HEAD) .
# 国内构建可加：--build-arg NPM_REGISTRY=https://registry.npmmirror.com/ --build-arg DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
# （pnpm 按 lockfile 的 integrity 校验包，apt 按 Release 签名校验，换源不影响内容）
docker save <tag> | gzip > <tag 里的 : 换成 ->.tar.gz
```
