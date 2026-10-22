# syntax=docker/dockerfile:1
#
# Web dashboard (Next.js) image — pnpm monorepo build.
#
# BUILD CONTEXT IS THE REPO ROOT (not apps/web): pnpm is a workspace and the
# single lockfile lives at the root.
#   docker build -f apps/web/Dockerfile -t ghcr.io/apilens/web:dev .
#
# Build once, promote everywhere: nothing environment-specific is baked in.
# The BFF reads DJANGO_API_URL / AUTH_API_URL / SESSION_SECRET at runtime
# (server-side only; the app uses no NEXT_PUBLIC_* variables).

# Pinned by digest; Renovate bumps both tag and digest.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
# Version must match "packageManager" in the root package.json.
RUN corepack enable && corepack prepare pnpm@11.28.7 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# ---- deps: install ONLY what the frontend needs, from the frozen lockfile ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter frontend...

# ---- builder ----
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web
RUN pnpm --filter frontend build

# ---- runner: Next standalone output (monorepo layout) ----
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Standalone roots at the workspace dir: node_modules at the root, the app's
# server.js under apps/web/. Static + public aren't traced into standalone,
# so copy them explicitly to where server.js expects them.
COPY --from=builder --chown=65532:65532 /app/apps/web/.next/standalone ./
COPY --from=builder --chown=65532:65532 /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=65532:65532 /app/apps/web/public ./apps/web/public

# Non-root (same UID as every APILens image). With a read-only root
# filesystem, mount a writable tmpfs at /app/apps/web/.next/cache.
USER 65532:65532
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
