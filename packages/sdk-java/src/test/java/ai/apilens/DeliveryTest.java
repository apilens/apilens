package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.internal.Delivery;
import ai.apilens.micrometer.ApiLensMetrics;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpServer;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.binder.MeterBinder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Delivery safety (#556): byte-bounded queue, maxBatchBytes, gzip, Retry-After, drop reasons, stats(). */
class DeliveryTest {
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final int KB = 1024;

  // ---- gzip -------------------------------------------------------------

  @Test
  void gzipsBatchBodiesByDefault() throws Exception {
    try (StubIngest server = StubIngest.start()) {
      ApiLensClient client = client(server, b -> {});
      client.capture(record("/a", ""));

      assertEquals(1, client.flushAll());
      Received req = server.requests.get(0);
      assertEquals("gzip", req.contentEncoding);
      assertTrue(req.raw.length > 2 && (req.raw[0] & 0xff) == 0x1f && (req.raw[1] & 0xff) == 0x8b);
      assertEquals("/a", MAPPER.readTree(req.body).get("requests").get(0).get("path").asText());
    }
  }

  @Test
  void compressFalseSendsPlainJson() throws Exception {
    try (StubIngest server = StubIngest.start()) {
      ApiLensClient client = client(server, b -> b.compress(false));
      client.capture(record("/a", ""));

      client.flushAll();
      Received req = server.requests.get(0);
      assertNull(req.contentEncoding);
      assertEquals(req.body, new String(req.raw, StandardCharsets.UTF_8));
    }
  }

  // ---- maxBatchBytes ----------------------------------------------------

  @Test
  void neverSendsABodyLargerThanMaxBatchBytes() throws Exception {
    try (StubIngest server = StubIngest.start()) {
      int limit = 4 * KB;
      ApiLensClient client = client(server, b -> b.maxBatchBytes(limit).batchSize(200).compress(false));
      for (int i = 0; i < 20; i += 1) {
        client.capture(record("/r" + i, "x".repeat(600)));
      }

      assertEquals(20, client.flushAll());
      assertTrue(server.requests.size() > 1, "expected the batch to be split");
      int total = 0;
      for (Received req : server.requests) {
        assertTrue(req.raw.length <= limit, "body of " + req.raw.length + " bytes exceeds " + limit);
        total += MAPPER.readTree(req.body).get("requests").size();
      }
      assertEquals(20, total);
      assertEquals(0, client.droppedCount());
      assertEquals(0, client.stats().queuedRecords());
    }
  }

  @Test
  void truncatesASingleOversizedRecordInsteadOfDroppingIt() throws Exception {
    try (StubIngest server = StubIngest.start()) {
      int limit = 2 * KB;
      ApiLensClient client = client(server, b -> b.maxBatchBytes(limit).compress(false));
      client.capture(record("/big", "y".repeat(10_000)));

      assertEquals(1, client.flushAll());
      Received req = server.requests.get(0);
      assertTrue(req.raw.length <= limit);
      JsonNode sent = MAPPER.readTree(req.body).get("requests").get(0);
      assertEquals("/big", sent.get("path").asText());
      assertTrue(sent.get("response_payload").asText().length() < 10_000);
      assertEquals(1L, client.dropCounts().get(ApiLensClient.DROP_TRUNCATED));
      assertEquals(0, client.droppedCount(), "truncated records are sent, not dropped");
    }
  }

  // ---- byte-bounded queue -----------------------------------------------

  @Test
  void dropsOldestRecordsWhenQueueBytesAreFull() throws Exception {
    try (StubIngest server = StubIngest.start()) {
      int each = record("/a", "z".repeat(1000)).estimatedBytes();
      ApiLensClient client = client(server, b -> b.maxQueueBytes(3L * each));
      for (String path : List.of("/a", "/b", "/c", "/d", "/e")) {
        client.capture(record(path, "z".repeat(1000)));
      }

      assertEquals(3, client.queuedRequestCount());
      assertEquals(3L * each, client.queuedBytes());
      assertEquals(2L, client.dropCounts().get(ApiLensClient.DROP_QUEUE_BYTES));
      assertEquals(2, client.droppedCount());

      client.flushAll();
      String body = server.requests.get(0).body;
      assertFalse(body.contains("\"/a\""));
      assertFalse(body.contains("\"/b\""));
      assertTrue(body.contains("\"/c\"") && body.contains("\"/e\""));
      assertEquals(0, client.queuedBytes());
    }
  }

  @Test
  void byteBudgetIsSharedAcrossQueuesAndShedsRecordsLargerThanIt() throws Exception {
    try (StubIngest server = StubIngest.start()) {
      SpanRecord span = SpanRecord.builder().name("s".repeat(500)).build();
      int spanBytes = span.estimatedBytes();
      ApiLensClient client = client(server, b -> b.maxQueueBytes(2L * spanBytes));
      client.captureSpan(span);
      client.captureSpan(SpanRecord.builder().name("t".repeat(500)).build());

      // An empty request queue evicts from the largest other queue (spans).
      client.capture(record("/a", ""));
      assertEquals(1L, client.dropCounts().get(ApiLensClient.DROP_QUEUE_BYTES));
      assertEquals(2, client.stats().queuedRecords());
      assertTrue(client.queuedBytes() <= 2L * spanBytes);

      // A record larger than the whole budget is shed without evicting anything.
      client.capture(record("/huge", "h".repeat(3 * spanBytes)));
      assertEquals(2L, client.dropCounts().get(ApiLensClient.DROP_QUEUE_BYTES));
      assertEquals(2, client.stats().queuedRecords());
    }
  }

  // ---- retry classification ---------------------------------------------

  @Test
  void honoursRetryAfterSecondsOn429() throws Exception {
    try (StubIngest server = StubIngest.start(
        reply(429, Map.of("Retry-After", "2")), reply(200, Map.of()))) {
      ApiLensClient client = client(server, b -> b.maxRetries(3));
      List<Duration> waits = recordSleeps(client);
      client.capture(record("/a", ""));

      assertEquals(1, client.flushAll());
      assertEquals(List.of(Duration.ofSeconds(2)), waits);
      assertEquals(2, server.requests.size());
    }
  }

  @Test
  void honoursRetryAfterHttpDateAndCapsItAtSixtySeconds() throws Exception {
    String farFuture = DateTimeFormatter.RFC_1123_DATE_TIME
        .format(Instant.now().plus(Duration.ofHours(1)).atOffset(ZoneOffset.UTC));
    try (StubIngest server = StubIngest.start(
        reply(503, Map.of("Retry-After", farFuture)), reply(200, Map.of()))) {
      ApiLensClient client = client(server, b -> b.maxRetries(3));
      List<Duration> waits = recordSleeps(client);
      client.capture(record("/a", ""));

      assertEquals(1, client.flushAll());
      assertEquals(List.of(Duration.ofSeconds(60)), waits);
    }
  }

  @Test
  void retries408And5xxWithFullJitterBackoff() throws Exception {
    try (StubIngest server = StubIngest.start(reply(408, Map.of()), reply(502, Map.of()), reply(200, Map.of()))) {
      ApiLensClient client = client(server, b -> b
          .maxRetries(3)
          .retryBackoffBase(Duration.ofMillis(100))
          .retryBackoffMax(Duration.ofSeconds(5)));
      List<Duration> waits = recordSleeps(client);
      client.random = () -> 0.5;
      client.capture(record("/a", ""));

      assertEquals(1, client.flushAll());
      // 0.5 * 100ms * 2^0, then 0.5 * 100ms * 2^1.
      assertEquals(List.of(Duration.ofMillis(50), Duration.ofMillis(100)), waits);
      assertEquals(3, server.requests.size());
    }
  }

  @Test
  void doesNotRetryOtherClientErrors() throws Exception {
    try (StubIngest server = StubIngest.start(reply(400, Map.of(), "{\"detail\":\"bad batch\"}"))) {
      ApiLensClient client = client(server, b -> b.maxRetries(3));
      List<Duration> waits = recordSleeps(client);
      client.capture(record("/a", ""));
      client.capture(record("/b", ""));

      assertEquals(0, client.flushAll());
      assertEquals(1, server.requests.size());
      assertTrue(waits.isEmpty());
      ClientStats stats = client.stats();
      assertEquals(2L, stats.dropCounts().get(ApiLensClient.DROP_NON_RETRYABLE));
      assertEquals(2, stats.droppedCount());
      assertEquals(1, stats.failedBatches());
      assertTrue(stats.lastError().contains("400"));
    }
  }

  @Test
  void countsRetriesExhausted() throws Exception {
    try (StubIngest server = StubIngest.start(reply(500, Map.of()), reply(500, Map.of()), reply(500, Map.of()))) {
      ApiLensClient client = client(server, b -> b.maxRetries(2));
      recordSleeps(client);
      client.capture(record("/a", ""));

      assertEquals(0, client.flushAll());
      assertEquals(3, server.requests.size());
      assertEquals(1L, client.dropCounts().get(ApiLensClient.DROP_RETRIES_EXHAUSTED));
      assertEquals(1, client.stats().failedBatches());
    }
  }

  // ---- stats ------------------------------------------------------------

  @Test
  void statsReportsQueueAndDelivery() throws Exception {
    try (StubIngest server = StubIngest.start()) {
      ApiLensClient client = client(server, b -> b.batchSize(2));
      ClientStats empty = client.stats();
      assertEquals(0, empty.queuedRecords());
      assertNull(empty.lastSuccessAt());
      assertEquals(ApiLensClient.DROP_REASONS, List.copyOf(empty.dropCounts().keySet()));

      client.capture(record("/a", ""));
      client.capture(record("/b", ""));
      client.capture(record("/c", ""));
      client.captureLog(LogRecord.builder().message("boom").level("error").build());
      assertEquals(4, client.stats().queuedRecords());
      assertTrue(client.stats().queuedBytes() >= 4L * ApiLensClient.RECORD_OVERHEAD_BYTES);

      assertEquals(4, client.flushAll());
      ClientStats stats = client.stats();
      assertEquals(0, stats.queuedRecords());
      assertEquals(0, stats.queuedBytes());
      assertEquals(3, stats.sentBatches());
      assertEquals(4, stats.sentRecords());
      assertEquals(0, stats.failedBatches());
      assertEquals(0, stats.droppedCount());
      assertNotNull(stats.lastSuccessAt());
      assertNull(stats.lastError());
    }
  }

  // ---- Micrometer -------------------------------------------------------

  @Test
  void micrometerBinderExposesStats() throws Exception {
    try (StubIngest server = StubIngest.start(reply(400, Map.of()), reply(200, Map.of()))) {
      ApiLensClient client = client(server, b -> {});
      MeterRegistry registry = new SimpleMeterRegistry();
      new ApiLensMetrics(client).bindTo(registry);

      client.capture(record("/rejected", ""));
      client.flushAll();
      client.capture(record("/ok", ""));
      client.capture(record("/queued", ""));
      client.flushOnce();
      client.capture(record("/waiting", ""));

      assertEquals(1.0, registry.get("apilens.queue.records").gauge().value());
      assertTrue(registry.get("apilens.queue.bytes").gauge().value() > 0);
      assertEquals(1.0, registry.get("apilens.batches.sent").functionCounter().count());
      assertEquals(2.0, registry.get("apilens.records.sent").functionCounter().count());
      assertEquals(1.0, registry.get("apilens.batches.failed").functionCounter().count());
      assertEquals(1.0, registry.get("apilens.records.dropped").tag("reason", "non_retryable")
          .functionCounter().count());
      assertEquals(0.0, registry.get("apilens.records.dropped").tag("reason", "queue_full")
          .functionCounter().count());
      assertEquals(0.0, registry.get("apilens.records.truncated").functionCounter().count());
    }
  }

  @Test
  void springRegistersTheMeterBinderWhenMicrometerIsPresent() throws Exception {
    try (StubIngest server = StubIngest.start();
         AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
      ClientConfig.url = server.url();
      context.register(ClientConfig.class, ai.apilens.spring.ApiLensMetricsAutoConfiguration.class);
      context.refresh();

      MeterBinder binder = context.getBean(MeterBinder.class);
      MeterRegistry registry = new SimpleMeterRegistry();
      binder.bindTo(registry);
      assertNotNull(registry.find("apilens.queue.records").gauge());
      assertNotNull(registry.find("apilens.records.dropped").tag("reason", "queue_bytes").functionCounter());
    }
  }

  @Configuration(proxyBeanMethods = false)
  static class ClientConfig {
    static String url;

    @Bean(destroyMethod = "shutdown")
    ApiLensClient apiLensClient() {
      return new ApiLensClient(ApiLensConfig.builder()
          .apiKey("test")
          .appId("orders-api")
          .baseUrl(url + "/v1")
          .enabled(true)
          .build());
    }
  }

  // ---- Delivery helpers -------------------------------------------------

  @Test
  void parsesRetryAfter() {
    Instant now = Instant.parse("2026-11-05T10:00:00Z");
    assertEquals(Duration.ofSeconds(3), Delivery.parseRetryAfter("3", now));
    assertEquals(Duration.ofMillis(1500), Delivery.parseRetryAfter(" 1.5 ", now));
    assertEquals(Duration.ofSeconds(60), Delivery.parseRetryAfter("3600", now));
    assertEquals(Duration.ofSeconds(30), Delivery.parseRetryAfter("Thu, 05 Nov 2026 10:00:30 GMT", now));
    assertEquals(Duration.ZERO, Delivery.parseRetryAfter("Thu, 05 Nov 2026 09:00:00 GMT", now));
    assertNull(Delivery.parseRetryAfter("", now));
    assertNull(Delivery.parseRetryAfter(null, now));
    assertNull(Delivery.parseRetryAfter("soon", now));
    assertNull(Delivery.parseRetryAfter("-5", now));
  }

  @Test
  void classifiesStatuses() {
    for (int status : new int[] {408, 429, 500, 502, 503, 504}) {
      assertTrue(Delivery.isRetryableStatus(status), String.valueOf(status));
    }
    for (int status : new int[] {400, 401, 403, 404, 413, 422}) {
      assertFalse(Delivery.isRetryableStatus(status), String.valueOf(status));
    }
  }

  @Test
  void backoffIsFullJitterCappedAtMax() {
    Duration base = Duration.ofMillis(250);
    Duration max = Duration.ofSeconds(5);
    assertEquals(Duration.ZERO, Delivery.backoff(0, base, max, 0.0));
    assertEquals(Duration.ofMillis(249), Delivery.backoff(0, base, max, 0.999));
    assertEquals(Duration.ofMillis(500), Delivery.backoff(2, base, max, 0.5));
    assertEquals(Duration.ofMillis(2500), Delivery.backoff(40, base, max, 0.5));
  }

  @Test
  void configRejectsInvalidDeliveryBounds() {
    assertThrowsIae(() -> ApiLensConfig.builder().maxQueueBytes(0).build());
    assertThrowsIae(() -> ApiLensConfig.builder().maxBatchBytes(ApiLensConfig.MIN_BATCH_BYTES - 1).build());
    ApiLensConfig defaults = ApiLensConfig.builder().build();
    assertEquals(64L * 1024 * 1024, defaults.maxQueueBytes());
    assertEquals(4 * 1024 * 1024, defaults.maxBatchBytes());
    assertTrue(defaults.compress());
  }

  // ---- helpers ----------------------------------------------------------

  private static void assertThrowsIae(Runnable runnable) {
    try {
      runnable.run();
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("expected IllegalArgumentException");
  }

  private static ApiLensClient client(StubIngest server, Consumer<ApiLensConfig.Builder> mutator) {
    ApiLensConfig.Builder builder = ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(server.url() + "/v1")
        .batchSize(10)
        .retryBackoffBase(Duration.ofMillis(1))
        .retryBackoffMax(Duration.ofMillis(2));
    mutator.accept(builder);
    ApiLensClient client = new ApiLensClient(builder.build());
    client.stop();
    return client;
  }

  private static List<Duration> recordSleeps(ApiLensClient client) {
    List<Duration> waits = new CopyOnWriteArrayList<>();
    client.sleeper = waits::add;
    return waits;
  }

  private static RequestRecord record(String path, String responsePayload) {
    return RequestRecord.builder()
        .method("GET")
        .path(path)
        .statusCode(200)
        .responseTimeMs(1)
        .responsePayload(responsePayload)
        .build();
  }

  private static Reply reply(int status, Map<String, String> headers) {
    return new Reply(status, headers, "");
  }

  private static Reply reply(int status, Map<String, String> headers, String body) {
    return new Reply(status, headers, body);
  }

  private record Reply(int status, Map<String, String> headers, String body) {}

  private record Received(String path, String contentEncoding, byte[] raw, String body) {}

  /** Local HTTP stub that replays scripted replies (then 200s) and records each request. */
  private static final class StubIngest implements AutoCloseable {
    private final HttpServer server;
    private final Queue<Reply> replies = new ConcurrentLinkedQueue<>();
    final List<Received> requests = new CopyOnWriteArrayList<>();

    private StubIngest(HttpServer server) {
      this.server = server;
    }

    static StubIngest start(Reply... replies) throws IOException {
      HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      StubIngest stub = new StubIngest(http);
      stub.replies.addAll(List.of(replies));
      http.createContext("/", exchange -> {
        Headers headers = exchange.getRequestHeaders();
        String encoding = headers.getFirst("Content-Encoding");
        byte[] raw = exchange.getRequestBody().readAllBytes();
        byte[] decoded = "gzip".equalsIgnoreCase(encoding)
            ? new GZIPInputStream(new ByteArrayInputStream(raw)).readAllBytes()
            : raw;
        stub.requests.add(new Received(
            exchange.getRequestURI().getPath(), encoding, raw, new String(decoded, StandardCharsets.UTF_8)));
        Reply reply = stub.replies.isEmpty() ? new Reply(200, Map.of(), "") : stub.replies.remove();
        reply.headers().forEach((name, value) -> exchange.getResponseHeaders().add(name, value));
        byte[] body = reply.body().getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(reply.status(), body.length == 0 ? -1 : body.length);
        if (body.length > 0) {
          exchange.getResponseBody().write(body);
        }
        exchange.close();
      });
      http.start();
      return stub;
    }

    String url() {
      return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }
}
