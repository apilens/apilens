package ai.apilens.spring;

import ai.apilens.ApiLensEnv;
import ai.apilens.CaptureProfile;
import ai.apilens.RequestExcluder;
import ai.apilens.RequestInfo;
import ai.apilens.RequestSampler;
import ai.apilens.ResponseInfo;
import ai.apilens.ResponseSampler;
import ai.apilens.Sampler;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Consumer;

/** Request-capture options used by the Spring servlet filter. */
public final class ApiLensSpringOptions {
  /** Default {@code maxPayloadBytes} when neither the flag nor a capture profile sets it. */
  public static final int DEFAULT_MAX_PAYLOAD_BYTES = 65_536;

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
  private final boolean captureIp;
  private final boolean anonymizeIp;
  private final List<String> excludePaths;
  private final List<String> excludeUserAgents;
  private final boolean defaultExclusions;
  private final BiFunction<RequestInfo, byte[], byte[]> maskRequestBody;
  private final BiFunction<ResponseInfo, byte[], byte[]> maskResponseBody;
  private final double sampleRate;
  private final RequestSampler sampleOnRequest;
  private final ResponseSampler sampleOnResponse;
  private final CaptureProfile captureProfile;
  // As set on the builder (null = unset), so toBuilder() keeps the profile able to fill them.
  private final Boolean explicitLogRequestBody;
  private final Boolean explicitLogResponseBody;
  private final Boolean explicitCapturePayloads;
  private final Boolean explicitCaptureHeaders;
  private final Integer explicitMaxPayloadBytes;

  private ApiLensSpringOptions(Builder builder) {
    CaptureProfile.Resolved capture = CaptureProfile.resolve(
        builder.captureProfile,
        builder.captureHeaders,
        builder.capturePayloads,
        builder.logRequestBody,
        builder.logResponseBody,
        builder.maxPayloadBytes,
        DEFAULT_MAX_PAYLOAD_BYTES);
    this.environment = builder.environment;
    this.enabled = builder.enabled;
    this.enableRequestLogging = builder.enableRequestLogging;
    this.logRequestBody = capture.logRequestBody();
    this.logResponseBody = capture.logResponseBody();
    this.capturePayloads = capture.capturePayloads();
    this.captureHeaders = capture.captureHeaders();
    this.captureSpans = builder.captureSpans;
    this.serviceName = builder.serviceName;
    this.maxPayloadBytes = Math.max(capture.maxPayloadBytes(), 0);
    this.redactQueryParams = List.copyOf(builder.redactQueryParams);
    this.redactHeaders = List.copyOf(builder.redactHeaders);
    this.redactBodyFields = List.copyOf(builder.redactBodyFields);
    this.parametrizePaths = builder.parametrizePaths;
    this.captureIp = builder.captureIp;
    this.anonymizeIp = builder.anonymizeIp;
    this.excludePaths = List.copyOf(builder.excludePaths);
    this.excludeUserAgents = List.copyOf(builder.excludeUserAgents);
    this.defaultExclusions = builder.defaultExclusions;
    this.maskRequestBody = builder.maskRequestBody;
    this.maskResponseBody = builder.maskResponseBody;
    this.sampleRate = builder.sampleRate;
    this.sampleOnRequest = builder.sampleOnRequest;
    this.sampleOnResponse = builder.sampleOnResponse;
    this.captureProfile = builder.captureProfile;
    this.explicitLogRequestBody = builder.logRequestBody;
    this.explicitLogResponseBody = builder.logResponseBody;
    this.explicitCapturePayloads = builder.capturePayloads;
    this.explicitCaptureHeaders = builder.captureHeaders;
    this.explicitMaxPayloadBytes = builder.maxPayloadBytes;
  }

  public static Builder builder() {
    return new Builder();
  }

  /**
   * Capture options read from the {@code APILENS_*} environment variables, for apps without
   * Spring Boot (Spring Boot binds the same variables to {@code apilens.*} itself).
   *
   * @throws IllegalArgumentException naming the variable when a value cannot be parsed
   */
  public static ApiLensSpringOptions fromEnv() {
    return builderFromEnv().build();
  }

  /** {@link #fromEnv()} over a fixed map of variables. */
  public static ApiLensSpringOptions fromEnv(Map<String, String> variables) {
    return builderFromEnv(variables).build();
  }

  /**
   * A builder pre-filled from the {@code APILENS_*} environment variables. Setters called on it
   * afterwards win, so the precedence is explicit &gt; env &gt; capture profile &gt; default.
   * {@code APILENS_EXCLUDE_PATHS} / {@code APILENS_EXCLUDE_USER_AGENTS} are not read here: the
   * filter always adds them to the configured patterns.
   */
  public static Builder builderFromEnv() {
    return builderFromEnv(ApiLensEnv.system());
  }

