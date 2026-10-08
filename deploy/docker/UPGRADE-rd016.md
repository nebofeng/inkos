# 升级说明：`inkos:1.8.0-34b3213b-d14a99d9` → `@@NEWTAG@@`（Studio 自带登录）

**新镜像默认开启 Studio 登录。切换前不配好账号，Studio 会拒绝所有访问（页面/API 503，容器 unhealthy）。**
daemon、容器内 CLI（`docker-compose exec inkos inkos status` 等）不受影响。NPM 的 Basic Auth 可以先保留，两者不冲突。

服务器1 只有独立版 `docker-compose` v2.26.1；每条命令后注释里是插件版写法。

## 切换前（不停机，随时可做）

```sh
cd /opt/docker-dir/inkos
sha256sum -c @@NEWTAR@@.sha256
docker load -i @@NEWTAR@@
cp .env .env.bak-$(date +%Y%m%d)            # 回滚用
cp compose.yml compose.yml.bak-$(date +%Y%m%d)
# 用这次交付的 compose.yml 覆盖（Studio 健康检查改走 /healthz）；.env.example 里有新增变量的说明
vi .env      # INKOS_IMAGE=@@NEWTAG@@
             # 改 .env 不影响正在运行的容器，直到下面 up -d

# 生成密码哈希（一次性容器，用新镜像；按提示输两次密码，不回显）
docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
# 插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs

vi .env      # 必填：INKOS_STUDIO_USER=<用户名>
             #       INKOS_STUDIO_PASSWORD_HASH=<上一步输出的 scrypt:... 整串>（只放哈希，不放明文）
             # 先留空：INKOS_TRUSTED_PROXIES=（切换后按 README 7.4 查到 NPM 的 peer 地址再填）
docker-compose config >/dev/null && echo compose-ok      # 插件版：docker compose config >/dev/null && echo compose-ok
```

## 切换（约 1 分钟，Studio 短暂不可用）

```sh
docker-compose up -d inkos                 # 插件版：docker compose up -d inkos
docker-compose ps                          # 插件版：docker compose ps        —— inkos 应为 healthy
docker-compose logs --tail 20 inkos        # 插件版：docker compose logs --tail 20 inkos  —— 应有 [studio-auth] 登录已启用
docker-compose up -d inkos-daemon          # 插件版：docker compose up -d inkos-daemon  —— 换到新镜像（会重启 daemon，选没有章节在写的时候）
```

验证：手机打开 NPM 域名 → （Basic Auth）→ 「InkOS Studio 请登录后继续」→ 登录后回到原页面；侧边栏底部有「退出登录」。
「服务」页的 API Key 显示为 `****` + 后 4 位，不改直接保存不会覆盖真实 key。

## 切换后

1. 按 README 7.4：`docker-compose logs inkos | grep studio-auth`（插件版：`docker compose logs inkos | grep studio-auth`）看 `peer=`，
   把 NPM 的地址填进 `INKOS_TRUSTED_PROXIES`，`docker-compose up -d inkos`（插件版：`docker compose up -d inkos`）。不填的话登录限流对所有人共用一个计数。
2. 是否去掉 NPM Basic Auth 由用户决定，步骤见 README 7.6。

## 回滚

`.env` 里 `INKOS_IMAGE` 改回 `inkos:1.8.0-34b3213b-d14a99d9`、compose.yml 换回备份，`docker-compose up -d`（插件版：`docker compose up -d`）。
旧镜像会忽略新增的 `INKOS_STUDIO_*` 变量；`data/.inkos/` 下新增的 `studio-session-secret`、`studio-auth-revoked.json` 对旧镜像无影响。
回滚后 Studio 又没有登录，必须保留 NPM 的 Basic Auth。
