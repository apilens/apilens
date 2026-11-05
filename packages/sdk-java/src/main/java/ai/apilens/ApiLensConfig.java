package ai.apilens;

import ai.apilens.internal.Strings;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

/** Runtime configuration for {@link ApiLensClient}. */
public final class ApiLensConfig {
  /** Smallest accepted {@code maxBatchBytes}. */
  public static final int MIN_BATCH_BYTES = 1024;

  private final String apiKey;
  private final String projectSlug;
  private final String appId;
  private final String baseUrl;
  private final String ingestPath;
  private final String spansPath;
  private final String logsPath;
  private final String environment;
  private final String release;
  private final String commit;
  private final int batchSize;
  private final Duration flushInterval;
  private final Duration timeout;
  private final boolean verifyTls;
  private final String caBundlePath;
  private final int maxQueueSize;
  private final long maxQueueBytes;
  private final int maxBatchBytes;
  private final boolean compress;
  private final int maxRetries;
  private final Duration retryBackoffBase;
  private final Duration retryBackoffMax;
  private final boolean enabled;
  private final String userAgent;

  private ApiLensConfig(Builder builder) {
    this.apiKey = Strings.clean(builder.apiKey);
    this.projectSlug = Strings.clean(builder.projectSlug);
    this.appId = Strings.clean(builder.appId);
    this.baseUrl = Strings.firstNonBlank(builder.baseUrl, "https://ingest.apilens.ai/v1");
    this.ingestPath = Strings.firstNonBlank(builder.ingestPath, "requests");
    this.spansPath = Strings.firstNonBlank(builder.spansPath, "traces");
    this.logsPath = Strings.firstNonBlank(builder.logsPath, "logs");
    this.environment = Strings.firstNonBlank(builder.environment, "production");
    this.release = Strings.firstNonBlank(builder.release, detectRelease());
    this.commit = Strings.firstNonBlank(builder.commit, detectCommit());
    this.batchSize = builder.batchSize;
    this.flushInterval = builder.flushInterval;
    this.timeout = builder.timeout;
    this.verifyTls = builder.verifyTls;
    this.caBundlePath = Strings.clean(builder.caBundlePath);
    this.maxQueueSize = builder.maxQueueSize;
    this.maxQueueBytes = builder.maxQueueBytes;
    this.maxBatchBytes = builder.maxBatchBytes;
    this.compress = builder.compress;
    this.maxRetries = builder.maxRetries;
    this.retryBackoffBase = builder.retryBackoffBase;
    this.retryBackoffMax = builder.retryBackoffMax;
    this.enabled = builder.enabled;
    this.userAgent = Strings.firstNonBlank(builder.userAgent, "apilens-java-sdk/" + ApiLensVersion.VERSION);
  }

  public static Builder builder() {
    return new Builder();
  }

  /**
   * A config read from the {@code APILENS_*} environment variables, for apps without Spring Boot.
   *
   * @throws IllegalArgumentException naming the variable when a value cannot be parsed
   */
  public static ApiLensConfig fromEnv() {
    return builderFromEnv().build();
  }

  /** {@link #fromEnv()} over a fixed map of variables. */
  public static ApiLensConfig fromEnv(Map<String, String> variables) {
    return builderFromEnv(variables).build();
  }

  /**
   * A builder pre-filled from the {@code APILENS_*} environment variables. Setters called on it
   * afterwards win, so the precedence is explicit &gt; env &gt; default.
   */
  public static Builder builderFromEnv() {
    return builderFromEnv(ApiLensEnv.system());
  }

  /** {@link #builderFromEnv()} over a fixed map of variables. */
  public static Builder builderFromEnv(Map<String, String> variables) {
    return builderFromEnv(ApiLensEnv.of(variables));
  }

