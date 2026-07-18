package ai.apilens;

import ai.apilens.internal.Strings;
import ai.apilens.internal.Wire;
import java.time.Instant;
import java.util.Map;

/** One request record sent to the API Lens /requests ingest endpoint. */
public final class RequestRecord {
  private final Instant timestamp;
  private final String environment;
  private final String method;
  private final String path;
  private final String rawPath;
  private final int statusCode;
  private final double responseTimeMs;
  private final String projectSlug;
  private final String appId;
  private final long requestSize;
  private final long responseSize;
  private final String ipAddress;
  private final String userAgent;
  private final String consumerId;
  private final String consumerName;
  private final String consumerGroup;
  private final String requestPayload;
  private final String responsePayload;
  private final String requestHeaders;
  private final String responseHeaders;
  private final String baseUrl;
  private final String traceId;
  private final String spanId;
  private final String release;
  private final String commit;

  private RequestRecord(Builder builder) {
    this.timestamp = builder.timestamp == null ? Instant.now() : builder.timestamp;
    this.environment = Strings.clean(builder.environment);
    this.method = Strings.firstNonBlank(builder.method, "GET").toUpperCase();
    this.path = Strings.normalizePath(builder.path);
    this.rawPath = Strings.clean(builder.rawPath);
    this.statusCode = Math.max(builder.statusCode, 0);
    this.responseTimeMs = Math.max(builder.responseTimeMs, 0.0);
    this.projectSlug = Strings.clean(builder.projectSlug);
    this.appId = Strings.clean(builder.appId);
    this.requestSize = Math.max(builder.requestSize, 0);
    this.responseSize = Math.max(builder.responseSize, 0);
    this.ipAddress = Strings.clean(builder.ipAddress);
    this.userAgent = Strings.clean(builder.userAgent);
    this.consumerId = Strings.clean(builder.consumerId);
    this.consumerName = Strings.clean(builder.consumerName);
    this.consumerGroup = Strings.clean(builder.consumerGroup);
    this.requestPayload = builder.requestPayload == null ? "" : builder.requestPayload;
    this.responsePayload = builder.responsePayload == null ? "" : builder.responsePayload;
    this.requestHeaders = builder.requestHeaders == null ? "" : builder.requestHeaders;
    this.responseHeaders = builder.responseHeaders == null ? "" : builder.responseHeaders;
    this.baseUrl = Strings.clean(builder.baseUrl);
    this.traceId = Strings.clean(builder.traceId);
    this.spanId = Strings.clean(builder.spanId);
    this.release = Strings.clean(builder.release);
    this.commit = Strings.clean(builder.commit);
  }

  public static Builder builder() {
    return new Builder();
  }

  public String path() {
    return path;
  }

  public Map<String, Object> toWire(ApiLensConfig config) {
    String wirePath = Strings.normalizePath(path);
    String wireRawPath = Strings.firstNonBlank(rawPath, wirePath);
    if (!wireRawPath.startsWith("/")) {
      wireRawPath = "/" + wireRawPath;
    }

    Map<String, Object> out = Wire.map();
    out.put("project_slug", Strings.firstNonBlank(projectSlug, config.projectSlug()));
    out.put("app_id", Strings.firstNonBlank(appId, config.appId()));
    out.put("timestamp", Wire.isoUtc(timestamp));
    out.put("environment", Strings.firstNonBlank(environment, config.environment()));
    out.put("method", Strings.firstNonBlank(method, "GET").toUpperCase());
    out.put("path", wirePath);
    out.put("raw_path", wireRawPath);
    out.put("status_code", statusCode);
    out.put("response_time_ms", responseTimeMs);
    out.put("request_size", requestSize);
    out.put("response_size", responseSize);
    out.put("ip_address", ipAddress);
    out.put("user_agent", userAgent);
    out.put("consumer_id", consumerId);
    out.put("consumer_name", consumerName);
    out.put("consumer_group", consumerGroup);
    out.put("request_payload", requestPayload);
    out.put("response_payload", responsePayload);
    out.put("request_headers", requestHeaders);
    out.put("response_headers", responseHeaders);
    out.put("base_url", baseUrl);
    out.put("trace_id", traceId);
    out.put("span_id", spanId);
    out.put("release", Strings.firstNonBlank(release, config.release()));
    out.put("commit", Strings.firstNonBlank(commit, config.commit()));
    return out;
  }

