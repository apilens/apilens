package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConsumer;
import ai.apilens.ApiLensConsumers;
import ai.apilens.LogRecord;
import ai.apilens.PathTemplates;
import ai.apilens.Redactor;
import ai.apilens.RequestExcluder;
import ai.apilens.RequestInfo;
import ai.apilens.RequestRecord;
import ai.apilens.ResponseInfo;
import ai.apilens.SampleResponseInfo;
import ai.apilens.Sampler;
import ai.apilens.SpanRecord;
import ai.apilens.TraceContext;
import ai.apilens.internal.Strings;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.DoubleSupplier;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingRequestWrapper;
import org.springframework.web.util.ContentCachingResponseWrapper;

/** Spring MVC servlet filter for automatic request, span, and error-log capture. */
public class ApiLensSpringFilter extends OncePerRequestFilter {
  private static final Logger LOGGER = Logger.getLogger("apilens");
  private static final String BEST_MATCHING_PATTERN_ATTRIBUTE =
      "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";

  private final ApiLensClient client;
  private final ApiLensSpringOptions options;
  private final ApiLensConsumerResolver consumerResolver;
  private final Redactor redactor;
  private final RequestExcluder excluder;
  private final Sampler sampler;

  public ApiLensSpringFilter(ApiLensClient client, ApiLensSpringOptions options) {
    this(client, options, null);
  }

  public ApiLensSpringFilter(
      ApiLensClient client,
      ApiLensSpringOptions options,
      ApiLensConsumerResolver consumerResolver) {
    this(client, options, consumerResolver, null);
  }

  /** {@code random} replaces the sampling PRNG in tests; {@code null} uses the default. */
  ApiLensSpringFilter(
      ApiLensClient client,
      ApiLensSpringOptions options,
      ApiLensConsumerResolver consumerResolver,
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
    this.sampler = new Sampler(
        this.options.sampleRate(),
        this.options.sampleOnRequest(),
        this.options.sampleOnResponse(),
        random);
  }

