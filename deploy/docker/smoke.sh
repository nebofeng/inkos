#!/bin/bash
# InkOS Docker 冒烟（RD-011 + RD-016 Studio 登录）。
#   A=空项目（含 E 段登录用例），B=服务器3 备份副本（去掉密钥），D=空项目无 llm.services。
#   只用假 key、假密码、假 baseUrl，不发真实大模型请求；日志里不打印密码哈希和 cookie 值。
# usage: smoke.sh <image-tag>      环境变量：R（工作目录，默认 /root/workspace/rd016）、SRC_COMPOSE、BAK
# 结束时 exit $fails（全部通过 = 0）。
IMG=${1:?image}
R=${R:-/root/workspace/rd016}
LOG=$R/smoke.log
SRC_COMPOSE=${SRC_COMPOSE:-$(cd "$(dirname "$0")" && pwd)}
BAK=${BAK:-/mnt/e/data/cloud-bak/server3-grokbot-box/2026-10-08/workspace/inkos-data}
NET=rd016-fake-sub2api
PORT=4567
FAKEKEY=sk-fake-rd016-smoke-0000
FAKEUSER=smoke
FAKEPW=fake-rd016-smoke-Pw-0000
XFF_IP=198.51.100.77
# 项目网段：server0 上空闲则用默认 172.31.67.0/24；被占用且未在环境里覆盖时改用 172.31.69.0/24
SMOKE_SUBNET=${INKOS_SUBNET:-172.31.67.0/24}
SMOKE_GATEWAY=${INKOS_GATEWAY:-172.31.67.1}
SMOKE_TRUSTED=${INKOS_TRUSTED_PROXIES:-${SMOKE_GATEWAY}/32}
exec > $LOG 2>&1
fails=0; passes=0
ok(){ passes=$((passes+1)); echo "PASS | $*"; }; bad(){ fails=$((fails+1)); echo "FAIL | $*"; }
chk(){ local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
wait_health(){ # name timeout
  local n=$1 t=${2:-150} s
  for i in $(seq 1 $t); do s=$(docker inspect -f '{{.State.Health.Status}}' $n 2>/dev/null); [ "$s" = healthy ] && { echo "$n healthy after ${i}s"; return 0; }; sleep 1; done
  echo "$n health=$s"; docker logs --tail 30 $n; return 1; }
http(){ curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1"; }
CK=""   # 当前登录 cookie（name=value），只在内存里，不打印
httpc(){ curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Cookie: $CK" "$1"; }
getc(){ curl -s --max-time 15 -H "Cookie: $CK" "$1"; }
# login <password> [cookie变量名] [额外 curl 参数...] -> 设置 LOGIN_CODE、LOGIN_HDR（set-cookie 属性，令牌已打码）、cookie
login(){ local pw=$1 var=${2:-CK} h=/tmp/rd016-login-h b=/tmp/rd016-login-b
  shift; [ $# -gt 0 ] && shift
  curl -s -D $h -o $b --max-time 15 -H 'Content-Type: application/json' "$@" \
    -d "$(node -e 'console.log(JSON.stringify({username:process.argv[1],password:process.argv[2]}))' "$FAKEUSER" "$pw")" \
    http://127.0.0.1:$PORT/api/v1/auth/login
  LOGIN_CODE=$(head -1 $h | awk '{print $2}'); LOGIN_RETRY=$(grep -i '^retry-after:' $h | tr -d '\r' | awk '{print $2}')
  LOGIN_HDR=$(grep -i '^set-cookie:' $h | tr -d '\r' | sed -E 's/=v1\.[^;]+/=<token>/')
  local c; c=$(grep -i '^set-cookie:' $h | tr -d '\r' | sed -E 's/^[Ss]et-[Cc]ookie: *([^;]+).*/\1/')
  [ -n "$c" ] && printf -v "$var" '%s' "$c"; rm -f $h $b; }

echo "=== $(date '+%F %T') smoke $IMG"
docker image inspect $IMG --format 'id={{.Id}} size={{.Size}} user={{.Config.User}} entry={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}} health={{json .Config.Healthcheck.Test}}'
docker image inspect $IMG --format '{{range .Config.Env}}{{println .}}{{end}}'
docker volume ls -q | sort > /tmp/rd016-vol-before
(ss -ltn 2>/dev/null | grep -q ":$PORT ") && { echo "port $PORT busy, use 14567"; PORT=14567; }
if docker network ls -q | xargs -r docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' | grep -qx "$SMOKE_SUBNET"; then
  if [ -n "${INKOS_SUBNET:-}" ]; then
    echo "INKOS_SUBNET=$SMOKE_SUBNET is already in use on this host (explicit override; network create may fail)"
  else
    echo "default subnet 172.31.67.0/24 is in use on server0; smoke overrides to 172.31.69.0/24"
    SMOKE_SUBNET=172.31.69.0/24
    SMOKE_GATEWAY=172.31.69.1
    SMOKE_TRUSTED=172.31.69.1/32
  fi
else
  echo "using subnet $SMOKE_SUBNET gateway $SMOKE_GATEWAY trusted $SMOKE_TRUSTED (free on this host)"
fi
docker network create $NET >/dev/null && echo "net $NET created"
# 用镜像里的 hash-password.mjs 生成假密码的哈希（stdin 传入，不进命令行参数）
HASHLINE=$(printf '%s\n' "$FAKEPW" | docker run --rm -i --entrypoint node $IMG /usr/local/lib/inkos/hash-password.mjs 2>/dev/null)
case "$HASHLINE" in INKOS_STUDIO_PASSWORD_HASH=scrypt:32768:8:1:*) echo "fake password hash generated (scrypt, not printed)";; *) echo "hash generation failed";; esac

mk_proj(){ # dir
  local T=$1; rm -rf $T; mkdir -p $T/data; cp $SRC_COMPOSE/compose.yml $T/
  sed -e "s#^INKOS_IMAGE=.*#INKOS_IMAGE=$IMG#" -e "s#^INKOS_BIND=.*#INKOS_BIND=127.0.0.1#" -e "s#^INKOS_PORT=.*#INKOS_PORT=$PORT#" \
      -e "s#^SUB2API_NETWORK=.*#SUB2API_NETWORK=$NET#" -e "s#^INKOS_SECRETS_FROM_ENV=.*#INKOS_SECRETS_FROM_ENV=1#" \
      -e "s#^INKOS_STUDIO_USER=.*#INKOS_STUDIO_USER=$FAKEUSER#" -e "s#^INKOS_STUDIO_PASSWORD_HASH=.*#$HASHLINE#" \
      -e "s#^INKOS_SUBNET=.*#INKOS_SUBNET=$SMOKE_SUBNET#" -e "s#^INKOS_GATEWAY=.*#INKOS_GATEWAY=$SMOKE_GATEWAY#" \
      -e "s#^INKOS_TRUSTED_PROXIES=.*#INKOS_TRUSTED_PROXIES=$SMOKE_TRUSTED#" \
      $SRC_COMPOSE/.env.example > $T/.env; echo "CUSTOM_SUB2API_API_KEY=$FAKEKEY" >> $T/.env; chmod 600 $T/.env; chmod 700 $T; }
set_fake_llm(){ # 改 inkos.json：服务 custom:sub2api，baseUrl http://sub2api:8080/v1（临时网络里没有这个主机）
  docker compose run --rm --no-deps inkos node -e '
const fs=require("fs");const p="/data/inkos.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.llm=c.llm||{};
const u="http://sub2api:8080/v1";c.llm.baseUrl=u;
if(!Array.isArray(c.llm.services)||!c.llm.services.length){c.llm.services=[{service:"custom",name:"sub2api",baseUrl:u,apiFormat:"responses",stream:true}];c.llm.service="custom:sub2api";c.llm.configSource="studio";c.llm.model=c.llm.model||"fake-model";c.llm.defaultModel=c.llm.defaultModel||"fake-model";}
else c.llm.services=c.llm.services.map(s=>s&&s.baseUrl?{...s,baseUrl:u}:s);
fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");console.log("baseUrl ->",c.llm.baseUrl,"services:",c.llm.services.map(s=>s.service+":"+(s.name||"")+"@"+s.baseUrl).join(","));'; }

########## A：空项目 ##########
echo; echo "########## A 空项目"
A=$R/smoke-a; mk_proj $A; chown 1000:1000 $A/data; cd $A
echo "--- A0 空 data 目录直接起 Studio：应拒绝启动（防挂错目录）"
docker compose -p rd016smoke run --rm --no-deps inkos studio; rc=$?
chk "A0 空目录拒绝启动 (exit=$rc, 期望 66)" [ $rc = 66 ]
echo "--- A1 inkos init 建空项目"
docker compose -p rd016smoke run --rm --no-deps inkos inkos init --lang zh | tail -5
chk "A1 inkos.json 已生成" [ -f data/inkos.json ]
COMPOSE_PROJECT_NAME=rd016smoke set_fake_llm
echo 99999 > data/inkos.pid; chown 1000:1000 data/inkos.pid; echo "(放了一个残留 inkos.pid=99999)"
docker compose -p rd016smoke up -d 2>&1 | tail -5
wait_health inkos; chk "A2 Studio 容器 healthy" [ "$(docker inspect -f '{{.State.Health.Status}}' inkos)" = healthy ]
wait_health inkos-daemon 120; chk "A3 daemon 容器 healthy（残留 pid 已清理）" [ "$(docker inspect -f '{{.State.Health.Status}}' inkos-daemon)" = healthy ]
nets=$(docker inspect inkos --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
echo "inkos networks: $nets"
chk "E13 inkos 同时加入项目固定网段网络和假外部网络" [ -n "$(echo " $nets " | grep -E ' rd016smoke_default | inkos_default ')" -a -n "$(echo " $nets " | grep -F " $NET ")" ]
projnet=$(docker inspect inkos --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | grep -E '_default$' | head -1)
ipam=$(docker network inspect "$projnet" -f '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}')
echo "project net $projnet ipam=[$ipam] configured=[$SMOKE_SUBNET $SMOKE_GATEWAY]"
chk "E14 项目网络 subnet/gateway 等于配置值" [ "$ipam" = "$SMOKE_SUBNET $SMOKE_GATEWAY" ]
docker logs inkos-daemon 2>&1 | head -14
docker logs inkos-daemon 2>&1 | grep -q "模型配置 OK" && ok "A3b daemon 启动前模型配置检查通过" || bad "A3b daemon 模型配置检查"
login "$FAKEPW"; echo "login: HTTP $LOGIN_CODE"
peerline=$(docker logs inkos 2>&1 | grep '登录成功' | tail -1)
echo "login log: $peerline"
chk "E15 经发布端口登录 peer=项目网关" [ "$LOGIN_CODE" = 200 -a -n "$(echo "$peerline" | grep -F "peer=$SMOKE_GATEWAY")" ]
c=$(httpc http://127.0.0.1:$PORT/); chk "A4 GET /（已登录）-> $c" [ "$c" = 200 ]
c=$(httpc http://127.0.0.1:$PORT/api/v1/books); chk "A5 GET /api/v1/books（已登录）-> $c" [ "$c" = 200 ]
getc http://127.0.0.1:$PORT/api/v1/books | head -c 300; echo
docker port inkos
v=$(docker exec inkos inkos --version 2>&1 | tail -1); chk "A6 inkos --version = $v" [ "$v" = 1.8.0 ]
docker exec inkos id
chk "A7 容器以 uid 1000 运行" [ "$(docker exec inkos id -u)" = 1000 ]
docker exec inkos inkos status > /tmp/rd016-st 2>&1; rc=$?; tail -8 /tmp/rd016-st; chk "A8 inkos status (exit=$rc)" [ $rc = 0 ]
docker exec inkos inkos book list > /tmp/rd016-st 2>&1; rc=$?; tail -5 /tmp/rd016-st; chk "A9 inkos book list (exit=$rc)" [ $rc = 0 ]
docker exec inkos inkos graph --help > /dev/null 2>&1; rc=$?; chk "A10 inkos graph --help (exit=$rc)" [ $rc = 0 ]
docker exec inkos timeout 90 inkos doctor > /tmp/rd016-st 2>&1; echo "doctor exit=$?（API 连通性应失败：sub2api 是假主机）"; grep -iE 'node|api|sqlite|fail|ok' /tmp/rd016-st | head -12
docker exec inkos sh -c 'ls -l /data/.inkos/secrets.json | cut -c1-10'
n=$(grep -c "$FAKEKEY" data/.inkos/secrets.json); chk "A11 INKOS_SECRETS_FROM_ENV 把 .env 的假 key 写进 secrets.json（600）" [ "$n" = 1 -a "$(stat -c %a data/.inkos/secrets.json)" = 600 ]
docker logs inkos 2>&1 | grep sync-secrets
docker exec inkos sh -c 'echo marker-$(date +%s) > /data/smoke-marker'; M=$(cat data/smoke-marker)
docker compose -p rd016smoke restart 2>&1 | tail -3
wait_health inkos; wait_health inkos-daemon 120
chk "A12 重启后数据还在（marker 一致）" [ "$(docker exec inkos cat /data/smoke-marker)" = "$M" ]
chk "A13 重启后 Studio 200（同一 cookie）" [ "$(httpc http://127.0.0.1:$PORT/)" = 200 ]

########## E：Studio 登录（RD-016）##########
echo; echo "########## E Studio 登录"
U=http://127.0.0.1:$PORT
b=$(curl -s --max-time 10 $U/api/v1/books); c=$(http $U/api/v1/books); echo "unauth books: $c $b"
chk "E1 未登录 GET /api/v1/books -> 401 JSON AUTH_REQUIRED" [ "$c" = 401 -a -n "$(echo "$b" | grep '"AUTH_REQUIRED"')" ]
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 $U/api/v1/events); chk "E1b 未登录 SSE /api/v1/events -> $c" [ "$c" = 401 ]
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' -d '{}' $U/api/v1/daemon/start); chk "E1c 未登录 POST /api/v1/daemon/start -> $c" [ "$c" = 401 ]
loc=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "$U/?tab=1"); echo "GET /?tab=1 -> $loc"
chk "E1d 未登录页面 302 到 /login?next=" [ -n "$(echo "$loc" | grep -E '^302 .*/login\?next=%2F%3Ftab%3D1$')" ]
lp=$(curl -s --max-time 10 "$U/login"); chk "E1e 登录页中文、手机 viewport、有表单" [ -n "$(echo "$lp" | grep 'lang="zh-CN"')" -a -n "$(echo "$lp" | grep 'width=device-width')" -a -n "$(echo "$lp" | grep 'autocomplete="current-password"')" ]
hz=$(curl -s --max-time 10 $U/healthz); c=$(http $U/healthz); echo "healthz: $c $hz"
chk "E2 /healthz 200 且只有 {\"ok\":true}（无书名/key/路径/版本）" [ "$c" = 200 -a "$hz" = '{"ok":true}' ]
echo "set-cookie: $LOGIN_HDR"
chk "E5 正确登录 200，cookie HttpOnly+Secure+SameSite=Lax+30天" [ "$LOGIN_CODE" = 200 -a -n "$(echo "$LOGIN_HDR" | grep -i 'HttpOnly' | grep -i 'Secure' | grep -i 'SameSite=Lax' | grep 'Max-Age=2592000')" ]
c=$(httpc $U/api/v1/books); chk "E6 已登录 /api/v1/books -> $c" [ "$c" = 200 ]
ct=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 3 -H "Cookie: $CK" $U/api/v1/events); echo "auth SSE: $ct"
chk "E6b 已登录 SSE 能连上（text/event-stream）" [ -n "$(echo "$ct" | grep '^200 text/event-stream')" ]
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Cookie: $CK" -H 'Authorization: Basic Zm9vOmJhcg==' $U/api/v1/books)
wa=$(curl -s -D - -o /dev/null --max-time 10 -H 'Authorization: Basic Zm9vOmJhcg==' $U/api/v1/books | grep -ci '^www-authenticate')
chk "E6c 带 NPM Basic Auth 的 Authorization 头不影响（有 cookie 200=$c，无 cookie 401 且无 WWW-Authenticate=$wa）" [ "$c" = 200 -a "$wa" = 0 ]
sec=$(getc "$U/api/v1/services/custom%3Asub2api/secret"); echo "secret endpoint: $sec"
all=""; for p in /api/v1/services /api/v1/services/config "/api/v1/services/custom%3Asub2api/secret" /api/v1/project /api/v1/project/research-search /api/v1/doctor "/api/v1/services/custom%3Asub2api/models" /api/v1/books; do all="$all$(getc "$U$p")"; done
hits=$(printf '%s' "$all" | grep -c -F -- "$FAKEKEY")
chk "E7 key 打码：secret 接口只返回 ****0000，8 个 GET 接口里搜不到完整 key（命中 $hits）" [ "$sec" = '{"apiKey":"****0000"}' -a "$hits" = 0 ]
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X PUT -H "Cookie: $CK" -H 'Content-Type: application/json' -d '{"apiKey":"****0000"}' "$U/api/v1/services/custom%3Asub2api/secret")
n=$(grep -c -F -- "$FAKEKEY" data/.inkos/secrets.json)
chk "E7b UI 原样保存打码值（PUT ****0000 -> $c）不覆盖真实 key（secrets.json 里仍有完整假 key：$n）" [ "$c" = 200 -a "$n" = 1 ]
login "$FAKEPW" CK2
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H "Cookie: $CK2" $U/api/v1/auth/logout)
c2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Cookie: $CK2" $U/api/v1/books); c3=$(httpc $U/api/v1/books)
chk "E8 退出登录（logout $c）后该会话 401（$c2），其他会话不受影响（$c3）" [ "$c" = 200 -a "$c2" = 401 -a "$c3" = 200 ]
ls -l data/.inkos/studio-session-secret data/.inkos/studio-auth-revoked.json | cut -c1-10
chk "E8b 会话密钥/吊销列表文件 600" [ "$(stat -c %a data/.inkos/studio-session-secret)" = 600 -a "$(stat -c %a data/.inkos/studio-auth-revoked.json)" = 600 ]
docker compose -p rd016smoke restart inkos 2>&1 | tail -1; wait_health inkos
c=$(httpc $U/api/v1/books); c2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Cookie: $CK2" $U/api/v1/books)
chk "E9 容器重启后会话仍有效（$c），已退出的会话仍无效（$c2）" [ "$c" = 200 -a "$c2" = 401 ]
login "wrong-password-1"; chk "E3 错误密码 -> $LOGIN_CODE" [ "$LOGIN_CODE" = 401 ]
for i in 2 3 4; do login "wrong-password-$i"; echo "wrong #$i -> $LOGIN_CODE"; done
login "wrong-password-5"; c5=$LOGIN_CODE; r5=$LOGIN_RETRY
login "$FAKEPW" CK3; echo "5th wrong -> $c5 (Retry-After $r5); then correct -> $LOGIN_CODE (Retry-After $LOGIN_RETRY)"
chk "E4 同一 IP 失败 5 次 -> 429 + Retry-After，锁定期间正确密码也 429" [ "$c5" = 429 -a -n "$r5" -a "$LOGIN_CODE" = 429 -a -n "$LOGIN_RETRY" ]
login "$FAKEPW" CKXFF -H "X-Forwarded-For: $XFF_IP"
xffline=$(docker logs inkos 2>&1 | grep "ip=$XFF_IP" | tail -1)
echo "xff login: HTTP $LOGIN_CODE log: $xffline"
chk "E16 经发布端口带 X-Forwarded-For 时归属该 IP（trusted 网关）" [ "$LOGIN_CODE" = 200 -a -n "$(echo "$xffline" | grep -F "ip=$XFF_IP" | grep -F "peer=$SMOKE_GATEWAY")" ]
docker logs inkos 2>&1 | grep studio-auth | tail -4
docker compose -p rd016smoke exec -T inkos inkos status > /tmp/rd016-st 2>&1; rc=$?; tail -4 /tmp/rd016-st
chk "E10 docker compose exec inkos inkos status 不受登录影响 (exit=$rc)" [ $rc = 0 ]
h=$(printf '%s\n' "$FAKEPW" | docker compose -p rd016smoke run --rm -T --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs 2>/dev/null)
docker compose -p rd016smoke run --rm -T --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs "$FAKEPW" >/dev/null 2>&1; rc=$?
chk "E11 hash-password.mjs：compose run 从 stdin 生成 scrypt 哈希；命令行给密码被拒（exit=$rc）" [ -n "$(echo "$h" | grep -E '^INKOS_STUDIO_PASSWORD_HASH=scrypt:32768:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$')" -a "$rc" = 2 ]
unset h
echo "--- A14 daemon 被 SIGKILL（留下 inkos.pid）后再启动"
docker kill -s KILL inkos-daemon >/dev/null; sleep 3; ls -l data/inkos.pid
docker compose -p rd016smoke up -d inkos-daemon 2>&1 | tail -2
wait_health inkos-daemon 120; chk "A14 SIGKILL 后 daemon 能再起来并 healthy" [ "$(docker inspect -f '{{.State.Health.Status}}' inkos-daemon)" = healthy ]
docker inspect inkos --format 'mounts={{json .Mounts}} restart={{.HostConfig.RestartPolicy.Name}} mem={{.HostConfig.Memory}} log={{json .HostConfig.LogConfig}}'
docker inspect inkos --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker inspect inkos inkos-daemon --format '{{.Name}} {{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}' 
chk "A15 只有 bind mount" [ -z "$(docker inspect inkos inkos-daemon --format '{{range .Mounts}}{{if ne .Type "bind"}}x{{end}}{{end}}')" ]
chk "A16 restart 策略 on-failure:5" [ "$(docker inspect inkos-daemon --format '{{.HostConfig.RestartPolicy.Name}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}')" = on-failure:5 ]
docker compose -p rd016smoke stop inkos-daemon 2>&1 | tail -1
e=$(docker inspect -f '{{.State.ExitCode}}' inkos-daemon); docker logs --tail 3 inkos-daemon 2>&1
chk "A17 docker stop 后 daemon 退出码 143（宿主机重启后 on-failure 会拉起）= $e" [ "$e" = 143 ]
echo "--- E12 没配置登录：Studio 拒绝访问"
cp .env .env.bak && sed -i -e 's#^INKOS_STUDIO_USER=.*#INKOS_STUDIO_USER=#' -e 's#^INKOS_STUDIO_PASSWORD_HASH=.*#INKOS_STUDIO_PASSWORD_HASH=#' .env
docker compose -p rd016smoke up -d inkos 2>&1 | tail -1; sleep 8
a=$(http $U/api/v1/books); p=$(http $U/); hz=$(curl -s --max-time 5 $U/healthz); hzc=$(http $U/healthz); lc=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"username":"smoke","password":"x"}' $U/api/v1/auth/login)
echo "unconfigured: api=$a page=$p login=$lc healthz=$hzc $hz"; docker logs inkos 2>&1 | grep studio-auth | head -4
chk "E12 未配置登录：/api 503、页面 503、登录 503、/healthz 503 {\"ok\":false}" [ "$a" = 503 -a "$p" = 503 -a "$lc" = 503 -a "$hzc" = 503 -a "$hz" = '{"ok":false}' ]
docker logs inkos 2>&1 | grep -q "登录未配置" && ok "E12b 日志里有清楚的未配置说明" || bad "E12b 日志里没有未配置说明"
mv .env.bak .env
docker compose -p rd016smoke down 2>&1 | tail -3

