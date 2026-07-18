package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.ApiLensConsumers;
import ai.apilens.ApiLensClientTest.IngestServer;
import jakarta.servlet.FilterChain;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
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
}
