package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensClientTest.IngestServer;
import ai.apilens.ApiLensConfig;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.MapPropertySource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockServletContext;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.servlet.HandlerExceptionResolver;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

/** Exceptions an {@code @ExceptionHandler} / {@code @ControllerAdvice} turns into a response. */
class HandledExceptionCaptureTest {

  @Test
  void mvcAdviceReturning500ShipsTheFullStackAndIsNeverSampled() throws Exception {
    try (IngestServer ingest = IngestServer.start();
        AnnotationConfigWebApplicationContext context = mvcContext(ingest)) {
      MockMvc mvc = MockMvcBuilders.webAppContextSetup(context)
          .addFilters(context.getBean(ApiLensSpringFilter.class))
          .build();

      MockHttpServletResponse response = mvc.perform(get("/charge")).andReturn().getResponse();
      assertEquals(500, response.getStatus());
      assertEquals("payment failed", response.getContentAsString(), "the advice still renders the response");
      ApiLensClient client = context.getBean(ApiLensClient.class);
      client.flushAll();

      assertEquals(List.of("/v1/requests", "/v1/traces", "/v1/logs"), ingest.paths(),
          "kept at sampleRate 0: record, span and exception log");
      assertTrue(ingest.bodies().get(0).contains("\"sampled\":true"), ingest.bodies().get(0));
      assertTrue(ingest.bodies().get(0).contains("\"status_code\":500"), ingest.bodies().get(0));
      String log = ingest.bodies().get(2);
      assertTrue(log.contains("\"level\":\"ERROR\""), log);
      assertTrue(log.contains("\"logger_name\":\"apilens.exception\""), log);
      assertTrue(log.contains("\"message\":\"java.lang.IllegalStateException: payment gateway down\""), log);
      assertTrue(log.contains("Caused by: java.io.IOException: socket reset"), log);
      assertTrue(log.contains("\"exception.chain_depth\":\"2\""), log);
      assertTrue(log.contains("at ai.apilens.spring.HandledExceptionCaptureTest$MvcController.charge"), log);
      assertFalse(log.contains("HTTP 500 on"), "the stack, not a bare status line");
    }
  }

  @Test
  void mvcAdviceReturning400ShipsAWarnLogWithTheStack() throws Exception {
    try (IngestServer ingest = IngestServer.start();
        AnnotationConfigWebApplicationContext context = mvcContext(ingest)) {
      MockMvc mvc = MockMvcBuilders.webAppContextSetup(context)
          .addFilters(context.getBean(ApiLensSpringFilter.class))
          .build();

      assertEquals(400, mvc.perform(get("/validate")).andReturn().getResponse().getStatus());
      assertEquals(200, mvc.perform(get("/ok")).andReturn().getResponse().getStatus());
      ApiLensClient client = context.getBean(ApiLensClient.class);
      client.flushAll();

      String requests = ingest.bodies().get(ingest.paths().indexOf("/v1/requests"));
      assertTrue(requests.contains("\"status_code\":400"), requests);
      assertEquals(1, count(requests, "\"sampled\":true"), "the handled 400 is kept, the 200 sampled out");
      List<String> logs = bodiesFor(ingest, "/v1/logs");
      assertEquals(1, logs.size(), logs.toString());
      String log = logs.get(0);
      assertTrue(log.contains("\"level\":\"WARN\""), log);
      assertTrue(log.contains("\"logger_name\":\"apilens.exception\""), log);
      assertTrue(log.contains("\"status_code\":400"), log);
      assertTrue(log.contains("java.lang.IllegalArgumentException: quantity must be positive"), log);
      assertTrue(log.contains("at ai.apilens.spring.HandledExceptionCaptureTest$MvcController.validate"), log);
      String spans = ingest.bodies().get(ingest.paths().indexOf("/v1/traces"));
      assertFalse(spans.contains("\"status\":\"error\""), "a handled 4xx is not an error span: " + spans);
    }
  }

  @Test
  void resolverIsRegisteredFirstAndChangesNothing() throws Exception {
    try (IngestServer ingest = IngestServer.start();
        AnnotationConfigWebApplicationContext context = mvcContext(ingest)) {
      ApiLensHandlerExceptionResolver resolver = context.getBean(ApiLensHandlerExceptionResolver.class);
      assertEquals(Integer.MIN_VALUE, resolver.getOrder());
      assertTrue(context.getBeansOfType(HandlerExceptionResolver.class).containsValue(resolver));
    }
  }

