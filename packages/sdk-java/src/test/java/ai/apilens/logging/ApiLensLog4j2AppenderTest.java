package ai.apilens.logging;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensClientTest.IngestServer;
import ai.apilens.TraceContext;
import java.util.List;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.config.DefaultConfiguration;
import org.junit.jupiter.api.Test;

class ApiLensLog4j2AppenderTest {
  @Test
  void shipsAnErrorWithAThrowableAsAFullExceptionLogOnTheCurrentTrace() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = ApiLensLogbackAppenderTest.testClient(server);
      LoggerContext context = new LoggerContext("apilens-log4j2-test");
      context.start(new DefaultConfiguration());
      ApiLensLog4j2Appender appender = new ApiLensLog4j2Appender(client);
      appender.attachTo(context);
      Logger logger = context.getLogger("com.example.Orders");

      TraceContext trace = TraceContext.begin("00-fedcba9876543210fedcba9876543210-0123456789abcdef-01");
      try (TraceContext.Scope ignored = trace.makeCurrent()) {
        RuntimeException failure = new RuntimeException("charge failed", new IllegalStateException("db down"));
        failure.addSuppressed(new IllegalArgumentException("cleanup failed"));
        logger.error("charge {} failed", 42, failure);
      }
      client.flushAll();

      assertEquals(List.of("/v1/logs"), server.paths());
      String body = server.bodies().get(0);
      assertTrue(body.contains("\"logger_name\":\"apilens.exception\""), body);
      assertTrue(body.contains("\"message\":\"java.lang.RuntimeException: charge failed\""), body);
      assertTrue(body.contains("\"trace_id\":\"fedcba9876543210fedcba9876543210\""), body);
      assertTrue(body.contains("\"span_id\":\"" + trace.spanId() + "\""), body);
      assertTrue(body.contains("Caused by: java.lang.IllegalStateException: db down"), body);
      assertTrue(body.contains("Suppressed: java.lang.IllegalArgumentException: cleanup failed"), body);
      assertTrue(body.contains("\"log.logger\":\"com.example.Orders\""), body);
      assertTrue(body.contains("\"log.message\":\"charge 42 failed\""), body);

      appender.detach();
      context.stop();
      client.shutdown(false);
    }
  }

  @Test
  void ignoresEventsWithoutAThrowableBelowErrorAndAfterDetach() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = ApiLensLogbackAppenderTest.testClient(server);
      LoggerContext context = new LoggerContext("apilens-log4j2-ignore");
      context.start(new DefaultConfiguration());
      ApiLensLog4j2Appender appender = new ApiLensLog4j2Appender(client);
      appender.attachTo(context);
      Logger logger = context.getLogger("com.example.Orders");

      logger.error("no throwable");
      logger.warn("only a warning", new RuntimeException("warn"));
      context.getLogger("ai.apilens.ApiLensClient").error("delivery failed", new RuntimeException("x"));
      client.flushAll();
      assertEquals(List.of(), server.paths());

      appender.detach();
      logger.error("after detach", new RuntimeException("x"));
      client.flushAll();
      assertEquals(List.of(), server.paths());
      context.stop();
      client.shutdown(false);
    }
  }

  @Test
  void staysAttachedWhenLog4j2Reconfigures() throws Exception {
    try (IngestServer server = IngestServer.start()) {
      ApiLensClient client = ApiLensLogbackAppenderTest.testClient(server);
      LoggerContext context = new LoggerContext("apilens-log4j2-reconfigure");
      context.start(new DefaultConfiguration());
      ApiLensLog4j2Appender appender = new ApiLensLog4j2Appender(client);
      appender.attachTo(context);

      context.setConfiguration(new DefaultConfiguration());
      assertTrue(appender.isStarted(), "the reload must not stop the appender");
      assertTrue(context.getConfiguration().getRootLogger().getAppenders().containsKey(ApiLensLog4j2Appender.NAME));
      context.getLogger("com.example.Orders").error("after reload", new RuntimeException("boom"));
      client.flushAll();
      assertEquals(List.of("/v1/logs"), server.paths());
      assertTrue(server.bodies().get(0).contains("java.lang.RuntimeException: boom"));

      appender.detach();
      context.stop();
      client.shutdown(false);
    }
  }
}
