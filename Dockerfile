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
USER node
CMD ["node", "--enable-source-maps", "main.cjs"]
