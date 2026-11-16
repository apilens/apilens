# Changelog

## Unreleased

- Delivery without silent loss: a batch that fails with 408/429/5xx or a
  network error is retried with backoff for up to `maxRetryDuration`
  (default 300 s, `APILENS_MAX_RETRY_SECONDS`, `apilens.max-retry-duration`)
  instead of 3 attempts; `maxRetries` now defaults to `-1` (no attempt cap).
  A 200 partial accept drops only the refused records (`invalid`,
  `app_rejected`). Every drop is counted per signal and reason, logged at
  `WARNING` (at most once a minute) and reported in the next heartbeat's
  `dropped` field, reset once a heartbeat is accepted.
- JVM shutdown hook: a client not managed by Spring flushes its queues when
  the JVM exits. The flush of `shutdown()` and the hook is bounded by
  `shutdownTimeout` (default 5 s); records still unsent then are counted as
  `shutdown`. `registerShutdownHook(false)` turns the hook off; the Spring
  Boot auto-configuration does, since Spring closes the client itself.
- Logged exceptions: Spring Boot attaches a Logback appender (and a Log4j2
  appender when Log4j2 is the logging system) that ships every event logged at
  `ERROR` with a throwable as an `apilens.exception` log with the full
  exception payload, tied to the current request's trace. Handled exceptions
  that are only logged are now captured. `apilens.capture-logs=off` turns it
  off; outside Spring Boot use `ApiLensLogbackAppender.attach(client)` or
  `ApiLensLog4j2Appender.attach(client)`.
- Full exception payload: the `apilens.exception` log now reports the
  qualified class name (`java.lang.IllegalStateException: ...`), unwraps the
  `ServletException` Spring MVC wraps handler exceptions in, and carries the
  full `printStackTrace` output (every `Caused by` and `Suppressed`). Log
  payloads are capped at 64 KiB keeping the head and the tail with a
  `\n…[N chars truncated]…\n` marker, so the root cause survives. The log
  carries `exception.type`, `exception.message` and `exception.chain_depth`
  attributes.
- README restructured to match the Python SDK's: the `ApiLensConfig` and
  filter option tables list the same options in the same order (options the
  Java SDK does not offer are marked), plus the full environment-variable and
  `apilens.*` property tables. `ReadmeTest` fails when a builder option,
  Spring property or `APILENS_*` variable is missing from the README.
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
