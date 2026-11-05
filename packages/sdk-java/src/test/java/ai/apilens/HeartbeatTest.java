package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import ai.apilens.HeartbeatStub.Received;
import ai.apilens.HeartbeatStub.Reply;
import ai.apilens.internal.HttpClients;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * Heartbeat, remote capture policy and app metadata (#557). Contract:
 * apps/docs/ingest/heartbeat.mdx and the ingest handlers' OpenAPI schemas.
 */
class HeartbeatTest {
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Duration FAST = Duration.ofMillis(200);
  private static final Duration WAIT = Duration.ofSeconds(5);
  private static final RemotePolicy DISABLED = new RemotePolicy(false, 1.0, true, true, true, null);
  private static final RemotePolicy NARROW = new RemotePolicy(true, 0.5, false, true, false, 1024);

  // ---- contract ---------------------------------------------------------

  @Test
  void heartbeatOnStartMatchesTheIngestContract() throws Exception {
    assumeTrue(IngestContract.available(), "OpenAPI document not in this checkout");
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, FAST, b -> b.projectSlug("shop").release("2026.11.05").commit("9f2c1ab"));
      try {
        assertTrue(HeartbeatStub.await(() -> !stub.heartbeats().isEmpty(), WAIT), "no heartbeat on start");
        Received beat = stub.heartbeats().get(0);
        assertEquals(List.of(), IngestContract.heartbeatViolations(beat.body()));
        assertEquals("test-key", beat.headers().get("x-api-key"));
        JsonNode body = beat.body();
        assertEquals("orders-api", body.get("app_id").asText());
        assertEquals("production", body.get("environment").asText());
        assertEquals(client.instanceId(), body.get("instance_id").asText());
        assertEquals(ApiLensClient.SDK_NAME, body.get("sdk_name").asText());
        assertEquals(ApiLensVersion.VERSION, body.get("sdk_version").asText());
        assertTrue(body.get("runtime").asText().startsWith("java "));
        assertEquals(ProcessHandle.current().pid(), body.get("pid").asLong());
        assertTrue(body.get("uptime_s").isIntegralNumber());
        assertEquals("shop", body.get("project_slug").asText());
        assertEquals("2026.11.05", body.get("release").asText());
        assertEquals("9f2c1ab", body.get("commit").asText());
        assertFalse(body.has("final"));
        JsonNode stats = body.get("stats");
        for (String key : List.of("queued_records", "queued_bytes", "sent_batches", "sent_records",
            "failed_batches", "dropped", "drop_counts", "last_error", "last_success_at")) {
          assertTrue(stats.has(key), "stats." + key);
        }
        assertFalse(body.toString().contains("test-key"), "the API key belongs in the header only");
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void metadataReportMatchesTheIngestContract() throws Exception {
    assumeTrue(IngestContract.available(), "OpenAPI document not in this checkout");
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, Duration.ofSeconds(10), b -> b.sendHeartbeat(false));
      try {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("framework", "spring-boot");
        payload.put("framework_version", "3.5.16");
        payload.put("java_version", System.getProperty("java.version"));
        payload.put("sdk_version", ApiLensVersion.VERSION);
        payload.put("routes", List.of(Map.of("method", "get", "path", "/orders/{id}")));
        payload.put("config", Map.of("capture_headers", true, "nested", Map.of("apiKey", "leak")));
        payload.put("api_key", "leak");

        assertTrue(client.sendMetadata(payload));
        JsonNode body = stub.metadata().get(0).body();
        assertEquals(List.of(), IngestContract.metadataViolations(body));
        assertEquals("orders-api", body.get("app_id").asText());
        assertEquals("production", body.get("environment").asText());
        assertEquals("GET", body.get("routes").get(0).get("method").asText());
        assertFalse(body.toString().contains("leak"));
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void contractRejectsWhatIngestRejects() {
    assumeTrue(IngestContract.available(), "OpenAPI document not in this checkout");
    JsonNode missing = MAPPER.valueToTree(Map.of("app_id", "a"));
    assertFalse(IngestContract.heartbeatViolations(missing).isEmpty(), "instance_id is required");
    JsonNode withKey = MAPPER.valueToTree(Map.of("app_id", "a", "instance_id", "i", "stats", Map.of("Api-Key", "x")));
    assertFalse(IngestContract.heartbeatViolations(withKey).isEmpty(), "api_key at any depth");
    assertThrows(IllegalArgumentException.class,
        () -> IngestContract.heartbeatResponse(Map.of("enabled", true)), "policy fields are required");
  }

  // ---- schedule ---------------------------------------------------------

  @Test
  void repeatsEveryIntervalWithOneInstanceId() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, FAST, b -> {});
      try {
        assertTrue(HeartbeatStub.await(() -> stub.heartbeats().size() >= 3, WAIT));
        List<Received> beats = stub.heartbeats();
        for (Received beat : beats) {
          assertEquals(client.instanceId(), beat.body().get("instance_id").asText());
        }
        long gapMs = (beats.get(1).atNanos() - beats.get(0).atNanos()) / 1_000_000;
        assertTrue(gapMs >= FAST.toMillis() - 20, "heartbeat repeated after only " + gapMs + "ms");
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void shutdownSendsAFinalHeartbeat() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, Duration.ofSeconds(30), b -> {});
      assertTrue(HeartbeatStub.await(() -> stub.heartbeats().size() == 1, WAIT));
      client.shutdown();
      List<Received> beats = stub.heartbeats();
      assertEquals(2, beats.size());
      assertTrue(beats.get(1).body().get("final").asBoolean());
    }
  }

  @Test
  void retryAfterReschedulesTheNextHeartbeat() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      stub.heartbeatReplies(new Reply(429, Map.of("Retry-After", "1"), "{}"),
          Reply.ok(HeartbeatStub.policy(RemotePolicy.CAPTURE_EVERYTHING)));
      ApiLensClient client = client(stub, Duration.ofMillis(50), b -> {});
      try {
        assertTrue(HeartbeatStub.await(() -> stub.heartbeats().size() >= 2, WAIT));
        List<Received> beats = stub.heartbeats();
        long gapMs = (beats.get(1).atNanos() - beats.get(0).atNanos()) / 1_000_000;
        assertTrue(gapMs >= 900, "Retry-After: 1 not honoured, next heartbeat after " + gapMs + "ms");
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void registeredAppsGetTheirOwnHeartbeatOnce() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = stoppedClient(stub, b -> {});
      client.registerApp("orders-api", "Staging");
      client.registerApp("orders-api", "staging");
      client.registerApp("", "production");

      assertTrue(client.sendHeartbeat());
      List<String> envs = new ArrayList<>();
      stub.heartbeats().forEach(beat -> envs.add(beat.body().get("environment").asText()));
      envs.sort(String::compareTo);
      assertEquals(List.of("production", "staging"), envs);
    }
  }

  @Test
  void heartbeatsCanBeTurnedOff() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient off = client(stub, FAST, b -> b.sendHeartbeat(false));
      ApiLensClient disabled = client(stub, FAST, b -> b.enabled(false));
      Thread.sleep(3 * FAST.toMillis());
      assertFalse(off.sendHeartbeat());
      assertFalse(disabled.sendHeartbeat());
      off.shutdown();
      disabled.shutdown();
      assertEquals(0, stub.heartbeats().size());
    }
  }

  @Test
  void intervalBelowTheIngestRateLimitIsRefused() {
    assertThrows(IllegalArgumentException.class,
        () -> ApiLensConfig.builder().heartbeatInterval(Duration.ofSeconds(9)).build());
    assertEquals(Duration.ofSeconds(60), ApiLensConfig.builder().build().heartbeatInterval());
  }

  // ---- remote policy ----------------------------------------------------

  @Test
  void responsePolicyIsKept() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(NARROW)));
      ApiLensClient client = stoppedClient(stub, b -> {});
      assertEquals(RemotePolicy.CAPTURE_EVERYTHING, client.remotePolicy());

      assertTrue(client.sendHeartbeat());
      assertEquals(NARROW, client.remotePolicy());
    }
  }

  @Test
  void policyIsAppliedWithinOneInterval() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, FAST, b -> {});
      try {
        assertTrue(HeartbeatStub.await(() -> !stub.heartbeats().isEmpty(), WAIT));
        client.capture(record("/before"));
        assertEquals(1, client.queuedRequestCount());

        // The app is disabled in APILens: the next heartbeat (one interval later) carries it.
        stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(DISABLED)));
        long changed = System.nanoTime();
        assertTrue(HeartbeatStub.await(() -> !client.remotePolicy().enabled(), WAIT));
        long tookMs = (System.nanoTime() - changed) / 1_000_000;
        assertTrue(tookMs <= FAST.toMillis() + 300, "policy took " + tookMs + "ms, interval " + FAST.toMillis());

        client.capture(record("/during"));
        client.captureSpan(SpanRecord.builder().traceId("t").spanId("s").name("x").build());
        client.captureLog(LogRecord.builder().level("ERROR").message("boom").build());
        assertEquals(1, client.queuedRequestCount(), "records are not captured while disabled");
        assertEquals(1, client.stats().queuedRecords());

        // Heartbeats continue, so re-enabling takes effect on the next one.
        stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(RemotePolicy.CAPTURE_EVERYTHING)));
        assertTrue(HeartbeatStub.await(() -> client.remotePolicy().enabled(), WAIT));
        client.capture(record("/after"));
        assertEquals(2, client.queuedRequestCount());
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void failedHeartbeatKeepsThePreviousPolicy() throws Exception {
    List<Reply> failures = List.of(
        Reply.status(503), Reply.status(401), Reply.status(422), Reply.ok("not json"), Reply.ok("{}"),
        Reply.ok("{\"policy\":{\"enabled\":true}}"),
        Reply.ok("{\"policy\":{\"enabled\":true,\"sample_rate\":2,\"capture_headers\":true,"
            + "\"capture_request_body\":true,\"capture_response_body\":true,\"max_payload_bytes\":null}}"));
    for (Reply failure : failures) {
      try (HeartbeatStub stub = HeartbeatStub.start()) {
        stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(NARROW)), failure);
        ApiLensClient client = stoppedClient(stub, b -> {});
        assertTrue(client.sendHeartbeat());
        client.sendHeartbeat();
        assertEquals(NARROW, client.remotePolicy(), "after " + failure);
      }
    }
  }

  @Test
  void networkErrorIsSilentAndKeepsDeliveryWorking() throws Exception {
    ApiLensConfig config = ApiLensConfig.builder()
        .apiKey("test-key").appId("orders-api").baseUrl("http://127.0.0.1:1/v1")
        .timeout(Duration.ofMillis(200)).maxRetries(0).build();
    ApiLensClient client = new ApiLensClient(config, HttpClients.create(config), null, false);
    assertFalse(client.sendHeartbeat());
    assertEquals(RemotePolicy.CAPTURE_EVERYTHING, client.remotePolicy());
  }

  @Test
  void failingHeartbeatDoesNotAffectDataFlush() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      stub.heartbeatReplies(Reply.status(500));
      ApiLensClient client = stoppedClient(stub, b -> {});
      assertFalse(client.sendHeartbeat());
      client.capture(record("/a"));
      assertEquals(1, client.flushAll());
      assertEquals(1, stub.requests().size());
    }
  }

  @Test
  void remotePolicyParsing() {
    JsonNode full = MAPPER.valueToTree(Map.of("enabled", false, "sample_rate", 0.25, "capture_headers", true,
        "capture_request_body", false, "capture_response_body", true, "max_payload_bytes", 512));
    assertEquals(new RemotePolicy(false, 0.25, true, false, true, 512), RemotePolicy.fromJson(full));
    Map<String, Object> nullCap = new LinkedHashMap<>(RemotePolicy.CAPTURE_EVERYTHING.toWire());
    assertEquals(RemotePolicy.CAPTURE_EVERYTHING, RemotePolicy.fromJson(MAPPER.valueToTree(nullCap)));
    nullCap.put("sample_rate", "1");
    assertNull(RemotePolicy.fromJson(MAPPER.valueToTree(nullCap)));
    assertNull(RemotePolicy.fromJson(null));
  }

  @Test
  void remotePolicyOnlyNarrows() {
    RemotePolicy cap = new RemotePolicy(true, 1.0, true, true, true, 100);
    assertEquals(100, cap.limitPayloadBytes(65_536));
    assertEquals(50, cap.limitPayloadBytes(50), "a larger remote cap never raises the local one");
    assertEquals(65_536, RemotePolicy.CAPTURE_EVERYTHING.limitPayloadBytes(65_536));
    assertTrue(RemotePolicy.CAPTURE_EVERYTHING.keeps(() -> { throw new AssertionError("no draw at rate 1"); }));
    assertFalse(new RemotePolicy(true, 0.0, true, true, true, null).keeps(() -> 0.0));
    RemotePolicy half = new RemotePolicy(true, 0.5, true, true, true, null);
    assertTrue(half.keeps(() -> 0.49));
    assertFalse(half.keeps(() -> 0.5));
  }

  // ---- metadata ---------------------------------------------------------

  @Test
  void reportMetadataIsSentOncePerProcessAndDoesNotBlock() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, Duration.ofSeconds(30), b -> b.sendHeartbeat(false));
      try {
        assertTrue(client.reportMetadata("production", () -> {
          sleep(200);
          return new LinkedHashMap<>(Map.of("framework", "spring-boot"));
        }));
        assertFalse(client.reportMetadata("production", LinkedHashMap::new), "once per app and environment");
        assertTrue(stub.metadata().isEmpty(), "the report runs off the caller's thread");
        assertTrue(HeartbeatStub.await(() -> stub.metadata().size() == 1, WAIT));
        assertTrue(client.reportMetadata("staging", LinkedHashMap::new), "another environment reports too");
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void disabledMetadataReportsNothing() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient off = client(stub, Duration.ofSeconds(30), b -> b.sendMetadata(false));
      ApiLensClient stopped = stoppedClient(stub, b -> b.appId("other-api"));
      assertFalse(off.reportMetadata("production", LinkedHashMap::new));
      assertFalse(stopped.reportMetadata("production", LinkedHashMap::new));
      off.shutdown(false);
    }
  }

  @Test
  void metadataIsRetriedOnRetryableStatusesOnly() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      stub.metadataReplies(Reply.status(503), Reply.status(502));
      ApiLensClient client = stoppedClient(stub, b -> {});
      client.sleeper = duration -> {};
      assertTrue(client.sendMetadata(new LinkedHashMap<>()));
      assertEquals(3, stub.metadata().size());

      stub.metadataReplies(Reply.status(422));
      assertFalse(client.sendMetadata(new LinkedHashMap<>()));
      assertEquals(4, stub.metadata().size());

      stub.metadataReplies(Reply.status(503), Reply.status(503), Reply.status(503), Reply.status(503));
      assertFalse(client.sendMetadata(new LinkedHashMap<>()));
      assertEquals(8, stub.metadata().size(), "1 attempt + 3 retries");
    }
  }

  @Test
  void routesAreNormalisedAndCapped() {
    List<Map<String, String>> routes = new ArrayList<>();
    routes.add(Map.of("method", " get ", "path", "/a"));
    routes.add(Map.of("method", "GET", "path", "/a"));
    routes.add(Map.of("method", "", "path", "/b"));
    routes.add(Map.of("method", "POST", "path", " "));
    for (int i = 0; i < 2100; i += 1) {
      routes.add(Map.of("method", "GET", "path", "/r" + i));
    }
    List<Map<String, String>> capped = ApiLensClient.capRoutes(routes);
    assertEquals(ApiLensClient.MAX_METADATA_ROUTES, capped.size());
    assertEquals(Map.of("method", "GET", "path", "/a"), capped.get(0));
    assertEquals("/r0", capped.get(1).get("path"));
    assertEquals(List.of(), ApiLensClient.capRoutes(null));
  }

  @Test
  void apiKeyFieldsAreStrippedAtAnyDepth() {
    for (String name : List.of("api_key", "apiKey", "API-KEY", "api.key", "Api Key")) {
      assertTrue(ApiLensClient.isApiKeyName(name), name);
    }
    assertFalse(ApiLensClient.isApiKeyName("api_keys"));
    Object stripped = ApiLensClient.stripApiKeyFields(Map.of(
        "keep", 1, "apiKey", "x", "list", List.of(Map.of("api_key", "y", "ok", true))));
    assertEquals(Map.of("keep", 1, "list", List.of(Map.of("ok", true))), stripped);
  }

  // ---- helpers ----------------------------------------------------------

  private static ApiLensClient client(HeartbeatStub stub, Duration interval, Consumer<ApiLensConfig.Builder> mutator) {
    ApiLensConfig.Builder builder = ApiLensConfig.builder()
        .apiKey("test-key")
        .appId("orders-api")
        .baseUrl(stub.baseUrl())
        .flushInterval(Duration.ofSeconds(30))
        .retryBackoffBase(Duration.ofMillis(1))
        .retryBackoffMax(Duration.ofMillis(2));
    mutator.accept(builder);
    ApiLensConfig config = builder.build();
    return new ApiLensClient(config, HttpClients.create(config), interval, true);
  }

  /** A client whose background threads are stopped: heartbeats only on sendHeartbeat(). */
  private static ApiLensClient stoppedClient(HeartbeatStub stub, Consumer<ApiLensConfig.Builder> mutator) {
    ApiLensConfig.Builder builder = ApiLensConfig.builder()
        .apiKey("test-key")
        .appId("orders-api")
        .baseUrl(stub.baseUrl());
    mutator.accept(builder);
    ApiLensConfig config = builder.build();
    return new ApiLensClient(config, HttpClients.create(config), null, false);
  }

  private static RequestRecord record(String path) {
    return RequestRecord.builder().method("GET").path(path).statusCode(200).responseTimeMs(1).build();
  }

  private static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException ex) {
      Thread.currentThread().interrupt();
    }
  }
}
