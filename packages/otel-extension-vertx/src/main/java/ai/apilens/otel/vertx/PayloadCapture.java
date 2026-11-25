package ai.apilens.otel.vertx;

import io.netty.buffer.ByteBuf;
import io.netty.handler.codec.http.HttpRequest;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;
import io.vertx.core.MultiMap;
import io.vertx.core.buffer.Buffer;
import io.vertx.core.http.HttpServerRequest;
import io.vertx.core.http.impl.HttpRequestHead;
import io.vertx.core.net.HostAndPort;
import io.vertx.core.net.SocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.regex.Pattern;

/**
 * Helper injected into the application's class loader: the state of one exchange, kept from
 * the request's start until its response ends. Bodies are cut at {@link #MAX_BODY_CHARS}; only
 * text bodies (JSON, XML, forms, plain text) are recorded.
 *
 * <p>HTTP/1.x exchanges annotate the server span of the agent's Netty instrumentation. The agent
 * does not trace HTTP/2 (or HTTP/3) at all, so for those this class starts the server span
 * itself, keeps it current while the request handler runs, and ends it with the response.
 */
public final class PayloadCapture {

  static final int MAX_BODY_CHARS = 65_536;

  /** Static assets are not API traffic: no span for them on HTTP/2 (the agent's HTTP/1 spans stay). */
  private static final Pattern STATIC_ASSET =
      Pattern.compile(
          "(?i).*\\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|html?|txt|wasm)$");

  private static final Tracer TRACER =
      GlobalOpenTelemetry.getTracer("ai.apilens.vertx-http2", "0.4.0");

  /** Keyed by the server response; weak so an exchange that never ends cannot leak. */
  private static final Map<Object, Exchange> EXCHANGES =
      Collections.synchronizedMap(new WeakHashMap<>());

  static final class Exchange {
    final Span span;
    final String requestHeaders;
    final boolean requestText;
    final StringBuilder requestBody = new StringBuilder();
    final StringBuilder responseBody = new StringBuilder();
    /** Whether this class started the span (HTTP/2) and so must end it. */
    final boolean owned;

    Exchange(Span span, String requestHeaders, boolean requestText, boolean owned) {
      this.span = span;
      this.requestHeaders = requestHeaders;
      this.requestText = requestText;
      this.owned = owned;
    }
  }

  static final class HeadersGetter implements TextMapGetter<MultiMap> {
    @Override
    public Iterable<String> keys(MultiMap carrier) {
      return carrier.names();
    }

    @Override
    public String get(MultiMap carrier, String key) {
      return carrier == null ? null : carrier.get(key);
    }
  }

  static final class HeadersSetter implements TextMapSetter<MultiMap> {
    @Override
    public void set(MultiMap carrier, String key, String value) {
      if (carrier != null) {
        carrier.set(key, value);
      }
    }
  }

  private static final HeadersGetter GETTER = new HeadersGetter();
  private static final HeadersSetter SETTER = new HeadersSetter();

  private PayloadCapture() {}

  /** Called as the request starts, while the agent's server span is current. */
  public static void begin(Object response, Object request) {
    if (response == null || !(request instanceof HttpRequest)) {
      return;
    }
    Span span = Span.current();
    if (!span.getSpanContext().isValid() || !span.isRecording()) {
      return;
    }
    HttpRequest req = (HttpRequest) request;
    Map<String, String> headers = new LinkedHashMap<>();
    for (Map.Entry<String, String> h : req.headers()) {
      put(headers, h.getKey(), h.getValue());
    }
    boolean text = textual(req.headers().get("content-type"), true);
    EXCHANGES.put(response, new Exchange(span, json(headers), text, false));
  }

  public static void requestChunk(Object response, Object chunk) {
    Exchange ex = response == null ? null : EXCHANGES.get(response);
    if (ex != null && ex.requestText && chunk instanceof Buffer) {
      append(ex.requestBody, (Buffer) chunk);
    }
  }

  public static void responseChunk(Object response, Object chunk) {
    Exchange ex = EXCHANGES.get(response);
    if (ex != null && chunk instanceof ByteBuf) {
      ByteBuf buf = (ByteBuf) chunk;
      int room = MAX_BODY_CHARS - ex.responseBody.length();
      if (room > 0 && buf.isReadable()) {
        ex.responseBody.append(
            buf.toString(buf.readerIndex(), Math.min(buf.readableBytes(), room), StandardCharsets.UTF_8));
      }
    }
  }

  /** Called as the response ends, before the last write that ends the server span. */
  public static void end(Object response, Object chunk, Object headers) {
    Exchange ex = EXCHANGES.remove(response);
    if (ex == null) {
      return;
    }
    if (chunk instanceof Buffer) {
      append(ex.responseBody, (Buffer) chunk);
    }
    finish(ex, headers);
  }

