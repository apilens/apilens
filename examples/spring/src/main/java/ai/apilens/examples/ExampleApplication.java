package ai.apilens.examples;

import java.util.List;
import java.util.Locale;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * APILens example app: Spring Boot (MVC) + the Java SDK.
 *
 * <p>Same endpoint set as examples/fastapi and examples/express (see {@link ExampleController}).
 * Configuration is environment only:
 *
 * <ul>
 *   <li>{@code EXAMPLE_POSTURE}: off | metadata | redacted | full (default full). {@code off}
 *       leaves the SDK's auto-configuration out (the benchmark baseline); the others are the SDK
 *       capture-profile presets.
 *   <li>{@code APILENS_*}: bound to the {@code apilens.*} properties by Spring's relaxed binding
 *       (APILENS_API_KEY, APILENS_APP_ID, APILENS_BASE_URL, APILENS_ENVIRONMENT,
 *       APILENS_SAMPLE_RATE, APILENS_REDACT_*, APILENS_EXCLUDE_*, ...).
 * </ul>
 */
@SpringBootApplication
public class ExampleApplication {
  static final List<String> POSTURES = List.of("off", "metadata", "redacted", "full");

  public static void main(String[] args) {
    String posture = posture();
    if (posture.equals("off")) {
      System.setProperty(
          "spring.autoconfigure.exclude",
          "ai.apilens.spring.ApiLensAutoConfiguration,"
              + "ai.apilens.spring.ApiLensMetricsAutoConfiguration,"
              + "ai.apilens.spring.ApiLensWebFluxAutoConfiguration");
    } else {
      System.setProperty("apilens.capture-profile", posture);
    }
    SpringApplication.run(ExampleApplication.class, args);
  }

  static String posture() {
    String raw = System.getenv().getOrDefault("EXAMPLE_POSTURE", "");
    String posture = raw.trim().toLowerCase(Locale.ROOT);
    if (posture.isEmpty()) {
      return "full";
    }
    if (!POSTURES.contains(posture)) {
      throw new IllegalArgumentException(
          "EXAMPLE_POSTURE must be one of " + String.join(", ", POSTURES) + ", got " + raw);
    }
    return posture;
  }
}
