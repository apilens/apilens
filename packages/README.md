# Packages

Client SDKs, versioned and released independently of the platform
(release-please components `sdk-python`, `sdk-ts`, `sdk-java`).

- `packages/sdk-python`: Python SDK with framework middleware (PyPI: `apilenss`)
- `packages/sdk-typescript`: JavaScript/TypeScript SDK for Express (npm: `apilens-js-sdk`)
- `packages/sdk-java`: Java SDK with Spring Boot auto-configuration (Maven: `ai.apilens:apilens-java-sdk`)

All three speak the v1 ingest JSON format (`/v1/requests`, `/v1/logs`,
`/v1/traces`, `/v1/deploys`), which the v2 edge keeps unchanged.
