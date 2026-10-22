package ai.apilens.internal;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

public final class Wire {
  private static final DateTimeFormatter ISO_UTC = DateTimeFormatter.ISO_INSTANT.withZone(ZoneOffset.UTC);

  private Wire() {}

  public static String isoUtc(Instant instant) {
    return ISO_UTC.format(instant == null ? Instant.now() : instant);
  }

  public static Map<String, Object> map() {
    return new LinkedHashMap<>();
  }
}
