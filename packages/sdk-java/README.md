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

Spring properties use the `apilens.*` prefix:

| Property | Default |
|---|---|
| `apilens.api-key` | required to enable auto-configuration |
| `apilens.app-id` | required |
| `apilens.project-slug` | empty |
| `apilens.base-url` | `https://ingest.apilens.ai/v1` |
| `apilens.environment` | `production` |
| `apilens.batch-size` | `200` |
| `apilens.flush-interval` | `3s` |
| `apilens.timeout` | `5s` |
| `apilens.max-queue-size` | `10000` |
| `apilens.max-retries` | `3` |
| `apilens.log-request-body` | `true` |
| `apilens.log-response-body` | `true` |
| `apilens.capture-headers` | `true` |
| `apilens.capture-spans` | `true` |
| `apilens.max-payload-bytes` | `65536` |
| `apilens.exclude-paths` | empty |
| `apilens.exclude-user-agents` | empty |
| `apilens.default-exclusions` | `true` |
| `apilens.sample-rate` | `1.0` |
| `apilens.capture-ip` | `true` |
| `apilens.anonymize-ip` | `false` |

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
The `APILENS_EXCLUDE_PATHS` environment variable (comma-separated) adds path
patterns on top.

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
