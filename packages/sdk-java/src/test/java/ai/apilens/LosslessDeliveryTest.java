package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.HeartbeatStub.Received;
import ai.apilens.HeartbeatStub.Reply;
import ai.apilens.internal.HttpClients;
import ai.apilens.spring.ApiLensProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;

/**
 * Delivery without silent loss (#930, D7 of #897): retry window, partial accept, drop
 * reporting in the heartbeat, WARNING drop logs and the JVM shutdown hook.
 */
class LosslessDeliveryTest {

  // ---- retry window -----------------------------------------------------

  @Test
  void outageInsideTheRetryWindowLosesNothing() throws Exception {
    // 40 failed attempts at up to 5 s of backoff each: minutes of outage, well past the old
    // 3 retries, but inside the default 300 s window.
    try (Ingest ingest = Ingest.start(40, 503)) {
      ApiLensClient client = client(ingest, b -> {});
      AtomicLong clock = fakeClock(client);
      for (int i = 0; i < 3; i += 1) {
        client.capture(record("/r" + i));
      }

      assertEquals(3, client.flushAll());
      assertEquals(41, ingest.attempts.get());
      assertEquals(3, ingest.records.get());
      assertEquals(0, client.droppedCount());
      assertEquals(Map.of(), client.unreportedDrops());
      long waited = TimeUnit.NANOSECONDS.toSeconds(clock.get());
      assertTrue(waited > 60 && waited < 300, "simulated outage of " + waited + "s");
    }
  }

  @Test
  void outageLongerThanTheWindowDropsCountsAndWarns() throws Exception {
    try (Ingest ingest = Ingest.start(Integer.MAX_VALUE, 503);
        LogCapture logs = LogCapture.start()) {
      ApiLensClient client = client(ingest, b -> b.maxRetryDuration(Duration.ofSeconds(60)));
      AtomicLong clock = fakeClock(client);
      client.capture(record("/a"));
      client.capture(record("/b"));

      assertEquals(0, client.flushAll());
      assertEquals(60, TimeUnit.NANOSECONDS.toSeconds(clock.get()));
      assertEquals(2L, client.dropCounts().get(ApiLensClient.DROP_RETRIES_EXHAUSTED));
      assertEquals(Map.of("requests", Map.of("retries_exhausted", 2L)), client.unreportedDrops());
      LogRecord warning = logs.find(Level.WARNING, "API Lens dropped 2 records");
      assertNotNull(warning, "drops are logged at WARNING: " + logs.messages());
      assertTrue(warning.getMessage().contains("retries_exhausted=2"), warning.getMessage());
      assertTrue(warning.getMessage().contains("503"), warning.getMessage());
    }
  }

  @Test
  void dropWarningsAreRateLimited() throws Exception {
    try (Ingest ingest = Ingest.start(Integer.MAX_VALUE, 503);
        LogCapture logs = LogCapture.start()) {
      ApiLensClient client = client(ingest, b -> b.maxRetries(0));
      for (int i = 0; i < 5; i += 1) {
        client.capture(record("/r" + i));
        client.flushAll();
      }

      assertEquals(5L, client.dropCounts().get(ApiLensClient.DROP_RETRIES_EXHAUSTED));
      long warnings = logs.records.stream()
          .filter(r -> r.getLevel() == Level.WARNING && r.getMessage().startsWith("API Lens dropped"))
          .count();
      assertEquals(1, warnings, logs.messages().toString());
    }
  }

  // ---- partial accept ---------------------------------------------------

  @Test
  void partialAcceptDropsOnlyTheRefusedRecords() throws Exception {
    String answer = "{\"accepted\":2,\"invalid\":1,\"errors\":[{\"index\":1,\"reason\":\"invalid timestamp\"}],"
        + "\"rejected\":[{\"app_id\":\"other\",\"records\":1,\"error\":\"app_not_allowed\",\"detail\":\"no\"}]}";
    try (Ingest ingest = Ingest.start(0, 200)) {
      ingest.answer = answer;
      ApiLensClient client = client(ingest, b -> {});
      for (int i = 0; i < 4; i += 1) {
        client.capture(record("/r" + i));
      }

      assertEquals(4, client.flushAll());
      assertEquals(1, ingest.attempts.get(), "a partial accept is not retried");
      ClientStats stats = client.stats();
      assertEquals(2, stats.sentRecords());
      assertEquals(1L, stats.dropCounts().get(ApiLensClient.DROP_INVALID));
      assertEquals(1L, stats.dropCounts().get(ApiLensClient.DROP_APP_REJECTED));
      assertEquals(2, stats.droppedCount());
      assertTrue(stats.lastError().contains("invalid timestamp"), stats.lastError());
      assertEquals(Map.of("requests", Map.of("invalid", 1L, "app_rejected", 1L)), client.unreportedDrops());
    }
  }

