package ai.apilens;

import ai.apilens.internal.Strings;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Current request trace identifiers. */
public final class TraceContext {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final Pattern TRACEPARENT =
      Pattern.compile("^[\\da-fA-F]{2}-([\\da-fA-F]{32})-([\\da-fA-F]{16})-[\\da-fA-F]{2}(?:-.*)?$");
  private static final ThreadLocal<TraceContext> CURRENT = new ThreadLocal<>();

  private final String traceId;
  private final String spanId;
  private final String parentSpanId;

  private TraceContext(String traceId, String spanId, String parentSpanId) {
    this.traceId = traceId;
    this.spanId = spanId;
    this.parentSpanId = parentSpanId;
  }

  public static TraceContext begin(String traceparent) {
    Matcher matcher = TRACEPARENT.matcher(Strings.clean(traceparent));
    if (matcher.matches()) {
      return new TraceContext(
          matcher.group(1).toLowerCase(Locale.ROOT),
          randomHex(8),
          matcher.group(2).toLowerCase(Locale.ROOT));
    }
    return new TraceContext(randomHex(16), randomHex(8), "");
  }

  public static TraceContext current() {
    TraceContext value = CURRENT.get();
    return value == null ? new TraceContext("", "", "") : value;
  }

  public Scope makeCurrent() {
    TraceContext previous = CURRENT.get();
    CURRENT.set(this);
    return new Scope(previous);
  }

  public String traceId() {
    return traceId;
  }

  public String spanId() {
    return spanId;
  }

  public String parentSpanId() {
    return parentSpanId;
  }

  public String traceparent() {
    if (traceId.isEmpty() || spanId.isEmpty()) {
      return "";
    }
    return "00-" + traceId + "-" + spanId + "-01";
  }

  public static String currentTraceId() {
    return current().traceId();
  }

  public static String currentSpanId() {
    return current().spanId();
  }

  public static String currentTraceparent() {
    return current().traceparent();
  }

  private static String randomHex(int bytes) {
    byte[] data = new byte[bytes];
    String value;
    do {
      RANDOM.nextBytes(data);
      StringBuilder out = new StringBuilder(bytes * 2);
      for (byte b : data) {
        out.append(String.format("%02x", b));
      }
      value = out.toString();
    } while (value.chars().allMatch(ch -> ch == '0'));
    return value;
  }

  public static final class Scope implements AutoCloseable {
    private final TraceContext previous;
    private boolean closed;

    private Scope(TraceContext previous) {
      this.previous = previous;
    }

    @Override
    public void close() {
      if (closed) {
        return;
      }
      closed = true;
      if (previous == null) {
        CURRENT.remove();
      } else {
        CURRENT.set(previous);
      }
    }
  }
}
