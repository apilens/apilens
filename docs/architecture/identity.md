# Identity

The `identity` role is APILens' built-in identity provider: email codes and
magic links, passkeys, TOTP, OAuth/OIDC sign-in, sessions and invitations
(ADR 0005). This page documents the contract its endpoints share.

## Errors

Every identity endpoint fails with an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
problem served as `application/problem+json`. On top of Huma's standard
members (`title`, `status`, `detail`) each problem carries two extension
members:

| Member | Type | Meaning |
|---|---|---|
| `code` | string | Stable, machine-readable error code from the catalogue below. |
| `retry_after` | integer | Seconds to wait before retrying. Only on rate limits and lockouts; mirrored in the `Retry-After` header. |

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
| `oauth_state_mismatch` | 400 Bad Request | Sign-in couldn't be completed. Start again. |
| `oauth_email_unverified` | 403 Forbidden | Your account with this provider has no verified email. Verify it there, or sign in with email. |
| `invite_expired` | 410 Gone | This invitation has expired. Ask for a new one. |
| `invite_email_mismatch` | 403 Forbidden | This invitation was sent to a different email address. Sign in with that address. |
| `forbidden` | 403 Forbidden | You don't have permission to do that. |
| `internal_error` | 500 Internal Server Error | Something went wrong on our side. Please try again. |

`internal/identity/errors_test.go` checks that this table lists every code
with its status.
