package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensClientTest.IngestServer;
import ai.apilens.ApiLensConfig;
import ai.apilens.ApiLensConsumer;
import ai.apilens.TraceContext;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;
import reactor.util.context.ContextView;

class ApiLensWebFilterTest {
  @Test
  void excludedRequestsPassThroughUndecorated() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensWebFilter filter = new ApiLensWebFilter(client, ApiLensSpringOptions.builder()
          .excludePaths(List.of("^/internal/"))
          .build());

      for (MockServerHttpRequest request : List.of(
          MockServerHttpRequest.get("/healthz").build(),
          MockServerHttpRequest.get("/internal/jobs").build(),
          MockServerHttpRequest.get("/orders").header("User-Agent", "kube-probe/1.29").build(),
          MockServerHttpRequest.options("/orders").build())) {
        MockServerWebExchange exchange = MockServerWebExchange.from(request);
        AtomicReference<ServerWebExchange> seen = new AtomicReference<>();
        filter.filter(exchange, ex -> {
          seen.set(ex);
          return Mono.empty();
        }).block();
        assertSame(exchange, seen.get(), "excluded request must not be decorated: " + request.getURI());
      }
      client.flushAll();
      assertTrue(server.bodies().isEmpty(), server.bodies().toString());
      client.shutdown(false);
    }
  }

  @Test
  void bodyCaptureRespectsTheCapAndContentType() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensWebFilter filter = new ApiLensWebFilter(client, ApiLensSpringOptions.builder()
          .maxPayloadBytes(8)
          .captureSpans(false)
          .build());

      MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/upload")
          .contentType(MediaType.TEXT_PLAIN)
          .body("0123456789abcdef"));
      AtomicReference<String> handlerSaw = new AtomicReference<>();
      filter.filter(exchange, ex -> DataBufferUtils.join(ex.getRequest().getBody())
          .flatMap(buffer -> {
            handlerSaw.set(buffer.toString(StandardCharsets.UTF_8));
            DataBufferUtils.release(buffer);
            ex.getResponse().getHeaders().setContentType(MediaType.IMAGE_PNG);
            return ex.getResponse().writeWith(Mono.just(wrap(ex, "PNGDATA-PNGDATA")));
          })).block();
      client.flushAll();

      assertEquals("0123456789abcdef", handlerSaw.get(), "the handler reads the whole body");
      JsonNode record = ApiLensWebFilterE2ETest.records(server, "raw_path").get(0);
      assertEquals("01234567", record.get("request_payload").asText());
      assertEquals(16, record.get("request_size").asLong());
      assertEquals("[image/png, 15 bytes omitted]", record.get("response_payload").asText());
      assertEquals(15, record.get("response_size").asLong());
      client.shutdown(false);
    }
  }

  @Test
  void sampledOutRequestSendsOnlyTheBaseRecordWithoutCopyingBodies() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensWebFilter filter = new ApiLensWebFilter(client, ApiLensSpringOptions.builder().sampleRate(0.0).build());

      MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/orders/9")
          .contentType(MediaType.APPLICATION_JSON)
          .body("{\"secret\":true}"));
      filter.filter(exchange, ex -> DataBufferUtils.join(ex.getRequest().getBody())
          .flatMap(buffer -> {
            DataBufferUtils.release(buffer);
            return ex.getResponse().writeWith(Mono.just(wrap(ex, "{\"ok\":true}")));
          })).block();
      client.flushAll();

      List<JsonNode> records = ApiLensWebFilterE2ETest.records(server, "raw_path");
      assertEquals(1, records.size());
      JsonNode record = records.get(0);
      assertFalse(record.get("sampled").asBoolean());
      assertEquals("", record.get("request_payload").asText());
      assertEquals("", record.get("response_payload").asText());
      assertEquals("", record.get("request_headers").asText());
      assertTrue(ApiLensWebFilterE2ETest.records(server, "kind").isEmpty(), "no span when sampled out");
      client.shutdown(false);
    }
  }

  @Test
  void consumerResolverStatusExceptionsAndTraceContext() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensWebFilter filter = new ApiLensWebFilter(client, ApiLensSpringOptions.builder().build(),
          exchange -> ApiLensConsumer.of(exchange.getRequest().getHeaders().getFirst("X-Tenant")));

      AtomicReference<TraceContext> fromAttribute = new AtomicReference<>();
      AtomicReference<ContextView> reactorContext = new AtomicReference<>();
      MockServerWebExchange exchange = MockServerWebExchange.from(
          MockServerHttpRequest.get("/orders/1").header("X-Tenant", "acme").build());
      WebFilterChain chain = ex -> {
        fromAttribute.set(ApiLensWebFilter.traceContext(ex));
        return Mono.deferContextual(ctx -> {
          reactorContext.set(ctx);
          return Mono.error(new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "down"));
        });
      };
      filter.filter(exchange, chain).onErrorResume(ex -> Mono.empty()).block();

      filter.filter(MockServerWebExchange.from(MockServerHttpRequest.get("/orders/2").build()),
          ex -> Mono.error(new ResponseStatusException(HttpStatus.NOT_FOUND))).onErrorResume(ex -> Mono.empty()).block();
      client.flushAll();

      List<JsonNode> records = ApiLensWebFilterE2ETest.records(server, "raw_path");
      JsonNode unavailable = records.get(0);
      assertEquals(503, unavailable.get("status_code").asInt());
      assertEquals("acme", unavailable.get("consumer_id").asText());
      assertEquals(fromAttribute.get().traceId(), unavailable.get("trace_id").asText());
      assertSame(fromAttribute.get(), reactorContext.get().get(TraceContext.class));
      assertEquals(404, records.get(1).get("status_code").asInt());

      List<JsonNode> logs = ApiLensWebFilterE2ETest.records(server, "logger_name");
      assertEquals(1, logs.size(), "a 404 status exception is not an error log");
      assertEquals(503, logs.get(0).get("status_code").asInt());
      client.shutdown(false);
    }
  }

  @Test
  void cancelledBeforeTheResponseIsRecordedAsClientClosedRequest() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensWebFilter filter = new ApiLensWebFilter(client, ApiLensSpringOptions.builder().captureSpans(false).build());

      filter.filter(MockServerWebExchange.from(MockServerHttpRequest.get("/slow").build()), ex -> Mono.never())
          .subscribe()
          .dispose();
      client.flushAll();

      JsonNode record = ApiLensWebFilterE2ETest.records(server, "raw_path").get(0);
      assertEquals(ApiLensWebFilter.CLIENT_CLOSED_REQUEST, record.get("status_code").asInt());
      client.shutdown(false);
    }
  }

  @Test
  void autoConfigurationAppliesCustomizersAndTheFilterOrder() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      StaticListableBeanFactory beans = new StaticListableBeanFactory();
      ApiLensSpringOptionsCustomizer customizer =
          options -> options.maskRequestBody((info, body) -> "{\"replaced\":true}".getBytes(StandardCharsets.UTF_8));
      beans.addBean("bodyMasking", customizer);
      ApiLensProperties properties = new ApiLensProperties();
      properties.setCaptureSpans(false);
      properties.setFilterOrder(-50);

      ApiLensWebFilter filter = new ApiLensWebFluxAutoConfiguration().apiLensWebFilter(
          client,
          properties,
          beans.getBeanProvider(ApiLensWebFluxConsumerResolver.class),
          beans.getBeanProvider(ApiLensSpringOptionsCustomizer.class));
      assertEquals(-50, filter.getOrder());

      MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/orders")
          .contentType(MediaType.APPLICATION_JSON)
          .body("{\"original\":true}"));
      filter.filter(exchange, ex -> DataBufferUtils.join(ex.getRequest().getBody())
          .doOnNext(DataBufferUtils::release)
          .then()).block();
      client.flushAll();

      JsonNode record = ApiLensWebFilterE2ETest.records(server, "raw_path").get(0);
      assertEquals("{\"replaced\":true}", record.get("request_payload").asText());
      client.shutdown(false);
    }
  }

  private static DataBuffer wrap(ServerWebExchange exchange, String text) {
    return exchange.getResponse().bufferFactory().wrap(text.getBytes(StandardCharsets.UTF_8));
  }

  private static ApiLensClient testClient(IngestServer server) {
    ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(server.url() + "/v1")
        .batchSize(10)
        .sendHeartbeat(false)
        .retryBackoffBase(Duration.ofMillis(1))
        .build());
    client.stop();
    return client;
  }
}
