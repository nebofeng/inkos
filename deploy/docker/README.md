# InkOS Docker 部署（服务器1 `/opt/docker-dir/inkos/`）

镜像来源：`github.com/nebofeng/inkos` 集成分支 `deploy/docker-auth` = `deploy/docker`（基于 `deploy/server3` 的 `34b3213b`，加 Docker 相关文件）+ 功能分支 `feat/studio-auth`（Studio 自带登录），InkOS 版本 1.8.0。
当前镜像 tag：**`@@NEWTAG@@`**（tar.gz：`@@NEWTAR@@`，sha256 `@@NEWSHA@@`）。
上一版（无登录）：`inkos:1.8.0-34b3213b-d14a99d9`，回滚用。**从上一版升级前必须先配好登录**，见第 7 节和 `UPGRADE-rd016.md`。
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
- 都加入 **两个** docker 网络：
  1. 项目默认网络 `inkos_default`，**固定网段**（`.env` 的 `INKOS_SUBNET` / `INKOS_GATEWAY`，默认 `172.31.67.0/24` / `172.31.67.1`）。docker-proxy 对已发布端口做 SNAT 时，多网卡容器里选**接口名字典序靠前**的那张网的网关当 peer；`inkos_default` 排在 `sub2api_sub2api-network` 前面，所以 peer 是项目网关，`INKOS_TRUSTED_PROXIES` 只填该网关（见 7.4）。
  2. sub2api 的外部网络：服务器1 上是 **`sub2api_sub2api-network`**（`.env` 的 `SUB2API_NETWORK`）。
     **不要把外部网络改成字典序比 `inkos_default` 更靠前的名字**，否则发布端口的 peer 会变成那张网的网关，和 `INKOS_TRUSTED_PROXIES` 对不上。
     sub2api 容器在这个网络里的别名是 `sub2api`、容器端口 `8080`，所以模型地址写 **`http://sub2api:8080/v1`**（写在 data/inkos.json 里，不在镜像里）。
- **切换前必须确认默认网段在服务器1 上空闲**（被占用则三处一起改，见下）。改网段或第一次套上固定网段，必须 `docker-compose down` 再 `up`（只 `up -d` 不会改已经存在的 `inkos_default` 的 IPAM）：
  ```sh
  docker network ls -q | xargs docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
  ```
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
| `INKOS_SUBNET` / `INKOS_GATEWAY` | 项目默认网络的网段和网关，默认 `172.31.67.0/24` / `172.31.67.1`。必须与 `INKOS_TRUSTED_PROXIES` 一起改 |
| `TZ` | 默认 `Asia/Shanghai`（cron 按这个时区算，和服务器3 一致） |
| `INKOS_UID` / `INKOS_GID` | 容器运行用户，默认 1000:1000，要和 `./data` 属主一致 |
| `INKOS_RESTART` | 重启策略，默认 `on-failure:5` |
| `INKOS_MEM_LIMIT` / `INKOS_DAEMON_MEM_LIMIT` | 内存上限，默认 1g |
| `INKOS_LOG_MAX_SIZE` / `INKOS_LOG_MAX_FILE` | 容器日志轮转，默认 20m / 5 |
| `INKOS_STUDIO_USER` / `INKOS_STUDIO_PASSWORD_HASH` | **必填**：Studio 登录用户名和 scrypt 密码哈希（只放哈希，不放明文），见第 7 节 |
| `INKOS_TRUSTED_PROXIES` | 只信任这些直连地址的 `X-Forwarded-For`（IP/CIDR）。必须写成 **`<INKOS_GATEWAY>/32`**（默认 `172.31.67.1/32`），见 7.4 |
| 可选 `INKOS_STUDIO_SESSION_SECRET` | 会话签名密钥（≥32 字符）；不设则自动生成 `data/.inkos/studio-session-secret`（600） |
| 可选 `INKOS_STUDIO_COOKIE_SECURE=0` | 只用于本机 http 测试（cookie 去掉 Secure）；生产不要设 |
| 可选 `INKOS_STUDIO_AUTH=off` | **危险**：完全关闭登录，生产禁止 |
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

- Studio：镜像 `HEALTHCHECK` 和 compose 里都是 `node /usr/local/lib/inkos/healthcheck.mjs`，每 30s 请求 `http://127.0.0.1:4567/healthz`，
  200 且 `{"ok":true}` 为 healthy（启动宽限 40s）。`/healthz` **不需要登录**，只返回 `{"ok":true}`，没有书名、key、路径、版本。
  **登录没配置时 `/healthz` 返回 503 `{"ok":false}`，容器显示 unhealthy**（Studio 同时拒绝所有页面和 API）。
