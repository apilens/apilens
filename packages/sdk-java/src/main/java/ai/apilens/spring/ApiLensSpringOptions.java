package ai.apilens.spring;

import ai.apilens.RequestExcluder;
import ai.apilens.RequestInfo;
import ai.apilens.RequestSampler;
import ai.apilens.ResponseInfo;
import ai.apilens.ResponseSampler;
import ai.apilens.Sampler;
import java.util.List;
import java.util.function.BiFunction;

/** Request-capture options used by the Spring servlet filter. */
public final class ApiLensSpringOptions {
  private final String environment;
  private final boolean enabled;
  private final boolean enableRequestLogging;
  private final boolean logRequestBody;
  private final boolean logResponseBody;
  private final boolean capturePayloads;
  private final boolean captureHeaders;
  private final boolean captureSpans;
  private final String serviceName;
  private final int maxPayloadBytes;
  private final List<String> redactQueryParams;
  private final List<String> redactHeaders;
  private final List<String> redactBodyFields;
  private final boolean parametrizePaths;
  private final List<String> excludePaths;
  private final List<String> excludeUserAgents;
  private final boolean defaultExclusions;
  private final BiFunction<RequestInfo, byte[], byte[]> maskRequestBody;
  private final BiFunction<ResponseInfo, byte[], byte[]> maskResponseBody;
  private final double sampleRate;
  private final RequestSampler sampleOnRequest;
  private final ResponseSampler sampleOnResponse;

  private ApiLensSpringOptions(Builder builder) {
    this.environment = builder.environment;
    this.enabled = builder.enabled;
    this.enableRequestLogging = builder.enableRequestLogging;
    this.logRequestBody = builder.logRequestBody;
    this.logResponseBody = builder.logResponseBody;
    this.capturePayloads = builder.capturePayloads;
    this.captureHeaders = builder.captureHeaders;
    this.captureSpans = builder.captureSpans;
    this.serviceName = builder.serviceName;
    this.maxPayloadBytes = Math.max(builder.maxPayloadBytes, 0);
    this.redactQueryParams = List.copyOf(builder.redactQueryParams);
    this.redactHeaders = List.copyOf(builder.redactHeaders);
    this.redactBodyFields = List.copyOf(builder.redactBodyFields);
    this.parametrizePaths = builder.parametrizePaths;
    this.excludePaths = List.copyOf(builder.excludePaths);
    this.excludeUserAgents = List.copyOf(builder.excludeUserAgents);
    this.defaultExclusions = builder.defaultExclusions;
    this.maskRequestBody = builder.maskRequestBody;
    this.maskResponseBody = builder.maskResponseBody;
    this.sampleRate = builder.sampleRate;
    this.sampleOnRequest = builder.sampleOnRequest;
    this.sampleOnResponse = builder.sampleOnResponse;
  }

  public static Builder builder() {
    return new Builder();
  }

  /** A builder pre-filled with these options. */
  public Builder toBuilder() {
    return new Builder()
        .environment(environment)
        .enabled(enabled)
        .enableRequestLogging(enableRequestLogging)
        .logRequestBody(logRequestBody)
        .logResponseBody(logResponseBody)
        .capturePayloads(capturePayloads)
        .captureHeaders(captureHeaders)
        .captureSpans(captureSpans)
        .serviceName(serviceName)
        .maxPayloadBytes(maxPayloadBytes)
        .redactQueryParams(redactQueryParams)
        .redactHeaders(redactHeaders)
        .redactBodyFields(redactBodyFields)
        .parametrizePaths(parametrizePaths)
        .excludePaths(excludePaths)
        .excludeUserAgents(excludeUserAgents)
        .defaultExclusions(defaultExclusions)
        .maskRequestBody(maskRequestBody)
        .maskResponseBody(maskResponseBody)
        .sampleRate(sampleRate)
        .sampleOnRequest(sampleOnRequest)
        .sampleOnResponse(sampleOnResponse);
  }

  public String environment() {
    return environment;
  }

  public boolean enabled() {
    return enabled;
  }

  public boolean enableRequestLogging() {
    return enableRequestLogging;
  }

  public boolean logRequestBody() {
    return logRequestBody;
  }

  public boolean logResponseBody() {
    return logResponseBody;
  }

  public boolean capturePayloads() {
    return capturePayloads && enableRequestLogging;
  }

  public boolean captureHeaders() {
    return captureHeaders && enableRequestLogging;
  }

  public boolean captureSpans() {
    return captureSpans;
  }

  public String serviceName() {
    return serviceName;
  }

  public int maxPayloadBytes() {
    return maxPayloadBytes;
  }

  public List<String> redactQueryParams() {
    return redactQueryParams;
  }

  public List<String> redactHeaders() {
    return redactHeaders;
  }

  public List<String> redactBodyFields() {
    return redactBodyFields;
  }

  public boolean parametrizePaths() {
    return parametrizePaths;
  }

  /** Extra case-insensitive path regexes; a matching request is not captured. */
  public List<String> excludePaths() {
    return excludePaths;
  }

  /** Extra case-insensitive User-Agent regexes; a matching request is not captured. */
  public List<String> excludeUserAgents() {
    return excludeUserAgents;
  }

  /** Whether the built-in health-check/probe/static-file exclusions apply. */
  public boolean defaultExclusions() {
    return defaultExclusions;
  }

  /**
   * Callback run on the captured raw request body before the regex masking; return the bytes to
   * store, or {@code null} to store {@code [masked]}. A thrown exception also stores
   * {@code [masked]}. {@code null} when unset.
   */
  public BiFunction<RequestInfo, byte[], byte[]> maskRequestBody() {
    return maskRequestBody;
  }