  /**
   * Excluded requests (built-in health/probe/static defaults, {@code excludePaths},
   * {@code excludeUserAgents}) bypass the filter entirely: no wrapping, no body
   * buffering, no record, span or log.
   */
  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return !options.enabled()
        || !client.isEnabled()
        || "OPTIONS".equalsIgnoreCase(request.getMethod())
        || excluder.shouldExclude(request.getRequestURI(), request.getHeader("User-Agent"));
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request,
      HttpServletResponse response,
      FilterChain filterChain) throws ServletException, IOException {
    // Sampling runs before any body buffering: a request dropped here is not wrapped, so its
    // body is never copied. The response is still wrapped for the base record's response size.
    Sampler.RequestDecision sampling = sampler.onRequest(() -> requestInfo(request));
    HttpServletRequest requestWrapper = sampling.mayKeep() ? wrapRequest(request) : request;
    ContentCachingResponseWrapper responseWrapper = wrapResponse(response);
    Instant startedAt = Instant.now();
    long startedNanos = System.nanoTime();
    int statusCode = 500;
    Exception capturedException = null;
    Error capturedError = null;

    TraceContext trace = TraceContext.begin(request.getHeader("traceparent"));
    try (TraceContext.Scope ignored = trace.makeCurrent()) {
      try {
        filterChain.doFilter(requestWrapper, responseWrapper);
        statusCode = responseWrapper.getStatus();
      } catch (IOException | ServletException | RuntimeException ex) {
        capturedException = ex;
        throw ex;
      } catch (Error error) {
        capturedError = error;
        throw error;
      } finally {
        try {
          capture(requestWrapper, responseWrapper, sampling, startedAt, startedNanos, statusCode, trace,
              capturedException, capturedError);
        } catch (Exception ex) {
          LOGGER.log(Level.WARNING, "Error while logging request in API Lens Spring filter", ex);
        } finally {
          ApiLensConsumers.clear();
          responseWrapper.copyBodyToResponse();
        }
      }
    }
  }

  private ContentCachingRequestWrapper wrapRequest(HttpServletRequest request) {
    if (request instanceof ContentCachingRequestWrapper wrapper) {
      return wrapper;
    }
    return new ContentCachingRequestWrapper(request, options.maxPayloadBytes());
  }

  private ContentCachingResponseWrapper wrapResponse(HttpServletResponse response) {
    if (response instanceof ContentCachingResponseWrapper wrapper) {
      return wrapper;
    }
    return new ContentCachingResponseWrapper(response);
  }

  private void capture(
      HttpServletRequest request,
      ContentCachingResponseWrapper response,
      Sampler.RequestDecision sampling,
      Instant startedAt,
      long startedNanos,
      int statusCode,
      TraceContext trace,
      Exception capturedException,
      Error capturedError) {
    String method = Strings.firstNonBlank(request.getMethod(), "GET").toUpperCase();
    String rawRequestPath = Strings.normalizePath(request.getRequestURI());
    String rawPath = rawRequestPath;
    if (!Strings.isBlank(request.getQueryString())) {
      rawPath = rawRequestPath + "?" + redactor.redactQuery(request.getQueryString());
    }
    String routeTemplate = routeTemplate(request);
    String endpointPath = PathTemplates.resolveEndpointPath(routeTemplate, rawRequestPath, options.parametrizePaths());
    int finalStatusCode = statusCode <= 0 ? response.getStatus() : statusCode;
    double elapsedMs = Math.max((System.nanoTime() - startedNanos) / 1_000_000.0, 0.0);
    ApiLensConsumer consumer = resolveConsumer(request, response);
    // Sampled out: the base record is still sent (sampled=false) so metrics stay exact, but
    // without headers, bodies, span or error log. The trace context was still made current.
    boolean sampled = sampler.onResponse(sampling, () -> new SampleResponseInfo(
        requestInfo(request), endpointPath, finalStatusCode, elapsedMs, consumer, sampling.callback()));

    String requestPayload = "";
    String responsePayload = "";
    if (sampled && options.capturePayloads() && options.maxPayloadBytes() > 0) {
      // Content-type aware: JSON / text / form-encoded bodies go through the mask callback and
      // then the regex masking; anything else is stored as "[<content-type>, N bytes omitted]".
      RequestInfo requestInfo = new RequestInfo(
          method, rawRequestPath, rawPath, lowerHeaders(requestHeaders(request)));
      if (options.logRequestBody() && request instanceof ContentCachingRequestWrapper cached) {
        String contentType = Strings.clean(request.getContentType());
        requestPayload = capturedPayload(
            cached.getContentAsByteArray(), contentType, requestSize(request),
            options.maskRequestBody(), requestInfo);
      }
      if (options.logResponseBody()) {
        String contentType = Strings.clean(response.getContentType());
        ResponseInfo responseInfo = new ResponseInfo(
            requestInfo, finalStatusCode, lowerHeaders(responseHeaders(response)));
        responsePayload = capturedPayload(
            response.getContentAsByteArray(), contentType, responseSize(response),
            options.maskResponseBody(), responseInfo);
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
        .requestSize(requestSize(request))
        .responseSize(responseSize(response))
        .ipAddress(clientIp(request))
        .userAgent(request.getHeader("User-Agent"))
        .consumer(consumer)
        .requestPayload(requestPayload)
        .responsePayload(responsePayload)
        .requestHeaders(sampled && options.captureHeaders() ? redactor.serializeHeaders(requestHeaders(request)) : "")
        .responseHeaders(sampled && options.captureHeaders() ? redactor.serializeHeaders(responseHeaders(response)) : "")
        .baseUrl(baseUrl(request))
        .traceId(trace.traceId())
        .spanId(trace.spanId())
        .sampled(sampled)
        .build());

    if (sampled && options.captureSpans()) {
      boolean isError = capturedException != null || capturedError != null || finalStatusCode >= 500;
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
        captureErrorLog(capturedException, capturedError, finalStatusCode, method, endpointPath, trace, consumer);
      }
    }
  }

  private void captureErrorLog(
      Exception capturedException,
      Error capturedError,
      int statusCode,
      String method,
      String endpointPath,
      TraceContext trace,
      ApiLensConsumer consumer) {
    Throwable throwable = capturedException != null ? capturedException : capturedError;
    String message = throwable == null
        ? "HTTP " + statusCode + " on " + method + " " + endpointPath
        : throwable.getClass().getSimpleName() + ": " + throwable.getMessage();
    String payload = throwable == null ? "" : stackTrace(throwable);

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
        .payload(payload)
        .build());
  }

  private RequestInfo requestInfo(HttpServletRequest request) {
    String method = Strings.firstNonBlank(request.getMethod(), "GET").toUpperCase();
    String rawRequestPath = Strings.normalizePath(request.getRequestURI());
    String rawPath = rawRequestPath;
    if (!Strings.isBlank(request.getQueryString())) {
      rawPath = rawRequestPath + "?" + redactor.redactQuery(request.getQueryString());
    }
    return new RequestInfo(method, rawRequestPath, rawPath, lowerHeaders(requestHeaders(request)));
  }

  private <T> String capturedPayload(
      byte[] body,
      String contentType,
      long declaredSize,
      BiFunction<? super T, byte[], byte[]> masker,
      T info) {
    if (!Redactor.isCapturableContentType(contentType)) {
      // The body may not have been cached at all (e.g. multipart parsed by the container), so
      // report the larger of the declared and the cached size.
      long size = Math.max(declaredSize, body == null ? 0 : body.length);
      return size > 0 ? Redactor.omittedPlaceholder(contentType, size) : "";
    }
    return redactor.maskBody(body, contentType, masker, info, options.maxPayloadBytes());
  }

  private static Map<String, String> lowerHeaders(Map<String, Object> headers) {
    Map<String, String> out = new LinkedHashMap<>();
    headers.forEach((name, value) -> {
      String key = Strings.clean(name).toLowerCase(Locale.ROOT);
      if (key.isEmpty()) {
        return;
      }
      String text;
      if (value instanceof Iterable<?> iterable) {
        List<String> parts = new ArrayList<>();
        iterable.forEach(item -> parts.add(String.valueOf(item)));
        text = String.join(", ", parts);
      } else {
        text = String.valueOf(value);
      }
      out.merge(key, text, (a, b) -> a + ", " + b);
    });
    return out;
  }

  private ApiLensConsumer resolveConsumer(HttpServletRequest request, HttpServletResponse response) {
    ApiLensConsumer current = ApiLensConsumers.current().orElse(ApiLensConsumer.empty());
    if (!current.isEmpty()) {
      return current;
    }
    if (consumerResolver == null) {
      return ApiLensConsumer.empty();
    }
    ApiLensConsumer resolved = consumerResolver.resolve(request, response);
    return resolved == null ? ApiLensConsumer.empty() : resolved;
  }

  private String routeTemplate(HttpServletRequest request) {
    Object pattern = request.getAttribute(BEST_MATCHING_PATTERN_ATTRIBUTE);
    return pattern == null ? "" : String.valueOf(pattern);
  }

  private long requestSize(HttpServletRequest request) {
    long value = request.getContentLengthLong();
    return Math.max(value, 0L);
  }

  private long responseSize(ContentCachingResponseWrapper response) {
    String contentLength = response.getHeader("Content-Length");
    if (!Strings.isBlank(contentLength)) {
      try {
        return Math.max(Long.parseLong(contentLength), 0L);
      } catch (NumberFormatException ignored) {
        // Fall through to cached byte count.
      }
    }
    return Math.max(response.getContentSize(), 0);
  }

  private String clientIp(HttpServletRequest request) {
    String forwarded = request.getHeader("X-Forwarded-For");
    if (!Strings.isBlank(forwarded)) {
      return forwarded.split(",", 2)[0].trim();
    }
    String realIp = request.getHeader("X-Real-IP");
    if (!Strings.isBlank(realIp)) {
      return realIp.trim();
    }
    return Strings.clean(request.getRemoteAddr());
  }

  private String baseUrl(HttpServletRequest request) {
    String scheme = firstHeaderPart(request, "X-Forwarded-Proto");
    if (scheme.isEmpty()) {
      scheme = request.getScheme();
    }
    String host = firstHeaderPart(request, "X-Forwarded-Host");
    if (host.isEmpty()) {
      host = request.getHeader("Host");
    }
    if (Strings.isBlank(host)) {
      host = request.getServerName();
      int port = request.getServerPort();
      boolean defaultPort = ("http".equalsIgnoreCase(scheme) && port == 80)
          || ("https".equalsIgnoreCase(scheme) && port == 443);
      if (port > 0 && !defaultPort) {
        host = host + ":" + port;
      }
    }
    return Strings.isBlank(host) ? "" : scheme + "://" + host;
  }

  private String firstHeaderPart(HttpServletRequest request, String name) {
    String value = request.getHeader(name);
    if (Strings.isBlank(value)) {
      return "";
    }
    return value.split(",", 2)[0].trim();
  }

  private Map<String, Object> requestHeaders(HttpServletRequest request) {
    Map<String, Object> headers = new LinkedHashMap<>();
    Enumeration<String> names = request.getHeaderNames();
    if (names == null) {
      return headers;
    }
    while (names.hasMoreElements()) {
      String name = names.nextElement();
      headers.put(name, Collections.list(request.getHeaders(name)));
    }
    return headers;
  }

  private Map<String, Object> responseHeaders(HttpServletResponse response) {
    Map<String, Object> headers = new LinkedHashMap<>();
    for (String name : response.getHeaderNames()) {
      headers.put(name, response.getHeaders(name));
    }
    return headers;
  }

  private String stackTrace(Throwable throwable) {
    StringWriter out = new StringWriter();
    throwable.printStackTrace(new PrintWriter(out));
    return out.toString();
  }
}