  public static final class Builder {
    private Instant timestamp;
    private String environment = "";
    private String method = "GET";
    private String path = "/";
    private String rawPath = "";
    private int statusCode;
    private double responseTimeMs;
    private String projectSlug = "";
    private String appId = "";
    private long requestSize;
    private long responseSize;
    private String ipAddress = "";
    private String userAgent = "";
    private String consumerId = "";
    private String consumerName = "";
    private String consumerGroup = "";
    private String requestPayload = "";
    private String responsePayload = "";
    private String requestHeaders = "";
    private String responseHeaders = "";
    private String baseUrl = "";
    private String traceId = "";
    private String spanId = "";
    private String release = "";
    private String commit = "";

    private Builder() {}

    public Builder timestamp(Instant timestamp) {
      this.timestamp = timestamp;
      return this;
    }

    public Builder environment(String environment) {
      this.environment = environment;
      return this;
    }

    public Builder method(String method) {
      this.method = method;
      return this;
    }

    public Builder path(String path) {
      this.path = path;
      return this;
    }

    public Builder rawPath(String rawPath) {
      this.rawPath = rawPath;
      return this;
    }

    public Builder statusCode(int statusCode) {
      this.statusCode = statusCode;
      return this;
    }

    public Builder responseTimeMs(double responseTimeMs) {
      this.responseTimeMs = responseTimeMs;
      return this;
    }

    public Builder projectSlug(String projectSlug) {
      this.projectSlug = projectSlug;
      return this;
    }

    public Builder appId(String appId) {
      this.appId = appId;
      return this;
    }

    public Builder requestSize(long requestSize) {
      this.requestSize = requestSize;
      return this;
    }

    public Builder responseSize(long responseSize) {
      this.responseSize = responseSize;
      return this;
    }

    public Builder ipAddress(String ipAddress) {
      this.ipAddress = ipAddress;
      return this;
    }

    public Builder userAgent(String userAgent) {
      this.userAgent = userAgent;
      return this;
    }

    public Builder consumer(ApiLensConsumer consumer) {
      if (consumer != null) {
        this.consumerId = consumer.id();
        this.consumerName = consumer.name();
        this.consumerGroup = consumer.group();
      }
      return this;
    }

    public Builder consumerId(String consumerId) {
      this.consumerId = consumerId;
      return this;
    }

    public Builder consumerName(String consumerName) {
      this.consumerName = consumerName;
      return this;
    }

    public Builder consumerGroup(String consumerGroup) {
      this.consumerGroup = consumerGroup;
      return this;
    }

    public Builder requestPayload(String requestPayload) {
      this.requestPayload = requestPayload;
      return this;
    }

    public Builder responsePayload(String responsePayload) {
      this.responsePayload = responsePayload;
      return this;
    }

    public Builder requestHeaders(String requestHeaders) {
      this.requestHeaders = requestHeaders;
      return this;
    }

    public Builder responseHeaders(String responseHeaders) {
      this.responseHeaders = responseHeaders;
      return this;
    }

    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    public Builder traceId(String traceId) {
      this.traceId = traceId;
      return this;
    }

    public Builder spanId(String spanId) {
      this.spanId = spanId;
      return this;
    }

    public Builder release(String release) {
      this.release = release;
      return this;
    }

    public Builder commit(String commit) {
      this.commit = commit;
      return this;
    }

    public RequestRecord build() {
      return new RequestRecord(this);
    }
  }
}
