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

**Safeguards.** Threat model, OpenID conformance suite in CI, external pentest before GA, encrypted secrets, key rotation, shared rate limits, fail-closed.

**Revisit if** SAML library advisories keep recurring; then broker SAML through an external Keycloak and keep only OIDC in core.