  static Builder builderFromEnv(ApiLensEnv env) {
    Builder builder = builder();
    set(env.string("APILENS_API_KEY"), builder::apiKey);
    set(env.string("APILENS_PROJECT_SLUG"), builder::projectSlug);
    set(env.string("APILENS_APP_ID"), builder::appId);
    set(env.string("APILENS_BASE_URL"), builder::baseUrl);
    set(env.string("APILENS_ENVIRONMENT"), builder::environment);
    set(env.bool("APILENS_ENABLED"), builder::enabled);
    set(env.integer("APILENS_BATCH_SIZE"), builder::batchSize);
    set(env.seconds("APILENS_FLUSH_INTERVAL"), builder::flushInterval);
    set(env.seconds("APILENS_TIMEOUT"), builder::timeout);
    set(env.bool("APILENS_VERIFY_TLS"), builder::verifyTls);
    set(env.string("APILENS_CA_BUNDLE_PATH"), builder::caBundlePath);
    set(env.integer("APILENS_MAX_QUEUE_SIZE"), builder::maxQueueSize);
    set(env.longValue("APILENS_MAX_QUEUE_BYTES"), builder::maxQueueBytes);
    set(env.integer("APILENS_MAX_BATCH_BYTES"), builder::maxBatchBytes);
    set(env.bool("APILENS_COMPRESS"), builder::compress);
    set(env.integer("APILENS_MAX_RETRIES"), builder::maxRetries);
    return builder;
  }

  private static <T> void set(T value, Consumer<T> setter) {
    if (value != null) {
      setter.accept(value);
    }
  }

  public String apiKey() {
    return apiKey;
  }

  public String projectSlug() {
    return projectSlug;
  }

  public String appId() {
    return appId;
  }

  public String baseUrl() {
    return baseUrl;
  }

  public String ingestPath() {
    return ingestPath;
  }

  public String spansPath() {
    return spansPath;
  }

  public String logsPath() {
    return logsPath;
  }

  public String environment() {
    return environment;
  }

  public String release() {
    return release;
  }

  public String commit() {
    return commit;
  }

  public int batchSize() {
    return batchSize;
  }

  public Duration flushInterval() {
    return flushInterval;
  }

  public Duration timeout() {
    return timeout;
  }

  public boolean verifyTls() {
    return verifyTls;
  }

  public String caBundlePath() {
    return caBundlePath;
  }

  public int maxQueueSize() {
    return maxQueueSize;
  }

  /** Estimated bytes all three queues (requests, spans, logs) may hold together. */
  public long maxQueueBytes() {
    return maxQueueBytes;
  }

  /** Upper bound on one ingest request body (uncompressed JSON). */
  public int maxBatchBytes() {
    return maxBatchBytes;
  }

  /** Whether batch bodies are gzipped ({@code Content-Encoding: gzip}). */
  public boolean compress() {
    return compress;
  }

  public int maxRetries() {
    return maxRetries;
  }

  public Duration retryBackoffBase() {
    return retryBackoffBase;
  }

  public Duration retryBackoffMax() {
    return retryBackoffMax;
  }

  public boolean enabled() {
    return enabled;
  }

  public String userAgent() {
    return userAgent;
  }

  private static String detectRelease() {
    return Strings.clean(System.getenv("APILENS_RELEASE"));
  }

  private static String detectCommit() {
    for (String name : new String[] {"APILENS_COMMIT", "GIT_COMMIT", "SOURCE_VERSION", "RENDER_GIT_COMMIT"}) {
      String value = Strings.clean(System.getenv(name));
      if (!value.isEmpty()) {
        return value;
      }
    }
    return "";
  }

  public static final class Builder {
    private String apiKey = "";
    private String projectSlug = "";
    private String appId = "";
    private String baseUrl = "";
    private String ingestPath = "";
    private String spansPath = "";
    private String logsPath = "";
    private String environment = "";
    private String release = "";
    private String commit = "";
    private int batchSize = 200;
    private Duration flushInterval = Duration.ofSeconds(3);
    private Duration timeout = Duration.ofSeconds(5);
    private boolean verifyTls = true;
    private String caBundlePath = "";
    private int maxQueueSize = 10_000;
    private long maxQueueBytes = 64L * 1024 * 1024;
    private int maxBatchBytes = 4 * 1024 * 1024;
    private boolean compress = true;
    private int maxRetries = 3;
    private Duration retryBackoffBase = Duration.ofMillis(250);
    private Duration retryBackoffMax = Duration.ofSeconds(5);
    private boolean enabled = true;
    private String userAgent = "";

