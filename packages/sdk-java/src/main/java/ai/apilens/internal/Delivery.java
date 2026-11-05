package ai.apilens.internal;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.regex.Pattern;
import java.util.zip.GZIPOutputStream;

/** Retry classification, Retry-After parsing, backoff and gzip for ingest delivery. */
public final class Delivery {
  /** A server-sent Retry-After is honoured up to this long. */
  public static final Duration RETRY_AFTER_MAX = Duration.ofSeconds(60);
  /** gzip level for ingest bodies: a good size/CPU trade-off for JSON batches. */
  public static final int GZIP_LEVEL = 5;

  private static final Pattern DELTA_SECONDS = Pattern.compile("\\d+(\\.\\d+)?");

  private Delivery() {}

  /** 408, 429 and 5xx are worth retrying; any other 4xx cannot succeed. */
  public static boolean isRetryableStatus(int status) {
    return status == 408 || status == 429 || status >= 500;
  }

  /**
   * Delay from a {@code Retry-After} header (delta-seconds or HTTP-date), clamped to
   * {@code [0, 60s]}. {@code null} when the header is missing or unparseable.
   */
  public static Duration parseRetryAfter(String value, Instant now) {
    String raw = Strings.clean(value);
    if (raw.isEmpty()) {
      return null;
    }
    long millis;
    if (DELTA_SECONDS.matcher(raw).matches()) {
      millis = (long) (Double.parseDouble(raw) * 1000);
    } else {
      try {
        Instant at = ZonedDateTime.parse(raw, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant();
        millis = at.toEpochMilli() - now.toEpochMilli();
      } catch (DateTimeParseException ex) {
        return null;
      }
    }
    return Duration.ofMillis(Math.max(0, Math.min(millis, RETRY_AFTER_MAX.toMillis())));
  }

  /**
   * Full-jitter exponential backoff: {@code random * min(max, base * 2^attempt)}, so clients
   * that failed together do not retry in lockstep. {@code random} is in {@code [0, 1)}.
   */
  public static Duration backoff(int attempt, Duration base, Duration max, double random) {
    long baseMs = Math.max(base.toMillis(), 1);
    long maxMs = Math.max(max.toMillis(), 1);
    long factor = 1L << Math.min(Math.max(attempt, 0), 30);
    long ceiling = baseMs > maxMs / factor ? maxMs : Math.min(baseMs * factor, maxMs);
    double unit = Math.min(Math.max(random, 0.0), 1.0);
    return Duration.ofMillis((long) Math.floor(unit * ceiling));
  }

  /** gzip {@code body} at {@link #GZIP_LEVEL}. */
  public static byte[] gzip(byte[] body) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(body.length / 4, 64));
    try (GZIPOutputStream gz = new LeveledGzip(out, GZIP_LEVEL)) {
      gz.write(body);
    }
    return out.toByteArray();
  }

  private static final class LeveledGzip extends GZIPOutputStream {
    LeveledGzip(ByteArrayOutputStream out, int level) throws IOException {
      super(out);
      def.setLevel(level);
    }
  }
}
