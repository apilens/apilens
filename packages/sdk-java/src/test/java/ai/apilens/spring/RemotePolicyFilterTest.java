package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.HeartbeatStub;
import ai.apilens.HeartbeatStub.Reply;
import ai.apilens.IngestContract;
import ai.apilens.RemotePolicy;
import ai.apilens.SampleDecision;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockServletContext;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

/** The remote capture policy in the Spring filter only narrows capture, and the metadata report (#557). */
class RemotePolicyFilterTest {
  private static final String BODY = "{\"item\":\"" + "b".repeat(200) + "\"}";

  @Test
  void captureEverythingKeepsTheLocalBehaviour() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      JsonNode record = captureOne(stub, RemotePolicy.CAPTURE_EVERYTHING, UnaryOperator.identity());
      assertTrue(record.get("sampled").asBoolean());
      assertFalse(record.get("request_headers").asText().isEmpty());
      assertEquals(BODY, record.get("request_payload").asText());
      assertEquals(BODY, record.get("response_payload").asText());
    }
  }

  @Test
  void remoteFlagsTurnPartsOff() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      JsonNode record = captureOne(stub,
          new RemotePolicy(true, 1.0, false, false, true, null), UnaryOperator.identity());
      assertTrue(record.get("sampled").asBoolean());
      assertEquals("", record.path("request_headers").asText(""));
      assertEquals("", record.path("response_headers").asText(""));
      assertEquals("", record.path("request_payload").asText(""));
      assertEquals(BODY, record.get("response_payload").asText());
    }
  }

  @Test
  void remotePolicyNeverWidensTheLocalOptions() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      // Remote says capture everything with a 1 MiB cap; locally headers and request bodies are
      // off, bodies are capped at 20 bytes and every request is sampled out.
      JsonNode record = captureOne(stub, new RemotePolicy(true, 1.0, true, true, true, 1 << 20),
          options -> options.captureHeaders(false).logRequestBody(false).maxPayloadBytes(20));
      assertEquals("", record.path("request_headers").asText(""));
      assertEquals("", record.path("request_payload").asText(""));
      assertTrue(record.get("response_payload").asText().length() <= 40,
          "local 20-byte cap kept: " + record.get("response_payload").asText());

      JsonNode sampledOut = captureOne(stub, RemotePolicy.CAPTURE_EVERYTHING,
          options -> options.sampleOnRequest(info -> SampleDecision.DROP));
      assertFalse(sampledOut.get("sampled").asBoolean(), "a remote rate of 1 keeps local sampling");
    }
  }

  @Test
  void remoteMaxPayloadBytesCapsBodies() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      JsonNode record = captureOne(stub, new RemotePolicy(true, 1.0, true, true, true, 16), UnaryOperator.identity());
      String payload = record.get("response_payload").asText();
      assertTrue(payload.length() < BODY.length(), "remote cap applied: " + payload);
      assertFalse(payload.contains("b".repeat(50)));
    }
  }

  @Test
  void remoteSampleRateSendsOnlyTheBaseRecord() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      JsonNode record = captureOne(stub, new RemotePolicy(true, 0.0, true, true, true, null), UnaryOperator.identity());
      assertFalse(record.get("sampled").asBoolean());
      assertEquals(201, record.get("status_code").asInt(), "the base record keeps metrics exact");
      assertEquals("", record.path("request_payload").asText(""));
      assertEquals("", record.path("request_headers").asText(""));
      assertTrue(stub.requests().size() == 1, "one base record");
    }
  }

  @Test
  void disabledPolicyBypassesTheFilter() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(new RemotePolicy(false, 1.0, true, true, true, null))));
      ApiLensClient client = client(stub);
      assertTrue(client.sendHeartbeat());
      ApiLensSpringFilter filter = new ApiLensSpringFilter(client, ApiLensSpringOptions.builder().build());

      MockHttpServletRequest request = new MockHttpServletRequest("GET", "/orders/1");
      AtomicReference<ServletRequest> seen = new AtomicReference<>();
      filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> {
        seen.set(req);
        ((HttpServletResponse) res).setStatus(200);
      });
      client.flushAll();

      assertSame(request, seen.get(), "nothing is wrapped while capture is disabled");
      assertTrue(stub.requests().isEmpty());
      assertTrue(stub.heartbeats().size() >= 1, "heartbeats continue");
    }
  }

  @Test
  void filterRegistersItsEnvironmentForHeartbeats() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub);
      new ApiLensSpringFilter(client, ApiLensSpringOptions.builder().environment("staging").build());
      int before = stub.heartbeats().size();
      assertTrue(client.sendHeartbeat());
      List<String> envs = new ArrayList<>();
      stub.heartbeats().subList(before, stub.heartbeats().size())
          .forEach(beat -> envs.add(beat.body().get("environment").asText()));
      assertTrue(envs.contains("staging"), envs.toString());
    }
  }

  // ---- metadata report --------------------------------------------------

  @Test
  void metadataReportListsSpringMvcRoutesAndTheEffectiveConfig() throws Exception {
    assumeTrue(IngestContract.available(), "OpenAPI document not in this checkout");
    try (HeartbeatStub stub = HeartbeatStub.start();
        AnnotationConfigWebApplicationContext context = new AnnotationConfigWebApplicationContext()) {
      context.setServletContext(new MockServletContext());
      context.register(WebConfig.class, OrdersController.class);
      context.refresh();

      ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
          .apiKey("secret-api-key")
          .appId("orders-api")
          .projectSlug("shop")
          .baseUrl(stub.baseUrl())
          .caBundlePath("")
          .sendHeartbeat(false)
          .build());
      try {
        ApiLensSpringFilter filter = new ApiLensSpringFilter(client, ApiLensSpringOptions.builder()
            .redactBodyFields(List.of("^ssn$"))
            .excludePaths(List.of("^/internal/"))
            .maskRequestBody((info, body) -> body)
            .build());
        ApiLensMetadataReporter reporter = new ApiLensMetadataReporter(client, filter, true);

        assertTrue(reporter.report(context));
        assertFalse(reporter.report(context), "once per process");
        assertTrue(HeartbeatStub.await(() -> stub.metadata().size() == 1, Duration.ofSeconds(5)));

        JsonNode body = stub.metadata().get(0).body();
        assertEquals(List.of(), IngestContract.metadataViolations(body));
        assertEquals("orders-api", body.get("app_id").asText());
        assertEquals("shop", body.get("project_slug").asText());
        assertEquals("spring-boot", body.get("framework").asText());
        assertFalse(body.get("framework_version").asText().isEmpty());
        assertEquals(System.getProperty("java.version"), body.get("java_version").asText());
        assertFalse(body.toString().contains("secret-api-key"));

        List<String> routes = new ArrayList<>();
        body.get("routes").forEach(r -> routes.add(r.get("method").asText() + " " + r.get("path").asText()));
        assertTrue(routes.contains("GET /orders/{id}"), routes.toString());
        assertTrue(routes.contains("POST /orders"), routes.toString());
        assertTrue(routes.contains("* /orders/any"), routes.toString());

        JsonNode config = body.get("config");
        assertTrue(config.get("capture_headers").asBoolean());
        assertEquals(65_536, config.get("max_payload_bytes").asInt());
        assertTrue(config.get("redact_body_fields").toString().contains("^ssn$"));
        assertTrue(config.get("redact_body_fields").toString().contains("password"), "built-ins are listed");
        assertTrue(config.get("exclude_paths").toString().contains("^/internal/"));
        assertEquals(1.0, config.get("sample_rate").asDouble());
        assertTrue(config.get("callbacks").get("mask_request_body").asBoolean());
        assertFalse(config.get("callbacks").get("mask_response_body").asBoolean());
        assertTrue(config.get("callbacks").get("consumer_resolver").asBoolean());
        assertFalse(config.get("custom_ca").asBoolean());
      } finally {
        client.shutdown(false);
      }
    }
  }

  @EnableWebMvc
  static class WebConfig {}

  @RestController
  static class OrdersController {
    @GetMapping("/orders/{id}")
    String get(@PathVariable("id") String id) {
      return id;
    }

    @PostMapping("/orders")
    String create() {
      return "ok";
    }

    @RequestMapping("/orders/any")
    String any() {
      return "any";
    }
  }

  // ---- helpers ----------------------------------------------------------

  private static ApiLensClient client(HeartbeatStub stub) {
    ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(stub.baseUrl())
        .compress(false)
        .sendMetadata(false)
        .build());
    client.stop();
    return client;
  }

  /** Applies {@code policy} through a heartbeat, runs one POST through the filter, returns its record. */
  private static JsonNode captureOne(
      HeartbeatStub stub, RemotePolicy policy, UnaryOperator<ApiLensSpringOptions.Builder> local) throws Exception {
    stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(policy)));
    ApiLensClient client = client(stub);
    assertTrue(client.sendHeartbeat());
    assertEquals(policy, client.remotePolicy());
    ApiLensSpringFilter filter = new ApiLensSpringFilter(
        client, local.apply(ApiLensSpringOptions.builder()).build(), null, () -> 0.5);

    MockHttpServletRequest request = new MockHttpServletRequest("POST", "/orders");
    request.setContentType("application/json");
    request.setContent(BODY.getBytes(StandardCharsets.UTF_8));
    request.addHeader("X-Trace", "1");
    FilterChain chain = (req, res) -> {
      req.getInputStream().readAllBytes();
      HttpServletResponse response = (HttpServletResponse) res;
      response.setStatus(201);
      response.setContentType("application/json");
      response.setHeader("X-Out", "1");
      response.getWriter().write(BODY);
    };
    int before = stub.requests().size();
    filter.doFilter(request, new MockHttpServletResponse(), chain);
    client.flushAll();
    assertEquals(before + 1, stub.requests().size());
    return stub.requests().get(stub.requests().size() - 1).body().get("requests").get(0);
  }
}
