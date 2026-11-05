package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensClientTest.IngestServer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import org.junit.jupiter.api.Test;
import org.springframework.boot.web.reactive.context.AnnotationConfigReactiveWebApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.MapPropertySource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ReactorHttpHandlerAdapter;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.config.EnableWebFlux;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.adapter.WebHttpHandlerBuilder;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;

/**
 * End to end: a WebFlux app (annotated controllers and a router function) on a real Reactor
 * Netty server, wired only by the API Lens auto-configuration, called over HTTP, with the
 * records read back from a stub ingest server.
 */
class ApiLensWebFilterE2ETest {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

  @Test
  void autoConfiguredWebFilterCapturesAReactiveAppOverHttp() throws Exception {
    try (IngestServer ingest = IngestServer.start();
        AnnotationConfigReactiveWebApplicationContext context = new AnnotationConfigReactiveWebApplicationContext()) {
      context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.of(
          "apilens.api-key", "test-key",
          "apilens.app-id", "orders-api",
          "apilens.environment", "staging",
          "apilens.base-url", ingest.url() + "/v1",
          "apilens.flush-interval", "1h",
          "apilens.send-heartbeat", "false",
          "apilens.send-metadata", "false",
          "apilens.redact-body-fields", "^password$",
          "apilens.redact-query-params", "^token$")));
      context.register(WebConfig.class, OrdersController.class,
          ApiLensWebFluxAutoConfiguration.class, ApiLensAutoConfiguration.class);
      context.refresh();

      assertEquals(1, context.getBeansOfType(ApiLensWebFilter.class).size());
      assertTrue(context.getBeansOfType(ApiLensSpringFilter.class).isEmpty(),
          "the servlet filter is skipped in a reactive app");
      assertEquals(1, context.getBeansOfType(ApiLensMetadataReporter.class).size());

      DisposableServer server = HttpServer.create()
          .host("127.0.0.1")
          .port(0)
          .handle(new ReactorHttpHandlerAdapter(WebHttpHandlerBuilder.applicationContext(context).build()))
          .bindNow();
      try {
        String base = "http://127.0.0.1:" + server.port();
        HttpClient http = HttpClient.newHttpClient();

        HttpResponse<String> get = http.send(HttpRequest.newBuilder(URI.create(base + "/orders/42?token=secret&keep=1"))
            .header("traceparent", "00-" + TRACE_ID + "-00f067aa0ba902b7-01")
            .header("X-Forwarded-For", "203.0.113.9")
            .header("Authorization", "Bearer secret")
            .build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, get.statusCode());
        assertEquals("{\"id\":\"42\",\"status\":\"shipped\"}", get.body(), "body reaches the client intact");

        HttpResponse<String> post = http.send(HttpRequest.newBuilder(URI.create(base + "/orders"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString("{\"item\":\"book\",\"password\":\"hunter2\"}"))
            .build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(201, post.statusCode());
        assertEquals("{\"item\":\"book\",\"password\":\"hunter2\"}", post.body(), "request body still reaches the handler");

        assertEquals(200, http.send(HttpRequest.newBuilder(URI.create(base + "/fn/items/sku-9")).build(),
            HttpResponse.BodyHandlers.ofString()).statusCode());
        HttpResponse<String> stream = http.send(HttpRequest.newBuilder(URI.create(base + "/stream")).build(),
            HttpResponse.BodyHandlers.ofString());
        assertEquals("abc", stream.body());
        assertEquals(500, http.send(HttpRequest.newBuilder(URI.create(base + "/boom")).build(),
            HttpResponse.BodyHandlers.ofString()).statusCode());
        assertEquals(404, http.send(HttpRequest.newBuilder(URI.create(base + "/nowhere/7")).build(),
            HttpResponse.BodyHandlers.ofString()).statusCode());
        assertEquals(200, http.send(HttpRequest.newBuilder(URI.create(base + "/healthz")).build(),
            HttpResponse.BodyHandlers.ofString()).statusCode());

        ApiLensClient client = context.getBean(ApiLensClient.class);
        // The capture runs after the response completed, so wait for the last request's record.
        assertTrue(awaitRecords(client, ingest, "raw_path", 6), "six captured requests");
        List<JsonNode> requests = records(ingest, "raw_path");
        List<JsonNode> spans = records(ingest, "kind");
        List<JsonNode> logs = records(ingest, "logger_name");

        JsonNode order = find(requests, r -> r.get("raw_path").asText().startsWith("/orders/42"));
        assertEquals("GET", order.get("method").asText());
        assertEquals("/orders/{id}", order.get("path").asText());
        assertEquals("/orders/42?token=[redacted]&keep=1", order.get("raw_path").asText());
        assertEquals(200, order.get("status_code").asInt());
        assertEquals("staging", order.get("environment").asText());
        assertEquals("orders-api", order.get("app_id").asText());
        assertEquals("user-7", order.get("consumer_id").asText());
        assertEquals("Ada", order.get("consumer_name").asText());
        assertEquals("203.0.113.9", order.get("ip_address").asText());
        assertEquals(TRACE_ID, order.get("trace_id").asText());
        assertEquals("{\"id\":\"42\",\"status\":\"shipped\"}", order.get("response_payload").asText());
        assertTrue(order.get("request_headers").asText().contains("\"authorization\":\"[redacted]\""),
            order.get("request_headers").asText());
        assertTrue(order.get("base_url").asText().startsWith("http://127.0.0.1:"));
        assertTrue(order.get("response_size").asLong() > 0);
        assertTrue(order.get("sampled").asBoolean());

        JsonNode created = find(requests, r -> r.get("raw_path").asText().equals("/orders"));
        assertEquals(201, created.get("status_code").asInt());
        assertEquals("{\"item\":\"book\",\"password\":\"[redacted]\"}", created.get("request_payload").asText());
        assertEquals("{\"item\":\"book\",\"password\":\"[redacted]\"}", created.get("response_payload").asText());
        assertTrue(created.get("request_size").asLong() > 0);

        JsonNode routed = find(requests, r -> r.get("raw_path").asText().equals("/fn/items/sku-9"));
        assertEquals("/fn/items/{sku}", routed.get("path").asText(), "router functions report their template");

        JsonNode streamed = find(requests, r -> r.get("raw_path").asText().equals("/stream"));
        assertEquals(3, streamed.get("response_size").asLong(), "chunked body counted as it streams");

        JsonNode boom = find(requests, r -> r.get("raw_path").asText().equals("/boom"));
        assertEquals(500, boom.get("status_code").asInt());
        JsonNode missing = find(requests, r -> r.get("raw_path").asText().equals("/nowhere/7"));
        assertEquals(404, missing.get("status_code").asInt());
        assertFalse(requests.stream().anyMatch(r -> r.get("raw_path").asText().equals("/healthz")),
            "default exclusions apply");

        JsonNode orderSpan = find(spans, s -> s.get("name").asText().equals("GET /orders/{id}"));
        assertEquals("server", orderSpan.get("kind").asText());
        assertEquals("00f067aa0ba902b7", orderSpan.get("parent_span_id").asText());
        assertEquals(order.get("span_id").asText(), orderSpan.get("span_id").asText());
        assertEquals("error", find(spans, s -> s.get("name").asText().equals("GET /boom")).get("status").asText());

        assertEquals(1, logs.size(), "one error log: the 500, not the 404");
        JsonNode log = logs.get(0);
        assertEquals("apilens.exception", log.get("logger_name").asText());
        assertTrue(log.get("message").asText().contains("kaboom"));
        assertTrue(log.get("payload").asText().contains("IllegalStateException"));
        assertEquals(boom.get("trace_id").asText(), log.get("trace_id").asText());

        List<String> routes = new ArrayList<>();
        ApiLensMetadataReporter.routes(context).forEach(r -> routes.add(r.get("method") + " " + r.get("path")));
        assertTrue(routes.contains("GET /orders/{id}"), routes.toString());
        assertTrue(routes.contains("POST /orders"), routes.toString());
      } finally {
        server.disposeNow();
      }
    }
  }

