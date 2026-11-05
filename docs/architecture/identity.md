# Identity

The `identity` role is APILens' built-in identity provider: email codes and
magic links, passkeys, TOTP, OAuth/OIDC sign-in, sessions and invitations
(ADR 0005). This page documents how sign-in works end to end, the tokens it
issues, how memberships reach SpiceDB (ADR 0006), the capabilities vocabulary
the UI gates on, and the contract every identity endpoint shares (errors).

Security controls per flow live in the
[identity threat model](../security/identity-threat-model.md); self-host
configuration lives in [`deploy/README.md`](../../deploy/README.md) and the
docs site (`apps/docs/self-host/*`).

## Status

Identity lands over milestone M2. Sections below describe the M2 design; the
table says what is on `v2` today. Rows marked *planned* name the issue that
implements them, and that issue updates this page when it merges.

| Piece | State |
|---|---|
| `identity` and `api` role targets, `IdentityConfig`, `EmailConfig`, `AuthzConfig` | done |
| Error catalogue (`problem+json` + `code`), CORS/CSRF posture, auth rate limits | done |
| Signing-key storage (`00003_signing_keys.sql`, AES-256-GCM with the KEK) | done |
| `users`, `audit_events`, `sessions` tables; audit recorder | done |
| `email.send` River job, `smtp` and `log` providers | done |
| `GET /api/v1/auth/providers`, `GET /api/v1/auth/oauth/{provider}/start` | done |
| SpiceDB schema, Go client (fail-closed, ZedTokens), SpiceDB in compose/Helm | done |
| UI: encrypted session cookie, auth gate, `/api/auth/*` Route Handlers, refresh coalescing | done |
| Key rotation and JWKS, access-token issuer, session verifier (#233–#236) | planned |
| Refresh rotation and logout (#238) | planned |
| Email code and magic link (#248–#254) | planned |
| OAuth callback and handoff (#255, #258–#260) | planned |
| Passkeys (#261–#265), TOTP and recovery (#266–#270) | planned |
| `GET/PATCH/DELETE /api/v1/users/me` (#245); the sole-owner check reads memberships once #276 lands | done |
| Device labels, `GET /api/v1/users/me/sessions` (#271) | done |
| Change email with verification of the new address (#274) | done |
| Session revocation and the access-token `sid` denylist (#272) | done |
| New-device alerts, purge (#273, #275) | planned |
| Orgs, members, invitations, projects, API keys (#276–#287) | planned |
| Outbox relay, reconciler, `authz.Require`, capabilities (#291–#296) | planned |
| Per-org OIDC SSO (#297–#300) | planned |
| OIDC provider skeleton: discovery, authorize, token, userinfo, client credentials (#301), behind `identity.oidc_provider.enabled` | done |
| First-admin CLI `apilens user create` / `user magic-link` (#353) | planned |

## Components

```
browser ──► web (apps/ui, Next.js) ──server-side──► identity  (/api/v1/auth/*)
  │            │  encrypted httpOnly cookie            api       (/api/v1/users, /orgs, /projects)
  │            │  {access, refresh, user}              query     (/api/v1/... reads)
  │            ▼                                          │
  └──► OAuth / SSO provider ──callback──► identity        ├── Postgres  (source of truth, outbox)
                                                          ├── Valkey    (rate limits, OAuth state,
                                                          │              handoff codes, denylist)
                                                          └── SpiceDB   (permissions, via outbox relay)
```

- **The browser never holds a token.** `web` calls identity from Route
  Handlers (`apps/ui/src/app/api/auth/*`) and keeps the session bundle in an
  AES-256-GCM sealed, `httpOnly`, `SameSite=Lax` cookie
  (`apps/ui/src/lib/session.ts`). Identity itself sets no cookies.
- **Only identity holds signing keys.** Keys are stored encrypted with
  `identity.key_encryption_key`; every other role verifies access tokens
  locally against `GET /.well-known/jwks.json`.
- **Top-level navigations only.** The browser reaches identity directly only
  for OAuth/SSO redirects (`…/start`, `…/callback`) and the magic-link
  fallback. CORS is off unless `identity.cors_origins` is set.

## Sign-in flows

Every successful sign-in, whatever the method, ends in the same **session
bundle**:

```json
{
  "access_token": "<RS256 JWT>",
  "refresh_token": "<opaque, 32 random bytes, base64url>",
  "expires_in": 900,
  "user": { "id": "…", "email": "…", "email_verified": true, "…": "…" },
  "next": "/my-project"
}
```

or, when the user has confirmed TOTP and the method was not a passkey, in
`{"status": "2fa_required", "pre_auth_token": "…", "next": "…"}`.

### Email code and magic link

1. `POST /api/v1/auth/email/start` `{email, intent: signin|signup, next?, remember?}`
   always answers `200 {sent: true, retry_after}`, whether or not the account
   exists. Within the 30 s cooldown (per address and intent) no new email is
   sent and `retry_after` is the remaining wait. Otherwise identity
   issues a 6-digit code and a 256-bit link token (both stored as SHA-256,
   15 min, single use; a new issue invalidates older ones) and enqueues the
   `auth_code` email. For `intent=signin` with no account, the email says so
   and offers a sign-up link instead.
2. The user either types the code on `/verify`, which posts
   `POST /api/v1/auth/email/verify` `{email, code, remember}`, or opens the link
   `{public_ui_url}/verify?token=…&email=…`, which `web` exchanges server-side with
   `POST /api/v1/auth/email/verify-link` `{token, remember}`.
   `GET /api/v1/auth/email/link?token=` redirects to the UI without consuming
   the token, for clients that hit identity directly. Using the link consumes
   the email (its code stops working too); a used, superseded or unknown link
   answers `invalid_token`, an expired one `code_expired`. The link token is
   never logged or audited.
3. Five wrong codes lock the token (`too_many_attempts`). On success the user
   is found or created (`email_verified_at` set, `user.created` audited on
   first sign-in) and gets a session with `amr: ["email"]` (`remember` picks
   the 30-day or 24-hour lifetime), or `2fa_required` when TOTP is confirmed.
   Either answer carries the `next` stored with the email. A wrong, expired or
   unknown code is audited as `login.failed`; a session as `login.succeeded`.
   Code checks are rate-limited per address
   (`identity.rate_limits.code_verify_per_email`).

### Google and GitHub

1. The sign-in page links to `GET /api/v1/auth/oauth/{provider}/start?next=&remember=&intent=login|link`.
   Identity stores `{provider, PKCE verifier, nonce (Google), next, intent,
   remember}` in Valkey for 10 minutes under a random `state` and redirects
   (302) to the provider.
2. The provider redirects to `GET /api/v1/auth/oauth/{provider}/callback`.
   Identity takes the state (atomic `GETDEL`, so it is single use), exchanges
   the code with the PKCE verifier and gets a **verified** email: Google from
   the `id_token` (`email_verified`, nonce checked), GitHub from the primary
   verified address in `/user/emails`. No verified email means
   `oauth_email_unverified`.
3. The user is matched by (provider, subject), then by verified email (the
   identity is linked), else created. The session bundle (or the 2FA
   challenge) is stored under a one-time **handoff code** (60 s, Valkey) and
   the browser is sent to `{public_ui_url}/auth/callback?code=…`. Tokens never
   appear in a URL.
4. `web` redeems the code with `POST /api/v1/auth/handoff` and sets the
   cookie. Errors redirect to `{public_ui_url}/sign-in?error=<code>`:
   `oauth_state_mismatch` (unknown, used, expired or foreign state; a code or
   PKCE verifier the provider rejects; an id_token with the wrong nonce,
   audience or signature), `oauth_email_unverified`, `oauth_denied` (consent
   declined at the provider; the page shows its generic notice),
   `account_deleting`, `invalid_request` or `internal_error`. Every failure is
   audited as `login.failed` with the provider as `method`.

The callback lives in `internal/identity/oauth_callback.go`. A session is
audited as `login.succeeded` with `method` and `amr` set to the provider; the
identity's `last_login_at`, email and profile are refreshed on each sign-in.
Handoff codes are kept in Valkey under their SHA-256 only
(`internal/identity/handoff.go`). `POST /api/v1/auth/handoff` `{code}`
answers the stored session bundle or `2fa_required` payload and deletes the
code in the same step (`GETDEL`), so a code works once; an unknown, expired
or already redeemed code answers `invalid_token`. It is rate-limited per IP
(`identity.rate_limits.handoff_per_ip`, 30 / 15 min;
`internal/identity/handoff_redeem.go`).

`intent=link` attaches the provider to the signed-in user instead (Settings →
Connected accounts). The session is optional on `…/start` and required for
`intent=link`, so the UI's server calls it with the bearer and sends the
browser to the returned `Location`. The state carries the user id; the
callback links the provider account to that user (`internal/identity/oauth_link.go`),
audits `oauth.linked`, emails a `security_change` alert and redirects to
`{public_ui_url}{next}?linked={provider}`. A provider account already linked to
another user ends on `/sign-in?error=oauth_identity_taken`; one already linked
to the same user is a no-op.

`GET /api/v1/users/me/identities` lists the connected accounts (provider,
email, name, username, avatar, `created_at`, `last_login_at`) and
`DELETE /api/v1/users/me/identities/{id}` disconnects one (`oauth.unlinked`,
`security_change` alert; `oauth_identity_gone` for an id that is not the
user's). Email is always a sign-in method, so the last connected account can
be disconnected too.

### Passkeys

Passkeys are discoverable WebAuthn credentials bound to
`identity.webauthn.rp_id`. Sign-in is
`POST /api/v1/auth/passkeys/login/options` → browser ceremony →
`POST /api/v1/auth/passkeys/login/verify` `{challenge_id, response, remember, next}`
(`internal/identity/passkey_login.go`, `internal/identity/passkey/login.go`).
Both are public and rate-limited per IP (`passkey_login_per_ip`). Options are
discoverable (no `allowCredentials`), so the sign-in page can offer "Continue
with a passkey" and conditional UI without an email; an optional `email` hint
lists that account's passkeys in `allowCredentials` (an unknown address gets
discoverable options). Verify resolves the user from the credential id and
its user handle (the user id), answers `passkey_unknown` for an unregistered
credential and `passkey_failed` for a used challenge, a bad assertion or a
signature counter that did not advance (possible clone; audited as
`login.failed`). It stores the new counter, backup state and `last_used_at`.
A passkey is phishing-resistant and user-verifying, so it **skips** the TOTP
step (`amr: ["passkey"]`) and answers the session bundle with `next` echoed.
Registration (`…/register/options`, `…/register/verify`) requires a session.

Security settings manage the signed-in user's passkeys
(`internal/identity/passkeys.go`, `internal/identity/passkey/manage.go`):
`GET /api/v1/users/me/passkeys` lists them oldest first (name, authenticator
vendor from the AAGUID table, backup state, created and last used),
`PATCH /api/v1/users/me/passkeys/{id}` `{name}` renames one (audited as
`passkey.renamed`) and `DELETE /api/v1/users/me/passkeys/{id}` removes one
(audited as `passkey.removed`; the user is emailed a `security_change`
alert). Another user's passkey id answers `410 passkey_gone`, exactly like an
unknown or already removed one.

### Two-factor (TOTP) and backup codes

When TOTP is confirmed, email, social and SSO sign-ins answer `2fa_required`
with a `pre_auth_token`: 32 random bytes in Valkey for
`identity.pre_auth_ttl` (5 min), at most 5 attempts. It is not a JWT and is
accepted by one endpoint only: `POST /api/v1/auth/2fa/exchange`
`{pre_auth_token, code | backup_code}`, which returns the session bundle with
`totp` (or `backup_code`) appended to `amr`. Enabling TOTP returns 10 single-use
backup codes once. TOTP secrets are encrypted with the KEK.

**Exchanging** (`internal/identity/twofactor_exchange.go`) counts the attempt
atomically in Valkey (a Lua script) before the factor is checked, so parallel
guesses cannot exceed the cap. A wrong code (or a wrong or spent backup code)
answers `invalid_code`; the fifth wrong one answers `too_many_attempts` and
deletes the token, so the sign-in starts over. An unknown, expired or used
token answers `invalid_token`. A used backup code gets `used_at`; on success
the token is deleted (single use), the session keeps the first step's
`remember` and `next`, and `login.succeeded` records `method` (the first
factor), `second_factor` and `amr`.

**Enabling** (`internal/identity/twofactor.go`, `internal/identity/twofactor`)
is two session-authenticated calls. `POST /api/v1/auth/2fa/enable` needs a
sign-in less than 10 minutes old (`reauth_required` otherwise), generates a
secret (issuer `APILens`, account the user's email), stores it unconfirmed
(AES-256-GCM under the KEK, bound to the user id) and returns
`{secret, otpauth_uri}`; calling it again before confirming replaces the
pending secret. `POST /api/v1/auth/2fa/verify` `{code}` checks the code with
one period of skew, confirms the secret and returns `{backup_codes}`: 10
`xxxx-xxxx` codes, stored only as SHA-256 hashes salted with the user id. It
audits `totp.enabled` and enqueues the `security_change` email in the same
transaction. Both answer `already_enabled` once 2FA is on.

**Managing** (same files, `internal/identity/twofactor/manage.go`). All three
calls need the session to be current (not revoked or expired;
`session_expired` otherwise). `GET /api/v1/auth/2fa/status` returns
`{enabled, confirmed_at, backup_codes_remaining}` (a pending, unconfirmed
secret counts as off). The two that weaken or reset the second factor always
need a fresh one in the request, so a stolen session alone cannot touch 2FA:
`POST /api/v1/auth/2fa/disable` `{code | backup_code}` (exactly one) deletes
the secret and every backup code, audits `totp.disabled` (metadata `method`)
and enqueues the `security_change` email (`totp_disabled`);
`POST /api/v1/auth/2fa/backup-codes/regenerate` `{code}` replaces the backup
codes with 10 new ones, returned once, and enqueues the `security_change`
email (`backup_codes_regenerated`). Each runs in one transaction that locks
the confirmed `user_totp` row. A wrong code or a wrong or spent backup code
answers `invalid_totp`; `not_enabled` when 2FA is off.

**Lost device.** `POST /api/v1/auth/recovery/request` `{email}` always answers
200 `{sent: true}`. When the address has an active account with TOTP on, it
stores a request (`recovery_requests`, token stored as SHA-256 only), cancels
the user's older pending ones, audits `recovery.requested` and emails
`recovery_requested` with a cancel link. The request is ready
`identity.recovery_delay` (24 h) later. `GET …/recovery/status?token=` answers
`{status: pending|ready|confirmed|cancelled, requested_at, ready_at}`.
`POST …/recovery/confirm` `{token}` before `ready_at` answers
`recovery_not_ready` (409, `retry_after`); after it, in one transaction, it
deletes the TOTP secret and backup codes, revokes every session
(`account_recovered`), audits `recovery.confirmed` and `totp.disabled`
(metadata `method: recovery`) and enqueues the `security_change` email
(`recovery_completed`), then answers a fresh session (`amr: ["email"]`).
`POST …/recovery/cancel` `{token}` stops a pending request (audited
`recovery.cancelled`; repeating it is a no-op). An unknown, used or cancelled
token answers `invalid_token`. All four are rate-limited per IP
(`recovery_per_ip`), and request per address (`recovery_request_per_email`)
too (`internal/identity/recovery.go`, `internal/identity/recovery`).

### Per-org SSO (OIDC)

An org owner configures one OIDC connection (issuer, client ID, secret,
domains, `enforce`, `default_role`). `GET /api/v1/auth/sso/lookup?email=`
tells the sign-in page whether the email's domain has SSO and whether it is
enforced: `{sso, enforced, org_name?, start_url?}`. It looks up only the
domain, never the account, and reveals only the organization's display name
(accepted: that domain's sign-in page shows it anyway). Public mailbox
domains (gmail.com, outlook.com, yahoo.co.uk, …) never match, even if a
connection lists them. It is rate-limited per IP
(`identity.rate_limits.sso_lookup_per_ip`, 60 / 15 min).
`GET /api/v1/auth/sso/{org}/start` → IdP →
`GET /api/v1/auth/sso/{org}/callback` uses the same state, PKCE, nonce and
handoff mechanics as social sign-in (`internal/identity/sso.go`). The
provider's endpoints come from OIDC discovery on the connection's `issuer`
(cached per issuer); the redirect URI registered with it is
`{issuer}/api/v1/auth/sso/{org}/callback`. Start takes `next`, `remember`
and `login_hint` (forwarded to the provider), is rate-limited per IP
(`oauth_start_per_ip`) and answers 404 for an organization without a
connection. The callback decrypts the client secret (AES-GCM under the
identity key-encryption key, bound to the org id), verifies the `id_token`
(signature, issuer, audience = client ID, expiry, nonce) and reads `email`:
an explicit `email_verified: false` is `oauth_email_unverified`, and an email
outside the connection's `domains` (or at a public mailbox provider) is
`forbidden`. The user is found by email or created (`source: sso`) and joins
the org with `default_role` if not already a member (just-in-time; the
membership and its `membership.upserted` outbox row commit together). The
session has `amr: ["sso"]` (or the sign-in answers `2fa_required`), the
connection's `last_login_at` is set, and `login.succeeded` is audited with
`method: sso`, `org_id` and `joined`. With `enforce` on, email sign-in for
those domains (`POST /auth/email/start`) answers 403 `sso_required` with the
org's `start_url`, and social sign-in redirects to
`/sign-in?error=sso_required`.

Owners manage the connection with `GET/PUT/DELETE /api/v1/orgs/{slug}/sso`
(api role, `internal/controlplane/api/sso.go`, `orgs.SSOConnections`). The
client secret is write-only: it is sealed under the identity KEK on save, a
read shows `********`, and a PUT that omits it (or sends the mask) keeps it.
Reads also return the `redirect_uri` to register with the provider and the
`start_url`. Turning `enforce` on needs the caller to have signed in through
the connection since it was created (a `login.succeeded` with `method: sso`
and the org's `org_id`, also after a second factor) or it answers
`sso_untested`; a domain another organization already enforces answers
`sso_domain_taken`. `POST …/sso/test` runs discovery on a given `issuer` (or
the saved one) and reports the provider's metadata, or `ok: false` with
`unreachable`, `bad_status`, `invalid_document`, `issuer_mismatch` or
`missing_endpoints`. Changes are audited as `sso.updated` / `sso.deleted`.

### APILens as an OpenID provider (`/oauth/*`)

Identity is also an OpenID Connect provider and OAuth 2.0 authorization
server, for MCP clients, agents and service accounts (ADR 0005). It is built
on `zitadel/oidc` (`internal/identity/oidcprovider`) and is off unless
`identity.oidc_provider.enabled` (`APILENS_IDENTITY__OIDC_PROVIDER__ENABLED`)
is set. M2 ships the storage and the standard endpoints; M4 adds client
registration (CIMD/DCR), API scopes and token exchange (RFC 8693).

| Endpoint | |
|---|---|
| `GET /.well-known/openid-configuration` | discovery; `jwks_uri` is the existing `/.well-known/jwks.json` |
| `GET /oauth/authorize` | authorization code flow only (`response_type=code`); PKCE `S256` (required for public clients, `plain` refused) |
| `GET /oauth/authorize/callback?id=` | where the UI sends the browser back; issues the code |
| `POST /oauth/token` | `authorization_code`, `refresh_token` (rotating), `client_credentials`; `client_secret_basic` or `client_secret_post` |
| `GET /oauth/userinfo` | `sub`, plus `name`/`picture` (`profile`) and `email`/`email_verified` (`email`) |
| `POST /oauth/revoke`, `POST /oauth/introspect` | RFC 7009 / RFC 7662 |

**Sign-in reuses the UI.** Identity sets no cookies, so `/oauth/authorize`
stores the request (`oauth_auth_requests`, 10 minutes) and redirects to
`{public_ui_url}/auth/oidc?request_id=`. That Route Handler sends a
signed-out user through the normal sign-in (and back), then calls
`POST /api/v1/auth/oidc/requests/{id}/complete` with the user's session and
navigates to the returned callback URL. `GET /api/v1/auth/oidc/requests/{id}`
(public; the id is the capability) tells the UI the client, scopes, `prompt`
and `max_age`. With `prompt=none` and no session the UI ends the request with
`…/callback?id=…&error=login_required`. `auth_time` is the session's sign-in
time; when it is older than `max_age` (`prompt=login` is `max_age=0`)
`complete` answers `reauth_required` and the UI answers the client with
`login_required`.

**Tokens.** ID and access tokens are RS256 JWTs signed with the same active
key as session tokens; every access token has an `oauth_tokens` row (its
`jti`) that userinfo, refresh, revocation and introspection check.

| Grant | `sub` | `aud` | Accepted by the API |
|---|---|---|---|
| `client_credentials` | the client id (= `client_id`) | `apilens` | yes, as an `authn.KindClient` principal |
| `authorization_code` / `refresh_token` | the user id | the client id | no (only `/oauth/userinfo` until M4 defines delegated scopes) |

Refresh tokens (only with `offline_access` and a client registered for
`refresh_token`) are 32 random bytes, stored as SHA-256, rotate on every use
and keep the family's absolute lifetime (`identity.refresh_token_ttl`).
Authorization codes are single-use (redeeming deletes the request, even if
the client then fails authentication or PKCE) and live 2 minutes. Client
secrets are 32 random bytes, stored as SHA-256 and compared in constant
time.

**Clients** live in `oauth_clients` (`00011_oauth_provider.sql`). Until M4
adds dynamic registration an operator registers them:

```sh
apilens identity create-client -name="My app" \
  -redirect-uris=https://app.example.com/callback \
  -grant-types=authorization_code,refresh_token
apilens identity create-client -name="CI agent" -grant-types=client_credentials
apilens identity create-client -name="CLI" -public -native \
  -redirect-uris=http://127.0.0.1/callback
```

Each prints `client_id` and, for confidential clients, `client_secret`
(shown once). A public client has no secret, must use PKCE, and cannot use
`client_credentials`.

#### Running the OpenID conformance suite locally

The [OpenID conformance suite](https://gitlab.com/openid/conformance-suite)
runs as containers; test the **Basic OP** profile
(`oidcc-basic-certification-test-plan`) against a local stack:

1. Start APILens with the provider on and an HTTPS issuer the suite's
   containers can reach, e.g. behind a tunnel or Caddy with a local CA:
   `APILENS_IDENTITY__OIDC_PROVIDER__ENABLED=true`,
   `APILENS_IDENTITY__ISSUER=https://id.apilens.localhost`,
   `APILENS_IDENTITY__PUBLIC_UI_URL=https://app.apilens.localhost`. Keep the
   `log` email provider (or Mailpit) and sign in with an `@example.com`
   address.
2. Register the suite's client (two are needed for some tests):
   `apilens identity create-client -name=conformance -redirect-uris=https://localhost.emobix.co.uk:8443/test/a/apilens/callback -grant-types=authorization_code,refresh_token`
   (repeat with `-name=conformance-2`).
3. Start the suite: `git clone https://gitlab.com/openid/conformance-suite && cd conformance-suite && mvn clean package -DskipTests && docker compose up`,
   open `https://localhost.emobix.co.uk:8443`, create a plan
   *OpenID Connect Core: Basic Certification Profile Authorization server
   test*, server metadata *discovery*, client registration *static*, alias
   `apilens`, and paste the discovery URL and both clients' ids and secrets.
4. Run the plan; sign in through the APILens UI when a test opens it.

Known gaps of the skeleton: `prompt=login` and a too-old `max_age` answer
`login_required` instead of forcing a fresh sign-in, and there is no consent
screen (`prompt=consent` is ignored); both land with the M4 UI.

### Invitations

Admins and owners invite by email with a role (`admin`, `member`, `viewer`;
never `owner`). The invitation email links to `{public_ui_url}/invite/{token}`.
The control-plane `api` role manages them under `/api/v1/orgs/{slug}/invitations`
(owners and admins only): `POST` invites up to 50 addresses in one call and
answers one result per address (`invited`, `replaced` when a pending
invitation was swapped for a new one, `already_member`, `duplicate`); `GET`
lists pending ones (expired ones included, so they can be resent);
`POST …/{id}/resend` rotates the token and restarts the 7-day expiry, at most
once every 5 minutes (`rate_limited` with `retry_after`); `DELETE …/{id}`
revokes. Only the SHA-256 of a token is stored. Every email sent is audited
as `invitation.sent`; the email job is enqueued in the same transaction.
`GET /api/v1/auth/invitations/{token}` is public and shows the org, inviter,
masked email, role and expiry (`{org: {name, slug}, inviter_name,
email_masked, role, expires_at}`); an unknown token answers `invalid_token`,
an expired, revoked or used one `invite_expired`. It is rate-limited per IP
(`identity.rate_limits.invitation_lookup_per_ip`, 60 / 15 min). Accepting
(`POST /api/v1/auth/invitations/{token}/accept`) needs a session whose
verified email equals the invited one (`invite_email_mismatch` otherwise),
marks the invitation accepted, creates the membership through the outbox and
audits `invitation.accepted`, in one transaction; a user who already belongs
to the org keeps their role. It is idempotent: accepting a used invitation
again answers the org with `joined: false` while the user is still a member.
Both live under `/api/v1/auth`, so the identity role serves them.

## Tokens and sessions

### Access token

RS256 JWT, `identity.access_token_ttl` (15 min). Header `kid` names the
signing key; `GET /.well-known/jwks.json` serves the public keys (current and
recently retired, so rotation never breaks live tokens).

| Claim | Value |
|---|---|
| `iss` | `identity.issuer` |
| `sub` | user id |
| `aud` | `apilens` |
| `iat`, `exp` | issue time, issue time + `access_token_ttl` |
| `sid` | session id (the `sessions` row) |
| `amr` | how the session was authenticated: `email`, `google`, `github`, `passkey`, `totp`, `backup_code`, `sso` |

Verifiers (`api`, `query`, later `mcp`) accept only RS256 and only keys from
JWKS, check `iss`, `aud` and `exp`, and consult the `sid` denylist.

### Refresh token and session

A session is a `sessions` row with device metadata (user agent label, IP,
last active). Its refresh token is 32 random bytes, base64url; only the
SHA-256 is stored. Lifetime is `identity.refresh_token_ttl` (30 days) with
"Keep me signed in", otherwise `identity.refresh_token_ttl_short` (24 h).

- `POST /api/v1/auth/refresh` `{refresh_token}` rotates: it returns a new
  bundle and retires the old token. Replaying a retired token revokes the
  whole token family and audits `session.reuse_detected`.
- `POST /api/v1/auth/logout` revokes the session;
  `POST /api/v1/auth/logout-all` revokes all of the user's sessions.
  `DELETE /api/v1/users/me/sessions/{id}` signs out one session (idempotent,
  204) and `POST /api/v1/users/me/sessions/revoke-others` every session but
  the caller's (`{"revoked": n}`). Each audits `session.revoked`.
- Revoking a session pushes its `sid` into a Valkey denylist for one access
  token TTL, so its access token stops working within seconds (verifiers
  cache the denylist for 5 s and fall back to TTL-only if Valkey is down).
  Because the `sid` changes on every refresh, every row of the family whose
  access token may still be unexpired is denylisted, not only the live one
  (`authn.Denylist`, keys `authn:denied-sid:<sid>`). When Valkey is
  unreachable the verifier logs, at most once a minute, and accepts the
  token until it expires, as the API key verifier does; the revoking process
  itself still refuses the token at once.
- `web` refreshes server-side shortly before expiry and coalesces concurrent
  refreshes by token, so parallel requests never replay a rotated token.

### Lifetimes and limits

| Setting | Default |
|---|---|
| `identity.access_token_ttl` | `15m` |
| `identity.refresh_token_ttl` / `refresh_token_ttl_short` | `720h` / `24h` |
| `identity.email_code_ttl` / `email_code_max_attempts` | `15m` / `5` |
| `identity.pre_auth_ttl` | `5m` |
| `identity.recovery_delay` | `24h` |
| OAuth state / handoff code | 10 min / 60 s |
| Email start per email / per IP | 5 / 20 per 15 min |
| Code verify per email | 10 per 15 min |
| Refresh per IP | 60 per minute |
| Passkey and 2FA verify per user | 10 per 15 min |
| OAuth start per IP | 30 per 15 min |
| Passkey login options / verify per IP | 60 per 15 min each |
| Recovery request per email | 3 per hour |
| Recovery endpoints per IP | 20 per 15 min |

Rate limits are sliding windows in Valkey shared by every replica
(`identity.rate_limits.*`); they answer `429` with `Retry-After`.

## Account (`/api/v1/users/me`)

Served by the identity role and authenticated with the session scheme
(`internal/identity/me.go`, `internal/identity/account`).

- `GET` returns `id`, `email`, `email_verified`, `name`, `avatar_url`,
  `preferences`, `onboarding`, `created_at` and the current session's `amr`.
- `PATCH` accepts `name` (trimmed, at most 120 characters), `avatar_url` (an
  http(s) URL, or empty to clear it) and `preferences`, which is merged into
  the stored object; `preferences.home` is one of `endpoints`, `requests`,
  `exceptions`, and `preferences.last_project_slug` is a project slug (or
  empty to clear it) that `/users/me/context` returns as
  `last_project_slug`. Unknown fields fail validation (`422`). Audited as
  `user.updated` with the changed field names, never their values.
- `PATCH /api/v1/users/me/onboarding` (`internal/identity/onboarding.go`)
  saves onboarding progress so a refresh resumes: `step` replaces the stored
  step, `answers` (`org_slug`, `project_slug`, `language`, `runtime`,
  `method`, `invited`; other keys fail validation) is merged key by key into
  the stored `answers`, and `completed: true` stamps `completed_at` once
  (`false` reopens onboarding). The merge is one `UPDATE`, so concurrent saves
  never drop each other's answers. It returns
  `{step, completed, completed_at, answers}`.
- `DELETE` soft-deletes the account: it is hidden at once (the email can sign
  up again), every session is revoked (reason `user_deleted`) and
  `delete_after` is set 30 days out, after which a purge job removes the row.
  It answers `owner_transfer_required` (409) while the user is the only owner
  of an organization. Audited as `user.deleted`.
- During the grace period, sign-in for the address must not create a new
  account silently: once the email code (or provider) has proven control of
  the address and no active account matches, sign-in calls
  `account.Service.PendingDeletion` and, on a hit, answers
  `identity.ErrAccountDeleting(delete_after)` (`account_deleting`, 409, with
  `delete_after` in the problem body). An address that signed up again since
  has an active account, which wins.
- `POST /api/v1/users/me/restore` (public) takes `{email, code}` with a fresh
  email code for the address and clears `deleted_at`/`delete_after`. It issues
  no session: the user signs in again afterwards. A wrong code, an address
  with nothing to restore, and an account past its grace period all answer
  `invalid_code`; it shares the `code_verify_per_email` rate limit. Audited as
  `user.restored`.
- The purge job (`identity.purge_deleted_users`, a River periodic job, hourly
  and on start, run by the identity role) hard-deletes users whose
  `delete_after` has passed, 500 per transaction. Their sessions, email
  tokens, OAuth identities, passkeys and TOTP rows cascade. Audit events are
  kept but anonymised first: events about the user lose `user_id` and
  `metadata`, events they acted in lose `actor_user_id`, and both lose the IP
  and user agent.

### Changing the email (`/api/v1/users/me/email`)

Implemented by `internal/identity/email_change.go` and
`internal/identity/emailchange`.

1. `POST /api/v1/users/me/email/change` `{new_email}` answers `202` with the
   pending address and `expires_at` after emailing a 6-digit `change_email`
   code (the `email_change` template) to the new address. An older pending
   change of the user stops working. It answers `invalid_request` when the
   address is already the user's, and `email_taken` (409) when another active
   account has it. This is the one place identity reveals that an address is
   in use, and only to a signed-in user changing their own email.
2. `POST /api/v1/users/me/email/confirm` `{code}` checks the code against the
   user's pending change (`invalid_code`, `code_expired`,
   `too_many_attempts` as for sign-in codes). On success it sets the new
   email (verified), signs out every session except the current one (reason
   `email_changed`), retires outstanding sign-in emails to the old address,
   sends a `security_change` alert (`email_changed`) to the old address and
   audits `email.changed`. It returns the updated user like `GET`. It answers
   `email_taken` if the address was taken since the code was sent.

## Authorization: outbox and SpiceDB sync

Postgres is the source of truth for organizations, memberships and projects;
SpiceDB holds the derived relationships that permission checks read
([ADR 0006](../adr/0006-authorization-spicedb.md), schema in
[`authz/`](../../authz/README.md)).

1. **Write.** Every membership-affecting write calls
   `outbox.Emit(tx, topic, aggregate_id, payload)` in the same Postgres
   transaction as the change, so the outbox row commits or rolls back with it.
2. **Relay.** A River periodic job (every 2 s, and woken by `NOTIFY outbox`)
   reads pending rows in `id` order (`FOR UPDATE SKIP LOCKED`, 500 at a time),
   translates each topic into SpiceDB `WriteRelationships` with idempotent
   `TOUCH`/`DELETE` updates, stores the returned ZedToken for the org in
   Valkey and marks the row `processed_at`. A crash between the write and the
   mark re-applies the row safely. `apilens_outbox_lag_seconds` tracks lag.
3. **Reconcile.** An hourly River job (`authz.reconcile`, run by the
   `identity` role, which the M4 `worker` role will take over) repairs drift:
   relationships lost or left behind by a manual edit, a restored backup or a
   relay bug. It reads every membership of an active organization and every
   active project of an active organization from Postgres, reads the
   relationships it owns from SpiceDB (`organization#{owner,admin,member,viewer}`
   and `project#org`; project-level roles are left alone), `TOUCH`es what is
   missing and `DELETE`s what Postgres has no source for, and counts each
   repair in `apilens_authz_drift_total{kind="missing"|"extra"}`. It holds the
   relay's advisory lock for the whole run, so the relay cannot apply a row in
   between and have it undone by a stale snapshot; rows committed during the
   run are relayed after it. Operators can run it at once with
   `apilens authz reconcile` (`-dry-run` only reports), which prints
   `{"missing":n,"extra":n,"dry_run":false}`.
4. **Read.** Checks go through `internal/authz.Client` with
   `at_least_as_fresh` the org's last ZedToken, so a user sees their own
   writes immediately. When SpiceDB cannot answer, the check **fails closed**
   (`503`, never an allow).

| Topic | `aggregate_id` | Payload | Relationships |
|---|---|---|---|
| `org.created` | org id | `{org_id, owner_user_id}` | `TOUCH organization:{org}#owner@user:{owner}` |
| `org.deleted` | org id | `{org_id}` | `DELETE` every relationship of `organization:{org}` |
| `membership.upserted` | org id | `{org_id, user_id, role}` | `DELETE` the user's other org roles, `TOUCH organization:{org}#{role}@user:{user}` |
| `membership.deleted` | org id | `{org_id, user_id}` | `DELETE organization:{org}#{owner,admin,member,viewer}@user:{user}` |
| `project.created` | project id | `{project_id, org_id}` | `TOUCH project:{project}#org@organization:{org}` |
| `project.deleted` | project id | `{project_id}` | `DELETE` every relationship of `project:{project}` |
| `project.moved` | project id | `{project_id, from_org_id, to_org_id}` | `DELETE …#org@organization:{from}`, `TOUCH …#org@organization:{to}` |

The topics and payloads above are the contract the outbox helper (#277) and
the relay (#291) implement. The helper is
[`internal/controlplane/outbox`](../../internal/controlplane/outbox/outbox.go):
`outbox.Emit(ctx, tx, topic, aggregateID, payload)` takes a typed topic
constant and the matching payload struct (`OrgCreatedPayload`,
`MembershipUpsertedPayload`, …), refuses a payload of another topic or an
`aggregate_id` that is not the payload's org or project id, stores the payload
as JSON in `outbox.payload` (UUIDs as strings, keys exactly as in the table)
and sends `NOTIFY outbox`, which Postgres delivers only when the transaction
commits. Payloads carry ids and roles only, never emails or secrets. Topics are stable
once shipped; a new shape gets a new topic.

## Capabilities vocabulary

`GET /api/v1/users/me/context` (api role, `internal/controlplane/api/context.go`,
`internal/controlplane/usercontext`) returns in one call what the app shell
needs: `user` (the `/users/me` body), `orgs` (each with the user's `role` and
its projects with their environments), `last_project_slug` (the preference,
or null when the user can no longer see that project), `onboarding`
(`{step, completed}` read from the stored onboarding object) and
`capabilities`. It is four indexed queries in one read-only snapshot plus one
SpiceDB `CheckBulkPermissions` call whatever the number of organizations and
projects (under 50 ms for 10 × 10, asserted by an integration test).

The UI never derives permissions from a role. `GET /api/v1/users/me/context`
returns, per project, the list of **actions** the user may perform, in the
order of the table below. They are computed with one SpiceDB
`CheckBulkPermissions` call per context read, whatever the number of
projects: every distinct (permission, resource) pair is asked once, the
project permissions per project and the organization permissions once per
organization (`usercontext.Vocabulary`). A user with no projects causes no
SpiceDB call. Capabilities are never partial: when SpiceDB cannot answer the
call fails with 503 `authz_unavailable` (fail closed). The UI gates buttons on
them (`apps/ui/src/lib/capabilities.ts` mirrors the vocabulary). The server
still checks every request with `authz.Require`; capabilities only decide what
the UI shows.

```json
"capabilities": {
  "checkout-api": ["project.read", "project.update", "api_keys.create", "api_keys.revoke"]
}
```

| Action | SpiceDB permission | Gates |
|---|---|---|
| `project.read` | `project#view` | seeing the project and its telemetry |
| `project.update` | `project#edit` | project settings, environments |
| `project.delete` | `project#delete` | the project's danger zone |
| `api_keys.create` | `project#manage_keys` | creating ingest and read keys |
| `api_keys.revoke` | `project#manage_keys` | revoking keys |
| `capture.manage` | `project#manage_capture` | editing an app's remote capture policy |
| `alerts.manage` | `project#manage_alerts` | creating, changing and deleting alert rules and notification channels, sending test notifications |
| `members.invite` | `organization#invite` | the invite dialog and Invitations page |
| `members.remove` | `organization#manage_members` | role changes and removal on Members |
| `billing.manage` | `organization#manage_billing` | billing (SaaS) |

Which roles hold each permission is the table in
[`authz/README.md`](../../authz/README.md), asserted by
`authz/schema.validation.yaml`. Actions are stable once shipped; add new ones
here, in `usercontext.Vocabulary`, in `capabilities.ts` and in the schema in
the same change.

## Errors

Every identity endpoint fails with an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
problem served as `application/problem+json`. On top of Huma's standard
members (`title`, `status`, `detail`) each problem carries `code`, and some
carry more extension members:

| Member | Type | Meaning |
|---|---|---|
| `code` | string | Stable, machine-readable error code from the catalogue below. |
| `retry_after` | integer | Seconds to wait before retrying. Only on rate limits and lockouts; mirrored in the `Retry-After` header. |
| `suggestions` | string[] | Up to three free alternative slugs. Only on `slug_taken`. |

```json
{
  "title": "Rate limited",
  "status": 429,
  "detail": "Too many requests. Try again later.",
  "code": "rate_limited",
  "retry_after": 30
}
```

Rules:

- **The UI maps `code` to copy.** `title` and `detail` are for logs and API
  users and may change; `code` never changes once shipped. Tests assert on
  `code`, never on the message.
- **No enumeration.** No code, status or message reveals whether an email
  address, user or organization exists. Requesting a sign-in code always
  succeeds (`202`) whether or not the address has an account; verifying a code
  for an unknown address answers `invalid_code`, exactly like a wrong code.
  Identity never answers `404` for an account lookup.
- **Static copy.** Handlers build problems with `identity.Err(code)` or
  `identity.ErrRetryAfter(code, wait)` (`internal/identity/errors.go`). The
  title and detail come from the catalogue, so a handler cannot echo request
  data (such as an email address) into an error. An unknown code collapses to
  `internal_error`.
- Request-schema validation failures are Huma's own `422` problems and carry
  no `code`; the UI shows its generic form error for them.
- **Documented in the spec.** Identity and control-plane operations register
  through `identity.Operation(api, op, codes...)`
  (`internal/identity/openapi.go`). It requires an `OperationID`, `Summary`
  and a tag (`Auth`, `Users`, `Organizations` or `Projects`, declared with
  descriptions in `server.NewAPIConfig`), and adds one
  `application/problem+json` response per status with the `Problem` schema
  and an `x-apilens-codes` list of the codes it can carry. Regenerate the
  committed spec with `task gen:openapi`.

## Error catalogue

| Code | HTTP status | UI copy |
|---|---|---|
| `invalid_request` | 400 Bad Request | Something about this request isn't right. Please try again. |
| `invalid_code` | 400 Bad Request | That code isn't right. Check it and try again. |
| `code_expired` | 400 Bad Request | That code has expired. We'll send you a new one. |
| `too_many_attempts` | 429 Too Many Requests | Too many incorrect attempts. Request a new code. |
| `rate_limited` | 429 Too Many Requests | Too many requests. Try again in {retry_after} seconds. |
| `unauthenticated` | 401 Unauthorized | Sign in to continue. |
| `invalid_token` | 401 Unauthorized | This link is invalid or has already been used. |
| `session_expired` | 401 Unauthorized | Your session has expired. Sign in again. |
| `two_factor_required` | 401 Unauthorized | Enter the code from your authenticator app or use a passkey. |
| `invalid_totp` | 401 Unauthorized | That authentication code isn't right. |
| `passkey_unknown` | 401 Unauthorized | This passkey isn't registered with APILens. Sign in another way. |
| `passkey_failed` | 401 Unauthorized | We couldn't verify your passkey. Try again. |
| `passkey_already_registered` | 409 Conflict | This passkey is already registered. Use another authenticator. |
| `passkey_gone` | 410 Gone | This passkey was already removed. Refresh the page. |
| `oauth_state_mismatch` | 400 Bad Request | Sign-in couldn't be completed. Start again. |
| `oauth_email_unverified` | 403 Forbidden | Your account with this provider has no verified email. Verify it there, or sign in with email. |
| `oauth_identity_gone` | 410 Gone | This account was already disconnected. Refresh the page. |
| `invite_expired` | 410 Gone | This invitation has expired. Ask for a new one. |
| `invite_email_mismatch` | 403 Forbidden | This invitation was sent to a different email address. Sign in with that address. |
| `owner_transfer_required` | 409 Conflict | You're the only owner of an organization. Transfer ownership or delete it before deleting your account. |
| `already_enabled` | 409 Conflict | Two-factor authentication is already on. |
| `not_enabled` | 409 Conflict | Two-factor authentication is off. |
| `reauth_required` | 403 Forbidden | For your security, sign in again to continue. |
| `email_taken` | 409 Conflict | Another account already uses this email address. |
| `account_deleting` | 409 Conflict | This account is scheduled for deletion on {delete_after}. Restore it to keep using it. |
| `slug_taken` | 409 Conflict | That URL is taken. Try one of the suggestions. |
| `recovery_not_ready` | 409 Conflict | Account recovery is still in its waiting period. Try again in {retry_after} seconds, or cancel it if you didn't ask for it. |
| `slug_immutable` | 409 Conflict | This URL can't be changed yet. |
| `domain_not_allowed` | 400 Bad Request | Public email domains like gmail.com can't be added. Use your company's domain. |
| `last_owner` | 409 Conflict | An organization needs at least one owner. Make someone else an owner first. |
| `member_gone` | 410 Gone | This person is no longer a member. Refresh the page. |
| `api_key_gone` | 410 Gone | This API key no longer exists. Refresh the page. |
| `sso_required` | 403 Forbidden | Your organization requires single sign-on. Sign in through your company's identity provider. |
| `sso_not_configured` | 409 Conflict | Single sign-on isn't set up for this organization yet. |
| `sso_untested` | 409 Conflict | Sign in through single sign-on at least once before you enforce it, so nobody gets locked out. |
| `sso_domain_taken` | 409 Conflict | Another organization already requires single sign-on for this domain. |
| `forbidden` | 403 Forbidden | You don't have permission to do that. |
| `not_found` | 404 Not Found | We couldn't find that, or you don't have access to it. |
| `authz_unavailable` | 503 Service Unavailable | We couldn't check your permissions. Try again in {retry_after} seconds. |
| `internal_error` | 500 Internal Server Error | Something went wrong on our side. Please try again. |

`internal/identity/errors_test.go` checks that this table lists every code
with its status.

### Sign-in notices

Flows that end on `/sign-in` say why in the query: `?reason=` for an expected
landing, `?error=` for a sign-in that failed (OAuth callback, SSO
enforcement). The page shows one dismissible notice above the form
(`role="status"`). The value only selects one of these fixed sentences, never
shown itself. An unknown `?error=` shows *Sign-in didn't complete. Try again.*;
an unknown `?reason=` shows nothing. The copy lives in
`apps/ui/src/lib/sign-in-notice.ts`.

| Query | Sent by | Notice |
|---|---|---|
| `?reason=signed_out` | `POST /api/auth/logout` | You're signed out. Sign in again whenever you're ready. |
| `?reason=session_expired` | `web` when a refresh fails | Your session expired. Sign in again to pick up where you left off. |
| `?reason=account_deleted` | Account settings, after `DELETE /api/v1/users/me` | Your account is scheduled for deletion and you're signed out everywhere. It's removed for good in 30 days. |
| `?reason=2fa_locked` | Two-factor step after the fifth wrong code (`too_many_attempts`) | Too many wrong two-factor codes. Sign in again to start over. |
| `?reason=2fa_expired` | Two-factor step when the pending sign-in is gone (`invalid_token`, `2fa_session_expired`) | Your two-factor step timed out. Sign in again to continue. |
| `?error=oauth_email_unverified` | OAuth callback | That provider account has no verified email. Verify it with the provider, or sign in with an email code. |
| `?error=oauth_identity_taken` | OAuth callback (`intent=link`) | That provider account is already linked to a different APILens account. Sign in to that account instead. |
| `?error=account_deleting` | Sign-in to an account in its deletion grace period | This account is scheduled for deletion, so it can't sign in. Contact support to restore it. |
| `?error=sso_required` | Email or social sign-in on an SSO-enforced domain | Your organization requires single sign-on. Sign in through your company's identity provider. |