  @Test
  void webFluxAdviceRecordingTheExceptionShipsErrorAndWarnLogsWithTheStack() throws Exception {
    try (IngestServer ingest = IngestServer.start()) {
      ApiLensClient client = testClient(ingest);
      ApiLensWebFilter filter = new ApiLensWebFilter(client, ApiLensSpringOptions.builder().sampleRate(0.0).build());
      WebTestClient http = WebTestClient.bindToController(new FluxController())
          .controllerAdvice(new FluxAdvice())
          .webFilter(filter)
          .build();

      http.get().uri("/charge").exchange().expectStatus().isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR)
          .expectBody(String.class).isEqualTo("payment failed");
      http.get().uri("/validate").exchange().expectStatus().isBadRequest();
      http.get().uri("/ok").exchange().expectStatus().isOk();
      client.flushAll();

      List<String> logs = bodiesFor(ingest, "/v1/logs");
      String all = String.join("\n", logs);
      assertEquals(2, count(all, "\"logger_name\":\"apilens.exception\""), all);
      String error = logs.stream().filter(log -> log.contains("payment gateway down")).findFirst().orElseThrow();
      assertTrue(error.contains("\"level\":\"ERROR\""), error);
      assertTrue(error.contains("\"status_code\":500"), error);
      assertTrue(error.contains("Caused by: java.io.IOException: socket reset"), error);
      assertTrue(error.contains("at ai.apilens.spring.HandledExceptionCaptureTest$FluxController.charge"), error);
      String warn = logs.stream().filter(log -> log.contains("quantity must be positive")).findFirst().orElseThrow();
      assertTrue(warn.contains("\"level\":\"WARN\""), warn);
      assertTrue(warn.contains("\"status_code\":400"), warn);
      assertTrue(warn.contains("at ai.apilens.spring.HandledExceptionCaptureTest$FluxController.validate"), warn);
      String requests = String.join("\n", bodiesFor(ingest, "/v1/requests"));
      assertEquals(2, count(requests, "\"sampled\":true"), "both handled exceptions are kept: " + requests);
      assertEquals(1, count(requests, "\"sampled\":false"), "the 200 is sampled out: " + requests);
      client.shutdown(false);
    }
  }

  private static AnnotationConfigWebApplicationContext mvcContext(IngestServer ingest) {
    AnnotationConfigWebApplicationContext context = new AnnotationConfigWebApplicationContext();
    context.setServletContext(new MockServletContext());
    context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.of(
        "apilens.api-key", "test-key",
        "apilens.app-id", "orders-api",
        "apilens.base-url", ingest.url() + "/v1",
        "apilens.flush-interval", "1h",
        "apilens.send-heartbeat", "false",
        "apilens.send-metadata", "false",
        "apilens.sample-rate", "0")));
    context.register(MvcConfig.class, MvcController.class, MvcAdvice.class,
        ApiLensAutoConfiguration.class, ApiLensWebMvcAutoConfiguration.class);
    context.refresh();
    return context;
  }

  private static List<String> bodiesFor(IngestServer ingest, String path) {
    List<String> paths = ingest.paths();
    List<String> bodies = ingest.bodies();
    return java.util.stream.IntStream.range(0, paths.size())
        .filter(i -> paths.get(i).equals(path))
        .mapToObj(bodies::get)
        .toList();
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

  private static IllegalStateException gatewayDown() {
    return new IllegalStateException("payment gateway down", new IOException("socket reset"));
  }

  @Configuration(proxyBeanMethods = false)
  @EnableWebMvc
  static class MvcConfig {
  }

  @RestController
  static class MvcController {
    @GetMapping("/charge")
    String charge() {
      throw gatewayDown();
    }

    @GetMapping("/validate")
    String validate() {
      throw new IllegalArgumentException("quantity must be positive");
    }

    @GetMapping("/ok")
    String ok() {
      return "ok";
    }
  }

  @RestControllerAdvice
  static class MvcAdvice {
    @ExceptionHandler(IllegalStateException.class)
    ResponseEntity<String> failed(IllegalStateException ex) {
      return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("payment failed");
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ResponseEntity<String> invalid(IllegalArgumentException ex) {
      return ResponseEntity.badRequest().body(ex.getMessage());
    }
  }

  @RestController
  static class FluxController {
    @GetMapping("/charge")
    String charge() {
      throw gatewayDown();
    }

    @GetMapping("/validate")
    String validate() {
      throw new IllegalArgumentException("quantity must be positive");
    }

    @GetMapping("/ok")
    String ok() {
      return "ok";
    }
  }

  @RestControllerAdvice
  static class FluxAdvice {
    @ExceptionHandler(IllegalStateException.class)
    ResponseEntity<String> failed(IllegalStateException ex, ServerWebExchange exchange) {
      ApiLensWebFilter.recordException(exchange, ex);
      return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("payment failed");
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ResponseEntity<String> invalid(IllegalArgumentException ex, ServerWebExchange exchange) {
      ApiLensWebFilter.recordException(exchange, ex);
      return ResponseEntity.badRequest().body(ex.getMessage());
    }
  }
}