- daemon：compose 里覆盖为检查 `/data/inkos.pid` 里的进程还活着（60s 一次）。
- 手动：
  ```sh
  docker-compose ps            # 插件版：docker compose ps   —— STATUS 应为 healthy
  curl -s http://172.17.0.1:4567/healthz                                  # {"ok":true}
  curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1:4567/api/v1/books   # 401（没登录）
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

## 7. Studio 登录（feat/studio-auth）

Studio 现在自带登录页（中文、手机友好，登录后回到原来的页面），**默认开启**。没配置账号时 Studio **拒绝所有访问**（不会“没配就放行”）。

### 7.1 配置（首次或升级前做一次）

```sh
cd /opt/docker-dir/inkos
# 1) 生成密码哈希：按提示输入两次密码（不回显，不进 shell 历史）。用的是 .env 里 INKOS_IMAGE 指定的镜像，所以先确认它是新镜像
docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
# 插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
#   输出：INKOS_STUDIO_PASSWORD_HASH=scrypt:32768:8:1:<salt>:<hash>
#   非交互（例如从密码管理器管道传入）：加 -T，从 stdin 读第一行
#   printf '%s\n' "$PW" | docker-compose run --rm -T --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
#   （插件版：printf '%s\n' "$PW" | docker compose run --rm -T --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs）

# 2) 写进 .env（chmod 600）：
#    INKOS_STUDIO_USER=<用户名>
#    INKOS_STUDIO_PASSWORD_HASH=<上一步输出的 scrypt:... 整串>
vi .env