  /** Response-side counterpart of {@link #maskRequestBody()}, with the same semantics. */
  public BiFunction<ResponseInfo, byte[], byte[]> maskResponseBody() {
    return maskResponseBody;
  }

  /**
   * Fraction of requests, in {@code [0.0, 1.0]}, whose detail (headers, bodies, span, error log)
   * is kept when no sampling callback decides. Every request still sends its base record
   * ({@code sampled=false} when dropped), so metrics are unaffected. Defaults to {@code 1.0}.
   */
  public double sampleRate() {
    return sampleRate;
  }

  /** Request-stage sampling callback, run before the handler; {@code null} when unset. */
  public RequestSampler sampleOnRequest() {
    return sampleOnRequest;
  }

  /** Response-stage sampling callback, run after the handler; {@code null} when unset. */
  public ResponseSampler sampleOnResponse() {
    return sampleOnResponse;
  }

  public static final class Builder {
    private String environment = "";
    private boolean enabled = true;
    private boolean enableRequestLogging = true;
    private boolean logRequestBody = true;
    private boolean logResponseBody = true;
    private boolean capturePayloads = true;
    private boolean captureHeaders = true;
    private boolean captureSpans = true;
    private String serviceName = "";
    private int maxPayloadBytes = 65_536;
    private List<String> redactQueryParams = List.of();
    private List<String> redactHeaders = List.of();
    private List<String> redactBodyFields = List.of();
    private boolean parametrizePaths = true;
    private List<String> excludePaths = List.of();
    private List<String> excludeUserAgents = List.of();
    private boolean defaultExclusions = true;
    private BiFunction<RequestInfo, byte[], byte[]> maskRequestBody;
    private BiFunction<ResponseInfo, byte[], byte[]> maskResponseBody;
    private double sampleRate = 1.0;
    private RequestSampler sampleOnRequest;
    private ResponseSampler sampleOnResponse;

    private Builder() {}

    public Builder environment(String environment) {
      this.environment = environment == null ? "" : environment;
      return this;
    }

    public Builder enabled(boolean enabled) {
      this.enabled = enabled;
      return this;
    }

    public Builder enableRequestLogging(boolean enableRequestLogging) {
      this.enableRequestLogging = enableRequestLogging;
      return this;
    }

    public Builder logRequestBody(boolean logRequestBody) {
      this.logRequestBody = logRequestBody;
      return this;
    }

    public Builder logResponseBody(boolean logResponseBody) {
      this.logResponseBody = logResponseBody;
      return this;
    }

    public Builder capturePayloads(boolean capturePayloads) {
      this.capturePayloads = capturePayloads;
      return this;
    }

    public Builder captureHeaders(boolean captureHeaders) {
      this.captureHeaders = captureHeaders;
      return this;
    }

    public Builder captureSpans(boolean captureSpans) {
      this.captureSpans = captureSpans;
      return this;
    }

    public Builder serviceName(String serviceName) {
      this.serviceName = serviceName == null ? "" : serviceName;
      return this;
    }

    public Builder maxPayloadBytes(int maxPayloadBytes) {
      this.maxPayloadBytes = maxPayloadBytes;
      return this;
    }

    public Builder redactQueryParams(List<String> redactQueryParams) {
      this.redactQueryParams = redactQueryParams == null ? List.of() : List.copyOf(redactQueryParams);
      return this;
    }

    public Builder redactHeaders(List<String> redactHeaders) {
      this.redactHeaders = redactHeaders == null ? List.of() : List.copyOf(redactHeaders);
      return this;
    }

    public Builder redactBodyFields(List<String> redactBodyFields) {
      this.redactBodyFields = redactBodyFields == null ? List.of() : List.copyOf(redactBodyFields);
      return this;
    }

    public Builder parametrizePaths(boolean parametrizePaths) {
      this.parametrizePaths = parametrizePaths;
      return this;
    }

    public Builder excludePaths(List<String> excludePaths) {
      this.excludePaths = RequestExcluder.splitPatterns(excludePaths);
      return this;
    }

    public Builder excludeUserAgents(List<String> excludeUserAgents) {
      this.excludeUserAgents = RequestExcluder.splitPatterns(excludeUserAgents);
      return this;
    }

    public Builder defaultExclusions(boolean defaultExclusions) {
      this.defaultExclusions = defaultExclusions;
      return this;
    }

    public Builder maskRequestBody(BiFunction<RequestInfo, byte[], byte[]> maskRequestBody) {
      this.maskRequestBody = maskRequestBody;
      return this;
    }

    public Builder maskResponseBody(BiFunction<ResponseInfo, byte[], byte[]> maskResponseBody) {
      this.maskResponseBody = maskResponseBody;
      return this;
    }

    /**
     * @throws IllegalArgumentException when {@code sampleRate} is outside {@code [0.0, 1.0]}
     */
    public Builder sampleRate(double sampleRate) {
      this.sampleRate = Sampler.validateRate(sampleRate);
      return this;
    }

    public Builder sampleOnRequest(RequestSampler sampleOnRequest) {
      this.sampleOnRequest = sampleOnRequest;
      return this;
    }

    public Builder sampleOnResponse(ResponseSampler sampleOnResponse) {
      this.sampleOnResponse = sampleOnResponse;
      return this;
    }

    public ApiLensSpringOptions build() {
      return new ApiLensSpringOptions(this);
    }
  }
}
