package ai.apilens;

import ai.apilens.internal.Strings;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/** Endpoint grouping helpers shared by framework integrations. */
public final class PathTemplates {
  private static final Pattern INT = Pattern.compile("^\\d+$");
  private static final Pattern UUID =
      Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
  private static final Pattern ULID = Pattern.compile("^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$");
  private static final Pattern HEX = Pattern.compile("^[0-9a-fA-F]{24,}$");
  private static final Pattern MIXED_ID = Pattern.compile("^(?=[A-Za-z0-9._~-]*\\d)[A-Za-z0-9._~-]{16,}$");

  private PathTemplates() {}

  public static String resolveEndpointPath(String frameworkTemplate, String rawPath, boolean parametrizePaths) {
    if (!Strings.isBlank(frameworkTemplate)) {
      return Strings.normalizePath(frameworkTemplate);
    }
    String normalized = Strings.normalizePath(rawPath);
    if (!parametrizePaths || !parametrizeEnabled()) {
      return normalized;
    }
    return parametrizePath(normalized);
  }

  public static String parametrizePath(String path) {
    String normalized = Strings.normalizePath(path);
    if ("/".equals(normalized)) {
      return normalized;
    }
    String[] parts = normalized.split("/", -1);
    for (int i = 0; i < parts.length; i += 1) {
      String placeholder = placeholder(parts[i]).orElse(null);
      if (placeholder != null) {
        parts[i] = placeholder;
      }
    }
    return String.join("/", parts);
  }

  public static boolean parametrizeEnabled() {
    String raw = System.getenv("APILENS_PARAMETRIZE_PATHS");
    if (raw == null) {
      return true;
    }
    String value = raw.trim().toLowerCase(Locale.ROOT);
    return !value.equals("0") && !value.equals("false") && !value.equals("no") && !value.equals("off");
  }

  private static Optional<String> placeholder(String segment) {
    if (Strings.isBlank(segment)) {
      return Optional.empty();
    }
    if (INT.matcher(segment).matches()) {
      return Optional.of("{id}");
    }
    if (UUID.matcher(segment).matches()) {
      return Optional.of("{uuid}");
    }
    if (ULID.matcher(segment).matches()) {
      return Optional.of("{id}");
    }
    if (HEX.matcher(segment).matches()) {
      return Optional.of("{hash}");
    }
    if (MIXED_ID.matcher(segment).matches()) {
      return Optional.of("{id}");
    }
    return Optional.empty();
  }
}
