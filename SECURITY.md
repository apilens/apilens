# Security Policy

APILens processes API traffic, traces and logs that can contain sensitive
data, so we take security reports seriously and appreciate responsible
disclosure.

## Supported versions

APILens v2 is in pre-release (branch `v2`, images tagged `edge`). Until v2.0.0
ships, security fixes land on `v2` and in the latest `edge` images only.

| Version | Supported |
|---|---|
| v2 pre-release (`v2` branch, `edge` images) | Yes |
| v1 (legacy Django stack, tag `legacy-v1`) | Critical fixes only, until the v2 cutover |
| Published SDKs (`apilenss`, `apilens-js-sdk`, `ai.apilens:apilens-java-sdk`) | Latest minor release |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for security
problems.**

Report privately through GitHub's private vulnerability reporting:
<https://github.com/apilens/apilens/security/advisories/new>

Please include:

- the affected component and version (`apilens version`, image digest or SDK version),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested remediation.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| Initial assessment and severity | within 7 days |
| Fix for critical / high severity issues | within 30 days |
| Fix for medium / low severity issues | within 90 days |

We will keep you informed of progress, coordinate a disclosure date with you,
and credit you in the advisory unless you prefer to remain anonymous. We
publish fixes as GitHub Security Advisories and request CVEs where applicable.

## Scope

In scope: the code in this repository — the Go binary (`cmd/`, `internal/`),
the web dashboard, the AI service, the SDKs, the container images we publish
and the deployment manifests in `deploy/`.

Out of scope: denial-of-service via volumetric traffic, findings that require a
compromised host or privileged access you were already given, reports from
automated scanners without a demonstrated impact, and issues in third-party
dependencies that are already publicly known (please report those upstream).

## Verifying releases

Container images are signed with Sigstore cosign (keyless) and carry SLSA
build provenance and SBOM attestations:

```sh
cosign verify ghcr.io/apilens/apilens@<digest> \
  --certificate-identity-regexp '^https://github.com/apilens/apilens/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/apilens/apilens@<digest> -R apilens/apilens
```