########## B：服务器3 备份副本 ##########
echo; echo "########## B 备份副本（去掉 .inkos/secrets.json 和 .env，只读用备份）"
B=$R/smoke-b; mk_proj $B; cd $B
if [ -d "$BAK" ]; then
  tar -C "$BAK" --exclude=./.inkos/secrets.json --exclude=./.env -cf - . | tar -C data -xf -
  chown -R 1000:1000 data; echo "copied: $(du -sh data | cut -f1)"; ls data; ls data/books
  [ -e data/.inkos/secrets.json ] && bad "secrets.json 被拷过来了" || ok "B0 副本里没有真实 secrets.json"
  docker compose -p rd016smoke2 run --rm --no-deps inkos node /usr/local/lib/inkos/set-baseurl.mjs http://sub2api:8080/v1; rc=$?
  chk "B0b set-baseurl.mjs 把 baseUrl 改成 http://sub2api:8080/v1 (exit=$rc)" [ $rc = 0 ]
  grep -o '"baseUrl": "[^"]*"' data/inkos.json
  docker compose -p rd016smoke2 up -d inkos 2>&1 | tail -3
  wait_health inkos; chk "B1 Studio healthy（挂现有数据结构）" [ "$(docker inspect -f '{{.State.Health.Status}}' inkos)" = healthy ]
  login "$FAKEPW"; echo "login: HTTP $LOGIN_CODE"
  getc http://127.0.0.1:$PORT/api/v1/books > /tmp/rd016-books.json
  nb=$(node -e 'const d=require("/tmp/rd016-books.json");const b=d.books||d;console.log(b.length);for(const x of b)console.error(" -",x.id,"|",x.status,"| chapters:",x.chaptersWritten??x.chapterCount??"?")')
  chk "B2 Studio /api/v1/books 列出 $nb 本书（期望 3）" [ "$nb" = 3 ]
  for id in $(ls data/books); do e=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$id"); echo "$id: book=$(httpc http://127.0.0.1:$PORT/api/v1/books/$e) ch1=$(httpc http://127.0.0.1:$PORT/api/v1/books/$e/chapters/1)"; done
  c=$(httpc http://127.0.0.1:$PORT/); chk "B3 GET /（已登录）-> $c" [ "$c" = 200 ]
  docker exec inkos inkos status > /tmp/rd016-st 2>&1; rc=$?; tail -12 /tmp/rd016-st; chk "B4 inkos status (exit=$rc)" [ $rc = 0 ]
  docker exec inkos inkos book list > /tmp/rd016-st 2>&1; rc=$?; tail -6 /tmp/rd016-st; chk "B5 inkos book list (exit=$rc)" [ $rc = 0 ]
  first=$(ls data/books | head -1)
  docker exec inkos inkos graph status "$first" > /tmp/rd016-st 2>&1; rc=$?; tail -6 /tmp/rd016-st; echo "graph status exit=$rc"
  docker logs inkos 2>&1 | tail -5
  docker compose -p rd016smoke2 down 2>&1 | tail -3
else bad "备份目录不存在 $BAK"; fi

########## D：空项目没有 llm.services，daemon 应报错停下而不是无限重启 ##########
echo; echo "########## D 空项目（INKOS_ALLOW_INIT=1，无 llm.services）"
D=$R/smoke-d; mk_proj $D; chown 1000:1000 $D/data; cd $D
echo "INKOS_ALLOW_INIT=1" >> .env
docker compose -p rd016smoke3 up -d 2>&1 | tail -3
wait_health inkos 90; chk "D1 Studio 自动初始化空项目并 healthy" [ -f data/inkos.json -a "$(docker inspect -f '{{.State.Health.Status}}' inkos)" = healthy ]
node -e 'const c=require(process.argv[1]);console.log("llm.services =",JSON.stringify(c.llm&&c.llm.services))' $D/data/inkos.json
st=""; for i in $(seq 1 120); do st=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}' inkos-daemon); case "$st" in exited*) break;; esac; sleep 1; done
echo "daemon: $st (after ${i}s)"; sleep 20
st2=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}' inkos-daemon); echo "20s later: $st2"
set -- $st2
chk "D2 daemon 已停止（status=$1）" [ "$1" = exited ]
chk "D3 退出码 78（模型配置不可用）= $2" [ "$2" = 78 ]
chk "D4 重启次数封顶 5 次后不再重启（RestartCount=$3，20s 内无变化）" [ "$3" = 5 -a "$st" = "$st2" ]
docker logs inkos-daemon 2>&1 | grep -E 'llm-check|inkos-entrypoint' | tail -9
docker logs inkos-daemon 2>&1 | grep -q "模型（LLM）配置不可用" && ok "D5 日志里有清楚的错误说明" || bad "D5 日志里没有错误说明"
chk "D6 Studio 不受影响仍 healthy" [ "$(docker inspect -f '{{.State.Health.Status}}' inkos)" = healthy ]
docker compose -p rd016smoke3 down 2>&1 | tail -2
rm -rf $D

