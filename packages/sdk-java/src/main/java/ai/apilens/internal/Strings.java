package ai.apilens.internal;

import java.nio.charset.StandardCharsets;

public final class Strings {
  private Strings() {}

  public static boolean isBlank(String value) {
    return value == null || value.trim().isEmpty();
  }

  public static String clean(String value) {
    return value == null ? "" : value.trim();
  }

  public static String firstNonBlank(String first, String second) {
    return isBlank(first) ? clean(second) : clean(first);
  }

  public static String firstNonBlank(String first, String second, String third) {
    return firstNonBlank(firstNonBlank(first, second), third);
  }

  public static String normalizePath(String value) {
    String path = clean(value);
    if (path.isEmpty()) {
      return "/";
    }
    int queryIndex = path.indexOf('?');
    if (queryIndex >= 0) {
      path = path.substring(0, queryIndex);
    }
    return path.startsWith("/") ? path : "/" + path;
  }

  public static String truncate(String value, int maxChars) {
    if (value == null || value.length() <= maxChars) {
      return value == null ? "" : value;
    }
    return value.substring(0, Math.max(maxChars, 0));
  }

  public static int utf8Length(String value) {
    return value == null ? 0 : value.getBytes(StandardCharsets.UTF_8).length;
  }
}
