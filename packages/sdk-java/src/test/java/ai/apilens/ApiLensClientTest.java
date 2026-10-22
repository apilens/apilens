package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

public class ApiLensClientTest {
  @Test
  void normalizesRecordsAndSendsDefaults() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = newClient(server, builder -> builder.batchSize(10));
      client.stop();

      client.capture(RequestRecord.builder()
          .method("post")
          .path("v1/orders")
          .statusCode(201)
          .responseTimeMs(15.2)
          .build());

      int sent = client.flushAll();

      assertEquals(1, sent);
      assertEquals(List.of("/v1/requests"), server.paths());
      String body = server.bodies().get(0);
      assertTrue(body.contains("\"method\":\"POST\""));
      assertTrue(body.contains("\"path\":\"/v1/orders\""));
      assertTrue(body.contains("\"environment\":\"production\""));
      assertTrue(body.contains("\"app_id\":\"orders-api\""));
      client.shutdown(false);
    }
  }

  @Test
  void dropsOldestRecordsWhenQueueIsFull() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = newClient(server, builder -> builder.batchSize(10).maxQueueSize(2));
      client.stop();

      client.capture(record("/a"));
      client.capture(record("/b"));
      client.capture(record("/c"));

      assertEquals(1, client.droppedCount());
      assertEquals(2, client.queuedRequestCount());

      client.flushAll();
      String body = server.bodies().get(0);
      assertFalse(body.contains("\"path\":\"/a\""));
      assertTrue(body.contains("\"path\":\"/b\""));
      assertTrue(body.contains("\"path\":\"/c\""));
      client.shutdown(false);
    }
  }

  @Test
  void retriesFailedIngests() throws Exception {
    try (IngestServer server = IngestServer.start(500, 500, 200)) {
      ApiLensClient client = newClient(server, builder -> builder
          .batchSize(10)
          .maxRetries(2)
          .retryBackoffBase(Duration.ofMillis(1))
          .retryBackoffMax(Duration.ofMillis(5)));
      client.stop();

      client.capture(record("/retry"));

      assertEquals(1, client.flushAll());
      assertEquals(3, server.attempts());
      client.shutdown(false);
    }
  }

  @Test
  void resolvesRelativeIngestPathAgainstBaseUrlPath() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = newClient(server, builder -> builder
          .baseUrl(server.url() + "/api/v1")
          .ingestPath("ingest/requests")
          .batchSize(10));
      client.stop();

      client.capture(record("/x"));
      client.flushAll();

      assertEquals(List.of("/api/v1/ingest/requests"), server.paths());
      client.shutdown(false);
    }
  }

  @Test
  void keepsLeadingSlashIngestPathAtHostRoot() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = newClient(server, builder -> builder
          .baseUrl(server.url() + "/api/v1")
          .ingestPath("/ingest/requests")
          .batchSize(10));
      client.stop();

      client.capture(record("/x"));
      client.flushAll();

      assertEquals(List.of("/ingest/requests"), server.paths());
      client.shutdown(false);
    }
  }

  private ApiLensClient newClient(IngestServer server, ConfigMutator mutator) {
    ApiLensConfig.Builder builder = ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(server.url() + "/v1");
    mutator.apply(builder);
    return new ApiLensClient(builder.build());
  }

  private RequestRecord record(String path) {
    return RequestRecord.builder()
        .method("GET")
        .path(path)
        .statusCode(200)
        .responseTimeMs(1)
        .build();
  }

  @FunctionalInterface
  private interface ConfigMutator {
    void apply(ApiLensConfig.Builder builder);
  }

  public static final class IngestServer implements AutoCloseable {
    private final HttpServer server;
    private final Queue<Integer> statuses;
    private final List<String> paths = new CopyOnWriteArrayList<>();
    private final List<String> bodies = new CopyOnWriteArrayList<>();
    private final AtomicInteger attempts = new AtomicInteger();

    private IngestServer(HttpServer server, Queue<Integer> statuses) {
      this.server = server;
      this.statuses = statuses;
    }

    public static IngestServer start(int... statuses) throws IOException {
      Queue<Integer> statusQueue = new ConcurrentLinkedQueue<>();
      for (int status : statuses) {
        statusQueue.add(status);
      }
      HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      IngestServer ingest = new IngestServer(server, statusQueue);
      server.createContext("/", exchange -> {
        ingest.attempts.incrementAndGet();
        ingest.paths.add(exchange.getRequestURI().getPath());
        ingest.bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        int status = ingest.statuses.isEmpty() ? 200 : ingest.statuses.remove();
        exchange.sendResponseHeaders(status, -1);
        exchange.close();
      });
      server.start();
      return ingest;
    }

    public String url() {
      return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public List<String> paths() {
      return paths;
    }

    public List<String> bodies() {
      return bodies;
    }

    public int attempts() {
      return attempts.get();
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }
}
