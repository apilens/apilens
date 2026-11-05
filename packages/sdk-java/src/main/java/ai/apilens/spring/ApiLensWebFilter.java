package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConsumer;
import ai.apilens.IpPrivacy;
import ai.apilens.LogRecord;
import ai.apilens.PathTemplates;
import ai.apilens.Redactor;
import ai.apilens.RemotePolicy;
import ai.apilens.RequestExcluder;
import ai.apilens.RequestInfo;
import ai.apilens.RequestRecord;
import ai.apilens.ResponseInfo;
import ai.apilens.SampleResponseInfo;
import ai.apilens.Sampler;
import ai.apilens.SpanRecord;
import ai.apilens.TraceContext;
import ai.apilens.internal.Strings;
import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;
import java.util.function.DoubleSupplier;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.reactivestreams.Publisher;
import org.springframework.core.Ordered;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpRequestDecorator;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.springframework.web.util.pattern.PathPattern;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SignalType;

/**
 * Spring WebFlux filter for automatic request, span, and error-log capture; the reactive
 * counterpart of {@link ApiLensSpringFilter}, with the same {@link ApiLensSpringOptions}.
 *
 * <p>Bodies are captured by decorating the request and response {@link DataBuffer} streams:
 * each buffer is copied (up to {@code maxPayloadBytes}) as it passes, without consuming it, so
 * nothing is buffered beyond the cap. The endpoint is grouped by the matched route template
 * ({@link HandlerMapping#BEST_MATCHING_PATTERN_ATTRIBUTE}), which both annotated controllers and
 * router functions set.
 *
 * <p>Thread-locals do not follow a reactive request, so the consumer is set on the exchange
 * ({@link #setConsumer(ServerWebExchange, ApiLensConsumer)}) or resolved by an {@link
 * ApiLensWebFluxConsumerResolver}, and the trace context is read with {@link
 * #traceContext(ServerWebExchange)} (it is also in the Reactor context under {@code
 * TraceContext.class}).
 */
public class ApiLensWebFilter implements WebFilter, Ordered {
  /** Exchange attribute holding the {@link ApiLensConsumer} set by the application. */
  public static final String CONSUMER_ATTRIBUTE = ApiLensWebFilter.class.getName() + ".consumer";
  /** Exchange attribute holding the request's {@link TraceContext}. */
  public static final String TRACE_CONTEXT_ATTRIBUTE = ApiLensWebFilter.class.getName() + ".traceContext";
  /** Recorded when the client goes away before the response was committed. */
  static final int CLIENT_CLOSED_REQUEST = 499;

  private static final Logger LOGGER = Logger.getLogger("apilens");

  private final ApiLensClient client;
  private final ApiLensSpringOptions options;
  private final ApiLensWebFluxConsumerResolver consumerResolver;
  private final Redactor redactor;
  private final RequestExcluder excluder;
  private final Sampler sampler;
  private final DoubleSupplier random;
  private int order = Integer.MAX_VALUE - 100;

  public ApiLensWebFilter(ApiLensClient client, ApiLensSpringOptions options) {
    this(client, options, null);
  }

  public ApiLensWebFilter(
      ApiLensClient client,
      ApiLensSpringOptions options,
      ApiLensWebFluxConsumerResolver consumerResolver) {
    this(client, options, consumerResolver, null);
  }

  /** {@code random} replaces the sampling PRNG in tests; {@code null} uses the default. */
  ApiLensWebFilter(
      ApiLensClient client,
      ApiLensSpringOptions options,
      ApiLensWebFluxConsumerResolver consumerResolver,
      DoubleSupplier random) {
    this.client = client;
    this.options = options == null ? ApiLensSpringOptions.builder().build() : options;
    this.consumerResolver = consumerResolver;
    this.redactor = new Redactor(
        this.options.redactQueryParams(),
        this.options.redactHeaders(),
        this.options.redactBodyFields());
    this.excluder = new RequestExcluder(
        this.options.excludePaths(),
        this.options.excludeUserAgents(),
        this.options.defaultExclusions(),
        true);
    this.random = random == null ? () -> ThreadLocalRandom.current().nextDouble() : random;
    this.sampler = new Sampler(
        this.options.sampleRate(),
        this.options.sampleOnRequest(),
        this.options.sampleOnResponse(),
        this.random);
    if (client != null && this.options.enabled()) {
      // Heartbeats go out for the environment this filter records under.
      client.registerApp(client.config().appId(), this.options.environment());
    }
  }