  private static boolean awaitRecords(ApiLensClient client, IngestServer ingest, String field, int count)
      throws Exception {
    long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
    while (System.nanoTime() < deadline) {
      client.flushAll();
      if (records(ingest, field).size() >= count) {
        return true;
      }
      Thread.sleep(20);
    }
    return false;
  }

  /** Every record object in the delivered batches that has {@code field}. */
  static List<JsonNode> records(IngestServer ingest, String field) throws Exception {
    List<JsonNode> out = new ArrayList<>();
    for (String body : ingest.bodies()) {
      collect(JSON.readTree(body), field, out);
    }
    return out;
  }

  private static void collect(JsonNode node, String field, List<JsonNode> out) {
    if (node.isObject() && node.has(field)) {
      out.add(node);
      return;
    }
    node.forEach(child -> collect(child, field, out));
  }

  private static JsonNode find(List<JsonNode> records, Predicate<JsonNode> match) {
    return records.stream().filter(match).findFirst()
        .orElseThrow(() -> new AssertionError("no matching record in " + records));
  }

  @Configuration
  @EnableWebFlux
  static class WebConfig {
    @Bean
    RouterFunction<ServerResponse> itemRoutes() {
      return RouterFunctions.route()
          .GET("/fn/items/{sku}", request -> ServerResponse.ok().bodyValue("item " + request.pathVariable("sku")))
          .build();
    }
  }

  @RestController
  static class OrdersController {
    @GetMapping(value = "/orders/{id}", produces = MediaType.APPLICATION_JSON_VALUE)
    Mono<String> order(@PathVariable("id") String id, ServerWebExchange exchange) {
      ApiLensWebFilter.setConsumer(exchange, "user-7", "Ada", "pro");
      return Mono.just("{\"id\":\"" + id + "\",\"status\":\"shipped\"}");
    }

    @PostMapping(value = "/orders", produces = MediaType.APPLICATION_JSON_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    Mono<String> create(@RequestBody Mono<String> body) {
      return body;
    }

    @GetMapping(value = "/stream", produces = MediaType.TEXT_PLAIN_VALUE)
    Flux<String> stream() {
      return Flux.just("a", "b", "c");
    }

    @GetMapping("/boom")
    Mono<String> boom() {
      return Mono.error(new IllegalStateException("kaboom"));
    }

    @GetMapping("/healthz")
    Mono<String> health() {
      return Mono.just("ok");
    }
  }
}
