# 0002 — Open-source, self-hostable dependencies only

**Context.** APILens is MIT-licensed and self-hosted by its community, who cannot be asked to sign up for proprietary services.

**Decision.** Every runtime dependency is open source and self-hostable, preferring Apache-2.0/MIT/BSD/MPL. AGPL is acceptable only for an unmodified, separately run service. BSL, ELv2 and SSPL components are avoided (so: Valkey not Redis, Kafka or AutoMQ not Redpanda, OpenTofu not Terraform). Managed services remain an operational choice for our own SaaS (e.g. Cloud SQL), never a product requirement.

**Consequences.** Some capabilities are built rather than bought (identity, integrations). Enterprise features (SAML, SCIM) ship in the MIT core; the business model is hosting and support, not license gates.
