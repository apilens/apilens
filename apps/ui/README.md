# APILens UI (`apps/ui`)

The APILens dashboard: a Next.js app built on the APILens design system.

```bash
pnpm --filter ui dev        # http://localhost:3200 (or `task dev` for the whole stack)
pnpm --filter ui build
pnpm --filter ui typecheck
```

## Environment

The image is built once and promoted everywhere, so nothing environment-specific
is baked in at build time. The server reads these variables at runtime through
`src/lib/env.ts`, which validates them on first use and throws an error naming
the offending variable. `next build` does not need them.

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `APILENS_API_URL` | yes | `http://apilens:8080` | Base URL of the APILens backend (identity and dashboard API) the UI server calls. Absolute `http(s)` URL; usually an internal address. |
| `SESSION_SECRET` | yes | `openssl rand -hex 32` | Key that encrypts the httpOnly session cookie. At least 32 characters. Rotating it signs everyone out. |
| `APILENS_PUBLIC_URL` | yes | `https://apilens.example.com` | Origin users open the dashboard at, used for absolute links, redirects and cookie scope. |

Where they are set:

- **Local dev**: `mprocs.yaml` (`web` process) sets development values.
- **Docker Compose**: `deploy/compose/compose.yaml` (`web` service); `SESSION_SECRET`
  and `APILENS_PUBLIC_URL` come from `deploy/compose/.env` (see `.env.example`).
- **Helm**: `web.apiUrl`, `web.publicUrl` and the `session-secret` key of the
  chart Secret (`secrets.sessionSecret` or `secrets.existingSecret`); see
  `deploy/helm/apilens/README.md`.

Only server code may read configuration: import `env()` from `@/lib/env`.
The module imports `server-only`, so importing it from a Client Component fails
the build and the secret never reaches the browser.
