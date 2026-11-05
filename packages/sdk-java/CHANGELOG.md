# Changelog

## Unreleased

- Built-in default masking patterns for query params, headers and JSON/form
  body fields (`Redactor.DEFAULT_MASK_*`, same lists as the Python SDK) are now
  always applied; user `redact-*` patterns extend them. Matching body fields
  with boolean or `null` values stay visible, nested objects/arrays are masked
  whole, and bodies with nothing to mask are sent unchanged.
- Added `apilens.capture-ip` / `apilens.anonymize-ip` (`captureIp` /
  `anonymizeIp` on `ApiLensSpringOptions`) and `IpPrivacy`: IPv4 truncated to
  /24, IPv6 to /48. `APILENS_CAPTURE_IP=false` / `APILENS_ANONYMIZE_IP=true`
  can only tighten the configured policy.
- Added sampling: `sampleRate` (`apilens.sample-rate`) plus `sampleOnRequest` /
  `sampleOnResponse` callbacks returning `SampleDecision` (`KEEP`, `DROP`,
  `probability(p)`, `UNDECIDED`). A sampled-out request still sends its base
  record with `sampled: false` but no headers, bodies, span or error log, so
  metrics are unchanged. Callback exceptions count as `UNDECIDED`.
  `RequestRecord` gained `sampled` (wire field `sampled`, default `true`).
- Added `maskRequestBody` / `maskResponseBody` callbacks
  (`BiFunction<RequestInfo|ResponseInfo, byte[], byte[]>`) that run on the
  captured raw body before the regex masking; `null` or an exception stores
  `[masked]`. Spring Boot apps set them with an `ApiLensSpringOptionsCustomizer`
  bean.
- Body capture is content-type aware: only JSON, `text/*` and form-encoded
  bodies are captured (form fields masked via the query redactor); other types
  are stored as `[<content-type>, N bytes omitted]`.

- Added request exclusions: `apilens.exclude-paths`, `apilens.exclude-user-agents`
  and built-in default exclusions for health checks, probes and static
  well-known files (`apilens.default-exclusions`, on by default). Excluded
  requests bypass the Spring filter entirely.
- Added delivery safety: a byte-bounded queue (`maxQueueBytes`), `maxBatchBytes`
  batch cutting with oversized-record truncation, gzip request bodies
  (`compress`), 408/429/5xx retry with full-jitter backoff and `Retry-After`,
  per-reason drop counts, `ClientStats stats()`, and an optional Micrometer
  binder (`ApiLensMetrics`) auto-registered by Spring Boot.

## 0.1.0

- Added the first API Lens Java SDK release.
- Added a bounded background batching client for requests, spans, and logs.
- Added Spring Boot auto-configuration and Spring MVC servlet filtering.
- Added route-template grouping, payload/header capture, redaction, consumer
  attribution, trace context, and automatic 5xx/exception log capture.
