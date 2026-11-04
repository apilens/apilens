# 0005 — Identity built into the Go codebase, deployed as its own role

**Context.** None of 14 comparable OSS products (PostHog, Sentry, SigNoz, GitLab, Grafana, …) bundles a separate IdP. The OSS IdPs each miss something we need: Keycloak is ~1.25 GB of Java with experimental MCP support, Zitadel is AGPL with SCIM in preview and no CIMD, and Ory gates B2B features behind its enterprise license.

**Decision (M2).**
- **Code.** We write identity in our own code using vetted libraries:
  - `zitadel/oidc` v3 as the OIDC/OAuth server (client credentials, RFC 8693 token exchange)
  - `go-webauthn` for passkeys
  - `pquerna/otp` for TOTP
  - `go-oidc` for per-org OIDC SSO and social login
  - `gosaml2` for SAML (isolated `saml` role, fuzzed, minimum safe versions pinned)
  - `elimity-com/scim` for SCIM
- **MCP authorization.** Client ID Metadata Documents (CIMD) first, Dynamic Client Registration as fallback, RFC 8707 audience binding.
- **Deployment.** It runs as its own `identity` role: only identity pods hold signing keys and can read credential tables; other services verify JWTs locally via JWKS. Self-hosters can also plug in an external OIDC IdP instance-wide.

**Pinned minimum versions.** Pinned in `go.mod`; never go below these. Renovate bumps them together as the `identity` group. `govulncheck ./...` was clean for all of them when pinned (2026-11-04).

| Module | Minimum | Purpose |
| --- | --- | --- |
| `github.com/zitadel/oidc/v3` | v3.51.16 | OIDC/OAuth server |
| `github.com/go-webauthn/webauthn` | v0.18.2 | Passkeys |
| `github.com/pquerna/otp` | v1.5.0 | TOTP |
| `github.com/coreos/go-oidc/v3` | v3.21.0 | OIDC SSO and social login (relying party) |
| `golang.org/x/oauth2` | v0.37.0 | OAuth client flows for go-oidc |
| `github.com/wneessen/go-mail` | v0.8.1 | Magic-link, verification and invite email |
| `github.com/riverqueue/river` (+ `riverdriver/riverpgxv5`) | v0.51.0 | Background jobs ([0008](0008-background-jobs.md)) |
| `github.com/authzed/authzed-go` | v1.11.0 | SpiceDB client ([0006](0006-authorization-spicedb.md)) |

Until production code imports them, `internal/deps` holds blank imports so `go mod tidy` keeps them and govulncheck scans them. `gosaml2` and `elimity-com/scim` get pinned with the `saml` and SCIM work.

**Safeguards.** Threat model ([identity threat model and security checklist](../security/identity-threat-model.md)), OpenID conformance suite in CI, external pentest before GA, encrypted secrets, key rotation, shared rate limits, fail-closed.

**Revisit if** SAML library advisories keep recurring; then broker SAML through an external Keycloak and keep only OIDC in core.
