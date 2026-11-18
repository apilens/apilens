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

  /**
   * Caps {@code value} at {@code maxChars}, keeping the head and the tail with a
   * {@code "\n…[N chars truncated]…\n"} marker in the middle (D4, the same marker ingest uses), so
   * the raised exception and its root cause at the end both survive. N counts the dropped chars,
   * and the result, marker included, never exceeds {@code maxChars}. Surrogate pairs are never
   * split. When the cap cannot hold the marker it falls back to a head-only cut.
   */
  public static String truncateHeadTail(String value, int maxChars) {
    if (value == null || value.length() <= maxChars) {
      return value == null ? "" : value;
    }
    int total = value.length();
    // The marker only shrinks as the dropped count shrinks, so sizing it for the whole string
    // first keeps the result within the cap.
    int keep = maxChars - headTailMarker(total).length();
    if (keep <= 0) {
      return truncate(value, maxChars);
    }
    int tail = keep / 2;
    int head = keep - tail;
    if (head > 0 && Character.isHighSurrogate(value.charAt(head - 1))) {
      head--;
    }
    int tailStart = total - tail;
    if (tailStart < total && Character.isLowSurrogate(value.charAt(tailStart))) {
      tailStart++;
    }
    return value.substring(0, head) + headTailMarker(tailStart - head) + value.substring(tailStart);
  }

  private static String headTailMarker(int dropped) {
    return "\n…[" + dropped + " chars truncated]…\n";
  }

  public static int utf8Length(String value) {
    return value == null ? 0 : value.getBytes(StandardCharsets.UTF_8).length;
  }
}
