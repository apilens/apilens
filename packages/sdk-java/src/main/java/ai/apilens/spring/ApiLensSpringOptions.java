package ai.apilens.spring;

import java.util.List;

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
  }

  public static Builder builder() {
    return new Builder();
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

    public ApiLensSpringOptions build() {
      return new ApiLensSpringOptions(this);
    }
  }
}
