# Changelog

## Unreleased

- Added Spring WebFlux support: `ApiLensWebFilter` (a `WebFilter`) with the
  servlet filter's options, body capture by `DataBuffer` decoration within
  `maxPayloadBytes`, route templates from
  `HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE`, consumers via
  `ApiLensWebFilter.setConsumer(exchange, ...)` or an
  `ApiLensWebFluxConsumerResolver` bean, and `ApiLensWebFluxAutoConfiguration`
  for reactive apps (the servlet filter backs off). The metadata report lists
  WebFlux `@RequestMapping` routes too.
- Added `captureProfile` presets (`CaptureProfile.METADATA` / `REDACTED` /
  `FULL`, `apilens.capture-profile`, `APILENS_CAPTURE_PROFILE`) with the Python
  and TypeScript semantics: a preset only fills capture flags left unset.
- Added `ApiLensConfig.fromEnv()` / `builderFromEnv()` and
  `ApiLensSpringOptions.fromEnv()` / `builderFromEnv()` reading `APILENS_*`
  (parser: `ApiLensEnv`); precedence explicit > env > profile > default.
  `APILENS_EXCLUDE_USER_AGENTS` is now added to the configured patterns, like
  `APILENS_EXCLUDE_PATHS`.
- Added the `apilens.capture-profile`, `apilens.max-queue-bytes`,
  `apilens.max-batch-bytes` and `apilens.compress` Spring properties; every
  `apilens.*` property now has a description in the generated
  `spring-configuration-metadata.json` (the configuration processor is wired
  explicitly in the compiler plugin).
- `ApiLensProperties` capture flags (`capture-headers`, `capture-payloads`,
  `log-request-body`, `log-response-body`, `max-payload-bytes`) are nullable so
  a profile can fill them; their accessors are now `getX()` returning
  `Boolean` / `Integer`.
- Added the heartbeat: `POST /v1/heartbeat` on start, every
  `heartbeatInterval` (`apilens.heartbeat-interval`, default 60 s, minimum
  10 s) and a final one on shutdown, carrying SDK/runtime versions, pid,
  uptime and `stats()`. Its response's capture policy is exposed as
  `client.remotePolicy()` (`RemotePolicy`) and applied by the Spring filter;
  it can only narrow capture (disable, lower sample rate, drop headers or
  bodies, lower the body cap). `apilens.send-heartbeat` /
  `APILENS_SEND_HEARTBEAT=false` turn it off.
- Added the app metadata report: `POST /v1/metadata` once per process when the
  Spring application is ready, with Spring Boot/Spring/Java versions, the
  Spring MVC route templates and the effective capture config.
  `apilens.send-metadata` / `APILENS_SEND_METADATA=false` turn it off.
  `spring-webmvc` is now an optional dependency.
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
