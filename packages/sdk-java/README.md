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

Redaction accepts case-insensitive regexes matched against names:

```properties
apilens.redact-query-params[0]=token
apilens.redact-headers[0]=x-private-.*
apilens.redact-body-fields[0]=password
```

Built-in sensitive headers such as `authorization`, `cookie`, and `x-api-key`
are always redacted.

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
