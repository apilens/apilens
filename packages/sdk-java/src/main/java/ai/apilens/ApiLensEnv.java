package ai.apilens;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * Reads {@code APILENS_*} environment variables with the same names and value syntax as the
 * Python and TypeScript SDKs. Used by {@link ApiLensConfig#fromEnv()} and
 * {@code ApiLensSpringOptions.fromEnv()}.
 *
 * <ul>
 *   <li>booleans accept {@code 1}/{@code 0}/{@code true}/{@code false} (also
 *       {@code yes}/{@code no}/{@code on}/{@code off}), case-insensitive;
 *   <li>lists are comma-separated, blank entries dropped, so a regex that needs a literal comma
 *       must be passed as a list in code;
 *   <li>durations ({@code APILENS_FLUSH_INTERVAL}, {@code APILENS_TIMEOUT}) are seconds and may
 *       be fractional;
 *   <li>an unset or blank variable is ignored (every accessor returns {@code null}); an
 *       unparseable value throws {@link IllegalArgumentException} naming the variable.
 * </ul>
 */
public final class ApiLensEnv {
  /** Prefix shared by every variable. */
  public static final String PREFIX = "APILENS_";

  private static final Set<String> TRUE = Set.of("1", "true", "yes", "on");
  private static final Set<String> FALSE = Set.of("0", "false", "no", "off");

  private final Function<String, String> env;

  private ApiLensEnv(Function<String, String> env) {
    this.env = env;
  }

  /** The process environment ({@link System#getenv(String)}). */
  public static ApiLensEnv system() {
    return new ApiLensEnv(System::getenv);
  }

  /** A fixed map of variables, e.g. for tests or a config file already read into memory. */
  public static ApiLensEnv of(Map<String, String> variables) {
    Map<String, String> copy = variables == null ? Map.of() : Map.copyOf(variables);
    return new ApiLensEnv(copy::get);
  }

  /** {@code "sample_rate"} or {@code "sample-rate"} to {@code "APILENS_SAMPLE_RATE"}. */
  public static String variable(String option) {
    return PREFIX + option.replace('-', '_').toUpperCase(Locale.ROOT);
  }

  /** The trimmed value, or {@code null} when unset or blank. */
  public String string(String name) {
    String raw = env.apply(name);
    if (raw == null || raw.isBlank()) {
      return null;
    }
    return raw.trim();
  }

  public Boolean bool(String name) {
    String raw = string(name);
    if (raw == null) {
      return null;
    }
    String value = raw.toLowerCase(Locale.ROOT);
    if (TRUE.contains(value)) {
      return Boolean.TRUE;
    }
    if (FALSE.contains(value)) {
      return Boolean.FALSE;
    }
    throw invalid(name, "a boolean (1/0/true/false)", raw);
  }

  public Integer integer(String name) {
    String raw = string(name);
    if (raw == null) {
      return null;
    }
    try {
      return Integer.parseInt(raw);
    } catch (NumberFormatException e) {
      throw invalid(name, "an integer", raw);
    }
  }

  public Long longValue(String name) {
    String raw = string(name);
    if (raw == null) {
      return null;
    }
    try {
      return Long.parseLong(raw);
    } catch (NumberFormatException e) {
      throw invalid(name, "an integer", raw);
    }
  }

  public Double number(String name) {
    String raw = string(name);
    if (raw == null) {
      return null;
    }
    try {
      double value = Double.parseDouble(raw);
      if (Double.isFinite(value)) {
        return value;
      }
    } catch (NumberFormatException e) {
      // fall through
    }
    throw invalid(name, "a finite number", raw);
  }

  /** A duration given in (possibly fractional) seconds. */
  public Duration seconds(String name) {
    Double value = number(name);
    if (value == null) {
      return null;
    }
    return Duration.ofNanos(Math.round(value * 1_000_000_000d));
  }

  public List<String> list(String name) {
    String raw = string(name);
    return raw == null ? null : RequestExcluder.splitPatterns(raw);
  }

  public CaptureProfile captureProfile(String name) {
    String raw = string(name);
    if (raw == null) {
      return null;
    }
    try {
      return CaptureProfile.parse(raw);
    } catch (IllegalArgumentException e) {
      throw invalid(name, "one of metadata/redacted/full", raw);
    }
  }

  private static IllegalArgumentException invalid(String name, String expected, String raw) {
    return new IllegalArgumentException(name + ": expected " + expected + ", got \"" + raw + "\"");
  }
}