# 3) 生效（只重建 Studio 容器）
docker-compose up -d inkos              # 插件版：docker compose up -d inkos
docker-compose logs --tail 20 inkos     # 插件版：docker compose logs --tail 20 inkos   —— 应看到 [studio-auth] 登录已启用
```

- 哈希是 scrypt（node:crypto，N=32768,r=8,p=1，随机盐），格式 `scrypt:N:r:p:salt:hash`，**不含 `$`**，可直接写进 `.env`（compose 不会把它当变量替换）。
- 命令行参数里给密码会被拒绝（防止进 shell 历史/进程列表）；密码至少 8 个字符。
- 改密码：重新生成哈希、改 `.env`、`up -d inkos`。**改了哈希，所有已登录的会话立即失效。**

**配置来源和优先级**（先找到的生效）：

| 项 | 1（最高） | 2 | 3 |
|---|---|---|---|
| 用户名 + 密码哈希 | `.env`：`INKOS_STUDIO_USER` + `INKOS_STUDIO_PASSWORD_HASH`（两个必须同时设） | `data/.inkos/secrets.json` 的 `studioAuth.user` + `studioAuth.passwordHash` | 都没有 → 拒绝访问 |
| 会话签名密钥 | `.env`：`INKOS_STUDIO_SESSION_SECRET`（≥32 字符） | secrets.json `studioAuth.sessionSecret` | 自动生成 `data/.inkos/studio-session-secret`（600，属主 1000） |

- 推荐用 `.env`（和其他部署变量放一起）。用 secrets.json 时形如 `{"services":{...},"studioAuth":{"user":"…","passwordHash":"scrypt:…"}}`，
  Studio「服务」页保存 key 时会保留 `studioAuth` 字段；改完要 `docker-compose restart inkos`（插件版：`docker compose restart inkos`）。
- 设了 `INKOS_STUDIO_PASSWORD`（明文）会被忽略并在日志里警告。哈希字段里填了明文（不是 `scrypt:` 格式）→ 视为未配置，拒绝访问。

### 7.2 没配置 / 配错时

- 所有页面返回 503「Studio 暂不可用」说明页，`/api/*` 返回 503 `{"error":{"code":"AUTH_NOT_CONFIGURED"}}`，`/healthz` 返回 503 → 容器 unhealthy。
- `docker-compose logs inkos`（插件版：`docker compose logs inkos`）里有 `[studio-auth]` 框起来的原因和修复命令。
- Studio 进程本身不退出（不会触发 on-failure 重启循环），配好后 `up -d inkos` 即可。

### 7.3 会话、cookie、退出

- 登录有效期 **30 天**（固定，从登录时算）。cookie `inkos_studio_session`：`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`。
- 会话是签名令牌（HMAC-SHA256），容器重启/重建后仍有效（签名密钥在 data 里或 .env 里）。令牌绑定“用户名+密码哈希”，改密码即全部失效。
- **退出登录**：侧边栏底部「退出登录」按钮（手机上在左上角菜单打开的抽屉底部）。退出会把该会话记进 `data/.inkos/studio-auth-revoked.json`（600），重启后仍然无效。
- 强制所有设备下线：改密码；或删除 `data/.inkos/studio-session-secret` 后 `docker-compose restart inkos`（插件版：`docker compose restart inkos`）。
- `Secure` 默认开（NPM 是 https）。只有本机 `http://` 测试才设 `INKOS_STUDIO_COOKIE_SECURE=0`。

### 7.4 登录限流和可信代理（INKOS_TRUSTED_PROXIES）

- 同一 IP 15 分钟内失败 5 次 → 锁定，返回 429 + `Retry-After`（锁定期间密码对也不行），窗口滑出后自动解锁；成功登录清零。容器重启也清零。
- 服务器1 开着 docker-proxy（userland-proxy）：NPM 打到宿主机 `172.17.0.1:4567` 后，容器里看到的 TCP peer **就是项目默认网络的网关**（`INKOS_GATEWAY`，默认 `172.31.67.1`），不是 NPM 容器自己的 IP。
  前提是 `inkos_default` 的名字排在另一张网前面（生产上 `sub2api_sub2api-network` 满足）。
  所以 `.env` 里 **`INKOS_TRUSTED_PROXIES` 只填该网关**（默认 `172.31.67.1/32`），不要填整个网段、也不要猜 NPM 的 IP。
- **只信任网关，只证明请求走了宿主机上的已发布端口**（docker-proxy 从网关进来）。任何能打到 `172.17.0.1:4567` 的进程都可以带 `X-Forwarded-For`。
  **前面仍然必须有 NPM**（TLS、只让 NPM 连 docker0、目前还保留 NPM Basic Auth）。不要把 Studio 端口绑到 `0.0.0.0`。
- 三个变量必须一起改（网关变了，信任列表也要变）：
  ```
  INKOS_SUBNET=172.31.67.0/24
  INKOS_GATEWAY=172.31.67.1
  INKOS_TRUSTED_PROXIES=172.31.67.1/32
  ```
  默认网段被占用时换一个空闲 `/24`，三处一起改。改网段必须 `docker-compose down` 再 `up`（插件版：`docker compose down` 再 `up`）；已有 `inkos_default` 的 IPAM 不会被 `up -d` 改掉。
- 验证：
  ```sh
  docker-compose logs inkos | grep studio-auth | tail -5     # 插件版：docker compose logs inkos | grep studio-auth | tail -5
  # 经发布端口、不带 X-Forwarded-For：peer=<INKOS_GATEWAY>，ip 也是网关
  # 经 NPM（带 X-Forwarded-For）：ip=<客户端> peer=<INKOS_GATEWAY>
  docker network inspect inkos_default -f '{{range .IPAM.Config}}{{.Gateway}} {{.Subnet}}{{end}}'
  ```
- NPM 默认会加 `X-Forwarded-For`（`$proxy_add_x_forwarded_for`）。Studio 从右往左取第一个不在可信列表里的地址；直连地址不在列表里时完全忽略该头（防伪造）。
- 不要把 `INKOS_TRUSTED_PROXIES` 写成整个 `INKOS_SUBNET`：同网段里的其他容器就能伪造该头、绕过按 IP 的限流。

### 7.5 模型 key 不再从接口泄露

- 以前 `GET /api/v1/services/<服务>/secret` 会返回完整 key；现在所有返回 key 的接口（服务 key、封面 key、网页搜索 key）只返回 `****` + 后 4 位。
- 在 Studio「服务」页不改 key 直接保存/测试连接时，前端发回的是 `****xxxx`，服务端会用已保存的真实 key，**不会把 key 覆盖成星号**。要换 key 就输入完整新 key。

### 7.6 和 NPM Basic Auth 共存 / 以后去掉 Basic Auth

- Studio 登录只用 cookie，**完全不读也不写 `Authorization` 头**，未登录时返回的 401 也不带 `WWW-Authenticate`，所以和 NPM 的 Basic Auth 不冲突：
  先过 NPM 的 Basic Auth 弹窗，再进 Studio 登录页。手机上要输两次。
- **目前保留 NPM Basic Auth**，与 Studio 登录共存。以后是否去掉由用户决定。去掉的步骤：
  1. 确认 Studio 登录已生效：无痕窗口打开域名，先 Basic Auth，再看到「InkOS Studio 请登录后继续」；`curl -s https://<域名>/api/v1/books -u <basic 用户>:<basic 密码>` 返回 401 JSON。
  2. 确认 `INKOS_TRUSTED_PROXIES` 已按 7.4 配成网关 `/32`（日志里经 NPM 登录时 ip= 是真实客户端，peer= 是 `INKOS_GATEWAY`）。
  3. NPM → Proxy Hosts → 该域名 → Access List 改为 `Publicly Accessible`（或只保留 IP 白名单部分），保存。
  4. 无痕窗口再打开域名，应直接出现 Studio 登录页；错误密码 5 次后提示锁定。
  5. 回退：把 Access List 改回原来的即可，Studio 不需要任何改动。
- 不论是否去掉 Basic Auth，端口都只绑 `172.17.0.1`，不要暴露到公网。

### 7.7 危险开关

- `INKOS_STUDIO_AUTH=off`：完全关闭登录（日志每次启动都会警告）。只允许在本机临时调试，**生产禁止**。
- `INKOS_STUDIO_COOKIE_SECURE=0`：cookie 不带 Secure，只用于本机 http 测试。

## 8. 首次部署 / 空数据试跑

```sh
cd /opt/docker-dir/inkos
sha256sum -c inkos-1.8.0-34b3213b-d14a99d9.tar.gz.sha256
docker load -i inkos-1.8.0-34b3213b-d14a99d9.tar.gz
cp .env.example .env && chmod 600 .env && vi .env      # 确认 INKOS_IMAGE、SUB2API_NETWORK=sub2api_sub2api-network、INKOS_SECRETS_FROM_ENV=0
# 登录账号：按第 7.1 节生成哈希，填 INKOS_STUDIO_USER / INKOS_STUDIO_PASSWORD_HASH
# 网段：确认 INKOS_SUBNET 空闲，INKOS_GATEWAY 与 INKOS_TRUSTED_PROXIES=<网关>/32 一致
docker network ls -q | xargs docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
docker network inspect sub2api_sub2api-network >/dev/null && echo net-ok
docker-compose config >/dev/null && echo compose-ok    # 插件版：docker compose config >/dev/null && echo compose-ok

# 空数据试跑（不碰正式 data/）
mkdir -p /tmp/inkos-try/data && cp compose.yml .env /tmp/inkos-try/ && chown -R 1000:1000 /tmp/inkos-try/data
cd /tmp/inkos-try
docker-compose -p inkos-try run --rm --no-deps inkos inkos init --lang zh      # 插件版：docker compose -p inkos-try run --rm --no-deps inkos inkos init --lang zh
INKOS_BIND=127.0.0.1 INKOS_PORT=14567 docker-compose -p inkos-try up -d inkos  # 插件版：INKOS_BIND=127.0.0.1 INKOS_PORT=14567 docker compose -p inkos-try up -d inkos
docker-compose -p inkos-try ps                                                 # 插件版：docker compose -p inkos-try ps
curl -s http://127.0.0.1:14567/healthz                                         # {"ok":true}（没配登录则 503）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:14567/api/v1/books   # 401（没登录）
# 浏览器试登录要用 http://，需在 /tmp/inkos-try/.env 临时加 INKOS_STUDIO_COOKIE_SECURE=0（只限试跑）
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
docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs   # 插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs   改 Studio 密码（生成新哈希）
docker-compose logs inkos | grep studio-auth  # 插件版：docker compose logs inkos | grep studio-auth   登录成功/失败/限流记录（含 ip / peer）
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
| Studio 访问 | 原 inkos.nebofeng.com（8013 + Basic Auth），公网路由已断 | NPM → 172.17.0.1:4567；Studio 自带登录（第 7 节），NPM Basic Auth 可保留或由用户决定去掉 |
| 备份 | `/workspace/inkos-backup/daily-backup.sh`（02:47） | 服务器1 运维备份 `backup/daily/`（容器不管） |

## 12. 构建（开发机）

```sh
git checkout deploy/docker-auth          # = deploy/docker + feat/studio-auth
docker build -t inkos:1.8.0-34b3213b-$(git rev-parse --short=8 HEAD) --build-arg VCS_REF=$(git rev-parse --short=8 HEAD) .
# 国内构建可加：--build-arg NPM_REGISTRY=https://registry.npmmirror.com/ --build-arg DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
# （pnpm 按 lockfile 的 integrity 校验包，apt 按 Release 签名校验，换源不影响内容）
docker save <tag> | gzip > <tag 里的 : 换成 ->.tar.gz
```

## 13. 后续事项 / follow-ups

本次**不做**（记在这里，避免当成遗漏）：

- **CSRF token**：会话 cookie 目前只靠 `SameSite=Lax`，没有单独的 CSRF token。
- **通知渠道 token 打码**：notify 渠道的 token 还没有像模型 key 那样打成 `****` + 后 4 位。
