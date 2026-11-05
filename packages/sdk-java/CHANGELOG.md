# Changelog

## Unreleased

- Added request exclusions: `apilens.exclude-paths`, `apilens.exclude-user-agents`
  and built-in default exclusions for health checks, probes and static
  well-known files (`apilens.default-exclusions`, on by default). Excluded
  requests bypass the Spring filter entirely.

## 0.1.0

- Added the first API Lens Java SDK release.
- Added a bounded background batching client for requests, spans, and logs.
- Added Spring Boot auto-configuration and Spring MVC servlet filtering.
- Added route-template grouping, payload/header capture, redaction, consumer
  attribution, trace context, and automatic 5xx/exception log capture.
