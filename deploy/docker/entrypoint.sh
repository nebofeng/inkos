#!/bin/sh
# InkOS 容器入口。
#   studio  （默认）启动 Studio Web（容器内端口 $INKOS_STUDIO_PORT，默认 4567）
#   daemon  启动写作守护进程（等同于服务器3 上的 `inkos up`）
#   其他    在 /data 下直接执行，例如 `inkos status`、`inkos --version`
set -eu

DATA="${INKOS_PROJECT_ROOT:-/data}"
PORT="${INKOS_STUDIO_PORT:-4567}"
APP=/app
STUDIO_ENTRY="$APP/node_modules/@actalk/inkos-studio/dist/api/index.js"

log() { echo "[inkos-entrypoint] $*" >&2; }

check_data() {
  if [ ! -d "$DATA" ]; then
    log "数据目录 $DATA 不存在，检查 compose 里的 ./data:/data 挂载"; exit 64
  fi
  if [ ! -w "$DATA" ]; then
    log "$DATA 对 uid $(id -u) 不可写。在宿主机执行：chown -R $(id -u):$(id -g) <compose 目录>/data"; exit 65
  fi
  if [ ! -f "$DATA/inkos.json" ]; then
    if [ "${INKOS_ALLOW_INIT:-0}" = "1" ]; then
      log "$DATA 下没有 inkos.json，INKOS_ALLOW_INIT=1，初始化一个空项目"
      (cd "$DATA" && node "$APP/dist/index.js" init --lang "${INKOS_INIT_LANG:-zh}")
    else
      log "$DATA/inkos.json 不存在：数据目录可能挂错了（应挂服务器3 的 inkos-data 整个目录）。"
      log "确实要新建空项目，请设置 INKOS_ALLOW_INIT=1。"
      exit 66
    fi
  fi
  if [ "${INKOS_SECRETS_FROM_ENV:-0}" = "1" ]; then
    node /usr/local/lib/inkos/sync-secrets.mjs "$DATA"
  fi
}

cmd="${1:-studio}"
case "$cmd" in
  studio)
    check_data
    cd "$DATA"
    log "启动 Studio：端口 $PORT，项目目录 $DATA，uid $(id -u)"
    export INKOS_STUDIO_PORT="$PORT"
    exec node "$STUDIO_ENTRY" "$DATA"
    ;;
  daemon)
    shift
    check_data
    cd "$DATA"
    # `inkos up` 发现 inkos.pid 就拒绝启动。容器每次启动都是新的 PID 空间，
    # 这里留下的 inkos.pid 只可能是旧进程（或从服务器3 拷来的）残留，删掉再起。
    if [ -f inkos.pid ]; then
      log "清理残留 inkos.pid（旧 pid $(cat inkos.pid 2>/dev/null || echo '?')）"
      rm -f inkos.pid
    fi
    log "启动 daemon（inkos up），项目目录 $DATA，uid $(id -u)"
    exec node "$APP/dist/index.js" up "$@"
    ;;
  *)
    cd "$DATA" 2>/dev/null || true
    exec "$@"
    ;;
esac