  /**
   * HTTP/2 request start: starts the server span and returns its scope, which the caller closes
   * once the request handler returns. Null when nothing was started.
   */
  public static Object h2Begin(Object request, Object response, Object head) {
    if (response == null
        || !(head instanceof HttpRequestHead)
        || !(request instanceof HttpServerRequest)) {
      return null;
    }
    HttpRequestHead h = (HttpRequestHead) head;
    String path = h.uri == null ? "/" : h.uri;
    int q = path.indexOf('?');
    if (q >= 0) {
      path = path.substring(0, q);
    }
    if (STATIC_ASSET.matcher(path).matches()) {
      return null;
    }
    String method = h.method == null ? "GET" : h.method.name();
    Context parent =
        GlobalOpenTelemetry.getPropagators()
            .getTextMapPropagator()
            .extract(Context.root(), h.headers, GETTER);
    SpanBuilder b =
        TRACER
            .spanBuilder(method)
            .setSpanKind(SpanKind.SERVER)
            .setParent(parent)
            .setAttribute("http.request.method", method)
            .setAttribute("url.path", path)
            .setAttribute("network.protocol.version", "2");
    if (h.scheme != null) {
      b.setAttribute("url.scheme", h.scheme);
    }
    HostAndPort authority = h.authority;
    if (authority != null) {
      b.setAttribute("server.address", authority.host());
      if (authority.port() > 0) {
        b.setAttribute("server.port", (long) authority.port());
      }
    }
    Map<String, String> headers = new LinkedHashMap<>();
    String contentType = null;
    if (h.headers != null) {
      for (Map.Entry<String, String> e : h.headers) {
        put(headers, e.getKey(), e.getValue());
      }
      contentType = h.headers.get("content-type");
      String ua = h.headers.get("user-agent");
      if (ua != null) {
        b.setAttribute("user_agent.original", ua);
      }
    }
    try {
      SocketAddress remote = ((HttpServerRequest) request).remoteAddress();
      if (remote != null && remote.hostAddress() != null) {
        b.setAttribute("client.address", remote.hostAddress());
      }
    } catch (RuntimeException ignored) {
      // the address is optional
    }
    Span span = b.startSpan();
    EXCHANGES.put(
        response, new Exchange(span, json(headers), textual(contentType, true), true));
    return parent.with(span).makeCurrent();
  }

  /**
   * HTTP/2 request data or end: the request's span current again while Vert.x runs the handlers
   * waiting on the body (a POST's route handler runs only once the body has arrived).
   */
  public static Object h2Resume(Object response) {
    Exchange ex = response == null ? null : EXCHANGES.get(response);
    if (ex == null || !ex.owned) {
      return null;
    }
    return Context.current().with(ex.span).makeCurrent();
  }

  /**
   * An event bus message is sent: the sender's trace goes with it as a traceparent header, so the
   * consumer's work (a query in another verticle, a service proxy call) joins the request's
   * trace. Messages sent outside any trace are left alone.
   */
  public static void busSend(Object sendContext) {
    if (!(sendContext instanceof io.vertx.core.eventbus.impl.SendContext)) {
      return;
    }
    Context current = Context.current();
    if (!Span.fromContext(current).getSpanContext().isValid()) {
      return;
    }
    io.vertx.core.eventbus.impl.MessageImpl<?, ?> message =
        ((io.vertx.core.eventbus.impl.SendContext<?>) sendContext).message;
    if (message != null) {
      GlobalOpenTelemetry.getPropagators().getTextMapPropagator().inject(current, message.headers(), SETTER);
    }
  }

  /** An event bus message is handed to its consumer: the trace it carries is current meanwhile. */
  public static Object busReceive(Object message) {
    if (!(message instanceof io.vertx.core.eventbus.impl.MessageImpl)) {
      return null;
    }
    MultiMap headers = ((io.vertx.core.eventbus.impl.MessageImpl<?, ?>) message).headers();
    if (headers == null || headers.get("traceparent") == null) {
      return null;
    }
    Context ctx =
        GlobalOpenTelemetry.getPropagators().getTextMapPropagator().extract(Context.root(), headers, GETTER);
    if (!Span.fromContext(ctx).getSpanContext().isValid()) {
      return null;
    }
    return ctx.makeCurrent();
  }

  public static void h2Exit(Object scope) {
    if (scope instanceof Scope) {
      ((Scope) scope).close();
    }
  }

  /** HTTP/2 response write; the one with {@code end} set ends the span. */
  public static void h2Write(
      Object response, Object chunk, boolean end, Object headers, Object status) {
    Exchange ex = end ? EXCHANGES.remove(response) : EXCHANGES.get(response);
    if (ex == null) {
      return;
    }
    if (chunk instanceof Buffer) {
      append(ex.responseBody, (Buffer) chunk);
    }
    if (end) {
      finish(ex, headers);
      endOwned(ex, status, false);
    }
  }

  /** HTTP/2 stream closed or reset: ends a span whose response did not end through a write. */
  public static void h2Closed(Object response, boolean ended, Object headers, Object status) {
    Exchange ex = EXCHANGES.remove(response);
    if (ex == null || !ex.owned) {
      return;
    }
    finish(ex, headers);
    endOwned(ex, status, !ended);
  }