  @Test
  void plainOkAnswerAcceptsTheWholeBatch() throws Exception {
    try (Ingest ingest = Ingest.start(0, 200)) {
      ApiLensClient client = client(ingest, b -> {});
      client.capture(record("/a"));

      assertEquals(1, client.flushAll());
      assertEquals(1, client.stats().sentRecords());
      assertEquals(0, client.droppedCount());
    }
  }

  // ---- drop reporting ---------------------------------------------------

  @Test
  void heartbeatReportsDropsPerSignalAndResetsThemOnceAccepted() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensConfig config = ApiLensConfig.builder()
          .apiKey("test-key")
          .appId("orders-api")
          .baseUrl(stub.baseUrl())
          .maxQueueSize(1)
          .build();
      ApiLensClient client = new ApiLensClient(config, HttpClients.create(config), Duration.ofHours(1), false);
      client.registerApp("billing", "production");
      client.capture(record("/a"));
      client.capture(record("/b"));
      client.capture(record("/c"));
      client.captureSpan(SpanRecord.builder().name("s1").build());
      assertEquals(Map.of("requests", Map.of("queue_full", 2L)), client.unreportedDrops());

      stub.heartbeatReplies(Reply.status(503));
      assertFalse(client.sendHeartbeat());
      // Not accepted: the drops wait for the next heartbeat.
      assertEquals(Map.of("requests", Map.of("queue_full", 2L)), client.unreportedDrops());

      stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(RemotePolicy.CAPTURE_EVERYTHING)));

      assertTrue(client.sendHeartbeat());
      List<Received> beats = stub.heartbeats();
      Received accepted = beats.stream()
          .filter(b -> b.body().path("app_id").asText().equals("orders-api"))
          .reduce((first, second) -> second)
          .orElseThrow();
      assertEquals(2, accepted.body().path("dropped").path("requests").path("queue_full").asInt());
      if (IngestContract.available()) {
        assertEquals(List.of(), IngestContract.heartbeatViolations(accepted.body()));
      }
      // Only the configured app's heartbeat carries them, so they count once.
      for (Received beat : beats) {
        if (beat.body().path("app_id").asText().equals("billing")) {
          assertFalse(beat.body().has("dropped"), beat.body().toString());
        }
      }
      assertEquals(Map.of(), client.unreportedDrops());

      assertTrue(client.sendHeartbeat());
      Received next = stub.heartbeats().get(stub.heartbeats().size() - 1);
      assertFalse(next.body().has("dropped"), "zero drops send nothing extra");
      // The cumulative counters are untouched by reporting.
      assertEquals(2L, client.dropCounts().get(ApiLensClient.DROP_QUEUE_FULL));
    }
  }

  // ---- shutdown -----------------------------------------------------------

  @Test
  void runningClientRegistersAShutdownHookAndCloseRemovesIt() throws Exception {
    try (Ingest ingest = Ingest.start(0, 200)) {
      ApiLensClient client = new ApiLensClient(config(ingest, b -> b.sendHeartbeat(false)));
      Thread hook = client.shutdownHook();
      assertNotNull(hook, "a non-Spring client registers a JVM shutdown hook");
      client.close();
      assertNull(client.shutdownHook());
      // Removed from the runtime: removing it again reports it was not registered.
      assertFalse(Runtime.getRuntime().removeShutdownHook(hook));

      ApiLensClient off = new ApiLensClient(config(ingest, b -> b.sendHeartbeat(false).registerShutdownHook(false)));
      assertNull(off.shutdownHook());
      off.close();
    }
  }

  @Test
  void springManagedClientRegistersNoShutdownHook() {
    ApiLensProperties properties = new ApiLensProperties();
    properties.setApiKey("test-key");
    ApiLensConfig config = properties.toClientConfig();
    assertFalse(config.registerShutdownHook());
    assertEquals(Duration.ofSeconds(5), config.shutdownTimeout());
    assertEquals(ApiLensConfig.DEFAULT_MAX_RETRY_DURATION, config.maxRetryDuration());
  }

  @Test
  void shutdownHookFlushesTheQueue() throws Exception {
    try (Ingest ingest = Ingest.start(0, 200)) {
      ApiLensClient client = new ApiLensClient(config(ingest, b -> b
          .sendHeartbeat(false)
          .flushInterval(Duration.ofHours(1))));
      client.capture(record("/a"));
      client.capture(record("/b"));
      Thread hook = client.shutdownHook();
      assertNotNull(hook);
      Runtime.getRuntime().removeShutdownHook(hook);

      hook.run();

      assertEquals(2, ingest.records.get());
      assertEquals(0, client.stats().queuedRecords());
    }
  }

  @Test
  void shutdownIsBoundedAndCountsWhatItCouldNotSend() throws Exception {
    try (Ingest ingest = Ingest.start(Integer.MAX_VALUE, 503)) {
      ApiLensClient client = new ApiLensClient(config(ingest, b -> b
          .sendHeartbeat(false)
          .flushInterval(Duration.ofHours(1))
          .batchSize(1)
          .retryBackoffBase(Duration.ofMillis(20))
          .retryBackoffMax(Duration.ofMillis(50))
          .shutdownTimeout(Duration.ofMillis(300))));
      client.capture(record("/a"));
      client.capture(record("/b"));

      long start = System.nanoTime();
      client.shutdown();
      long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

      assertTrue(tookMs < 3000, "shutdown took " + tookMs + "ms");
      assertEquals(2L, client.dropCounts().get(ApiLensClient.DROP_SHUTDOWN));
      assertEquals(0, client.stats().queuedRecords());
    }
  }

  @Test
  void nonSpringClientFlushesOnJvmExit() throws Exception {
    try (Ingest ingest = Ingest.start(0, 200)) {
      String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
      String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
      Process child = new ProcessBuilder(java, "-cp", classpath, ShutdownHookMain.class.getName(), ingest.url())
          .redirectErrorStream(true)
          .start();
      boolean exited = child.waitFor(30, TimeUnit.SECONDS);
      String output = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      if (!exited) {
        child.destroyForcibly();
      }
      assertTrue(exited, "child JVM did not exit: " + output);
      assertEquals(0, child.exitValue(), output);
      assertEquals(3, ingest.records.get(), "records flushed by the shutdown hook; child output: " + output);
    }
  }

  // ---- helpers ------------------------------------------------------------

  private static ApiLensConfig config(Ingest ingest, Consumer<ApiLensConfig.Builder> mutator) {
    ApiLensConfig.Builder builder = ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(ingest.url() + "/v1")
        .batchSize(10)
        .compress(false);
    mutator.accept(builder);
    return builder.build();
  }

  private static ApiLensClient client(Ingest ingest, Consumer<ApiLensConfig.Builder> mutator) {
    ApiLensClient client = new ApiLensClient(config(ingest, b -> {
      b.sendHeartbeat(false).registerShutdownHook(false);
      mutator.accept(b);
    }));
    client.stop();
    return client;
  }

  /** A clock that only the client's (fake) sleeps move. */
  private static AtomicLong fakeClock(ApiLensClient client) {
    AtomicLong clock = new AtomicLong();
    client.nanoClock = clock::get;
    client.sleeper = duration -> clock.addAndGet(duration.toNanos());
    client.random = () -> 0.99;
    return clock;
  }

  private static RequestRecord record(String path) {
    return RequestRecord.builder().method("GET").path(path).statusCode(200).responseTimeMs(1).build();
  }

  /** Ingest stub: the first {@code failures} batch calls answer {@code status}, later ones 200. */
  private static final class Ingest implements AutoCloseable {
    private final HttpServer server;
    final AtomicInteger attempts = new AtomicInteger();
    final AtomicInteger records = new AtomicInteger();
    volatile String answer = "";

    private Ingest(HttpServer server) {
      this.server = server;
    }

    static Ingest start(int failures, int status) throws IOException {
      HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      Ingest ingest = new Ingest(http);
      http.createContext("/", exchange -> {
        byte[] raw = exchange.getRequestBody().readAllBytes();
        String path = exchange.getRequestURI().getPath();
        int code = 200;
        String body = "";
        if (!path.endsWith("/heartbeat") && !path.endsWith("/metadata")) {
          int attempt = ingest.attempts.incrementAndGet();
          if (attempt <= failures) {
            code = status;
          } else {
            if ("gzip".equalsIgnoreCase(exchange.getRequestHeaders().getFirst("Content-Encoding"))) {
              raw = new GZIPInputStream(new java.io.ByteArrayInputStream(raw)).readAllBytes();
            }
            JsonNode batch = new com.fasterxml.jackson.databind.ObjectMapper().readTree(raw);
            batch.fields().forEachRemaining(field -> ingest.records.addAndGet(field.getValue().size()));
            body = ingest.answer;
          }
        }
        byte[] out = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(code, out.length == 0 ? -1 : out.length);
        if (out.length > 0) {
          exchange.getResponseBody().write(out);
        }
        exchange.close();
      });
      http.start();
      return ingest;
    }

    String url() {
      return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }

  /** Records what the SDK logs under the {@code apilens} logger. */
  private static final class LogCapture extends Handler implements AutoCloseable {
    private static final Logger LOGGER = Logger.getLogger("apilens");
    final List<LogRecord> records = new CopyOnWriteArrayList<>();

    static LogCapture start() {
      LogCapture capture = new LogCapture();
      LOGGER.addHandler(capture);
      return capture;
    }

    LogRecord find(Level level, String prefix) {
      return records.stream()
          .filter(r -> r.getLevel() == level && r.getMessage().startsWith(prefix))
          .findFirst()
          .orElse(null);
    }

    List<String> messages() {
      List<String> out = new ArrayList<>();
      records.forEach(r -> out.add(r.getLevel() + " " + r.getMessage()));
      return out;
    }

    @Override
    public void publish(LogRecord record) {
      records.add(record);
    }

    @Override
    public void flush() {}

    @Override
    public void close() {
      LOGGER.removeHandler(this);
    }
  }
}
