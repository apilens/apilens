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

## Session cookie

The signed-in session lives in one encrypted httpOnly cookie, `apilens_session`
(AES-256-GCM, key derived from `SESSION_SECRET` with HKDF-SHA256, base64url
value, leading version byte for future rotation). Two implementations share
one wire format (`src/lib/session-format.ts`) and one set of test vectors
(`src/lib/session.vectors.json`):

- `@/lib/session` uses `node:crypto` (Route Handlers, Server Actions, Server Components).
- `@/lib/session-edge` uses Web Crypto (edge runtime, proxy).

Change them together. `open()` returns `null` for any missing, tampered or
unknown-version cookie and never throws on cookie input.

## Backend client

Server code calls identity and the dashboard API through `src/lib/identity.ts`
(`identity().me({ accessToken })`, `identity().emailStart(...)`, ...). It is
`server-only`, sends a `X-Request-Id` on every call (pass the incoming one via
`contextFromHeaders(req.headers)`), and throws `ApiError { status, code,
retryAfter, requestId }` parsed from the RFC 9457 problem body. Branch on
`code`; `status` is `0` for network failures and timeouts.

## Session refresh

Authenticated calls go through `src/lib/server-session.ts`, which refreshes the
access token when the proxy flagged it as near expiry (`x-apilens-session-refresh`),
when it has expired, or after a backend 401 (retried once):

- Route Handlers: `withSession(req, async (s) => ... s.call((o) => identity().me(o)) ...)`
  writes the rewritten cookie with `res.cookies.set` and answers an expired
  session with a cleared cookie and `/sign-in?reason=session_expired` (302 for
  navigations, `401 {ok: false, code: "session_expired"}` for fetches).
- Server Actions: `withActionSession(...)` writes through `cookies()`.
- Server Components cannot set cookies, so `componentSession()` never refreshes.
  It uses the token while it is valid (the proxy flags it two minutes early);
  on `SessionExpiredError` call `redirectToRefresh(path)`, which bounces through
  `GET /api/auth/refresh?next=...` to refresh and rewrite the cookie.

Identity rotates the refresh token on every use and treats a replay as theft,
so refresh is coalesced per token: concurrent callers share one in-flight call
and a success is reused for 15 s (keyed by the token's SHA-256).
