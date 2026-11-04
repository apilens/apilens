# Identity threat model and security checklist

ADR [0005](../adr/0005-identity-built-in.md) builds identity into our own Go
code instead of running a separate IdP. In return it commits to a set of
safeguards: a threat model, the OpenID conformance suite in CI, an external
pentest before GA, encrypted secrets, key rotation, shared rate limits and
fail-closed behaviour. This document is the threat model. It also holds the
checklist that every identity change is reviewed against.

**Status.** M2 design baseline, written before most of the identity code
exists. The controls below are requirements. Each one points to the M2 issue
that implements it. When an implementation differs from this document,
update the document in the same PR. Before GA, a second maintainer
re-reviews this document, and the external pentest uses it as its scope.

**Scope.** The `identity` role, the identity-facing parts of `api` and
`query`, the `apps/ui` server (Route Handlers, `proxy.ts`, session cookie)
and the browser. API-key ingest auth (`edge`) and SAML/SCIM (M5) are out of
scope; SAML gets its own section in this document when the `saml` role lands.

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Signing keys (RS256 private keys) | `signing_keys.private_key_enc` in Postgres, AES-256-GCM under the key encryption key. Decrypted only in `identity` processes | Whoever holds one can mint an access token for any user |
| Key encryption key (KEK) | `identity.key_encryption_key` (env or secret, 32 bytes) | Decrypts the signing keys and TOTP secrets |
| `SESSION_SECRET` | `apps/ui` server env | Encrypts the session cookie, which holds the access and refresh tokens |
| Refresh tokens | Raw value only in the sealed cookie. SHA-256 in `sessions` | Long-lived (24 h or 30 d) account access |
| Access tokens | Sealed cookie; the UI server's outbound requests | 15 min of account access |
| Email link tokens and 6-digit codes | SHA-256 in Postgres; the user's inbox | Sign in or sign up as that email |
| Pre-auth tokens, OAuth state/PKCE/nonce, WebAuthn challenges, handoff codes | Valkey, short TTL | Each can finish a sign-in half-way through |
| TOTP secrets and backup codes | Secret encrypted under the KEK; backup codes hashed | The second factor |
| Passkey public keys and sign counts | Postgres | Passkey sign-in; clone detection |
| OAuth/OIDC client secrets (Google, GitHub, per-org SSO, OIDC provider clients) | Config/secret store; SSO secrets encrypted at rest | Impersonating APILens to a provider |
| Memberships and roles | Postgres (source of truth), SpiceDB (copy) | Who can see which org's telemetry |
| Audit events | `audit_events` in Postgres | Detection and forensics; must not be forgeable or leak secrets |
| Telemetry | ClickHouse | What the attacker is usually after: request, trace and log data that can hold customer PII |

## 2. Trust boundaries

```
                 (1) public internet                   (2) internal network
 Browser ──HTTPS──► apps/ui server (Next.js) ──HTTP(S)──► identity ──► Postgres
   │                 · sealed httpOnly cookie              │   │     (credential tables)
   │                 · Route Handlers /api/auth/*          │   └──► Valkey
   │                 · proxy.ts auth gate                  │        (rate limits, challenges,
   │                                                       │         handoff codes, sid denylist)
   │                                                       ▼
   └──HTTPS (OAuth/SSO redirects, magic-link              JWKS ──► api / query / mcp
        landing only)──► identity                                  (verify JWTs locally;
                                                                    authz via SpiceDB)
 Google / GitHub / org IdP ◄──HTTPS (3) third-party── identity
 SMTP relay ◄──(4) email── identity (River job)
```