########## 清理与镜像检查 ##########
echo; echo "########## 清理 & 镜像检查"
docker network rm $NET >/dev/null && echo "net removed"
docker ps -a --format '{{.Names}}' | grep -E '^inkos' && bad "测试容器残留" || ok "C1 测试容器已删除"
docker volume ls -q | sort > /tmp/rd016-vol-after
d=$(comm -13 /tmp/rd016-vol-before /tmp/rd016-vol-after); chk "C2 没有新增卷 [$d]" [ -z "$d" ]
rm -rf $A $B $D; chk "C3 测试目录已删除" [ ! -e $A -a ! -e $B -a ! -e $D ]
docker history --no-trunc $IMG --format '{{.CreatedBy}}' | grep -iE 'api_key=|apikey=|password=|token=|sk-[A-Za-z0-9]' && bad "history 里有可疑字样" || ok "C4 docker history 无 key/secret 字样"
f=$(docker run --rm --entrypoint sh $IMG -c 'find / -xdev \( -name ".env" -o -name ".env.*" -o -name "secrets.json" -o -name "inkos.json" -o -name "*.pem" \) -not -path "/proc/*" 2>/dev/null; ls /data | head')
chk "C5 镜像文件系统里没有 .env/secrets.json/inkos.json/小说数据 [$f]" [ -z "$f" ]
# 用备份里的真实 key 做“是否被打进镜像”的反查：只输出命中次数，不输出值
if [ -f "$BAK/.inkos/secrets.json" ]; then
  K=$(node -e 'const s=require(process.argv[1]);const v=Object.values(s.services||{}).map(x=>x.apiKey).filter(Boolean);console.log(v.join("\n"))' "$BAK/.inkos/secrets.json")
  hits=0; while IFS= read -r k; do [ -n "$k" ] || continue; h=$(docker save $IMG | grep -a -c -F -- "$k"); hits=$((hits+h)); done <<< "$K"; unset K k
  chk "C6 docker save 镜像全量里搜不到服务器3 的真实 key（命中 $hits 次）" [ "$hits" = 0 ]
fi
h=$(docker save $IMG | grep -a -c -F -e "$FAKEKEY" -e "$FAKEPW"); chk "C7 镜像里搜不到测试假 key / 假密码（命中 $h）" [ "$h" = 0 ]
unset HASHLINE CK CK2 CK3 CKXFF
echo "=== $(date '+%F %T') smoke done: PASS=$passes FAIL=$fails"
exit $fails
