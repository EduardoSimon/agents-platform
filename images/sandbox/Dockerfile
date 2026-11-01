# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f images/sandbox/Dockerfile .
# Runs with --read-only: only /workspace (a volume) and /tmp (a tmpfs) are writable.

ARG NODE_IMAGE=node:24.22.0-trixie-slim
ARG PNPM_VERSION=12.14.0

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --filter @agents-platform/sandboxd...
RUN pnpm --filter @agents-platform/sandboxd run build \
  && pnpm --filter @agents-platform/sandboxd deploy --prod /out

FROM ${NODE_IMAGE}
ARG PNPM_VERSION
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates curl git jq openssh-server ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@${PNPM_VERSION} && npm cache clean --force
RUN groupadd --gid 10001 sandbox \
  && useradd --uid 10001 --gid 10001 --home-dir /tmp/home --no-create-home --shell /bin/bash sandbox \
  && mkdir /workspace \
  && chown sandbox:sandbox /workspace
COPY --from=build /out /opt/sandboxd

# HOME and caches live on /tmp, the only writable path besides /workspace. The pnpm store sits on
# the workspace volume, next to sandboxd's own state: same filesystem as node_modules, so pnpm hard
# links instead of copying, and it survives a restart.
ENV HOME=/tmp/home \
  XDG_CACHE_HOME=/tmp/cache \
  XDG_CONFIG_HOME=/tmp/config \
  XDG_DATA_HOME=/tmp/data \
  XDG_STATE_HOME=/tmp/state \
  npm_config_cache=/tmp/npm \
  pnpm_config_store_dir=/workspace/.sandbox/pnpm-store \
  pnpm_config_update_notifier=false \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  WORKSPACE_DIR=/workspace \
  PORT=7070

USER 10001:10001
WORKDIR /workspace
EXPOSE 7070
# tini is PID 1: it forwards `docker stop` to sandboxd and reaps the services it leaves behind.
ENTRYPOINT ["tini", "--"]
CMD ["node", "/opt/sandboxd/dist/main.js"]
