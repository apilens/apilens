package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensClientTest.IngestServer;
import ai.apilens.ApiLensConfig;
import ai.apilens.TraceContext;
import ai.apilens.http.ApiLensClientHttpRequestInterceptor;
import ai.apilens.http.ApiLensHttpClient;
import ai.apilens.http.ApiLensHttpTracing;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.web.client.RestClientCustomizer;
import org.springframework.boot.web.client.RestTemplateCustomizer;
import org.springframework.boot.web.reactive.function.client.WebClientCustomizer;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.MapPropertySource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.client.RestTemplate;

class OutboundHttpSpringTest {
  private static final ObjectMapper JSON = new ObjectMapper();

  @Test
  void outboundSpanIsParentedToTheServerSpanOnTheWire() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
          .apiKey("test")
          .appId("orders-api")
          .baseUrl(server.url() + "/v1")
          .batchSize(10)
          .sendHeartbeat(false)
          .sendMetadata(false)
          .retryBackoffBase(Duration.ofMillis(1))
          .build());
      client.stop();
      ApiLensSpringOptions options = ApiLensSpringOptions.builder().build();
      ApiLensSpringFilter filter = new ApiLensSpringFilter(client, options);
      RestTemplate restTemplate = new RestTemplate();
      restTemplate.getInterceptors().add(new ApiLensClientHttpRequestInterceptor(
          new ApiLensHttpTracing(client, options.environment(), options.serviceName(), options.captureSpans())));

      MockHttpServletRequest request = new MockHttpServletRequest("GET", "/checkout");
      FilterChain chain = (req, res) -> {
        // The ingest server doubles as the downstream service; any non-ingest path will do.
        restTemplate.getForEntity(server.url() + "/downstream/pay", String.class);
        ((jakarta.servlet.http.HttpServletResponse) res).setStatus(200);
      };
      filter.doFilter(request, new MockHttpServletResponse(), chain);
      client.flushAll();

      List<JsonNode> spans = new ArrayList<>();
      for (int i = 0; i < server.paths().size(); i++) {
        if (server.paths().get(i).equals("/v1/traces")) {
          JsonNode body = JSON.readTree(server.bodies().get(i));
          (body.isArray() ? body : body.path("spans")).forEach(spans::add);
        }
      }
      JsonNode serverSpan = spans.stream().filter(s -> s.path("kind").asText().equals("server")).findFirst()
          .orElseThrow();
      JsonNode httpSpan = spans.stream().filter(s -> s.path("kind").asText().equals("http")).findFirst()
          .orElseThrow();
      assertEquals(serverSpan.path("trace_id").asText(), httpSpan.path("trace_id").asText());
      assertEquals(serverSpan.path("span_id").asText(), httpSpan.path("parent_span_id").asText());
      assertEquals("GET " + server.url() + "/downstream/pay", httpSpan.path("name").asText());
      assertEquals(200, httpSpan.path("status_code").asInt());
    }
  }

  @Test
  void autoConfigurationInstrumentsBuildersAndWrapsHttpClientBeans() {
    try (AnnotationConfigApplicationContext context = context(Map.of())) {
      ApiLensHttpTracing tracing = context.getBean(ApiLensHttpTracing.class);
      assertEquals(1, context.getBeansOfType(RestTemplateCustomizer.class).size());
      assertEquals(1, context.getBeansOfType(RestClientCustomizer.class).size());
      assertEquals(1, context.getBeansOfType(WebClientCustomizer.class).size());
      assertInstanceOf(ApiLensHttpClient.class, context.getBean(HttpClient.class));

      RestTemplate restTemplate = new RestTemplate();
      context.getBean(RestTemplateCustomizer.class).customize(restTemplate);
      assertInstanceOf(ApiLensClientHttpRequestInterceptor.class, restTemplate.getInterceptors().get(0));
      assertNotNull(tracing.start(TraceContext.begin(""), "GET", URI.create("http://example.com/x")));
    }
  }

  @Test
  void captureSpansOffPassesCallsThrough() {
    try (AnnotationConfigApplicationContext context = context(Map.of("apilens.capture-spans", "false"))) {
      ApiLensHttpTracing tracing = context.getBean(ApiLensHttpTracing.class);
      assertNull(tracing.start(TraceContext.begin(""), "GET", URI.create("http://example.com/x")));
    }
  }

  @Test
  void needsAClient() {
    try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
      context.register(Config.class);
      context.refresh();
      assertTrue(context.getBeansOfType(ApiLensHttpTracing.class).isEmpty());
      // The HttpClient bean is left as is.
      assertTrue(!(context.getBean(HttpClient.class) instanceof ApiLensHttpClient));
    }
  }

  private static AnnotationConfigApplicationContext context(Map<String, Object> extra) {
    Map<String, Object> properties = new HashMap<>(Map.of(
        "apilens.api-key", "test-key",
        "apilens.app-id", "orders-api",
        "apilens.base-url", "http://127.0.0.1:9/v1",
        "apilens.send-heartbeat", "false",
        "apilens.send-metadata", "false"));
    properties.putAll(extra);
    AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext();
    context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", properties));
    context.register(Config.class);
    context.refresh();
    return context;
  }

  @ImportAutoConfiguration({ApiLensAutoConfiguration.class, ApiLensHttpClientAutoConfiguration.class})
  static class Config {
    @Bean
    HttpClient httpClient() {
      return HttpClient.newHttpClient();
    }
  }
}
