package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import ai.apilens.logging.ApiLensLog4j2Appender;
import ai.apilens.logging.ApiLensLogbackAppender;
import ch.qos.logback.classic.LoggerContext;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;

class ApiLensLoggingAutoConfigurationTest {
  @Test
  void attachesTheAppendersByDefaultAndDetachesThemOnClose() {
    try (AnnotationConfigApplicationContext context = context(Map.of())) {
      assertEquals(1, context.getBeansOfType(ApiLensLogbackAppender.class).size());
      assertEquals(1, context.getBeansOfType(ApiLensLog4j2Appender.class).size());
      assertNotNull(rootLogback().getAppender(ApiLensLogbackAppender.NAME));
    }
    assertNull(rootLogback().getAppender(ApiLensLogbackAppender.NAME));
  }

  @Test
  void captureLogsOffAttachesNothing() {
    for (String off : new String[] {"off", "false"}) {
      try (AnnotationConfigApplicationContext context = context(Map.of("apilens.capture-logs", off))) {
        assertEquals(0, context.getBeansOfType(ApiLensLogbackAppender.class).size());
        assertEquals(0, context.getBeansOfType(ApiLensLog4j2Appender.class).size());
        assertNull(rootLogback().getAppender(ApiLensLogbackAppender.NAME));
      }
    }
  }

  @Test
  void needsAClient() {
    Map<String, Object> noKey = new HashMap<>(baseProperties());
    noKey.remove("apilens.api-key");
    try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
      context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", noKey));
      context.register(Config.class);
      context.refresh();
      assertEquals(0, context.getBeansOfType(ApiLensLogbackAppender.class).size());
    }
  }

  private static ch.qos.logback.classic.Logger rootLogback() {
    return ((LoggerContext) LoggerFactory.getILoggerFactory()).getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
  }

  private static Map<String, Object> baseProperties() {
    return Map.of(
        "apilens.api-key", "test-key",
        "apilens.app-id", "orders-api",
        "apilens.base-url", "http://127.0.0.1:9/v1",
        "apilens.send-heartbeat", "false",
        "apilens.send-metadata", "false");
  }

  private static AnnotationConfigApplicationContext context(Map<String, Object> extra) {
    Map<String, Object> properties = new HashMap<>(baseProperties());
    properties.putAll(extra);
    AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext();
    context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", properties));
    context.register(Config.class);
    context.refresh();
    return context;
  }

  @ImportAutoConfiguration({ApiLensAutoConfiguration.class, ApiLensLoggingAutoConfiguration.class})
  static class Config {}
}
