# syntax=docker/dockerfile:1
#
# Web UI (Next.js) image — pnpm monorepo build.
#
# BUILD CONTEXT IS THE REPO ROOT (not apps/ui): pnpm is a workspace and the
# single lockfile lives at the root.
#   docker build -f apps/ui/Dockerfile -t ghcr.io/apilens/web:dev .
#
# Build once, promote everywhere: nothing environment-specific is baked in.

# Pinned by digest; Renovate bumps both tag and digest.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
# Version must match "packageManager" in the root package.json.
RUN corepack enable && corepack prepare pnpm@11.28.7 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# ---- deps: install ONLY what the UI needs, from the frozen lockfile ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ui/package.json apps/ui/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter ui...

# ---- builder ----
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/ui/node_modules ./apps/ui/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ui ./apps/ui
RUN pnpm --filter ui build

# ---- runner: Next standalone output (monorepo layout) ----
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Standalone roots at the workspace dir: node_modules at the root, the app's
# server.js under apps/ui/. Static assets aren't traced into standalone,
# so copy them (and public/) to where server.js expects them.
COPY --from=builder --chown=65532:65532 /app/apps/ui/.next/standalone ./
COPY --from=builder --chown=65532:65532 /app/apps/ui/.next/static ./apps/ui/.next/static
COPY --from=builder --chown=65532:65532 /app/apps/ui/public ./apps/ui/public

# Non-root (same UID as every APILens image). With a read-only root
# filesystem, mount a writable tmpfs at /app/apps/ui/.next/cache.
USER 65532:65532
EXPOSE 3000
CMD ["node", "apps/ui/server.js"]