  /** Sets the consumer of this exchange; {@code null} or an empty consumer clears it. */
  public static void setConsumer(ServerWebExchange exchange, ApiLensConsumer consumer) {
    if (consumer == null || consumer.isEmpty()) {
      exchange.getAttributes().remove(CONSUMER_ATTRIBUTE);
      return;
    }
    exchange.getAttributes().put(CONSUMER_ATTRIBUTE, consumer);
  }

  public static void setConsumer(ServerWebExchange exchange, String identifier) {
    setConsumer(exchange, ApiLensConsumer.of(identifier));
  }

  public static void setConsumer(ServerWebExchange exchange, String identifier, String name, String group) {
    setConsumer(exchange, ApiLensConsumer.of(identifier, name, group));
  }

  /** The trace context of this exchange; empty ids when the filter did not capture it. */
  public static TraceContext traceContext(ServerWebExchange exchange) {
    Object value = exchange.getAttribute(TRACE_CONTEXT_ATTRIBUTE);
    return value instanceof TraceContext trace ? trace : TraceContext.current();
  }

  @Override
  public int getOrder() {
    return order;
  }

  /** Order among the application's {@code WebFilter}s; defaults to {@code Integer.MAX_VALUE - 100}. */
  public void setOrder(int order) {
    this.order = order;
  }

  /** Options this filter captures with (the metadata report describes them). */
  ApiLensSpringOptions options() {
    return options;
  }

  /** Exclusions this filter applies (the metadata report lists their patterns). */
  RequestExcluder excluder() {
    return excluder;
  }

  /**
   * Excluded requests (built-in defaults, {@code excludePaths}, {@code excludeUserAgents}),
   * {@code OPTIONS} requests, and every request while capture is off locally or by the remote
   * policy pass through untouched: no decoration, no record, span or log.
   */
  boolean shouldNotFilter(ServerHttpRequest request) {
    return !options.enabled()
        || client == null
        || !client.isEnabled()
        || !client.remotePolicy().enabled()
        || "OPTIONS".equalsIgnoreCase(request.getMethod().name())
        || excluder.shouldExclude(request.getURI().getRawPath(), request.getHeaders().getFirst("User-Agent"));
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    ServerHttpRequest request = exchange.getRequest();
    if (shouldNotFilter(request)) {
      return chain.filter(exchange);
    }
    // The remote policy is read once, so one request is captured under one policy. It can only
    // narrow the local options (see RemotePolicy).
    RemotePolicy policy = client.remotePolicy();
    // Sampling runs before the handler: a request dropped here never has a body byte copied.
    // Both streams are still decorated, with a zero cap, to count the bytes for the base record.
    Sampler.RequestDecision sampling = sampler.onRequest(() -> requestInfo(request));
    int maxPayloadBytes = policy.limitPayloadBytes(options.maxPayloadBytes());
    boolean mayCapture = sampling.mayKeep() && options.capturePayloads() && maxPayloadBytes > 0;
    BodyRecorder requestBody = new BodyRecorder(
        mayCapture && options.logRequestBody() && policy.captureRequestBody() ? maxPayloadBytes : 0);
    BodyRecorder responseBody = new BodyRecorder(
        mayCapture && options.logResponseBody() && policy.captureResponseBody() ? maxPayloadBytes : 0);
    Instant startedAt = Instant.now();
    long startedNanos = System.nanoTime();
    TraceContext trace = TraceContext.begin(request.getHeaders().getFirst("traceparent"));
    exchange.getAttributes().put(TRACE_CONTEXT_ATTRIBUTE, trace);

    ServerWebExchange decorated = exchange.mutate()
        .request(new RecordingRequest(request, requestBody))
        .response(new RecordingResponse(exchange.getResponse(), responseBody))
        .build();
    AtomicReference<Throwable> failure = new AtomicReference<>();

    return Mono.defer(() -> {
          // Covers the synchronous part of the chain; the attribute and the Reactor context
          // carry the trace across threads.
          try (TraceContext.Scope ignored = trace.makeCurrent()) {
            return chain.filter(decorated);
          }
        })
        .doOnError(failure::set)
        .doFinally(signal -> {
          try {
            capture(decorated, requestBody, responseBody, sampling, policy, startedAt, startedNanos,
                trace, signal, failure.get());
          } catch (Exception ex) {
            LOGGER.log(Level.WARNING, "Error while logging request in API Lens WebFlux filter", ex);
          }
        })
        .contextWrite(context -> context.put(TraceContext.class, trace));
  }