  /**
   * An exception the application logged: recorded on the current span (the request's server span,
   * or a span under it) when there is one. Outside a request it is not recorded.
   */
  public static void logged(Object throwable) {
    if (throwable instanceof Throwable) {
      record(Span.current(), (Throwable) throwable);
    }
  }

  /**
   * The application answers a request with an error for this exception: recorded on that
   * request's server span, which may no longer be current when the answer is sent from a callback.
   */
  public static void failed(Object routingContext, Object throwable) {
    if (!(throwable instanceof Throwable)) {
      return;
    }
    Span span = null;
    if (routingContext instanceof io.vertx.ext.web.RoutingContext) {
      Exchange ex = EXCHANGES.get(((io.vertx.ext.web.RoutingContext) routingContext).response());
      if (ex != null) {
        span = ex.span;
      }
    }
    record(span != null ? span : Span.current(), (Throwable) throwable);
  }

  /**
   * Each exception once: a request's handler often logs it and then answers with it. Weak keys,
   * so a recorded exception is not kept alive.
   */
  private static final Map<Throwable, Boolean> RECORDED =
      Collections.synchronizedMap(new WeakHashMap<>());

  private static void record(Span span, Throwable t) {
    if (span == null || !span.getSpanContext().isValid() || !span.isRecording()) {
      return;
    }
    if (RECORDED.put(t, Boolean.TRUE) != null) {
      return;
    }
    span.recordException(t);
  }

  private static void endOwned(Exchange ex, Object status, boolean aborted) {
    if (!ex.owned) {
      return;
    }
    int code = status instanceof HttpResponseStatus ? ((HttpResponseStatus) status).code() : 200;
    ex.span.setAttribute("http.response.status_code", (long) code);
    if (aborted) {
      ex.span.setStatus(StatusCode.ERROR, "stream closed before the response ended");
    } else if (code >= 500) {
      ex.span.setStatus(StatusCode.ERROR);
    }
    ex.span.end();
  }

  private static void finish(Exchange ex, Object headers) {
    Span span = ex.span;
    span.setAttribute("apilens.request.headers", ex.requestHeaders);
    if (ex.requestBody.length() > 0) {
      span.setAttribute("apilens.request.body", ex.requestBody.toString());
    }
    String contentType = null;
    if (headers instanceof MultiMap) {
      MultiMap mm = (MultiMap) headers;
      Map<String, String> out = new LinkedHashMap<>();
      for (Map.Entry<String, String> h : mm) {
        put(out, h.getKey(), h.getValue());
      }
      span.setAttribute("apilens.response.headers", json(out));
      contentType = mm.get("content-type");
    }
    String body = ex.responseBody.toString();
    if (!body.isEmpty() && (textual(contentType, false) || looksLikeJson(body))) {
      span.setAttribute("apilens.response.body", body);
    }
  }

  /** Header names lower-cased; repeated headers joined like HTTP does. */
  private static void put(Map<String, String> m, String name, String value) {
    String key = name.toLowerCase(Locale.ROOT);
    String prev = m.get(key);
    m.put(key, prev == null ? value : prev + ", " + value);
  }

  private static void append(StringBuilder sb, Buffer chunk) {
    int room = MAX_BODY_CHARS - sb.length();
    if (room <= 0 || chunk.length() == 0) {
      return;
    }
    sb.append(chunk.getString(0, Math.min(chunk.length(), room), "UTF-8"));
  }

  /** Text bodies only; an unknown type counts as text for requests (APIs often omit it). */
  static boolean textual(String contentType, boolean unknownIsText) {
    if (contentType == null || contentType.isEmpty()) {
      return unknownIsText;
    }
    String ct = contentType.toLowerCase(Locale.ROOT);
    return ct.contains("json")
        || ct.contains("xml")
        || ct.contains("x-www-form-urlencoded")
        || ct.contains("graphql")
        || ct.startsWith("text/plain");
  }

  static boolean looksLikeJson(String s) {
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (!Character.isWhitespace(c)) {
        return c == '{' || c == '[';
      }
    }
    return false;
  }

  static String json(Map<String, String> m) {
    StringBuilder sb = new StringBuilder("{");
    for (Map.Entry<String, String> e : m.entrySet()) {
      if (sb.length() > 1) {
        sb.append(',');
      }
      quote(sb, e.getKey());
      sb.append(':');
      quote(sb, e.getValue());
    }
    return sb.append('}').toString();
  }

  private static void quote(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"':
          sb.append("\\\"");
          break;
        case '\\':
          sb.append("\\\\");
          break;
        case '\n':
          sb.append("\\n");
          break;
        case '\r':
          sb.append("\\r");
          break;
        case '\t':
          sb.append("\\t");
          break;
        default:
          if (c < 0x20) {
            sb.append(String.format("\\u%04x", (int) c));
          } else {
            sb.append(c);
          }
      }
    }
    sb.append('"');
  }
}
