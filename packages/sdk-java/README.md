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

Redaction accepts case-insensitive regexes matched against names:

```properties
apilens.redact-query-params[0]=token
apilens.redact-headers[0]=x-private-.*
apilens.redact-body-fields[0]=password
```

Built-in sensitive headers such as `authorization`, `cookie`, and `x-api-key`
are always redacted.

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
