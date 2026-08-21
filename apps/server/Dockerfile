# syntax=docker/dockerfile:1
# Build context: repository root.

FROM --platform=$BUILDPLATFORM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH HUSKY=0
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @metacubexd/ui generate \
  && pnpm --filter @metacubexd/server... build

FROM alpine:3.20.10@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS kernel
ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.29
RUN apk add --no-cache ca-certificates curl gzip
RUN set -eux; \
    test "$MIHOMO_VERSION" = 'v1.19.29'; \
    case "$TARGETARCH" in \
      amd64) asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"; checksum='5612e698e96c8b8ad15abc4c0a4f098eba9234354b4f248cb97f2528e215b094' ;; \
      arm64) asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; checksum='9a868b5e4e0ad91d9d71e1b41b0cfce78aaba44360c30df74a723f8e3926a86c' ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}" -o /tmp/mihomo.gz; \
    printf '%s  %s\n' "$checksum" /tmp/mihomo.gz | sha256sum -c -; \
    gunzip -c /tmp/mihomo.gz > /usr/local/bin/mihomo; \
    chmod 0755 /usr/local/bin/mihomo; \
    /usr/local/bin/mihomo -v

FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime
RUN apk add --no-cache ca-certificates tini tzdata
WORKDIR /app
COPY --from=build /repo/apps/server/.output ./
COPY --from=build /repo/packages/ui/.output/public ./ui-dist
COPY --from=kernel /usr/local/bin/mihomo /usr/local/bin/mihomo
COPY LICENSE /usr/share/licenses/metacubexd/LICENSE
COPY NOTICE /usr/share/doc/metacubexd/NOTICE
COPY third_party/mihomo/LICENSE /usr/share/licenses/mihomo/LICENSE
COPY third_party/mihomo/SOURCE.md /usr/share/doc/mihomo/SOURCE.md
COPY --chmod=0755 apps/server/docker-entrypoint.sh /docker-entrypoint.sh
ENV NODE_ENV=production \
    UI_DIST=/app/ui-dist \
    MIHOMO_BIN=/usr/local/bin/mihomo \
    DATA_DIR=/data \
    PORT=8080 \
    NITRO_HOST=127.0.0.1 \
    SESSION_COOKIE_SECURE=true
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/control/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