  private void capture(
      ServerWebExchange exchange,
      BodyRecorder requestBody,
      BodyRecorder responseBody,
      Sampler.RequestDecision sampling,
      RemotePolicy policy,
      Instant startedAt,
      long startedNanos,
      TraceContext trace,
      SignalType signal,
      Throwable failure) {
    ServerHttpRequest request = exchange.getRequest();
    ServerHttpResponse response = exchange.getResponse();
    String method = request.getMethod().name().toUpperCase(Locale.ROOT);
    String rawRequestPath = Strings.normalizePath(request.getURI().getRawPath());
    String rawPath = rawPath(request, rawRequestPath);
    String endpointPath = PathTemplates.resolveEndpointPath(
        routeTemplate(exchange), rawRequestPath, options.parametrizePaths());
    // An error that reaches the filter is rendered after it by the WebExceptionHandlers, so the
    // status comes from the exception. A ResponseStatusException below 500 (404, 400...) is a
    // normal outcome, not an error to log.
    Throwable error = failure;
    int statusCode;
    if (error instanceof ResponseStatusException statusException) {
      statusCode = statusException.getStatusCode().value();
      if (statusCode < 500) {
        error = null;
      }
    } else if (error != null) {
      statusCode = 500;
    } else if (signal == SignalType.CANCEL && !response.isCommitted()) {
      statusCode = CLIENT_CLOSED_REQUEST;
    } else {
      HttpStatusCode status = response.getStatusCode();
      statusCode = status == null ? 200 : status.value();
    }
    int finalStatusCode = statusCode;
    double elapsedMs = Math.max((System.nanoTime() - startedNanos) / 1_000_000.0, 0.0);
    ApiLensConsumer consumer = resolveConsumer(exchange);
    // Sampled out: the base record is still sent (sampled=false) so metrics stay exact, but
    // without headers, bodies, span or error log. The remote sample rate only ever drops more.
    boolean sampled = sampler.onResponse(sampling, () -> new SampleResponseInfo(
        requestInfo(request), endpointPath, finalStatusCode, elapsedMs, consumer, sampling.callback()))
        && policy.keeps(random);
    int maxPayloadBytes = policy.limitPayloadBytes(options.maxPayloadBytes());
    boolean captureHeaders = sampled && options.captureHeaders() && policy.captureHeaders();
    long requestSize = size(request.getHeaders(), requestBody);
    long responseSize = size(response.getHeaders(), responseBody);

    String requestPayload = "";
    String responsePayload = "";
    if (sampled && options.capturePayloads() && maxPayloadBytes > 0) {
      RequestInfo requestInfo = new RequestInfo(
          method, rawRequestPath, rawPath, lowerHeaders(request.getHeaders()));
      if (options.logRequestBody() && policy.captureRequestBody()) {
        requestPayload = capturedPayload(
            requestBody.bytes(), request.getHeaders().getFirst(HttpHeaders.CONTENT_TYPE), requestSize,
            options.maskRequestBody(), requestInfo, maxPayloadBytes);
      }
      if (options.logResponseBody() && policy.captureResponseBody()) {
        ResponseInfo responseInfo = new ResponseInfo(
            requestInfo, finalStatusCode, lowerHeaders(response.getHeaders()));
        responsePayload = capturedPayload(
            responseBody.bytes(), response.getHeaders().getFirst(HttpHeaders.CONTENT_TYPE), responseSize,
            options.maskResponseBody(), responseInfo, maxPayloadBytes);
      }
    }

    client.capture(RequestRecord.builder()
        .timestamp(startedAt)
        .environment(options.environment())
        .method(method)
        .path(endpointPath)
        .rawPath(rawPath)
        .statusCode(finalStatusCode)
        .responseTimeMs(elapsedMs)
        .projectSlug(client.config().projectSlug())
        .appId(client.config().appId())
        .requestSize(requestSize)
        .responseSize(responseSize)
        .ipAddress(IpPrivacy.apply(clientIp(request), options.captureIp(), options.anonymizeIp()))
        .userAgent(request.getHeaders().getFirst("User-Agent"))
        .consumer(consumer)
        .requestPayload(requestPayload)
        .responsePayload(responsePayload)
        .requestHeaders(captureHeaders ? redactor.serializeHeaders(headerMap(request.getHeaders())) : "")
        .responseHeaders(captureHeaders ? redactor.serializeHeaders(headerMap(response.getHeaders())) : "")
        .baseUrl(baseUrl(request))
        .traceId(trace.traceId())
        .spanId(trace.spanId())
        .sampled(sampled)
        .build());

    if (sampled && options.captureSpans()) {
      boolean isError = error != null || finalStatusCode >= 500;
      client.captureSpan(SpanRecord.builder()
          .timestamp(startedAt)
          .environment(options.environment())
          .traceId(trace.traceId())
          .spanId(trace.spanId())
          .parentSpanId(trace.parentSpanId())
          .name(method + " " + endpointPath)
          .kind("server")
          .serviceName(Strings.firstNonBlank(options.serviceName(), client.config().appId()))
          .durationMs(elapsedMs)
          .status(isError ? "error" : "ok")
          .statusCode(finalStatusCode)
          .projectSlug(client.config().projectSlug())
          .appId(client.config().appId())
          .build());

      if (isError) {
        captureErrorLog(error, finalStatusCode, method, endpointPath, trace, consumer);
      }
    }
  }

