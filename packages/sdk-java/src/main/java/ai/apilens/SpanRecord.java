package ai.apilens;

import ai.apilens.internal.Strings;
import ai.apilens.internal.Wire;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/** One distributed-trace span sent to the API Lens /traces ingest endpoint. */
public final class SpanRecord {
  private final Instant timestamp;
  private final String environment;
  private final String traceId;
  private final String spanId;
  private final String parentSpanId;
  private final String name;
  private final String kind;
  private final String serviceName;
  private final double durationMs;
  private final String status;
  private final int statusCode;
  private final String projectSlug;
  private final String appId;
  private final Map<String, String> attributes;
  private final String release;
  private final String commit;

  private SpanRecord(Builder builder) {
    this.timestamp = builder.timestamp == null ? Instant.now() : builder.timestamp;
    this.environment = Strings.clean(builder.environment);
    this.traceId = Strings.clean(builder.traceId);
    this.spanId = Strings.clean(builder.spanId);
    this.parentSpanId = Strings.clean(builder.parentSpanId);
    this.name = Strings.clean(builder.name);
    this.kind = Strings.firstNonBlank(builder.kind, "internal").toLowerCase();
    this.serviceName = Strings.clean(builder.serviceName);
    this.durationMs = Math.max(builder.durationMs, 0.0);
    this.status = Strings.firstNonBlank(builder.status, "ok").toLowerCase();
    this.statusCode = Math.max(builder.statusCode, 0);
    this.projectSlug = Strings.clean(builder.projectSlug);
    this.appId = Strings.clean(builder.appId);
    this.attributes = Map.copyOf(builder.attributes);
    this.release = Strings.clean(builder.release);
    this.commit = Strings.clean(builder.commit);
  }

  public static Builder builder() {
    return new Builder();
  }

  public Map<String, Object> toWire(ApiLensConfig config) {
    Map<String, Object> out = Wire.map();
    out.put("project_slug", Strings.firstNonBlank(projectSlug, config.projectSlug()));
    out.put("app_id", Strings.firstNonBlank(appId, config.appId()));
    out.put("timestamp", Wire.isoUtc(timestamp));
    out.put("environment", Strings.firstNonBlank(environment, config.environment()));
    out.put("trace_id", traceId);
    out.put("span_id", spanId);
    out.put("parent_span_id", parentSpanId);
    out.put("name", name);
    out.put("kind", kind);
    out.put("service_name", serviceName);
    out.put("duration_ms", durationMs);
    out.put("status", status);
    out.put("status_code", statusCode);
    out.put("attributes", attributes);
    out.put("release", Strings.firstNonBlank(release, config.release()));
    out.put("commit", Strings.firstNonBlank(commit, config.commit()));
    return out;
  }

  public static final class Builder {
    private Instant timestamp;
    private String environment = "";
    private String traceId = "";
    private String spanId = "";
    private String parentSpanId = "";
    private String name = "";
    private String kind = "internal";
    private String serviceName = "";
    private double durationMs;
    private String status = "ok";
    private int statusCode;
    private String projectSlug = "";
    private String appId = "";
    private Map<String, String> attributes = new LinkedHashMap<>();
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

    public Builder traceId(String traceId) {
      this.traceId = traceId;
      return this;
    }

    public Builder spanId(String spanId) {
      this.spanId = spanId;
      return this;
    }

    public Builder parentSpanId(String parentSpanId) {
      this.parentSpanId = parentSpanId;
      return this;
    }

    public Builder name(String name) {
      this.name = name;
      return this;
    }

    public Builder kind(String kind) {
      this.kind = kind;
      return this;
    }

    public Builder serviceName(String serviceName) {
      this.serviceName = serviceName;
      return this;
    }

    public Builder durationMs(double durationMs) {
      this.durationMs = durationMs;
      return this;
    }

    public Builder status(String status) {
      this.status = status;
      return this;
    }

    public Builder statusCode(int statusCode) {
      this.statusCode = statusCode;
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

    public Builder attribute(String key, String value) {
      if (!Strings.isBlank(key)) {
        this.attributes.put(key, value == null ? "" : value);
      }
      return this;
    }

    public Builder attributes(Map<String, String> attributes) {
      this.attributes = attributes == null ? new LinkedHashMap<>() : new LinkedHashMap<>(attributes);
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

    public SpanRecord build() {
      return new SpanRecord(this);
    }
  }
}
