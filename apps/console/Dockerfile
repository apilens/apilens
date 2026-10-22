# syntax=docker/dockerfile:1
#
# Console (Next.js) image — pnpm monorepo build.
#
# BUILD CONTEXT IS THE REPO ROOT (not apps/console): pnpm is a workspace and
# the single lockfile lives at the root.
#   docker build -f apps/console/Dockerfile -t ghcr.io/apilens/console:dev .
#
# Build once, promote everywhere: nothing environment-specific is baked in.
# The server reads APILENS_API_URL, APILENS_READ_KEY and
# APILENS_PUBLIC_INGEST_URL at request time (no NEXT_PUBLIC_* variables).

# Pinned by digest; Renovate bumps both tag and digest.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
# Version must match "packageManager" in the root package.json.
RUN corepack enable && corepack prepare pnpm@11.28.7 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# ---- deps: install ONLY what the console needs, from the frozen lockfile ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json apps/console/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter console...

# ---- builder ----
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/console/node_modules ./apps/console/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console ./apps/console
RUN pnpm --filter console build

# ---- runner: Next standalone output (monorepo layout) ----
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Standalone roots at the workspace dir: node_modules at the root, the app's
# server.js under apps/console/. Static assets aren't traced into standalone,
# so copy them to where server.js expects them. (No public/ dir: no assets.)
COPY --from=builder --chown=65532:65532 /app/apps/console/.next/standalone ./
COPY --from=builder --chown=65532:65532 /app/apps/console/.next/static ./apps/console/.next/static

# Non-root (same UID as every APILens image). With a read-only root
# filesystem, mount a writable tmpfs at /app/apps/console/.next/cache.
USER 65532:65532
EXPOSE 3100
CMD ["node", "apps/console/server.js"]
