package ai.apilens.http;

import ai.apilens.ApiLensClient;
import ai.apilens.SpanRecord;
import ai.apilens.TraceContext;
import ai.apilens.internal.Strings;
import java.net.URI;
import java.time.Instant;
import java.util.Locale;

/**
 * Turns outbound HTTP calls made while a request is being captured into child {@code http} spans
 * of that request's server span, and gives each call the {@code traceparent} header to send
 * downstream. Shared by the RestTemplate/RestClient interceptor, the WebClient filter and the
 * {@code java.net.http.HttpClient} wrapper.
 *
 * <p>A call made outside a captured request (no current trace) is passed through untouched, and
 * so are the SDK's own uploads to the API Lens base URL. Spans carry the same attributes and caps
 * as the Python SDK: {@code http.method} and {@code http.url} (query string and userinfo
 * stripped), the response status, and status {@code error} when the call threw or answered 5xx.
 */
public final class ApiLensHttpTracing {
  static final int MAX_NAME_CHARS = 256;
  static final int MAX_URL_CHARS = 512;

  private final ApiLensClient client;
  private final String environment;
  private final String serviceName;
  private final boolean enabled;

  public ApiLensHttpTracing(ApiLensClient client, String environment, String serviceName, boolean enabled) {
    this.client = client;
    this.environment = Strings.clean(environment);
    this.serviceName = Strings.clean(serviceName);
    this.enabled = enabled && client != null;
  }

  /** Tracing with the client's environment and app id as the service name. */
  public static ApiLensHttpTracing of(ApiLensClient client) {
    return new ApiLensHttpTracing(client, "", "", true);
  }

  /**
   * Starts a child span for a call to {@code uri} under {@code trace}, or returns {@code null}
   * when the call is not traced (no current request, tracing off, or the SDK's own ingest).
   */
  public OutboundSpan start(TraceContext trace, String method, URI uri) {
    if (!enabled || trace == null || Strings.isBlank(trace.traceId()) || Strings.isBlank(trace.spanId())
        || uri == null) {
      return null;
    }
    String url = stripUrl(uri);
    if (isOwnIngest(url)) {
      return null;
    }
    return new OutboundSpan(trace, Strings.firstNonBlank(method, "GET").toUpperCase(Locale.ROOT), url);
  }

  /** Same as {@link #start(TraceContext, String, URI)} under the current thread's trace. */
  public OutboundSpan start(String method, URI uri) {
    return start(TraceContext.current(), method, uri);
  }

  private boolean isOwnIngest(String url) {
    String base = Strings.clean(client.config().baseUrl());
    return !base.isEmpty() && url.startsWith(base);
  }

  /** The URL without query string, fragment or userinfo, so span data never carries secrets. */
  static String stripUrl(URI uri) {
    StringBuilder out = new StringBuilder();
    if (uri.getScheme() != null) {
      out.append(uri.getScheme()).append("://");
    }
    if (uri.getHost() != null) {
      out.append(uri.getHost());
      if (uri.getPort() >= 0) {
        out.append(':').append(uri.getPort());
      }
    }
    if (uri.getRawPath() != null) {
      out.append(uri.getRawPath());
    }
    String text = out.toString();
    return text.length() > MAX_URL_CHARS ? text.substring(0, MAX_URL_CHARS) : text;
  }

  /** One in-flight outbound call. {@link #end} records it; only the first call counts. */
  public final class OutboundSpan {
    private final TraceContext trace;
    private final String method;
    private final String url;
    private final String spanId = TraceContext.newSpanId();
    private final Instant startedAt = Instant.now();
    private final long startedNanos = System.nanoTime();
    private boolean ended;

    private OutboundSpan(TraceContext trace, String method, String url) {
      this.trace = trace;
      this.method = method;
      this.url = url;
    }

    public String spanId() {
      return spanId;
    }

    /** The W3C header that makes the downstream service's span a child of this one. */
    public String traceparent() {
      return "00-" + trace.traceId() + "-" + spanId + "-01";
    }

    /** Records the span: {@code statusCode} 0 when no response arrived, {@code error} when it threw. */
    public void end(int statusCode, Throwable error) {
      synchronized (this) {
        if (ended) {
          return;
        }
        ended = true;
      }
      double elapsedMs = Math.max((System.nanoTime() - startedNanos) / 1_000_000.0, 0.0);
      String name = method + " " + url;
      if (name.length() > MAX_NAME_CHARS) {
        name = name.substring(0, MAX_NAME_CHARS);
      }
      trace.recordChildSpan(SpanRecord.builder()
          .timestamp(startedAt)
          .environment(Strings.firstNonBlank(environment, client.config().environment()))
          .traceId(trace.traceId())
          .spanId(spanId)
          .parentSpanId(trace.spanId())
          .name(name)
          .kind("http")
          .serviceName(Strings.firstNonBlank(serviceName, client.config().appId()))
          .durationMs(elapsedMs)
          .status(error != null || statusCode >= 500 ? "error" : "ok")
          .statusCode(Math.max(statusCode, 0))
          .projectSlug(client.config().projectSlug())
          .appId(client.config().appId())
          .attribute("http.url", url)
          .attribute("http.method", method)
          .build());
    }
  }
}
