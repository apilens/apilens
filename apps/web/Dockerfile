# Frontend (Next.js) image — pnpm monorepo build.
#
# BUILD CONTEXT IS THE REPO ROOT (not apps/web): pnpm is a workspace and the
# single source-of-truth lockfile lives at the root (pnpm-lock.yaml). Build with:
#   docker build -f apps/web/Dockerfile -t <img> --build-arg NEXT_PUBLIC_API_URL=... .
# (the deploy workflow / Cloud Build pass context "." accordingly.)

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- deps: install ONLY what the frontend needs, from the frozen lockfile ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter frontend...

# ---- builder ----
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so the
# API origin must be supplied here. Defaults to local dev; the deploy workflow
# overrides it with --build-arg NEXT_PUBLIC_API_URL=https://app.apilens.ai/api/v1
ARG NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web

RUN pnpm --filter frontend build

# ---- runner: Next standalone output (monorepo layout) ----
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Server-side base URL for the identity (IAM) service. The BFF auth routes +
# token refresh/validate call this directly over the internal docker network.
# Baked here as a RUNTIME env for the Next server so prod works via the normal
# image roll (no compose/metadata change needed); a compose-level AUTH_API_URL
# still overrides it. Empty default keeps local image builds on the dev fallback.
ARG AUTH_API_URL=
ENV AUTH_API_URL=$AUTH_API_URL

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Standalone roots at the workspace dir: node_modules at the root, the app's
# server.js under apps/web/. Static + public aren't traced into standalone,
# so copy them explicitly to where server.js expects them.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
