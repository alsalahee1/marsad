# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f apps/desk/Dockerfile .
# Multi-stage: install → build (shared + desk) → Nginx runtime (non-root) that serves the static
# bundle and proxies /api/ to the engine. The bundle holds no secrets and no engine address: the
# production build talks to `/api` on its own origin, and ENGINE_UPSTREAM is resolved by Nginx.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# --- dependencies for the desk and what it depends on (the shared package) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/engine/package.json apps/engine/
COPY apps/desk/package.json apps/desk/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@marsad/desk..."

# --- compile shared, then bundle the desk (Vite reads the shared package from source) ---
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/desk apps/desk
RUN pnpm --filter @marsad/shared build && pnpm --filter @marsad/desk build

# --- runtime: Nginx as uid 101, listening on 8080 ---
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# Where the engine is, as Nginx sees it (compose service name), and the DNS server that
# resolves it at request time so an engine restart never leaves Nginx holding a dead address.
ENV ENGINE_UPSTREAM=engine:8080
ENV NGINX_RESOLVER=127.0.0.11
# The image renders /etc/nginx/templates/*.template into /etc/nginx/conf.d/ at start,
# substituting only the environment variables that exist (so Nginx's own $vars survive).
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/desk/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/desk/nginx/proxy-params.inc /etc/nginx/marsad/proxy-params.inc
COPY --from=build /app/apps/desk/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