    private Builder() {}

    public Builder apiKey(String apiKey) {
      this.apiKey = apiKey;
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

    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    public Builder ingestPath(String ingestPath) {
      this.ingestPath = ingestPath;
      return this;
    }

    public Builder spansPath(String spansPath) {
      this.spansPath = spansPath;
      return this;
    }

    public Builder logsPath(String logsPath) {
      this.logsPath = logsPath;
      return this;
    }

    public Builder environment(String environment) {
      this.environment = environment;
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

    public Builder batchSize(int batchSize) {
      this.batchSize = batchSize;
      return this;
    }

    public Builder flushInterval(Duration flushInterval) {
      this.flushInterval = flushInterval == null ? Duration.ofSeconds(3) : flushInterval;
      return this;
    }

    public Builder timeout(Duration timeout) {
      this.timeout = timeout == null ? Duration.ofSeconds(5) : timeout;
      return this;
    }

    public Builder verifyTls(boolean verifyTls) {
      this.verifyTls = verifyTls;
      return this;
    }

    public Builder caBundlePath(String caBundlePath) {
      this.caBundlePath = caBundlePath;
      return this;
    }

    public Builder maxQueueSize(int maxQueueSize) {
      this.maxQueueSize = maxQueueSize;
      return this;
    }

    public Builder maxQueueBytes(long maxQueueBytes) {
      this.maxQueueBytes = maxQueueBytes;
      return this;
    }

    public Builder maxBatchBytes(int maxBatchBytes) {
      this.maxBatchBytes = maxBatchBytes;
      return this;
    }

    public Builder compress(boolean compress) {
      this.compress = compress;
      return this;
    }

    public Builder maxRetries(int maxRetries) {
      this.maxRetries = maxRetries;
      return this;
    }

    public Builder retryBackoffBase(Duration retryBackoffBase) {
      this.retryBackoffBase = retryBackoffBase == null ? Duration.ofMillis(250) : retryBackoffBase;
      return this;
    }

    public Builder retryBackoffMax(Duration retryBackoffMax) {
      this.retryBackoffMax = retryBackoffMax == null ? Duration.ofSeconds(5) : retryBackoffMax;
      return this;
    }

    public Builder enabled(boolean enabled) {
      this.enabled = enabled;
      return this;
    }

    public Builder userAgent(String userAgent) {
      this.userAgent = userAgent;
      return this;
    }

    public ApiLensConfig build() {
      if (batchSize <= 0 || batchSize > 1000) {
        throw new IllegalArgumentException("batchSize must be between 1 and 1000");
      }
      if (maxQueueSize <= 0) {
        throw new IllegalArgumentException("maxQueueSize must be > 0");
      }
      if (maxQueueBytes <= 0) {
        throw new IllegalArgumentException("maxQueueBytes must be > 0");
      }
      if (maxBatchBytes < MIN_BATCH_BYTES) {
        throw new IllegalArgumentException("maxBatchBytes must be >= " + MIN_BATCH_BYTES);
      }
      if (maxRetries < 0) {
        throw new IllegalArgumentException("maxRetries must be >= 0");
      }
      if (flushInterval.isNegative() || flushInterval.isZero()) {
        throw new IllegalArgumentException("flushInterval must be > 0");
      }
      if (timeout.isNegative() || timeout.isZero()) {
        throw new IllegalArgumentException("timeout must be > 0");
      }
      if (retryBackoffBase.isNegative() || retryBackoffBase.isZero()) {
        throw new IllegalArgumentException("retryBackoffBase must be > 0");
      }
      if (retryBackoffMax.isNegative() || retryBackoffMax.isZero()) {
        throw new IllegalArgumentException("retryBackoffMax must be > 0");
      }
      if (!Strings.isBlank(environment)) {
        environment = environment.trim().toLowerCase(Locale.ROOT);
      }
      return new ApiLensConfig(this);
    }
  }
}