  /** {@link #builderFromEnv()} over a fixed map of variables. */
  public static Builder builderFromEnv(Map<String, String> variables) {
    return builderFromEnv(ApiLensEnv.of(variables));
  }

  private static Builder builderFromEnv(ApiLensEnv env) {
    Builder builder = builder();
    set(env.string("APILENS_ENVIRONMENT"), builder::environment);
    set(env.bool("APILENS_ENABLED"), builder::enabled);
    set(env.captureProfile("APILENS_CAPTURE_PROFILE"), builder::captureProfile);
    set(env.bool("APILENS_CAPTURE_HEADERS"), builder::captureHeaders);
    set(env.bool("APILENS_CAPTURE_PAYLOADS"), builder::capturePayloads);
    set(env.bool("APILENS_LOG_REQUEST_BODY"), builder::logRequestBody);
    set(env.bool("APILENS_LOG_RESPONSE_BODY"), builder::logResponseBody);
    set(env.integer("APILENS_MAX_PAYLOAD_BYTES"), builder::maxPayloadBytes);
    set(env.list("APILENS_REDACT_QUERY_PARAMS"), builder::redactQueryParams);
    set(env.list("APILENS_REDACT_HEADERS"), builder::redactHeaders);
    set(env.list("APILENS_REDACT_BODY_FIELDS"), builder::redactBodyFields);
    set(env.bool("APILENS_DEFAULT_EXCLUSIONS"), builder::defaultExclusions);
    set(env.number("APILENS_SAMPLE_RATE"), builder::sampleRate);
    set(env.bool("APILENS_CAPTURE_IP"), builder::captureIp);
    set(env.bool("APILENS_ANONYMIZE_IP"), builder::anonymizeIp);
    set(env.bool("APILENS_CAPTURE_SPANS"), builder::captureSpans);
    set(env.string("APILENS_SERVICE_NAME"), builder::serviceName);
    return builder;
  }

  private static <T> void set(T value, Consumer<T> setter) {
    if (value != null) {
      setter.accept(value);
    }
  }

  /** A builder pre-filled with these options. */
  public Builder toBuilder() {
    Builder builder = new Builder();
    builder.logRequestBody = explicitLogRequestBody;
    builder.logResponseBody = explicitLogResponseBody;
    builder.capturePayloads = explicitCapturePayloads;
    builder.captureHeaders = explicitCaptureHeaders;
    builder.maxPayloadBytes = explicitMaxPayloadBytes;
    return builder
        .environment(environment)
        .enabled(enabled)
        .enableRequestLogging(enableRequestLogging)
        .captureProfile(captureProfile)
        .captureSpans(captureSpans)
        .serviceName(serviceName)
        .redactQueryParams(redactQueryParams)
        .redactHeaders(redactHeaders)
        .redactBodyFields(redactBodyFields)
        .parametrizePaths(parametrizePaths)
        .captureIp(captureIp)
        .anonymizeIp(anonymizeIp)
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

  /** The capture preset the flags were resolved with; {@code null} when unset. */
  public CaptureProfile captureProfile() {
    return captureProfile;
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

  /** Whether the client IP is recorded at all; {@code false} sends an empty IP. */
  public boolean captureIp() {
    return captureIp;
  }

  /** Whether the client IP is truncated (IPv4 to /24, IPv6 to /48) before it is recorded. */
  public boolean anonymizeIp() {
    return anonymizeIp;
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
    // null = unset: filled from captureProfile, then the default.
    private Boolean logRequestBody;
    private Boolean logResponseBody;
    private Boolean capturePayloads;
    private Boolean captureHeaders;
    private boolean captureSpans = true;
    private String serviceName = "";
    private Integer maxPayloadBytes;
    private CaptureProfile captureProfile;
    private List<String> redactQueryParams = List.of();
    private List<String> redactHeaders = List.of();
    private List<String> redactBodyFields = List.of();
    private boolean parametrizePaths = true;
    private boolean captureIp = true;
    private boolean anonymizeIp = false;
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

    /**
     * Capture preset ({@code null} for none). It only fills {@code captureHeaders},
     * {@code capturePayloads}, {@code logRequestBody}, {@code logResponseBody} and
     * {@code maxPayloadBytes} when they are not set on this builder, so an individual flag
     * always wins.
     */
    public Builder captureProfile(CaptureProfile captureProfile) {
      this.captureProfile = captureProfile;
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

    public Builder captureIp(boolean captureIp) {
      this.captureIp = captureIp;
      return this;
    }

    public Builder anonymizeIp(boolean anonymizeIp) {
      this.anonymizeIp = anonymizeIp;
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
