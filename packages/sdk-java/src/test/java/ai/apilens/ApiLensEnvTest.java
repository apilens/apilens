package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.spring.ApiLensSpringOptions;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ApiLensEnvTest {
  @Test
  void parsesValueSyntaxLikeThePythonSdk() {
    ApiLensEnv env = ApiLensEnv.of(Map.of(
        "APILENS_A", " YES ",
        "APILENS_B", "off",
        "APILENS_N", " 42 ",
        "APILENS_F", "0.25",
        "APILENS_S", "1.5",
        "APILENS_L", "^password$, ,^ssn$",
        "APILENS_BLANK", "   "));
    assertEquals(Boolean.TRUE, env.bool("APILENS_A"));
    assertEquals(Boolean.FALSE, env.bool("APILENS_B"));
    assertEquals(42, env.integer("APILENS_N"));
    assertEquals(0.25, env.number("APILENS_F"));
    assertEquals(Duration.ofMillis(1500), env.seconds("APILENS_S"));
    assertEquals(List.of("^password$", "^ssn$"), env.list("APILENS_L"));
    assertNull(env.string("APILENS_BLANK"));
    assertNull(env.bool("APILENS_MISSING"));
    assertEquals("APILENS_SAMPLE_RATE", ApiLensEnv.variable("sample-rate"));
  }

  @Test
  void unparseableValuesNameTheVariable() {
    ApiLensEnv env = ApiLensEnv.of(Map.of(
        "APILENS_ENABLED", "maybe",
        "APILENS_BATCH_SIZE", "ten",
        "APILENS_SAMPLE_RATE", "NaN",
        "APILENS_CAPTURE_PROFILE", "verbose"));
    assertTrue(assertThrows(IllegalArgumentException.class, () -> env.bool("APILENS_ENABLED"))
        .getMessage().startsWith("APILENS_ENABLED:"));
    assertTrue(assertThrows(IllegalArgumentException.class, () -> env.integer("APILENS_BATCH_SIZE"))
        .getMessage().startsWith("APILENS_BATCH_SIZE:"));
    assertThrows(IllegalArgumentException.class, () -> env.number("APILENS_SAMPLE_RATE"));
    IllegalArgumentException profile = assertThrows(IllegalArgumentException.class,
        () -> ApiLensSpringOptions.fromEnv(Map.of("APILENS_CAPTURE_PROFILE", "verbose")));
    assertTrue(profile.getMessage().startsWith("APILENS_CAPTURE_PROFILE:"));
  }

  @Test
  void configFromEnvReadsClientOptions() {
    ApiLensConfig config = ApiLensConfig.fromEnv(Map.ofEntries(
        Map.entry("APILENS_API_KEY", "apilens_test"),
        Map.entry("APILENS_APP_ID", "orders-api"),
        Map.entry("APILENS_PROJECT_SLUG", "shop"),
        Map.entry("APILENS_BASE_URL", "http://localhost:8080/v1"),
        Map.entry("APILENS_ENVIRONMENT", "Staging"),
        Map.entry("APILENS_ENABLED", "false"),
        Map.entry("APILENS_BATCH_SIZE", "50"),
        Map.entry("APILENS_FLUSH_INTERVAL", "0.5"),
        Map.entry("APILENS_TIMEOUT", "10"),
        Map.entry("APILENS_MAX_QUEUE_SIZE", "500"),
        Map.entry("APILENS_MAX_QUEUE_BYTES", "1048576"),
        Map.entry("APILENS_MAX_BATCH_BYTES", "65536"),
        Map.entry("APILENS_COMPRESS", "0"),
        Map.entry("APILENS_MAX_RETRIES", "1")));
    assertEquals("apilens_test", config.apiKey());
    assertEquals("orders-api", config.appId());
    assertEquals("shop", config.projectSlug());
    assertEquals("http://localhost:8080/v1", config.baseUrl());
    assertEquals("staging", config.environment());
    assertFalse(config.enabled());
    assertEquals(50, config.batchSize());
    assertEquals(Duration.ofMillis(500), config.flushInterval());
    assertEquals(Duration.ofSeconds(10), config.timeout());
    assertEquals(500, config.maxQueueSize());
    assertEquals(1_048_576L, config.maxQueueBytes());
    assertEquals(65_536, config.maxBatchBytes());
    assertFalse(config.compress());
    assertEquals(1, config.maxRetries());
  }

  @Test
  void configPrecedenceIsExplicitThenEnvThenDefault() {
    Map<String, String> env = Map.of("APILENS_APP_ID", "from-env", "APILENS_BATCH_SIZE", "50");
    ApiLensConfig config = ApiLensConfig.builderFromEnv(env).appId("explicit").build();
    assertEquals("explicit", config.appId());
    assertEquals(50, config.batchSize());
    assertEquals(3, config.maxRetries());
    assertEquals("production", ApiLensConfig.fromEnv(Map.of()).environment());
  }

  @Test
  void configFromEnvValidatesLikeTheBuilder() {
    assertThrows(IllegalArgumentException.class,
        () -> ApiLensConfig.fromEnv(Map.of("APILENS_BATCH_SIZE", "5000")));
  }

  @Test
  void springOptionsFromEnvReadCaptureOptions() {
    ApiLensSpringOptions options = ApiLensSpringOptions.fromEnv(Map.ofEntries(
        Map.entry("APILENS_CAPTURE_HEADERS", "false"),
        Map.entry("APILENS_LOG_RESPONSE_BODY", "false"),
        Map.entry("APILENS_MAX_PAYLOAD_BYTES", "2048"),
        Map.entry("APILENS_REDACT_QUERY_PARAMS", "^card$"),
        Map.entry("APILENS_REDACT_HEADERS", "^x-private$,^x-secret$"),
        Map.entry("APILENS_REDACT_BODY_FIELDS", "^iban$"),
        Map.entry("APILENS_DEFAULT_EXCLUSIONS", "false"),
        Map.entry("APILENS_SAMPLE_RATE", "0.1"),
        Map.entry("APILENS_CAPTURE_IP", "false"),
        Map.entry("APILENS_ANONYMIZE_IP", "true"),
        Map.entry("APILENS_CAPTURE_SPANS", "no"),
        Map.entry("APILENS_SERVICE_NAME", "orders")));
    assertFalse(options.captureHeaders());
    assertTrue(options.logRequestBody());
    assertFalse(options.logResponseBody());
    assertEquals(2048, options.maxPayloadBytes());
    assertEquals(List.of("^card$"), options.redactQueryParams());
    assertEquals(List.of("^x-private$", "^x-secret$"), options.redactHeaders());
    assertEquals(List.of("^iban$"), options.redactBodyFields());
    assertFalse(options.defaultExclusions());
    assertEquals(0.1, options.sampleRate());
    assertFalse(options.captureIp());
    assertTrue(options.anonymizeIp());
    assertFalse(options.captureSpans());
    assertEquals("orders", options.serviceName());
  }

  @Test
  void envCaptureProfileOnlyFillsFlagsLeftUnset() {
    Map<String, String> env = Map.of(
        "APILENS_CAPTURE_PROFILE", "metadata",
        "APILENS_LOG_REQUEST_BODY", "true");
    ApiLensSpringOptions options = ApiLensSpringOptions.fromEnv(env);
    assertEquals(CaptureProfile.METADATA, options.captureProfile());
    assertTrue(options.logRequestBody());
    assertFalse(options.logResponseBody());
    assertFalse(options.captureHeaders());

    ApiLensSpringOptions explicit = ApiLensSpringOptions.builderFromEnv(env)
        .captureProfile(CaptureProfile.REDACTED)
        .logRequestBody(false)
        .build();
    assertFalse(explicit.logRequestBody());
    assertTrue(explicit.logResponseBody());
    assertEquals(CaptureProfile.REDACTED_MAX_PAYLOAD_BYTES, explicit.maxPayloadBytes());
  }

  @Test
  void excludeUserAgentsFromEnvAreAddedToTheCodePatterns() {
    RequestExcluder excluder = new RequestExcluder(
        List.of(), List.of("uptimerobot"), false, name -> switch (name) {
          case RequestExcluder.ENV_EXCLUDE_USER_AGENTS -> "pingdom, ,statuscake";
          default -> null;
        });
    assertEquals(3, excluder.userAgentPatterns().size());
    assertTrue(excluder.matchesUserAgent("Pingdom.com_bot"));
    assertTrue(excluder.matchesUserAgent("UptimeRobot/2.0"));
  }
}
