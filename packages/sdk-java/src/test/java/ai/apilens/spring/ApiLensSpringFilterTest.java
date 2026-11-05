package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.ApiLensConsumers;
import ai.apilens.ApiLensClientTest.IngestServer;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class ApiLensSpringFilterTest {
  private static final String BEST_MATCHING_PATTERN_ATTRIBUTE =
      "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";

  @Test
  void capturesSpringRequestWithTemplatePayloadsHeadersConsumerAndSpan() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
          .apiKey("test")
          .appId("orders-api")
          .baseUrl(server.url() + "/v1")
          .batchSize(10)
          .retryBackoffBase(Duration.ofMillis(1))
          .build());
      client.stop();

      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder()
              .redactQueryParams(List.of("token"))
              .redactBodyFields(List.of("password"))
              .build());

      MockHttpServletRequest request = new MockHttpServletRequest("POST", "/orders/42");
      request.setQueryString("token=secret&keep=1");
      request.setContentType("application/json");
      request.setContent("{\"password\":\"secret\",\"item\":\"book\"}".getBytes(StandardCharsets.UTF_8));
      request.addHeader("Authorization", "Bearer secret");
      request.addHeader("X-Forwarded-For", "1.2.3.4, 5.6.7.8");
      request.addHeader("Host", "api.example.test");
      request.setAttribute(BEST_MATCHING_PATTERN_ATTRIBUTE, "/orders/{id}");
      MockHttpServletResponse response = new MockHttpServletResponse();
      ApiLensConsumers.setConsumer("user-123", "Alice", "enterprise");

      FilterChain chain = (servletRequest, servletResponse) -> {
        servletRequest.getInputStream().readAllBytes();
        var httpResponse = (jakarta.servlet.http.HttpServletResponse) servletResponse;
        httpResponse.setStatus(201);
        httpResponse.setContentType("application/json");
        httpResponse.getWriter().write("{\"ok\":true}");
      };

      filter.doFilter(request, response, chain);
      client.flushAll();

      assertEquals("{\"ok\":true}", response.getContentAsString());
      assertEquals(List.of("/v1/requests", "/v1/traces"), server.paths());
      String requestBody = server.bodies().get(0);
      String spanBody = server.bodies().get(1);

      assertTrue(requestBody.contains("\"path\":\"/orders/{id}\""));
      assertTrue(requestBody.contains("\"raw_path\":\"/orders/42?token=[redacted]&keep=1\""));
      assertTrue(requestBody.contains("\"consumer_id\":\"user-123\""));
      assertTrue(requestBody.contains("\"ip_address\":\"1.2.3.4\""));
      assertTrue(requestBody.contains("\\\"authorization\\\":\\\"[redacted]\\\""));
      assertTrue(requestBody.contains("\"request_payload\":\"{\\\"password\\\":\\\"[redacted]\\\",\\\"item\\\":\\\"book\\\"}\""));
      assertTrue(spanBody.contains("\"name\":\"POST /orders/{id}\""));
      assertTrue(spanBody.contains("\"kind\":\"server\""));

      client.shutdown(false);
    }
  }

  @Test
  void skipsDefaultExcludedPathsAndUserAgentsEntirely() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensSpringFilter filter = new ApiLensSpringFilter(client, ApiLensSpringOptions.builder().build());

      MockHttpServletResponse healthResponse = new MockHttpServletResponse();
      AtomicReference<ServletResponse> seen = new AtomicReference<>();
      filter.doFilter(new MockHttpServletRequest("GET", "/healthz"), healthResponse, (req, res) -> {
        seen.set(res);
        ((HttpServletResponse) res).setStatus(200);
      });
      assertSame(healthResponse, seen.get(), "excluded request must not be wrapped");

      MockHttpServletRequest probe = new MockHttpServletRequest("GET", "/orders");
      probe.addHeader("User-Agent", "kube-probe/1.29");
      filter.doFilter(probe, new MockHttpServletResponse(), okChain());

      filter.doFilter(new MockHttpServletRequest("GET", "/orders"), new MockHttpServletResponse(), okChain());
      client.flushAll();

      assertEquals(1, server.bodies().stream().filter(b -> b.contains("\"raw_path\"")).count());
      String requestBody = server.bodies().get(0);
      assertTrue(requestBody.contains("\"raw_path\":\"/orders\""));
      assertFalse(server.bodies().stream().anyMatch(b -> b.contains("/healthz")));

      client.shutdown(false);
    }
  }

  @Test
  void customExclusionsAndDefaultsOff() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder()
              .excludePaths(List.of("^/internal/"))
              .excludeUserAgents(List.of("uptimerobot"))
              .defaultExclusions(false)
              .captureSpans(false)
              .build());

      filter.doFilter(new MockHttpServletRequest("GET", "/internal/jobs"), new MockHttpServletResponse(), okChain());
      MockHttpServletRequest monitor = new MockHttpServletRequest("GET", "/orders");
      monitor.addHeader("User-Agent", "Mozilla/5.0 (compatible; UptimeRobot/2.0)");
      filter.doFilter(monitor, new MockHttpServletResponse(), okChain());
      filter.doFilter(new MockHttpServletRequest("GET", "/health"), new MockHttpServletResponse(), okChain());
      client.flushAll();

      assertEquals(List.of("/v1/requests"), server.paths());
      String body = server.bodies().get(0);
      assertTrue(body.contains("\"raw_path\":\"/health\""));
      assertFalse(body.contains("/internal/jobs"));
      assertFalse(body.contains("/orders"));

      client.shutdown(false);
    }
  }

  @Test
  void propertiesMapExclusionsToSpringOptions() {
    ApiLensProperties properties = new ApiLensProperties();
    ApiLensSpringOptions defaults = properties.toSpringOptions();
    assertTrue(defaults.defaultExclusions());
    assertEquals(List.of(), defaults.excludePaths());
    assertEquals(List.of(), defaults.excludeUserAgents());

    properties.setExcludePaths(List.of(" ^/internal/ ", ""));
    properties.setExcludeUserAgents(List.of("uptimerobot"));
    properties.setDefaultExclusions(false);
    ApiLensSpringOptions options = properties.toSpringOptions();
    assertFalse(options.defaultExclusions());
    assertEquals(List.of("^/internal/"), options.excludePaths());
    assertEquals(List.of("uptimerobot"), options.excludeUserAgents());
  }

  private static ApiLensClient testClient(IngestServer server) {
    ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(server.url() + "/v1")
        .batchSize(10)
        .retryBackoffBase(Duration.ofMillis(1))
        .build());
    client.stop();
    return client;
  }

  private static FilterChain okChain() {
    return (servletRequest, servletResponse) -> ((HttpServletResponse) servletResponse).setStatus(200);
  }
}
