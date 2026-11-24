package ai.apilens.otel.vertx;

import io.netty.buffer.ByteBuf;
import io.netty.handler.codec.http.HttpRequest;
import io.opentelemetry.api.trace.Span;
import io.vertx.core.MultiMap;
import io.vertx.core.buffer.Buffer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Helper injected into the application's class loader: the state of one exchange, kept from
 * the request's start until its response ends. Bodies are cut at {@link #MAX_BODY_CHARS}; only
 * text bodies (JSON, XML, forms, plain text) are recorded.
 */
public final class PayloadCapture {

  static final int MAX_BODY_CHARS = 65_536;

  /** Keyed by the Http1ServerResponse; weak so an exchange that never ends cannot leak. */
  private static final Map<Object, Exchange> EXCHANGES =
      Collections.synchronizedMap(new WeakHashMap<>());

  static final class Exchange {
    final Span span;
    final String requestHeaders;
    final boolean requestText;
    final StringBuilder requestBody = new StringBuilder();
    final StringBuilder responseBody = new StringBuilder();

    Exchange(Span span, String requestHeaders, boolean requestText) {
      this.span = span;
      this.requestHeaders = requestHeaders;
      this.requestText = requestText;
    }
  }

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
    EXCHANGES.put(response, new Exchange(span, json(headers), text));
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
