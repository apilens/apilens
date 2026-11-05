# APILens example app: Express + the TypeScript SDK from this repo.
# Build context is the repo root (see deploy/compose/compose.examples.yaml).
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS sdk
WORKDIR /repo/packages/sdk-typescript
COPY packages/sdk-typescript/package.json packages/sdk-typescript/README.md packages/sdk-typescript/CHANGELOG.md packages/sdk-typescript/LICENSE ./
COPY packages/sdk-typescript/src ./src
# Runtime JS only (no .d.ts): the example is plain JavaScript, so the SDK's
# dev toolchain (type declarations for every adapter) is not needed.
RUN npx --yes -p tsup@8.5.1 -p typescript@5.9.3 tsup --no-config src/index.ts src/express.ts \
      --format esm,cjs --platform node --target node18 --out-dir dist

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ENV NODE_ENV=production
COPY --from=sdk /repo/packages/sdk-typescript /repo/packages/sdk-typescript
WORKDIR /repo/examples/express
COPY examples/express/package.json ./
# --install-links copies the file: SDK into node_modules so it resolves its
# express peer dependency from this app.
RUN npm install --omit=dev --install-links --no-audit --no-fund && npm cache clean --force
COPY examples/express/server.mjs ./

USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD ["wget", "-qO-", "http://127.0.0.1:3000/health"]
CMD ["node", "server.mjs"]
