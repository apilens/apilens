package ai.apilens;

import ai.apilens.internal.Strings;
import ai.apilens.internal.Wire;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/** One error log sent to the API Lens /logs ingest endpoint. */
public final class LogRecord {
  private final Instant timestamp;
  private final String environment;
  private final String level;
  private final String message;
  private final String traceId;
  private final String spanId;
  private final String loggerName;
  private final String endpointMethod;
  private final String endpointPath;
  private final int statusCode;
  private final String consumerId;
  private final String consumerName;
  private final String consumerGroup;
  private final String projectSlug;
  private final String appId;
  private final String payload;
  private final Map<String, String> attributes;
  private final String release;
  private final String commit;

  private LogRecord(Builder builder) {
    this.timestamp = builder.timestamp == null ? Instant.now() : builder.timestamp;
    this.environment = Strings.clean(builder.environment);
    this.level = Strings.firstNonBlank(builder.level, "INFO").toUpperCase();
    this.message = Strings.truncate(builder.message, 4000);
    this.traceId = Strings.clean(builder.traceId);
    this.spanId = Strings.clean(builder.spanId);
    this.loggerName = Strings.clean(builder.loggerName);
    this.endpointMethod = Strings.clean(builder.endpointMethod).toUpperCase();
    this.endpointPath = Strings.clean(builder.endpointPath);
    this.statusCode = Math.max(builder.statusCode, 0);
    this.consumerId = Strings.clean(builder.consumerId);
    this.consumerName = Strings.clean(builder.consumerName);
    this.consumerGroup = Strings.clean(builder.consumerGroup);
    this.projectSlug = Strings.clean(builder.projectSlug);
    this.appId = Strings.clean(builder.appId);
    this.payload = Strings.truncate(builder.payload, 8000);
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
    out.put("level", level);
    out.put("message", message);
    out.put("logger_name", loggerName);
    out.put("endpoint_method", endpointMethod);
    out.put("endpoint_path", endpointPath);
    out.put("status_code", statusCode);
    out.put("consumer_id", consumerId);
    out.put("consumer_name", consumerName);
    out.put("consumer_group", consumerGroup);
    out.put("trace_id", traceId);
    out.put("span_id", spanId);
    out.put("payload", payload);
    out.put("attributes", attributes);
    out.put("release", Strings.firstNonBlank(release, config.release()));
    out.put("commit", Strings.firstNonBlank(commit, config.commit()));
    return out;
  }

  public static final class Builder {
    private Instant timestamp;
    private String environment = "";
    private String level = "INFO";
    private String message = "";
    private String traceId = "";
    private String spanId = "";
    private String loggerName = "";
    private String endpointMethod = "";
    private String endpointPath = "";
    private int statusCode;
    private String consumerId = "";
    private String consumerName = "";
    private String consumerGroup = "";
    private String projectSlug = "";
    private String appId = "";
    private String payload = "";
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

    public Builder level(String level) {
      this.level = level;
      return this;
    }

    public Builder message(String message) {
      this.message = message;
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

    public Builder loggerName(String loggerName) {
      this.loggerName = loggerName;
      return this;
    }

    public Builder endpointMethod(String endpointMethod) {
      this.endpointMethod = endpointMethod;
      return this;
    }

    public Builder endpointPath(String endpointPath) {
      this.endpointPath = endpointPath;
      return this;
    }

    public Builder statusCode(int statusCode) {
      this.statusCode = statusCode;
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

    public Builder projectSlug(String projectSlug) {
      this.projectSlug = projectSlug;
      return this;
    }

    public Builder appId(String appId) {
      this.appId = appId;
      return this;
    }

    public Builder payload(String payload) {
      this.payload = payload;
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

    public LogRecord build() {
      return new LogRecord(this);
    }
  }
}