  private void captureErrorLog(
      Throwable throwable,
      int statusCode,
      String method,
      String endpointPath,
      TraceContext trace,
      ApiLensConsumer consumer) {
    String message = throwable == null
        ? "HTTP " + statusCode + " on " + method + " " + endpointPath
        : throwable.getClass().getSimpleName() + ": " + throwable.getMessage();
    client.captureLog(LogRecord.builder()
        .timestamp(Instant.now())
        .environment(options.environment())
        .level("ERROR")
        .message(message)
        .loggerName(throwable == null ? "apilens.http" : "apilens.exception")
        .endpointMethod(method)
        .endpointPath(endpointPath)
        .statusCode(statusCode)
        .consumer(consumer)
        .traceId(trace.traceId())
        .spanId(trace.spanId())
        .projectSlug(client.config().projectSlug())
        .appId(client.config().appId())
        .payload(throwable == null ? "" : stackTrace(throwable))
        .build());
  }

  private RequestInfo requestInfo(ServerHttpRequest request) {
    String method = request.getMethod().name().toUpperCase(Locale.ROOT);
    String rawRequestPath = Strings.normalizePath(request.getURI().getRawPath());
    return new RequestInfo(method, rawRequestPath, rawPath(request, rawRequestPath), lowerHeaders(request.getHeaders()));
  }

  private String rawPath(ServerHttpRequest request, String rawRequestPath) {
    String query = request.getURI().getRawQuery();
    return Strings.isBlank(query) ? rawRequestPath : rawRequestPath + "?" + redactor.redactQuery(query);
  }

  private <T> String capturedPayload(
      byte[] body,
      String contentType,
      long declaredSize,
      BiFunction<? super T, byte[], byte[]> masker,
      T info,
      int maxPayloadBytes) {
    String type = Strings.clean(contentType);
    if (!Redactor.isCapturableContentType(type)) {
      return declaredSize > 0 ? Redactor.omittedPlaceholder(type, declaredSize) : "";
    }
    return redactor.maskBody(body, type, masker, info, maxPayloadBytes);
  }

  private ApiLensConsumer resolveConsumer(ServerWebExchange exchange) {
    Object current = exchange.getAttribute(CONSUMER_ATTRIBUTE);
    if (current instanceof ApiLensConsumer consumer && !consumer.isEmpty()) {
      return consumer;
    }
    if (consumerResolver == null) {
      return ApiLensConsumer.empty();
    }
    ApiLensConsumer resolved = consumerResolver.resolve(exchange);
    return resolved == null ? ApiLensConsumer.empty() : resolved;
  }

  private static String routeTemplate(ServerWebExchange exchange) {
    Object pattern = exchange.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
    if (pattern instanceof PathPattern pathPattern) {
      return pathPattern.getPatternString();
    }
    return pattern == null ? "" : String.valueOf(pattern);
  }

  /** {@code Content-Length} when declared, else the bytes that passed through the stream. */
  private static long size(HttpHeaders headers, BodyRecorder recorder) {
    long declared = headers.getContentLength();
    return declared >= 0 ? declared : recorder.total();
  }

  private static Map<String, Object> headerMap(HttpHeaders headers) {
    Map<String, Object> out = new LinkedHashMap<>();
    headers.forEach(out::put);
    return out;
  }

