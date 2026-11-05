package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.ApiLensConsumers;
import ai.apilens.ApiLensClientTest.IngestServer;
import ai.apilens.RequestInfo;
import ai.apilens.ResponseInfo;
import ai.apilens.SampleDecision;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
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

  @Test
  void maskCallbacksRunBeforeRegexMaskingWithRequestAndResponseInfo() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      AtomicReference<RequestInfo> seenRequest = new AtomicReference<>();
      AtomicReference<ResponseInfo> seenResponse = new AtomicReference<>();
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder()
              .captureSpans(false)
              .redactQueryParams(List.of("token"))
              .redactBodyFields(List.of("password"))
              .maskRequestBody((info, body) -> {
                seenRequest.set(info);
                return new String(body, StandardCharsets.UTF_8)
                    .replace("4111111111111111", "****")
                    .getBytes(StandardCharsets.UTF_8);
              })
              .maskResponseBody((info, body) -> {
                seenResponse.set(info);
                return null;
              })
              .build());

      MockHttpServletRequest request = new MockHttpServletRequest("POST", "/pay");
      request.setQueryString("token=abc");
      request.setContentType("application/json");
      request.addHeader("X-Tenant", "acme");
      request.setContent("{\"card\":\"4111111111111111\",\"password\":\"pw\"}".getBytes(StandardCharsets.UTF_8));
      filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> {
        req.getInputStream().readAllBytes();
        HttpServletResponse http = (HttpServletResponse) res;
        http.setStatus(402);
        http.setContentType("application/json");
        http.getWriter().write("{\"secret\":\"response\"}");
      });
      client.flushAll();

      String body = server.bodies().get(0);
      assertTrue(body.contains("\"request_payload\":\"{\\\"card\\\":\\\"****\\\",\\\"password\\\":\\\"[redacted]\\\"}\""), body);
      assertTrue(body.contains("\"response_payload\":\"[masked]\""), body);
      assertFalse(body.contains("4111111111111111"));
      assertFalse(body.contains("response\\\"}"));

      assertEquals("POST", seenRequest.get().method());
      assertEquals("/pay", seenRequest.get().path());
      assertEquals("/pay?token=[redacted]", seenRequest.get().rawPath());
      assertEquals("acme", seenRequest.get().headers().get("x-tenant"));
      assertEquals("application/json", seenRequest.get().contentType());
      assertEquals(402, seenResponse.get().statusCode());
      assertTrue(seenResponse.get().contentType().startsWith("application/json"));
      assertEquals(seenRequest.get(), seenResponse.get().request());

      client.shutdown(false);
    }
  }

  @Test
  void throwingMaskCallbackStoresMaskedNotRawBody() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder()
              .captureSpans(false)
              .maskRequestBody((info, body) -> {
                throw new IllegalStateException("mask bug");
              })
              .build());

      MockHttpServletRequest request = new MockHttpServletRequest("POST", "/notes");
      request.setContentType("text/plain");
      request.setContent("raw-secret-note".getBytes(StandardCharsets.UTF_8));
      MockHttpServletResponse response = new MockHttpServletResponse();
      filter.doFilter(request, response, (req, res) -> {
        req.getInputStream().readAllBytes();
        ((HttpServletResponse) res).setStatus(204);
      });
      client.flushAll();

      assertEquals(204, response.getStatus(), "a failing callback never breaks the request");
      String body = server.bodies().get(0);
      assertTrue(body.contains("\"request_payload\":\"[masked]\""), body);
      assertFalse(body.contains("raw-secret-note"));

      client.shutdown(false);
    }
  }

  @Test
  void capturesOnlyJsonTextAndFormBodies() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      AtomicInteger callbacks = new AtomicInteger();
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder()
              .captureSpans(false)
              .redactBodyFields(List.of("password"))
              .maskResponseBody((info, body) -> {
                callbacks.incrementAndGet();
                return body;
              })
              .build());

      MockHttpServletRequest form = new MockHttpServletRequest("POST", "/login");
      form.setContentType("application/x-www-form-urlencoded");
      form.setContent("user=alice&password=hunter2".getBytes(StandardCharsets.UTF_8));
      filter.doFilter(form, new MockHttpServletResponse(), (req, res) -> {
        req.getInputStream().readAllBytes();
        HttpServletResponse http = (HttpServletResponse) res;
        http.setContentType("image/png");
        http.getOutputStream().write(new byte[] {(byte) 0x89, 'P', 'N', 'G'});
      });

      MockHttpServletRequest upload = new MockHttpServletRequest("POST", "/upload");
      upload.setContentType("multipart/form-data; boundary=xyz");
      upload.setContent("--xyz\r\nbinary\r\n--xyz--".getBytes(StandardCharsets.UTF_8));
      filter.doFilter(upload, new MockHttpServletResponse(), okChain());
      client.flushAll();

      String body = server.bodies().get(0);
      assertTrue(body.contains("\"request_payload\":\"user=alice&password=[redacted]\""), body);
      assertTrue(body.contains("\"response_payload\":\"[image/png, 4 bytes omitted]\""), body);
      assertTrue(body.contains("\"request_payload\":\"[multipart/form-data, 22 bytes omitted]\""), body);
      assertFalse(body.contains("hunter2"));
      assertFalse(body.contains("binary"));
      assertEquals(0, callbacks.get(), "callbacks never see non-captured content types");

      client.shutdown(false);
    }
  }

  @Test
  void optionsCustomizerBeansSetCallbacksPropertiesCannotExpress() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      StaticListableBeanFactory beans = new StaticListableBeanFactory();
      ApiLensSpringOptionsCustomizer customizer =
          options -> options.maskRequestBody((info, body) -> "{\"replaced\":true}".getBytes(StandardCharsets.UTF_8));
      beans.addBean("bodyMasking", customizer);
      ApiLensProperties properties = new ApiLensProperties();
      properties.setCaptureSpans(false);

      ApiLensSpringFilter filter = new ApiLensAutoConfiguration().apiLensSpringFilter(
          client,
          properties,
          beans.getBeanProvider(ApiLensConsumerResolver.class),
          beans.getBeanProvider(ApiLensSpringOptionsCustomizer.class));

      MockHttpServletRequest request = new MockHttpServletRequest("POST", "/orders");
      request.setContentType("application/json");
      request.setContent("{\"original\":true}".getBytes(StandardCharsets.UTF_8));
      filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> req.getInputStream().readAllBytes());
      client.flushAll();

      String body = server.bodies().get(0);
      assertTrue(body.contains("\"request_payload\":\"{\\\"replaced\\\":true}\""), body);
      assertFalse(body.contains("original"));

      client.shutdown(false);
    }
  }

  @Test
  void sampledOutRequestSendsOnlyTheBaseRecordAndSkipsBodyBuffering() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client, ApiLensSpringOptions.builder().sampleRate(0.0).build());

      MockHttpServletRequest request = new MockHttpServletRequest("POST", "/orders/42");
      request.setContentType("application/json");
      request.setContent("{\"item\":\"book\"}".getBytes(StandardCharsets.UTF_8));
      request.addHeader("Authorization", "Bearer secret");
      request.addHeader("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
      request.setAttribute(BEST_MATCHING_PATTERN_ATTRIBUTE, "/orders/{id}");
      AtomicReference<Object> seenRequest = new AtomicReference<>();
      AtomicReference<String> seenTrace = new AtomicReference<>();
      MockHttpServletResponse response = new MockHttpServletResponse();
      filter.doFilter(request, response, (req, res) -> {
        seenRequest.set(req);
        seenTrace.set(ai.apilens.TraceContext.currentTraceId());
        req.getInputStream().readAllBytes();
        HttpServletResponse http = (HttpServletResponse) res;
        http.setStatus(500);
        http.setContentType("application/json");
        http.getWriter().write("{\"error\":true}");
      });
      client.flushAll();

      assertSame(request, seenRequest.get(), "a sampled-out request body must not be buffered");
      assertEquals("0af7651916cd43dd8448eb211c80319c", seenTrace.get(), "trace context still propagates");
      assertEquals("{\"error\":true}", response.getContentAsString());
      assertEquals(List.of("/v1/requests"), server.paths(), "no span and no error log");
      String body = server.bodies().get(0);
      assertTrue(body.contains("\"sampled\":false"), body);
      assertTrue(body.contains("\"path\":\"/orders/{id}\""));
      assertTrue(body.contains("\"status_code\":500"));
      assertTrue(body.contains("\"request_size\":15"));
      assertTrue(body.contains("\"response_size\":14"));
      assertTrue(body.contains("\"request_payload\":\"\""));
      assertTrue(body.contains("\"response_payload\":\"\""));
      assertTrue(body.contains("\"request_headers\":\"\""));
      assertTrue(body.contains("\"response_headers\":\"\""));
      assertTrue(body.contains("\"trace_id\":\"0af7651916cd43dd8448eb211c80319c\""));

      client.shutdown(false);
    }
  }

  @Test
  void sampleRateOneKeepsFullDetail() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client, ApiLensSpringOptions.builder().sampleRate(1.0).build());

      MockHttpServletRequest request = new MockHttpServletRequest("POST", "/orders");
      request.setContentType("application/json");
      request.setContent("{\"item\":\"book\"}".getBytes(StandardCharsets.UTF_8));
      filter.doFilter(request, new MockHttpServletResponse(), (req, res) -> {
        req.getInputStream().readAllBytes();
        ((HttpServletResponse) res).setStatus(500);
      });
      client.flushAll();

      assertEquals(List.of("/v1/requests", "/v1/traces", "/v1/logs"), server.paths());
      String body = server.bodies().get(0);
      assertTrue(body.contains("\"sampled\":true"), body);
      assertTrue(body.contains("\"request_payload\":\"{\\\"item\\\":\\\"book\\\"}\""), body);

      client.shutdown(false);
    }
  }

  @Test
  void sampleOnResponseKeepsOnlyErrors() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      AtomicReference<ai.apilens.SampleResponseInfo> seen = new AtomicReference<>();
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder()
              .sampleRate(0.0)
              .captureSpans(false)
              .sampleOnResponse(info -> {
                seen.set(info);
                return SampleDecision.of(info.statusCode() >= 500);
              })
              .build());

      MockHttpServletRequest ok = new MockHttpServletRequest("GET", "/orders/1");
      ok.setAttribute(BEST_MATCHING_PATTERN_ATTRIBUTE, "/orders/{id}");
      ok.addHeader("X-Tenant", "acme");
      filter.doFilter(ok, new MockHttpServletResponse(), okChain());
      assertEquals("/orders/{id}", seen.get().route());
      assertEquals(200, seen.get().statusCode());
      assertEquals("acme", seen.get().request().headers().get("x-tenant"));
      assertEquals(SampleDecision.UNDECIDED, seen.get().requestDecision());

      filter.doFilter(new MockHttpServletRequest("GET", "/orders/2"), new MockHttpServletResponse(),
          (req, res) -> ((HttpServletResponse) res).setStatus(503));
      client.flushAll();

      String body = server.bodies().get(0);
      assertTrue(body.contains("\"raw_path\":\"/orders/1\""));
      assertTrue(body.contains("\"raw_path\":\"/orders/2\""));
      assertEquals(1, count(body, "\"sampled\":false"), body);
      assertEquals(1, count(body, "\"sampled\":true"), body);
      assertTrue(body.indexOf("\"sampled\":false") < body.indexOf("/orders/2"), "the 200 is dropped");

      client.shutdown(false);
    }
  }

  @Test
  void sampleOnRequestDropIsFinalAndThrowingCallbacksAreUndecided() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      AtomicInteger responseCalls = new AtomicInteger();
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder()
              .captureSpans(false)
              .sampleOnRequest(info -> {
                if (info.path().startsWith("/internal")) {
                  return SampleDecision.DROP;
                }
                throw new IllegalStateException("boom");
              })
              .sampleOnResponse(info -> {
                responseCalls.incrementAndGet();
                if (info.statusCode() == 201) {
                  throw new IllegalStateException("boom");
                }
                return SampleDecision.KEEP;
              })
              .build());

      filter.doFilter(new MockHttpServletRequest("GET", "/internal/jobs"), new MockHttpServletResponse(),
          (req, res) -> ((HttpServletResponse) res).setStatus(500));
      MockHttpServletResponse created = new MockHttpServletResponse();
      filter.doFilter(new MockHttpServletRequest("POST", "/orders"), created,
          (req, res) -> ((HttpServletResponse) res).setStatus(201));
      client.flushAll();

      assertEquals(201, created.getStatus(), "callback exceptions never reach the handler");
      assertEquals(1, responseCalls.get(), "a request dropped on request is not offered to sampleOnResponse");
      String body = server.bodies().get(0);
      assertTrue(body.indexOf("\"sampled\":false") < body.indexOf("\"raw_path\":\"/orders\""), body);
      assertEquals(1, count(body, "\"sampled\":false"), body);
      assertEquals(1, count(body, "\"sampled\":true"), body);

      client.shutdown(false);
    }
  }

  @Test
  void sampleRateUsesTheRandomSourcePerRequest() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      double[] rolls = {0.1, 0.6, 0.2, 0.9};
      AtomicInteger next = new AtomicInteger();
      ApiLensSpringFilter filter = new ApiLensSpringFilter(
          client,
          ApiLensSpringOptions.builder().sampleRate(0.5).captureSpans(false).build(),
          null,
          () -> rolls[next.getAndIncrement()]);
      for (int i = 0; i < rolls.length; i++) {
        filter.doFilter(new MockHttpServletRequest("GET", "/r" + i), new MockHttpServletResponse(), okChain());
      }
      client.flushAll();

      String body = server.bodies().get(0);
      assertEquals(2, count(body, "\"sampled\":true"), body);
      assertEquals(2, count(body, "\"sampled\":false"), body);

      client.shutdown(false);
    }
  }

  @Test
  void propertiesMapSampleRateAndBuilderValidatesIt() {
    ApiLensProperties properties = new ApiLensProperties();
    assertEquals(1.0, properties.toSpringOptions().sampleRate());
    properties.setSampleRate(0.25);
    assertEquals(0.25, properties.toSpringOptions().sampleRate());
    assertEquals(0.25, properties.toSpringOptions().toBuilder().build().sampleRate());
    properties.setSampleRate(1.5);
    assertThrows(IllegalArgumentException.class, properties::toSpringOptions);
    assertThrows(IllegalArgumentException.class, () -> ApiLensSpringOptions.builder().sampleRate(-0.1));
  }

  private static int count(String haystack, String needle) {
    int count = 0;
    for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
      count++;
    }
    return count;
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
