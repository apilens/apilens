# API Lens Java SDK

Spring Boot and plain Java capture for API Lens. The SDK records request metrics,
request/response payloads, headers, route templates, consumer identity, server
spans, and automatic error logs, then sends them to API Lens from a background
worker so your request path does not perform network I/O.

## Install

Maven:

```xml
<dependency>
  <groupId>ai.apilens</groupId>
  <artifactId>apilens-java-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

Gradle:

```kotlin
implementation("ai.apilens:apilens-java-sdk:0.1.0")
```

## Spring Boot quick start

Add the dependency, then configure the project API key and app slug:

```properties
apilens.api-key=${APILENS_API_KEY}
apilens.app-id=orders-api
```

The starter auto-registers a servlet filter when `apilens.api-key` is present.
It uses Spring MVC's matched route pattern for endpoint grouping, so
`GET /orders/123` is captured as `GET /orders/{id}` while `raw_path` keeps the
exact URL.

Consumer attribution is explicit:

```java
import ai.apilens.ApiLensConsumers;

ApiLensConsumers.setConsumer("user-123", "Alice", "enterprise");
```

You can also centralize it with a bean:

```java
import ai.apilens.ApiLensConsumer;
import ai.apilens.spring.ApiLensConsumerResolver;
import org.springframework.context.annotation.Bean;

@Bean
ApiLensConsumerResolver apiLensConsumerResolver() {
  return (request, response) -> {
    var userId = request.getHeader("X-User-Id");
    return userId == null ? null : ApiLensConsumer.of(userId);
  };
}
```

## Plain Java capture

```java
import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.RequestRecord;

