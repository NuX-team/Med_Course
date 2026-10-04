# syntax=docker/dockerfile:1
# One image recipe for every process: docker build --build-arg APP=bot|worker|panel .
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS build
# corepack reads the pnpm version from package.json ("packageManager").
RUN corepack enable
WORKDIR /repo

# Dependency layer: keyed on the lockfile, so source edits do not re-download packages.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile

ARG APP
RUN test -n "$APP" || (echo "build with --build-arg APP=bot|worker|panel" && exit 1)
RUN pnpm --filter "@medcourse/${APP}" build

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /app
# The bundle is self-contained (see apps/*/tsup.config.ts): no node_modules at runtime.
COPY --from=build --chown=node:node /repo/apps/${APP}/dist/ ./
# The .sql files for `node ops.cjs migrate up` (bot image; harmless in the others, a few dozen KB).
COPY --from=build --chown=node:node /repo/packages/db/migrations/ ./migrations/
# Where the backup container's volume is mounted (deploy/docker-compose.prod.yml); owned by node so
# that a fresh named volume is writable by it.
RUN mkdir /backups && chown node:node /backups
USER node
CMD ["node", "--enable-source-maps", "main.cjs"]
