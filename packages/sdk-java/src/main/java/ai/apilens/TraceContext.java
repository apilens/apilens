package ai.apilens;

import ai.apilens.internal.Strings;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
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
  // Child spans (outbound HTTP calls) finished while the request's sampling verdict is pending.
  // The server filter releases them once it knows whether the request is kept.
  private final Object childLock = new Object();
  private List<SpanRecord> heldChildSpans = new ArrayList<>();
  private Consumer<SpanRecord> childSink;
  private boolean childrenReleased;

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

  /** A fresh random 16-hex-char span id, for a child span of this trace. */
  public static String newSpanId() {
    return randomHex(8);
  }

  /**
   * Records a finished child span of this request. Until the server filter calls {@link
   * #releaseChildSpans}, the span is held, because a request's spans are kept or dropped with it
   * (a sampled-out request that fails is still kept, D1). A span finishing after the release
   * follows the verdict.
   */
  public void recordChildSpan(SpanRecord span) {
    if (span == null || traceId.isEmpty()) {
      return;
    }
    Consumer<SpanRecord> sink;
    synchronized (childLock) {
      if (!childrenReleased) {
        heldChildSpans.add(span);
        return;
      }
      sink = childSink;
    }
    if (sink != null) {
      sink.accept(span);
    }
  }

  /**
   * Sends the held child spans to {@code sink} when {@code keep}, or discards them. Spans recorded
   * afterwards follow the same verdict. Only the first call has an effect.
   */
  public void releaseChildSpans(boolean keep, Consumer<SpanRecord> sink) {
    List<SpanRecord> held;
    synchronized (childLock) {
      if (childrenReleased) {
        return;
      }
      childrenReleased = true;
      childSink = keep ? sink : null;
      held = heldChildSpans;
      heldChildSpans = List.of();
    }
    if (keep && sink != null) {
      held.forEach(sink);
    }
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