try (var client = new ApiLensClient(ApiLensConfig.builder()
    .apiKey(System.getenv("APILENS_API_KEY"))
    .appId("orders-api")
    .build())) {
  client.capture(RequestRecord.builder()
      .method("GET")
      .path("/orders/{id}")
      .rawPath("/orders/123")
      .statusCode(200)
      .responseTimeMs(24.5)
      .build());
}
```

## Delivery and health

Capture never blocks the request path and the queue never grows without bound:

- `maxQueueSize` (default `10000` records per queue) and `maxQueueBytes`
  (default 64 MB, estimated, shared by requests, spans and logs) cap memory.
  When either is full the oldest records are dropped.
- `maxBatchBytes` (default 4 MB) caps one ingest request body. Batches are cut
  at `batchSize` records or `maxBatchBytes`, whichever comes first. A single
  record larger than the limit is truncated (payloads first), not dropped.
- `compress` (default `true`) gzips request bodies on the flush thread.
- 408, 429, 5xx and network errors are retried up to `maxRetries` with
  full-jitter exponential backoff, honouring `Retry-After` (capped at 60 s).
  Other 4xx responses are not retried; a 401 logs one clear message.

`client.stats()` returns a `ClientStats` snapshot:

```java
ClientStats s = client.stats();
// queuedRecords, queuedBytes, sentBatches, sentRecords, failedBatches,
// droppedCount, dropCounts {queue_full, queue_bytes, non_retryable,
// retries_exhausted, truncated}, lastError, lastSuccessAt
```

`truncated` counts records that were shortened and still sent, so it is not
part of `droppedCount`.

With `micrometer-core` on the classpath, Spring Boot registers an
`ApiLensMetrics` binder automatically (outside Spring, call
`new ApiLensMetrics(client).bindTo(registry)`):

| Meter | Type |
|---|---|
| `apilens.queue.records` | gauge |
| `apilens.queue.bytes` | gauge |
| `apilens.batches.sent`, `apilens.records.sent` | counter |
| `apilens.batches.failed` | counter |
| `apilens.records.dropped{reason}` | counter |
| `apilens.records.truncated` | counter |

## Configuration

Spring properties use the `apilens.*` prefix. The jar ships
`META-INF/spring-configuration-metadata.json`, so IntelliJ, VS Code and
Eclipse complete every property below with its description and default.

| Property | Default | Description |
|---|---|---|
| `apilens.api-key` | required | Project API key; auto-configuration is enabled only when it is set. |
| `apilens.app-id` | required | App slug. |
| `apilens.project-slug` | empty | Optional project assertion. |
| `apilens.base-url` | `https://ingest.apilens.ai/v1` | Ingest endpoint. |
| `apilens.environment` | `production` | Environment label (lower-cased). |
| `apilens.release` / `apilens.commit` | detected | Fall back to `APILENS_RELEASE` / `APILENS_COMMIT`, `GIT_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`. |
| `apilens.enabled` | `true` | Master switch: `false` sends nothing. |
| `apilens.batch-size` | `200` | Records per ingest request (1–1000). |
| `apilens.flush-interval` | `3s` | Interval between background flushes. |
| `apilens.timeout` | `5s` | HTTP timeout for one ingest request. |
| `apilens.max-queue-size` | `10000` | Records per queue (requests, spans, logs). |
| `apilens.max-queue-bytes` | `67108864` (64 MB) | Estimated bytes all three queues may hold together. |
| `apilens.max-batch-bytes` | `4194304` (4 MB) | Upper bound on one ingest request body (min `1024`). |
| `apilens.compress` | `true` | Gzip batch bodies. |
| `apilens.max-retries` | `3` | Retries for 408, 429, 5xx and network errors. |
| `apilens.retry-backoff-base` / `apilens.retry-backoff-max` | `250ms` / `5s` | Full-jitter backoff bounds. |
| `apilens.verify-tls` / `apilens.ca-bundle-path` | `true` / empty | TLS verification of the ingest endpoint. |
| `apilens.user-agent` | `apilens-java-sdk/<version>` | User-Agent of ingest requests. |
| `apilens.capture-profile` | unset (= `full`) | `metadata`, `redacted` or `full`; see [Capture profiles](#capture-profiles). |
| `apilens.enable-request-logging` | `true` | `false` turns off header and body capture. |
| `apilens.capture-headers` | `true`* | Capture request/response headers (redacted). |
| `apilens.capture-payloads` | `true`* | Capture request/response bodies. |
| `apilens.log-request-body` | `true`* | Capture request bodies. |
| `apilens.log-response-body` | `true`* | Capture response bodies. |
| `apilens.max-payload-bytes` | `65536`* | Body capture cap; `0` disables bodies. |
| `apilens.capture-spans` | `true` | Emit a server span per request. |
| `apilens.service-name` | app id | Service name on spans. |
| `apilens.redact-query-params` | empty | Extra query-param name regexes; built-ins always apply. |
| `apilens.redact-headers` | empty | Extra header name regexes; built-ins always apply. |
| `apilens.redact-body-fields` | empty | Extra JSON/form field name regexes; built-ins always apply. |
| `apilens.parametrize-paths` | `true` | Group raw paths into route templates. |
| `apilens.capture-ip` | `true` | `false` sends no client IP. |
| `apilens.anonymize-ip` | `false` | Truncate IPv4 to /24, IPv6 to /48. |
| `apilens.exclude-paths` | empty | Path regexes of requests not captured at all. |
| `apilens.exclude-user-agents` | empty | User-Agent regexes of requests not captured at all. |
| `apilens.default-exclusions` | `true` | Built-in health-check/probe/static-file exclusions. |
| `apilens.sample-rate` | `1.0` | Fraction of requests whose detail is kept. |
| `apilens.send-heartbeat` | `true` | Send `POST /v1/heartbeat`; see [Heartbeat and remote capture policy](#heartbeat-and-remote-capture-policy). |
| `apilens.heartbeat-interval` | `60s` | Time between heartbeats (at least `10s`). |
| `apilens.send-metadata` | `true` | Send the [app metadata](#app-metadata) report once the app is ready. |
| `apilens.filter-order` | `Integer.MAX_VALUE - 100` | Servlet filter order. |

\* The default applies only when `apilens.capture-profile` does not set the
flag.

Spring Boot also binds the matching environment variables
(`APILENS_SAMPLE_RATE` to `apilens.sample-rate`, `APILENS_REDACT_HEADERS=a,b`
to a list) with its usual precedence, where an OS environment variable
overrides `application.properties`.

## Capture profiles

`capture-profile` picks a capture posture in one greppable setting, with the
same names and semantics as the Python and TypeScript SDKs. It only fills the
capture flags you did not set, so an individual flag always wins over it.

| Profile | Headers | Bodies | Body cap | Use it for |
|---|---|---|---|---|
| `metadata` | off | off | — | First production rollout: method, path, status, latency, sizes and consumer only. |
| `redacted` | on (sensitive values `[redacted]`) | on (built-in masking) | 16 KB | Debugging with payloads, masked. |
| `full` | on | on | `max-payload-bytes` (64 KB) | Same as leaving it unset (the current defaults). |

```properties
apilens.capture-profile=metadata
# Individual flags win over the preset: request bodies only.
apilens.log-request-body=true
```

The built-in masking applies under every profile. Under `metadata`,
`capture-payloads=true` asks for both bodies. In code, call
`ApiLensSpringOptions.builder().captureProfile(CaptureProfile.METADATA)` (or
set it from an `ApiLensSpringOptionsCustomizer`); an unknown name fails at
startup.

## Environment variables

Without Spring Boot, `ApiLensConfig.fromEnv()` (client) and
`ApiLensSpringOptions.fromEnv()` (capture options) read the same `APILENS_*`
variables as the Python and TypeScript SDKs, so a rollout or a kill switch
needs no code change:

```java
var client = new ApiLensClient(ApiLensConfig.builderFromEnv()
    .appId("orders-api") // explicit setters win over the environment
    .build());
var filter = new ApiLensSpringFilter(client, ApiLensSpringOptions.fromEnv(), null);
```

Precedence: **explicit setter > env var > capture profile > default**
(`builderFromEnv()` pre-fills a builder; setters called on it afterwards
win). Booleans accept `1`/`0`/`true`/`false` (also `yes`/`no`/`on`/`off`, any
case). Lists are comma-separated (`APILENS_REDACT_BODY_FIELDS=^password$,^ssn$`);
a regex that needs a literal comma must be passed as a list in code. Durations
are seconds and may be fractional. Unset or empty variables are ignored; an
unparseable value throws `IllegalArgumentException` naming the variable.
`ApiLensEnv` exposes the parser.

| Variable | Option | Type | Default |
|---|---|---|---|
| `APILENS_API_KEY` | `apiKey` | string | — (required) |
| `APILENS_APP_ID` | `appId` | string | `""` |
| `APILENS_PROJECT_SLUG` | `projectSlug` | string | `""` |
| `APILENS_ENVIRONMENT` | `environment` | string | `"production"` |
| `APILENS_BASE_URL` | `baseUrl` | string | `https://ingest.apilens.ai/v1` |
| `APILENS_ENABLED` | `enabled` | bool | `true` |
| `APILENS_BATCH_SIZE` | `batchSize` | int | `200` |
| `APILENS_FLUSH_INTERVAL` | `flushInterval` | seconds | `3` |
| `APILENS_TIMEOUT` | `timeout` | seconds | `5` |
| `APILENS_VERIFY_TLS` | `verifyTls` | bool | `true` |
| `APILENS_CA_BUNDLE_PATH` | `caBundlePath` | string | `""` |
| `APILENS_MAX_QUEUE_SIZE` | `maxQueueSize` | int | `10000` |
| `APILENS_MAX_QUEUE_BYTES` | `maxQueueBytes` | long | `67108864` |
| `APILENS_MAX_BATCH_BYTES` | `maxBatchBytes` | int | `4194304` |
| `APILENS_COMPRESS` | `compress` | bool | `true` |
| `APILENS_MAX_RETRIES` | `maxRetries` | int | `3` |
| `APILENS_CAPTURE_PROFILE` | `captureProfile` | `metadata` / `redacted` / `full` | unset (= `full`) |
| `APILENS_CAPTURE_HEADERS` | `captureHeaders` | bool | `true` |
| `APILENS_CAPTURE_PAYLOADS` | `capturePayloads` | bool | `true` |
| `APILENS_LOG_REQUEST_BODY` | `logRequestBody` | bool | `true` |
| `APILENS_LOG_RESPONSE_BODY` | `logResponseBody` | bool | `true` |
| `APILENS_MAX_PAYLOAD_BYTES` | `maxPayloadBytes` | int | `65536` |
| `APILENS_REDACT_QUERY_PARAMS` | `redactQueryParams` | list | none (built-ins always apply) |
| `APILENS_REDACT_HEADERS` | `redactHeaders` | list | none (built-ins always apply) |
| `APILENS_REDACT_BODY_FIELDS` | `redactBodyFields` | list | none (built-ins always apply) |
| `APILENS_EXCLUDE_PATHS` | `excludePaths` | list, **added to** the configured value | none |
| `APILENS_EXCLUDE_USER_AGENTS` | `excludeUserAgents` | list, **added to** the configured value | none |
| `APILENS_DEFAULT_EXCLUSIONS` | `defaultExclusions` | bool | `true` |
| `APILENS_SAMPLE_RATE` | `sampleRate` | double 0.0–1.0 | `1.0` |
| `APILENS_CAPTURE_IP` | `captureIp` | bool; `false` wins over code | `true` |
| `APILENS_ANONYMIZE_IP` | `anonymizeIp` | bool; `true` wins over code | `false` |
| `APILENS_CAPTURE_SPANS` | `captureSpans` | bool | `true` |
| `APILENS_SERVICE_NAME` | `serviceName` | string | app id |
| `APILENS_SEND_HEARTBEAT` | `sendHeartbeat` | bool; `false` wins over code | `true` |
| `APILENS_SEND_METADATA` | `sendMetadata` | bool; `false` wins over code | `true` |

`APILENS_EXCLUDE_PATHS` / `APILENS_EXCLUDE_USER_AGENTS` are added by the
filter to whatever is configured, with or without Spring.
`APILENS_CAPTURE_IP=false`, `APILENS_ANONYMIZE_IP=true` and
`APILENS_PARAMETRIZE_PATHS=false` are kill switches: they win over code, but
only in the direction that captures less.

## Masking

Values are replaced with `[redacted]`; names stay visible. Built-in patterns
are always applied, with no configuration, and your patterns extend them
(they never replace them). Every pattern is a case-insensitive regex searched
for in the query-parameter, header or JSON/form field *name*:

| List | Built-in patterns |
|---|---|
| Query params (`Redactor.DEFAULT_MASK_QUERY_PARAMS`) | `auth`, `api.?key`, `secret`, `token`, `password`, `pwd` |
| Headers (`Redactor.DEFAULT_MASK_HEADER_PATTERNS`) | `auth`, `api.?key`, `secret`, `token`, `cookie` |
| Body fields (`Redactor.DEFAULT_MASK_BODY_FIELDS`) | `password`, `pwd`, `token`, `secret`, `auth`, `card.?number`, `ccv`, `cvv`, `cvc`, `ssn` |

The exact header names `authorization`, `proxy-authorization`, `cookie`,
`set-cookie`, `x-api-key`, `api-key`, `x-auth-token`, `x-amz-security-token`
and `x-csrf-token` are also always redacted. So `?token=abc` is captured as
`?token=[redacted]` out of the box.

A matching body field is masked when its value is a string, a number, or a
nested object/array (masked whole); booleans and `null` stay visible. A body or
query with nothing to mask is sent unchanged. Add your own patterns (anchor for
an exact match):

```properties
apilens.redact-query-params[0]=^card_number$
apilens.redact-headers[0]=x-private-.*
apilens.redact-body-fields[0]=^iban$
```

An invalid regex fails at startup with a `PatternSyntaxException`.

## Client IP privacy

```properties
apilens.capture-ip=true     # false: no client IP is sent at all
apilens.anonymize-ip=false  # true: IPv4 truncated to /24, IPv6 to /48
```

The IP is taken from the first `X-Forwarded-For` entry, then `X-Real-IP`, then
the socket address. With `anonymize-ip`, `203.0.113.42` is sent as
`203.0.113.0` and `2001:db8:85a3:8d3::1` as `2001:db8:85a3::`; IPv4-mapped IPv6
is treated as IPv4, and a value that is not a parseable IP is dropped. The
`APILENS_CAPTURE_IP=false` and `APILENS_ANONYMIZE_IP=true` environment
variables tighten this per deployment and cannot loosen what is configured.
Outside Spring, `IpPrivacy.apply(ip, captureIp, anonymizeIp)` applies the same
policy.

## Body capture and mask callbacks

Only JSON (`application/json`, `*+json`), `text/*` and
`application/x-www-form-urlencoded` bodies are captured. Any other content
type (multipart uploads, images, PDFs, a body with no `Content-Type`) is stored
as a placeholder such as `[multipart/form-data, 2048 bytes omitted]`.
Form-encoded bodies are masked with the query redactor: a field is redacted
when its name matches `redact-query-params` or `redact-body-fields`.

`maskRequestBody` / `maskResponseBody` handle what field patterns can't (XML,
free text, card numbers inside values). Each is a `BiFunction` called with a
`RequestInfo` (`method`, `path`, `rawPath`, `headers`, `contentType()`) or a
`ResponseInfo` (`request`, `statusCode`, `headers`, `contentType()`) and the
captured bytes (truncated to `max-payload-bytes`); return the bytes to store.
The order is fixed: callback, then the regex masking, so the patterns still
apply to whatever the callback returns. Fail closed: returning `null` or
throwing stores the whole body as `[masked]`, never the raw body. Callbacks are
not called for bodies that are not captured.

Spring properties cannot express callbacks. Register an
`ApiLensSpringOptionsCustomizer` bean; the auto-configuration applies every
customizer (in `@Order`) on top of the `apilens.*` properties:

```java
@Bean
ApiLensSpringOptionsCustomizer apiLensBodyMasking() {
  return options -> options
      .maskRequestBody((info, body) -> {
        if (info.path().startsWith("/payments")) {
          return null; // stored as [masked]
        }
        return body;
      })
      .maskResponseBody((info, body) -> info.statusCode() >= 400 ? body : null);
}
```

Without auto-configuration, pass the callbacks to
`ApiLensSpringOptions.builder()` directly.

## Excluding requests

Health checks, probes and static well-known files are not captured. An
excluded request skips the filter entirely: the request and response are not
wrapped, no body is buffered, and no record, span or log is sent.

Patterns are case-insensitive regexes searched against the request path
without the query string (`^` / `$` anchor to the path, so `^/health$` excludes
`/health` but not `/healthz` or `/api/health`), and against the `User-Agent`
header. They are compiled when the filter is created, so an invalid regex fails
at startup, never per request.

Default paths (`RequestExcluder.DEFAULT_EXCLUDED_PATHS`):

```
/_?healthz?$
/_?health[-_]?checks?$
/_?heart[-_]?beats?$
/ping$
/ready$
/live$
/favicon(?:-[\w-]+)?\.(?:ico|png|svg)$
/apple-touch-icon(?:-[\w-]+)?\.png$
/robots\.txt$
/sitemap\.xml$
/manifest\.json$
/site\.webmanifest$
/service-worker\.js$
/sw\.js$
/\.well-known/
```

Default user agents (`RequestExcluder.DEFAULT_EXCLUDED_USER_AGENTS`):

```
health[-_ ]?check
microsoft-azure-application-lb
googlehc
kube-probe
```

Add your own, or turn the defaults off:

```properties
apilens.exclude-paths[0]=^/internal/
apilens.exclude-paths[1]=^/status$
apilens.exclude-user-agents[0]=uptimerobot
# false records health checks and probes again
apilens.default-exclusions=true
```

Comma-separated values (`apilens.exclude-paths=^/internal/,^/status$`) also
work; use the indexed form for a regex that contains a comma (`\d{1,3}`).
Without Spring Boot, pass the same settings to
`ApiLensSpringOptions.builder().excludePaths(...).excludeUserAgents(...).defaultExclusions(...)`.
The `APILENS_EXCLUDE_PATHS` / `APILENS_EXCLUDE_USER_AGENTS` environment
variables (comma-separated) add patterns on top.

## Sampling

Sampling never changes metrics. Every request still sends its base record
(method, route, status, latency, sizes, consumer, trace id), so traffic, error
and latency charts stay exact. A sampled-out request only loses its detail:
headers, bodies, its span and its automatic error log, and its record carries
`sampled: false`. The trace context is still propagated to the handler and
downstream services, so they can decide independently.

`apilens.sample-rate` (`0.0`–`1.0`, default `1.0`) is the fraction of requests
whose detail is kept. Two callbacks refine it, each returning a
`SampleDecision`: `KEEP`, `DROP`, `SampleDecision.probability(p)` or
`UNDECIDED`.

- `sampleOnRequest` (`RequestSampler`) runs before the handler, with a
  `RequestInfo` (`method`, `path`, `rawPath`, `headers`, `userAgent()`). A
  request it drops is final, and its body is never buffered. `UNDECIDED` falls
  back to `sample-rate`.
- `sampleOnResponse` (`ResponseSampler`) runs after the handler, with a
  `SampleResponseInfo` (`request`, `route`, `statusCode`, `responseTimeMs`,
  `consumer`, `requestDecision`). It can drop a request but cannot keep one the
  request stage dropped. `UNDECIDED` keeps the prior decision. When it is set,
  the `sample-rate` roll for requests the request stage left undecided happens
  after it, so it can keep every error even at a low rate.

A callback that throws or returns `null` counts as `UNDECIDED` (logged once);
exceptions never reach the handler.

```java
@Bean
ApiLensSpringOptionsCustomizer apiLensSampling() {
  return options -> options
      .sampleRate(0.1)
      // Never keep detail for internal endpoints.
      .sampleOnRequest(request -> request.path().startsWith("/internal/")
          ? SampleDecision.DROP
          : SampleDecision.UNDECIDED)
      // Keep every server error; everything else follows sample-rate.
      .sampleOnResponse(response -> response.statusCode() >= 500
          ? SampleDecision.KEEP
          : SampleDecision.UNDECIDED);
}
```

## Heartbeat and remote capture policy

A daemon thread (`apilens-heartbeat`) sends `POST /v1/heartbeat` for the app:
once on start, then every `heartbeat-interval` (default 60 s, at least 10 s),
and once more with `"final": true` when the client shuts down (the Spring bean's
destroy method). APILens uses it for app status and uptime.

- **Body:** `app_id`, `environment` (the filter's), `instance_id` (a UUID per
  client, `client.instanceId()`), `sdk_name` (`apilens-java-sdk`),
  `sdk_version`, `runtime` (`java 21.0.5`), `pid`, `uptime_s`, `release`,
  `commit`, `project_slug` and `stats` (the `client.stats()` snapshot). Never
  the API key.
- **Failures are silent:** no retries; 401/403/422 are logged once at WARNING,
  everything else at FINE; 429/503 wait for `Retry-After`. Record delivery is
  never affected.
- **Turn it off:** `apilens.send-heartbeat=false` (`sendHeartbeat(false)`), or
  env `APILENS_SEND_HEARTBEAT=false`.

The response carries the app's capture policy, `client.remotePolicy()`
(`RemotePolicy.CAPTURE_EVERYTHING` until the first heartbeat succeeds; a failed
heartbeat keeps the previous one). The filter applies it from the next request,
so a change in APILens reaches the app within one heartbeat interval. It can only
**narrow** capture, never widen what the local options allow:

| Policy field | Effect |
|---|---|
| `enabled: false` | No request, span or log records are sent; the filter bypasses requests. Heartbeats continue. |
| `sample_rate` | Keeps that fraction of the requests local sampling keeps; the rest send only the base record (`sampled: false`). |
| `capture_headers`, `capture_request_body`, `capture_response_body` | `false` turns that part off; `true` never turns on what is off locally. |
| `max_payload_bytes` | The smaller of it and `max-payload-bytes`; `null` keeps the local cap. |

## App metadata

When the Spring application is ready, the SDK sends `POST /v1/metadata` once per
process: `framework` (`spring-boot`), `framework_version`, `spring_version`,
`java_version`, `sdk_version`, the route templates of every Spring MVC
`RequestMappingHandlerMapping` (at most 2000; a mapping without a method
condition is reported as `*`) and the effective capture config (masking
patterns and exclusions including the built-ins, sample rate, delivery
settings; callbacks only as `true`/`false`). Never sent: the API key, the CA
bundle path, callback details. 408/429/5xx are retried up to 3 times. Turn it
off with `apilens.send-metadata=false` or env `APILENS_SEND_METADATA=false`.
Outside Spring, call `client.reportMetadata(environment, () -> body)`.

The full contract is in the ingest docs (`apps/docs/ingest/heartbeat.mdx`).

## Publishing

The Maven project is configured for Maven Central's Central Publisher Portal.
With Central token credentials under server id `central` and GPG signing
available, publish with:

```bash
cd packages/sdk-java
mvn -P release deploy
```

The repository workflow `Publish Java SDK to Maven Central` runs the same
release profile from tags named `apilens-java-sdk-vX.Y.Z`.