  private static Map<String, String> lowerHeaders(HttpHeaders headers) {
    Map<String, String> out = new LinkedHashMap<>();
    headers.forEach((name, values) -> {
      String key = Strings.clean(name).toLowerCase(Locale.ROOT);
      if (key.isEmpty()) {
        return;
      }
      String text = String.join(", ", values == null ? List.of() : values);
      out.merge(key, text, (a, b) -> a + ", " + b);
    });
    return out;
  }

  private static String clientIp(ServerHttpRequest request) {
    String forwarded = request.getHeaders().getFirst("X-Forwarded-For");
    if (!Strings.isBlank(forwarded)) {
      return forwarded.split(",", 2)[0].trim();
    }
    String realIp = request.getHeaders().getFirst("X-Real-IP");
    if (!Strings.isBlank(realIp)) {
      return realIp.trim();
    }
    InetSocketAddress remote = request.getRemoteAddress();
    if (remote == null) {
      return "";
    }
    return remote.getAddress() == null ? Strings.clean(remote.getHostString()) : remote.getAddress().getHostAddress();
  }

  private static String baseUrl(ServerHttpRequest request) {
    URI uri = request.getURI();
    String scheme = firstHeaderPart(request, "X-Forwarded-Proto");
    if (scheme.isEmpty()) {
      scheme = Strings.clean(uri.getScheme());
    }
    String host = firstHeaderPart(request, "X-Forwarded-Host");
    if (host.isEmpty()) {
      host = Strings.clean(request.getHeaders().getFirst(HttpHeaders.HOST));
    }
    if (host.isEmpty()) {
      host = Strings.clean(uri.getRawAuthority());
    }
    return host.isEmpty() || scheme.isEmpty() ? "" : scheme + "://" + host;
  }

  private static String firstHeaderPart(ServerHttpRequest request, String name) {
    String value = request.getHeaders().getFirst(name);
    if (Strings.isBlank(value)) {
      return "";
    }
    return value.split(",", 2)[0].trim();
  }

  private static String stackTrace(Throwable throwable) {
    StringWriter out = new StringWriter();
    throwable.printStackTrace(new PrintWriter(out));
    return out.toString();
  }

  /**
   * Copies up to {@code limit} bytes of a body stream as it passes and counts every byte. The
   * buffer's read position is restored, so the body is not consumed.
   */
  static final class BodyRecorder {
    private final int limit;
    private final ByteArrayOutputStream captured = new ByteArrayOutputStream();
    private long total;

    BodyRecorder(int limit) {
      this.limit = Math.max(limit, 0);
    }

    synchronized void record(DataBuffer buffer) {
      int readable = buffer.readableByteCount();
      total += readable;
      int room = limit - captured.size();
      if (room <= 0 || readable <= 0) {
        return;
      }
      byte[] chunk = new byte[Math.min(room, readable)];
      int position = buffer.readPosition();
      buffer.read(chunk);
      buffer.readPosition(position);
      captured.write(chunk, 0, chunk.length);
    }

    synchronized byte[] bytes() {
      return captured.toByteArray();
    }

    synchronized long total() {
      return total;
    }
  }

  private static final class RecordingRequest extends ServerHttpRequestDecorator {
    private final BodyRecorder recorder;

    RecordingRequest(ServerHttpRequest delegate, BodyRecorder recorder) {
      super(delegate);
      this.recorder = recorder;
    }

    @Override
    public Flux<DataBuffer> getBody() {
      return super.getBody().doOnNext(recorder::record);
    }
  }

  private static final class RecordingResponse extends ServerHttpResponseDecorator {
    private final BodyRecorder recorder;

    RecordingResponse(ServerHttpResponse delegate, BodyRecorder recorder) {
      super(delegate);
      this.recorder = recorder;
    }

    @Override
    public Mono<Void> writeWith(Publisher<? extends DataBuffer> body) {
      if (body instanceof Mono<? extends DataBuffer> mono) {
        return super.writeWith(mono.doOnNext(recorder::record));
      }
      return super.writeWith(Flux.from(body).doOnNext(recorder::record));
    }

    @Override
    public Mono<Void> writeAndFlushWith(Publisher<? extends Publisher<? extends DataBuffer>> body) {
      return super.writeAndFlushWith(
          Flux.from(body).map(inner -> Flux.from(inner).doOnNext(recorder::record)));
    }
  }
}
