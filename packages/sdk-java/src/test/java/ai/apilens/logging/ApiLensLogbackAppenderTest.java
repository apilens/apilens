package ai.apilens.logging;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensClientTest.IngestServer;
import ai.apilens.ApiLensConfig;
import ai.apilens.TraceContext;
import ai.apilens.spring.ApiLensSpringFilter;
import ai.apilens.spring.ApiLensSpringOptions;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class ApiLensLogbackAppenderTest {
  @Test
  void shipsAnErrorWithAThrowableAsAFullExceptionLogOnTheCurrentTrace() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      LoggerContext context = new LoggerContext();
      ApiLensLogbackAppender appender = new ApiLensLogbackAppender(client);
      appender.attachTo(context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME));
      Logger logger = context.getLogger("com.example.Orders");

      TraceContext trace = TraceContext.begin("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
      try (TraceContext.Scope ignored = trace.makeCurrent()) {
        IllegalStateException root = new IllegalStateException("db down");
        logger.error("charge {} failed", 42, new RuntimeException("charge failed", root));
      }
      client.flushAll();

      assertEquals(List.of("/v1/logs"), server.paths());
      String body = server.bodies().get(0);
      assertTrue(body.contains("\"logger_name\":\"apilens.exception\""), body);
      assertTrue(body.contains("\"level\":\"ERROR\""), body);
      assertTrue(body.contains("\"message\":\"java.lang.RuntimeException: charge failed\""), body);
      assertTrue(body.contains("\"trace_id\":\"0123456789abcdef0123456789abcdef\""), body);
      assertTrue(body.contains("\"span_id\":\"" + trace.spanId() + "\""), body);
      assertTrue(body.contains("Caused by: java.lang.IllegalStateException: db down"), body);
      assertTrue(body.contains("\"exception.type\":\"java.lang.RuntimeException\""), body);
      assertTrue(body.contains("\"exception.chain_depth\":\"2\""), body);
      assertTrue(body.contains("\"log.logger\":\"com.example.Orders\""), body);
      assertTrue(body.contains("\"log.message\":\"charge 42 failed\""), body);

      appender.detach();
      client.shutdown(false);
    }
  }

  @Test
  void ignoresEventsWithoutAThrowableBelowErrorAndFromTheSdk() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      LoggerContext context = new LoggerContext();
      ApiLensLogbackAppender appender = new ApiLensLogbackAppender(client);
      appender.attachTo(context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME));

      context.getLogger("com.example.Orders").error("no throwable");
      context.getLogger("com.example.Orders").warn("only a warning", new RuntimeException("warn"));
      context.getLogger("ai.apilens.ApiLensClient").error("delivery failed", new RuntimeException("x"));
      client.flushAll();
      assertEquals(List.of(), server.paths());

      appender.detach();
      context.getLogger("com.example.Orders").error("after detach", new RuntimeException("x"));
      client.flushAll();
      assertEquals(List.of(), server.paths());
      client.shutdown(false);
    }
  }

  @Test
  void attachesTheTraceIdOfTheRequestTheFilterIsHandling() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = testClient(server);
      LoggerContext context = new LoggerContext();
      ApiLensLogbackAppender appender = new ApiLensLogbackAppender(client);
      appender.attachTo(context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME));
      Logger logger = context.getLogger("com.example.Orders");
      ApiLensSpringFilter filter = new ApiLensSpringFilter(client, ApiLensSpringOptions.builder().build());

      // A handled exception: logged, then answered with 200, so only the appender reports it.
      FilterChain chain = (req, res) -> {
        logger.error("handled", new IllegalArgumentException("bad input"));
        ((HttpServletResponse) res).setStatus(200);
      };
      filter.doFilter(new MockHttpServletRequest("GET", "/orders/1"), new MockHttpServletResponse(), chain);
      client.flushAll();

      String requestTrace = traceId(server, "/v1/requests");
      String logTrace = traceId(server, "/v1/logs");
      assertEquals(32, requestTrace.length());
      assertEquals(requestTrace, logTrace);
      String logs = server.bodies().get(server.paths().indexOf("/v1/logs"));
      assertTrue(logs.contains("\"exception.type\":\"java.lang.IllegalArgumentException\""), logs);

      appender.detach();
      client.shutdown(false);
    }
  }

  static String traceId(IngestServer server, String path) {
    int index = server.paths().indexOf(path);
    assertTrue(index >= 0, "no " + path + " in " + server.paths());
    Matcher matcher = Pattern.compile("\"trace_id\":\"([0-9a-f]*)\"").matcher(server.bodies().get(index));
    assertTrue(matcher.find(), server.bodies().get(index));
    return matcher.group(1);
  }

  static ApiLensClient testClient(IngestServer server) {
    ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(server.url() + "/v1")
        .batchSize(10)
        .sendHeartbeat(false)
        .retryBackoffBase(Duration.ofMillis(1))
        .build());
    client.stop();
    return client;
  }
}
