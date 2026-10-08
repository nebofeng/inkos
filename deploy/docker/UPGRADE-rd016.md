# 升级说明：`inkos:1.8.0-34b3213b-d14a99d9` → `@@NEWTAG@@`（Studio 自带登录）

**新镜像默认开启 Studio 登录。切换前不配好账号，Studio 会拒绝所有访问（页面/API 503，容器 unhealthy）。**
daemon、容器内 CLI（`docker-compose exec inkos inkos status` 等）不受影响。**NPM 的 Basic Auth 目前保留**，与 Studio 登录共存（不冲突）。

服务器1 只有独立版 `docker-compose` v2.26.1；每条命令后注释里是插件版写法。

## 切换前（不停机，随时可做）

```sh
cd /opt/docker-dir/inkos
sha256sum -c @@NEWTAR@@.sha256
docker load -i @@NEWTAR@@
cp .env .env.bak-$(date +%Y%m%d)            # 回滚用
cp compose.yml compose.yml.bak-$(date +%Y%m%d)
# 用这次交付的 compose.yml 覆盖（Studio 健康检查改走 /healthz；项目默认网络固定网段）；.env.example 里有新增变量的说明
# 固定网段切换前确认空闲（被占用则三处一起改 INKOS_SUBNET / INKOS_GATEWAY / INKOS_TRUSTED_PROXIES）：
docker network ls -q | xargs docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
vi .env      # INKOS_IMAGE=@@NEWTAG@@
             # INKOS_SUBNET=172.31.67.0/24
             # INKOS_GATEWAY=172.31.67.1
             # INKOS_TRUSTED_PROXIES=172.31.67.1/32   # 必须与 INKOS_GATEWAY 一致
             # 改 .env 不影响正在运行的容器，直到下面 down + up

# 生成密码哈希（一次性容器，用新镜像；按提示输两次密码，不回显）
docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
# 插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs

vi .env      # 必填：INKOS_STUDIO_USER=<用户名>
             #       INKOS_STUDIO_PASSWORD_HASH=<上一步输出的 scrypt:... 整串>（只放哈希，不放明文）
docker-compose config >/dev/null && echo compose-ok      # 插件版：docker compose config >/dev/null && echo compose-ok
```

## 切换（约 1 分钟，Studio 短暂不可用）

**这次会改项目默认网络的 IPAM（固定网段）。必须先 `down` 再 `up`：** 只 `up -d` 不会改已经存在的 `inkos_default` 的子网/网关，trusted proxies 会对不上。`down` 不删 `./data`。

```sh
docker-compose down                        # 插件版：docker compose down      —— 拆掉旧 inkos_default，数据在 ./data
docker-compose up -d                       # 插件版：docker compose up -d     —— 按新 compose 建网并拉起两个容器
docker-compose ps                          # 插件版：docker compose ps        —— inkos / inkos-daemon 应为 healthy
docker network inspect inkos_default -f '{{range .IPAM.Config}}{{.Gateway}} {{.Subnet}}{{end}}'
                                           # 应是 172.31.67.1 172.31.67.0/24（或你在 .env 里改过的值）
docker-compose logs --tail 20 inkos        # 插件版：docker compose logs --tail 20 inkos  —— 应有 [studio-auth] 登录已启用
```

选没有章节在写的时候切：`down` 会同时停 daemon。

验证：手机打开 NPM 域名 → （Basic Auth）→ 「InkOS Studio 请登录后继续」→ 登录后回到原页面；侧边栏底部有「退出登录」。
「服务」页的 API Key 显示为 `****` + 后 4 位，不改直接保存不会覆盖真实 key。

## 切换后

1. 按 README 7.4：从 NPM 域名登录一次，`docker-compose logs inkos | grep studio-auth`（插件版：`docker compose logs inkos | grep studio-auth`）应看到 `peer=<INKOS_GATEWAY>`（默认 `172.31.67.1`），带 `X-Forwarded-For` 时 `ip=` 是客户端。
   **只信任网关只证明请求走了宿主机已发布端口，前面仍然要有 NPM。** NPM Basic Auth 目前保留。
2. 是否去掉 NPM Basic Auth 由用户决定，步骤见 README 7.6。

## 回滚

`.env` 里 `INKOS_IMAGE` 改回 `inkos:1.8.0-34b3213b-d14a99d9`、compose.yml 换回备份，然后 **`docker-compose down && docker-compose up -d`**（插件版：`docker compose down && docker compose up -d`），才能把 `inkos_default` 从固定网段改回 Docker 自动分配。
旧镜像会忽略新增的 `INKOS_STUDIO_*` / `INKOS_SUBNET` / `INKOS_GATEWAY` 变量；`data/.inkos/` 下新增的 `studio-session-secret`、`studio-auth-revoked.json` 对旧镜像无影响。
回滚后 Studio 又没有登录，必须保留 NPM 的 Basic Auth。