1. **Browser and `apps/ui` server.** The browser never receives a token. It
   holds only the AES-256-GCM sealed, `httpOnly`, `SameSite=Lax` cookie
   (`apilens_session`, base64url, versioned payload). The UI server is the
   only party that opens the cookie and calls identity, `api` and `query`
   with the bearer token (#303, #304, #305).
2. **`apps/ui` server and identity, `api`, `query`.** The UI server calls
   these services server-side. Identity has no CORS by default
   (`identity.cors_origins` is opt-in) and sets no cookies (#246).
3. **Identity and the browser, directly.** Only for top-level navigations:
   OAuth/SSO start and callback, and the magic-link redirect helper. Every
   one of them ends in a redirect to `public_ui_url`. None of them puts a
   token in the URL. They carry a one-time handoff code instead (#258, #259).
4. **Identity and other roles.** Only `identity` decrypts signing keys or
   reads credential tables (sessions, email tokens, TOTP, passkeys, OAuth
   identities). `api`, `query` and `mcp` verify JWTs against JWKS and get
   their permissions from SpiceDB (#236, ADR 0006).
5. **Identity and third parties.** Google and GitHub, per-org OIDC IdPs and
   the SMTP relay. What they return is untrusted input: verify signatures,
   `aud`, `nonce` and `email_verified`.
6. **Operators.** Whoever holds the KEK, `SESSION_SECRET` or database access
   is trusted. Defending against a malicious operator is out of scope.
   Limiting what a leaked backup or a leaked log line exposes is in scope.

## 3. Attacker models

| ID | Attacker | Capabilities | Goals |
|---|---|---|---|
| A1 | Anonymous internet attacker | Sends any HTTP request to the UI and identity; scripts at scale; owns many IPs | Account takeover, user enumeration, spam via our mail, denial of service against sign-in |
| A2 | Malicious authenticated user | Has a valid account and may own an org | Reach other tenants' data; escalate their role; keep access after removal |
| A3 | Web attacker | Runs a site the victim visits; can phish | CSRF, open redirect, login CSRF, token theft through the `Referer` header or URL |
| A4 | Attacker with a victim's inbox | Reads, or briefly controls, the victim's email | Sign in by email; use recovery to remove 2FA |
| A5 | Attacker with a stolen token or device | Has a cookie, refresh token, backup code or unlocked laptop | Keep access, survive a password-less "sign out everywhere" |
| A6 | Malicious or compromised third party | A rogue OAuth app, a compromised org IdP, a malicious MCP client | Sign in as users of other orgs; mint tokens with a wider audience |
| A7 | Network or infrastructure attacker | Reads internal traffic, logs, backups or a Valkey dump | Collect tokens or secrets from logs, backups or caches |
| A8 | Insider with the code but no secrets | Reads this repository | Find logic flaws; there is no security through obscurity |

## 4. Controls per flow

Every flow ends in the same session bundle `{access_token, refresh_token,
expires_in, user}` (#238), or in `2fa_required` with a pre-auth token (#269).
The `amr` claim records how the user signed in (`email`, `google`, `github`,
`passkey`, `totp`, `backup_code`, `sso`).

### 4.0 HTTP posture of identity endpoints (#246)

`identity.Middleware` (`internal/identity/http.go`) wraps every request under
`/api/v1/auth/*`, including ones that match no operation:

| Threat | Control |
|---|---|
| Auth responses (tokens, session bundles) cached by a browser or proxy (A5, A7) | `Cache-Control: no-store` on every response |
| Tokens in URLs leaking through `Referer` (A3) | `Referrer-Policy: no-referrer` |
| MIME sniffing of JSON responses | `X-Content-Type-Options: nosniff` |
| Cross-origin scripts reading identity responses (A3) | CORS is deny-by-default. Only origins listed in `identity.cors_origins` (empty by default, validated as bare `scheme://host[:port]`) get `Access-Control-Allow-Origin`; credentials are never allowed; a preflight from any other origin gets `403` |
| CSRF (A3) | Identity sets no cookies. The session cookie is sealed and set by the `apps/ui` server, so there is no ambient credential to ride. Defence in depth: a non-`GET`/`HEAD`/`OPTIONS` request whose `Origin` is neither the issuer's origin nor an allowed CORS origin (including `null`) gets `403`. Server-side callers send no `Origin` and are unaffected; top-level `GET` navigations (OAuth callbacks, magic-link redirect) still work |

Tests: `internal/identity/http_test.go`.

### 4.1 Email code (6 digits)

| Threat | Control |
|---|---|
| Brute-forcing a 6-digit code (A1) | 15 min TTL; at most 5 attempts per token, then `too_many_attempts`; 10 verifies per email per 15 min (#249, #239) |
| Using a code issued for a different email | The code is bound to the email; verification looks up by `(email, code hash)` |
| Replay | Single use, consumed in the same transaction as session creation; a new token invalidates older unconsumed ones |
| Biased or predictable codes | `crypto/rand` with rejection sampling (no modulo bias); stored as SHA-256 |
| Email bombing or using us to spam (A1) | 30 s cooldown; 5 starts per 15 min per email and 20 per IP (#250, #239) |
| SSO bypass | Domains with SSO enforced get `sso_required` instead of a code (#299) |

### 4.2 Magic link

| Threat | Control |
|---|---|
| Guessing tokens | 256-bit token, base64url, SHA-256 stored, single use, same 15 min TTL (#249) |
| Token leaks via `Referer`, history or proxy logs (A3, A7) | The UI's `/verify?token=` landing exchanges the token server-side, then redirects to a URL without it; `Referrer-Policy: no-referrer` (#246, #316); access logs redact the `token` query parameter (§7) |
| Mail scanners "clicking" the link and using it up | The link opens the UI page. The token is consumed only by the server-side exchange, not by a `GET` to identity |
| Login CSRF: an attacker sends the victim the attacker's own link (A3) | The landing page names the email being signed in and asks for a click before exchanging the token, so a link the victim did not request does not silently switch accounts |
| Open redirect via `next` | `safeNext()` accepts same-origin relative paths only (#311) |

### 4.3 OAuth: Google and GitHub

| Threat | Control |
|---|---|
| CSRF on the callback or code injection (A3) | Random `state` stored server-side in Valkey for 10 min, single use; PKCE S256; `nonce` for Google (#257) |
| Account takeover through an unverified provider email (A6) | Google: `email_verified` must be true in the verified `id_token`. GitHub: only the primary, verified address from `/user/emails`. Otherwise `oauth_email_unverified` (#258) |
| Tokens in URLs | The callback stores the bundle under a one-time handoff code (60 s) and redirects to `/auth/callback?code=`. The UI exchanges it with `GETDEL` (#259) |
| Linking someone else's provider account | Link only through an authenticated `intent: link` flow; a `(provider, subject)` already linked elsewhere returns `oauth_identity_taken` (#260) |
| Open redirect | `next` is stored in the Valkey state, never read back from the callback URL, and passed through `safeNext()` |

### 4.4 Passkeys (WebAuthn)

| Threat | Control |
|---|---|
| Phishing | Origin binding: `rp_id` must be a registrable suffix of every configured origin (#262) |
| Challenge replay | Challenges live in Valkey for 5 min, single use, keyed by a random challenge id (#262, #264) |
| Cloned authenticator | Reject when the sign count goes backwards and is above 0; audit it (#264) |
| Registering a passkey on someone else's account | Registration needs an authenticated session (#263) |
| Treating a passkey as the second factor | A passkey counts as multi-factor (`amr` = `passkey`) and skips TOTP. User verification is `preferred`. Review before GA whether to require UV (§10) |

### 4.5 TOTP and backup codes

| Threat | Control |
|---|---|
| Brute-forcing the code | ±1 step skew; pre-auth token allows 5 attempts and is then deleted; 10 per 15 min per user (#269, #239) |
| Reusing a code inside its window | Remember the last accepted step per user and reject it again (open item, §10) |
| Secret disclosure from a DB dump (A7) | Secret encrypted under the KEK; backup codes hashed; ten codes shown once (#267) |
| Enabling 2FA from a hijacked session | Enable needs a sign-in in the last 10 min (or re-verification); audit plus a `security_change` email (#267) |
| Using the pre-auth token as a session | It is a random Valkey key, not a JWT, and only `/2fa/exchange` accepts it (#269) |

### 4.6 Account recovery (2FA device lost)

| Threat | Control |
|---|---|
| Inbox access alone removes 2FA (A4) | Request, then a 24 h cooling-off period (`identity.recovery_delay`), then confirm; the email contains a cancel link; status is visible (#270) |
| Enumeration | `request` always returns 200 |
| Persistence after recovery | Confirming disables TOTP, revokes every session and sends `security_change` |

### 4.7 Sessions and tokens

| Threat | Control |
|---|---|
| Forged access tokens | RS256, `kid` header, `iss` and `aud` (`apilens`) checked, 15 min `exp` (#235) |
| Algorithm confusion (`none`, HS256 signed with the public key) | The verifier accepts only RS256 and only keys from JWKS (#236) |
| Stolen refresh token (A5) | Rotated on every use; reusing a rotated token revokes the whole family and audits `session.reuse_detected` (#238) |
| Revocation lag for access tokens | Revoking a session pushes its `sid` to a Valkey denylist for one access-token TTL; verifiers check it (5 s local cache) (#272) |
| Cookie theft or tampering (A3, A7) | Sealed with AES-256-GCM (authenticated); `httpOnly`; `SameSite=Lax`; `Secure` over https; a tampered cookie decodes to `null` and never throws; the gate verifies the cookie, not just its presence (#303, #306) |
| Refresh stampede logging users out (the v1 bug) | Token-keyed refresh coalescing in the UI server (#307) |
| Long-lived sessions | 24 h by default, 30 d with "Keep me signed in"; users can list and revoke sessions; new devices trigger an email alert (#271, #273) |
| Soft-deleted accounts | Sign-in is blocked during the 30-day grace period; data is purged afterwards (#275) |

### 4.8 Invitations

| Threat | Control |
|---|---|
| Token guessing | Random token, stored hashed, with an expiry (#281) |
| Accepting an invite meant for someone else | Accept needs a session whose verified email equals the invite email, otherwise `invite_email_mismatch` (#282) |
| Information leak from the public lookup | Returns only org name and slug, inviter name, a masked email, role and expiry; rate-limited (#282) |
| Granting roles above the inviter's | Only admins and owners invite; allowed roles are `admin`, `member` and `viewer` (never `owner`); the role check runs through SpiceDB (#281, #293) |
| Invite spam | 50 emails per call; resend cooldown of 5 min |
| Domain-join abuse | Join needs `domain_join` on the org and a verified email in an `allowed_domains` entry; public email domains never match (#283) |

### 4.9 Per-org SSO (OIDC)

| Threat | Control |
|---|---|
| A compromised or malicious org IdP signing in users from other orgs (A6) | The `id_token` email must be in that org's verified `domains`; JIT membership only in that org, with its `default_role` (#299) |
| Domain hijack: an org claiming a domain it does not own | Domain ownership must be verified before `enforce` or JIT applies (open item, §10) |
| CSRF or code injection | Same state, PKCE and nonce handling as §4.3 |
| Bypassing enforcement through email or social sign-in | Email start and social callbacks return `sso_required` for enforced domains (#299) |
| Stored client secrets | Encrypted at rest; never returned by the API after creation (#300) |

### 4.10 OIDC provider (MCP and agents)

The provider is off by default (`identity.oidc_provider.enabled`). It reuses
the signing keys, requires PKCE for `authorization_code`, and binds tokens to
an audience (RFC 8707). Agent tokens carry `act` (RFC 8693) and get only
`view_*` permissions (ADR 0006). The OpenID conformance suite runs against it
in CI (#301).

## 5. Enumeration and timing

- `POST /auth/email/start` always returns `200 {sent: true, retry_after}`.
  The difference is in the email: someone signing in to an email with no
  account receives an email offering sign-up (#250).
- Code and link verification compare in constant time and do the hashing and
  compare even when no row exists, so the latency does not depend on whether
  an account exists (#249).
- Error codes are a fixed catalogue (#244). There is no `user_not_found`; an
  unknown email and a wrong code both return `invalid_code`.
- Recovery requests, invitation lookups and `sso/lookup` reveal nothing
  about other accounts. `sso/lookup` reveals only that a domain enforces SSO,
  which is acceptable because that domain's sign-in page reveals it anyway.
- Slug availability endpoints (`orgs/slug-available`,
  `projects/slug-available`) reveal that a slug exists. That is accepted
  because slugs are globally unique and not secret. They are rate-limited
  like other auth endpoints.

## 6. Rate limits

Shared across replicas in Valkey with a sliding window (#239). They answer
`429` with `Retry-After` and are configurable under `identity.rate_limits`.

| Endpoint | Default |
|---|---|
| Email start | 5 / 15 min per email, 20 / 15 min per IP |
| Code verify | 10 / 15 min per email |
| Refresh | 60 / min per IP |
| Passkey and 2FA verify | 10 / 15 min per user |
| OAuth/SSO start, handoff, passkey login options, invitation lookup, recovery | Per IP (values set in their issues) |

**Fail closed.** If Valkey is unreachable, rate-limited endpoints answer `503`
(logged at most once a minute) instead of skipping the limit. Real client IPs
come only from trusted proxy headers (`X-Forwarded-For` from configured
proxies). Otherwise anyone can set the header and get a fresh IP bucket on
every request.

## 7. Fail-closed authorization

- Every `api`, `query` and `mcp` operation runs `authz.Require(permission)`
  against a resource resolved from path parameters (#293). An operation with
  no requirement is a bug.
- The SpiceDB wrapper returns `false` on any transport error and increments
  `apilens_authz_errors_total` (#290). v1 failed open when OPA was down; v2
  must not.
- The JWKS verifier fails closed when JWKS is unreachable and its cache is
  empty (#236).
- Writes that change membership emit an outbox row in the same transaction
  (#277). Reads after a write use the stored ZedToken (`at_least_as_fresh`),
  so a removed member loses access immediately (the "new enemy" problem).
- The one deliberate degradation: if Valkey is down, the session denylist
  check falls back to TTL-only (at most 15 min of lag after a revocation) and
  logs it. This matches the API-key verifier (#272).
- Every ClickHouse query filters on the tenant first, and the project comes
  from the authorized principal, never from the request body (ADR 0004).
  Integration tests prove that two tenants never see each other's data
  (#296).

## 8. Logging rules (no secrets)

Never log, put into traces or error messages, or store in `audit_events.meta`:

- access, refresh, pre-auth or handoff tokens; magic-link tokens; email codes;
  backup codes; TOTP secrets or codes; WebAuthn assertions;
- OAuth `code`, `state`, `code_verifier`, `id_token`, provider access tokens,
  client secrets;
- the session cookie, `SESSION_SECRET`, the KEK, decrypted private keys;
- `Authorization`, `Cookie` and `Set-Cookie` headers, and the `token` and
  `code` query parameters of `/verify`, `/auth/callback` and
  `/invite/{token}` (redact path segments too).

Allowed: user id, session id (`sid`), `kid`, org and project ids, event kind,
`amr`, IP, user agent, error `code`. Email addresses go into audit events
(the user owns that data) but stay out of application logs at `info` level.

Enforcement: handlers log through `log/slog` with typed attributes, never
`%v` on request or response structs. A unit test per token type asserts that
the raw value is absent from captured log output (#232, #238). OTel span
attributes follow the same rules.

## 9. Key rotation runbook

Signing keys (#232, #233):

1. **Routine (every 90 days, or when an operator changes).** Run
   `apilens identity rotate-key`. It creates a new active key and marks the
   previous one retired. Retired keys are still published in JWKS for
   `refresh_token_ttl`, so tokens they signed keep verifying until they
   expire.
2. **Propagation.** Identity replicas reload keys within 60 s. Verifiers
   refetch JWKS when they see an unknown `kid` (at most once a minute). No
   restart is needed.
3. **Suspected compromise.** Rotate. Then remove the compromised key from
   JWKS immediately instead of waiting out the retirement window (a CLI flag
   to retire and unpublish at once is an open item, §10). Revoke all
   sessions (`logout-all` for every user) and write an advisory. Every token
   it signed stops verifying, so every user has to sign in again.

KEK (`identity.key_encryption_key`):

1. Supporting two KEKs at once (decrypt with the old one, encrypt with the
   new one) and a re-encryption command are open items (§10). Until they
   exist, rotating the KEK means rotating every signing key and making every
   TOTP user enroll again. Back up the KEK separately from database backups:
   a database dump without the KEK reveals no keys or TOTP secrets.

`SESSION_SECRET` (UI):

1. Changing it invalidates every cookie, so every user signs in again. The
   payload's version byte allows a future overlap window with two secrets.
   Rotate on compromise or when an operator leaves.

OAuth, SSO and SMTP credentials: rotate at the provider, update the secret,
then restart (or reload) `identity`.

## 10. Open items for the pentest and before GA

- [ ] Second-maintainer review of this document (acceptance criterion of #357).
- [ ] External pentest before GA, scoped to this document. Priority areas:
      OAuth/SSO callback and handoff, refresh rotation races, invitation
      accept, verified-domain join, `safeNext()`, cookie sealing, rate-limit
      bypass via proxy headers, tenant isolation in `query` with user
      sessions.
- [ ] OpenID conformance suite (basic OP profile) running in CI against the
      OIDC provider (#301, #355).
- [ ] Decide whether passkey sign-in requires user verification
      (`UserVerification: required`) before it can skip TOTP.
- [ ] TOTP replay protection: reject a step that was already accepted.
- [ ] Verifying domain ownership (DNS TXT) before SSO `enforce`, JIT
      membership or `domain_join` apply.
- [ ] `rotate-key --revoke` to unpublish a compromised key immediately.
- [ ] KEK rotation: decrypt with old and new keys, plus a re-encrypt command.
- [ ] Trusted-proxy configuration for client IPs, with tests.
- [ ] Fuzz targets for code parsing (#249) and JWT/JWKS parsing; `gosaml2`
      fuzzing when SAML lands (M5).
- [ ] Rate limits on refresh are per IP only. Decide whether a per-family
      limit is needed.
- [ ] Data shown in the new-device email and the session list (IP and
      device) is personal data; check retention against the privacy policy.

## Security checklist for identity changes

Copy into the PR description of any change to `internal/identity`,
`internal/authz`, the `api` role's membership code, or `apps/ui` session and
auth code. Answer every line, or write "n/a" with a reason.

- [ ] **Threat model.** This document still describes the change, or the PR
      updates it.
- [ ] **No secrets in logs.** No new token, code, secret or credential header
      reaches logs, spans, error messages or audit `meta` (§8); a test proves
      it for any new token type.
- [ ] **Enumeration.** Responses and timing are the same whether or not the
      account, email, invite or org exists; errors use catalogue codes
      (#244).
- [ ] **Rate limits.** Any new unauthenticated or credential-checking
      endpoint has per-IP and per-subject limits that fail closed.
- [ ] **Authorization.** Every new `api`/`query`/`mcp` operation uses
      `authz.Require`; errors deny; membership writes emit an outbox row in
      the same transaction.
- [ ] **Tokens.** New secrets come from `crypto/rand` with at least 128 bits
      (256 for links), are stored hashed (or encrypted if they must be read
      back), compared in constant time, single-use and expiring.
- [ ] **URLs and redirects.** No token in a URL that outlives one exchange;
      redirect targets go through `safeNext()` or are fixed to
      `public_ui_url`.
- [ ] **Browser.** No new CORS origin; auth responses send
      `Cache-Control: no-store`; cookies are set only by the UI server
      (#246).
- [ ] **Session effects.** Security changes (email, 2FA, passkeys, recovery,
      linked accounts) are audited and emailed, and revoke sessions where
      the threat calls for it.
- [ ] **Dependencies.** Identity modules stay at or above the minimum
      versions in ADR 0005; `govulncheck ./...` and osv-scanner are clean.
- [ ] **Tests.** Negative paths are covered: expired, replayed, wrong user,
      wrong tenant, tampered, dependency down.
