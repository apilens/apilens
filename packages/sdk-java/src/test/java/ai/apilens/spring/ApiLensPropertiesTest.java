package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensConfig;
import ai.apilens.CaptureProfile;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

class ApiLensPropertiesTest {
  private static ApiLensProperties bind(Map<String, String> values) {
    Binder binder = new Binder(new MapConfigurationPropertySource(values));
    return binder.bindOrCreate("apilens", ApiLensProperties.class);
  }

  @Test
  void appIdPropertyStillWinsAndIsFreeForm() {
    ApiLensProperties properties = bind(Map.of(
        "apilens.api-key", "apilens_test",
        "apilens.app-id", "Orders API"));
    ApiLensConfig config = properties.toClientConfig();
    assertEquals("Orders API", config.appId());
  }

  @Test
  void bindsEveryNewProperty() {
    ApiLensProperties properties = bind(Map.ofEntries(
        Map.entry("apilens.api-key", "apilens_test"),
        Map.entry("apilens.capture-profile", "redacted"),
        Map.entry("apilens.sample-rate", "0.5"),
        Map.entry("apilens.redact-headers", "^x-a$,^x-b$"),
        Map.entry("apilens.redact-query-params[0]", "^card$"),
        Map.entry("apilens.redact-body-fields[0]", "^iban$"),
        Map.entry("apilens.exclude-paths", "^/internal/"),
        Map.entry("apilens.exclude-user-agents[0]", "uptimerobot"),
        Map.entry("apilens.max-queue-bytes", "1048576"),
        Map.entry("apilens.max-batch-bytes", "65536"),
        Map.entry("apilens.compress", "false"),
        Map.entry("apilens.capture-ip", "false"),
        Map.entry("apilens.anonymize-ip", "true")));

    assertEquals(CaptureProfile.REDACTED, properties.getCaptureProfile());
    ApiLensConfig config = properties.toClientConfig();
    assertEquals(1_048_576L, config.maxQueueBytes());
    assertEquals(65_536, config.maxBatchBytes());
    assertFalse(config.compress());

    ApiLensSpringOptions options = properties.toSpringOptions();
    assertEquals(CaptureProfile.REDACTED, options.captureProfile());
    assertEquals(CaptureProfile.REDACTED_MAX_PAYLOAD_BYTES, options.maxPayloadBytes());
    assertTrue(options.captureHeaders());
    assertEquals(0.5, options.sampleRate());
    assertEquals(List.of("^x-a$", "^x-b$"), options.redactHeaders());
    assertEquals(List.of("^card$"), options.redactQueryParams());
    assertEquals(List.of("^iban$"), options.redactBodyFields());
    assertEquals(List.of("^/internal/"), options.excludePaths());
    assertEquals(List.of("uptimerobot"), options.excludeUserAgents());
    assertFalse(options.captureIp());
    assertTrue(options.anonymizeIp());
  }

  @Test
  void defaultsMatchTheClientAndOptionsDefaults() {
    ApiLensProperties properties = new ApiLensProperties();
    ApiLensConfig config = properties.toClientConfig();
    ApiLensConfig defaults = ApiLensConfig.builder().build();
    assertEquals(defaults.maxQueueBytes(), config.maxQueueBytes());
    assertEquals(defaults.maxBatchBytes(), config.maxBatchBytes());
    assertEquals(defaults.compress(), config.compress());

    ApiLensSpringOptions options = properties.toSpringOptions();
    assertEquals(null, options.captureProfile());
    assertTrue(options.captureHeaders());
    assertTrue(options.logRequestBody());
    assertTrue(options.logResponseBody());
    assertEquals(ApiLensSpringOptions.DEFAULT_MAX_PAYLOAD_BYTES, options.maxPayloadBytes());
  }

  @Test
  void explicitPropertiesWinOverTheCaptureProfile() {
    ApiLensSpringOptions options = bind(Map.of(
        "apilens.capture-profile", "METADATA",
        "apilens.log-request-body", "true")).toSpringOptions();
    assertTrue(options.logRequestBody());
    assertFalse(options.logResponseBody());
    assertFalse(options.captureHeaders());
  }

  @Test
  void customizerCanSetTheProfileOnTopOfProperties() {
    ApiLensSpringOptions.Builder builder = new ApiLensProperties().toSpringOptions().toBuilder();
    ApiLensSpringOptionsCustomizer customizer = options -> options.captureProfile(CaptureProfile.METADATA);
    customizer.customize(builder);
    ApiLensSpringOptions options = builder.build();
    assertFalse(options.captureHeaders());
    assertFalse(options.logRequestBody());
  }

  @Test
  void configurationMetadataIsGeneratedForIdeCompletion() throws Exception {
    try (InputStream in = getClass().getClassLoader()
        .getResourceAsStream("META-INF/spring-configuration-metadata.json")) {
      assertNotNull(in, "spring-boot-configuration-processor did not run");
      String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
      for (String name : List.of(
          "apilens.capture-profile",
          "apilens.sample-rate",
          "apilens.redact-query-params",
          "apilens.redact-headers",
          "apilens.redact-body-fields",
          "apilens.exclude-paths",
          "apilens.exclude-user-agents",
          "apilens.max-queue-bytes",
          "apilens.max-batch-bytes",
          "apilens.compress",
          "apilens.capture-ip",
          "apilens.anonymize-ip")) {
        assertTrue(json.contains("\"name\": \"" + name + "\""), name);
      }
    }
  }
}
