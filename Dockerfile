# InkOS 镜像（Studio + CLI + daemon），多阶段构建。
# 镜像里只有构建产物和生产依赖：没有 .env、密钥、小说数据。数据目录在运行时 bind mount 到 /data。
# 用法见 deploy/docker/README.md。

# 默认用和服务器3 现有运行时相同的 Node 版本（22.20.0）。
ARG NODE_IMAGE=node:22.20.0-bookworm-slim

############################
# 1) build：pnpm 安装 + 构建 core / cli / studio，再用 pnpm deploy 导出 cli 的生产依赖
############################
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG PNPM_VERSION=9.15.9
ENV CI=1
RUN npm install -g "pnpm@${PNPM_VERSION}" --registry="${NPM_REGISTRY}" \
 && pnpm config set registry "${NPM_REGISTRY}"
WORKDIR /src

# 先只拷依赖清单，利用缓存层
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/studio/package.json packages/studio/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build \
 && test -f packages/core/dist/index.js \
 && test -f packages/cli/dist/index.js \
 && test -f packages/studio/dist/index.html \
 && test -f packages/studio/dist/api/index.js

# 导出 @actalk/inkos（cli）及其生产依赖；workspace 里的 core / studio 会被拷成真实目录
RUN pnpm --filter @actalk/inkos deploy --prod /out \
 && test -f /out/dist/index.js \
 && test -f /out/node_modules/@actalk/inkos-studio/dist/index.html \
 && test -f /out/node_modules/@actalk/inkos-studio/dist/api/index.js \
 && test -f /out/node_modules/@actalk/inkos-core/dist/index.js \
 && rm -rf /out/node_modules/@actalk/*/src /out/node_modules/@actalk/*/node_modules/.cache \
 && find /out -name '*.map' -type f -delete \
 && find /out -path '*/__tests__/*' -type f -delete \
 && ! find /out -name '.env' -o -name 'secrets.json' | grep -q .

############################
# 2) runtime：只放 /app 产物 + tini + tzdata，非 root 运行
############################
FROM ${NODE_IMAGE} AS runtime
# 可选：国内构建时用 apt 镜像，例如 --build-arg DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn（slim 镜像没有 CA 证书，要用 http；apt 有签名校验）
ARG DEBIAN_MIRROR=
ARG VCS_REF=unknown
ARG INKOS_VERSION=1.8.0
LABEL org.opencontainers.image.title="inkos" \
      org.opencontainers.image.version="${INKOS_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/nebofeng/inkos" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s#http://deb.debian.org#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends tini tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    INKOS_PROJECT_ROOT=/data \
    INKOS_STUDIO_PORT=4567

COPY --from=build /out /app
COPY deploy/docker/entrypoint.sh /usr/local/bin/inkos-entrypoint
COPY deploy/docker/healthcheck.mjs deploy/docker/sync-secrets.mjs deploy/docker/set-baseurl.mjs /usr/local/lib/inkos/
RUN printf '#!/bin/sh\nexec node /app/dist/index.js "$@"\n' > /usr/local/bin/inkos \
 && chmod 0755 /usr/local/bin/inkos /usr/local/bin/inkos-entrypoint \
 && chmod 0644 /usr/local/lib/inkos/*.mjs \
 && mkdir -p /data && chown node:node /data \
 && inkos --version

# node 用户：uid 1000 / gid 1000（和服务器3 上数据目录的属主一致）
USER node
WORKDIR /data
EXPOSE 4567

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "/usr/local/lib/inkos/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/inkos-entrypoint"]
CMD ["studio"]
