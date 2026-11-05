package ai.apilens.spring;

import ai.apilens.ApiLensConfig;
import ai.apilens.CaptureProfile;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Spring Boot properties for API Lens. */
@ConfigurationProperties(prefix = "apilens")
public class ApiLensProperties {
  /** Project API key. Auto-configuration is enabled only when this is set. */
  private String apiKey = "";
  /** Optional project slug assertion; the key already identifies the project. */
  private String projectSlug = "";
  /** App slug the captured traffic belongs to. */
  private String appId = "";
  /** Ingest base URL. */
  private String baseUrl = "https://ingest.apilens.ai/v1";
  /** Request batch path, relative to the base URL. */
  private String ingestPath = "requests";
  /** Span batch path, relative to the base URL. */
  private String spansPath = "traces";
  /** Log batch path, relative to the base URL. */
  private String logsPath = "logs";
  /** Environment label, e.g. production or staging (lower-cased). */
  private String environment = "production";
  /** Release label; falls back to APILENS_RELEASE. */
  private String release = "";
  /** Commit SHA; falls back to APILENS_COMMIT, GIT_COMMIT, SOURCE_VERSION, RENDER_GIT_COMMIT. */
  private String commit = "";
  /** Records per ingest request (1-1000). */
  private int batchSize = 200;
  /** Interval between background flushes. */
  private Duration flushInterval = Duration.ofSeconds(3);
  /** HTTP timeout for one ingest request. */
  private Duration timeout = Duration.ofSeconds(5);
  /** Whether the ingest TLS certificate is verified. */
  private boolean verifyTls = true;
  /** PEM CA bundle used to verify the ingest TLS certificate. */
  private String caBundlePath = "";
  /** Records each queue (requests, spans, logs) may hold; the oldest are dropped when full. */
  private int maxQueueSize = 10_000;
  /** Estimated bytes the three queues may hold together; the oldest are dropped when full. */
  private long maxQueueBytes = 67_108_864L;
  /** Upper bound on one ingest request body (uncompressed JSON, at least 1024). */
  private int maxBatchBytes = 4_194_304;
  /** Whether batch bodies are gzipped (Content-Encoding: gzip). */
  private boolean compress = true;
  /** Retries for 408, 429, 5xx and network errors. */
  private int maxRetries = 3;
  /** Base delay of the full-jitter exponential retry backoff. */
  private Duration retryBackoffBase = Duration.ofMillis(250);
  /** Cap on one retry backoff delay. */
  private Duration retryBackoffMax = Duration.ofSeconds(5);
  /** Master switch: false sends nothing. */
  private boolean enabled = true;
  /** User-Agent of ingest requests; defaults to apilens-java-sdk/VERSION. */
  private String userAgent = "";
  /** Whether POST /v1/heartbeat is sent (on start, every heartbeat-interval and on shutdown). */
  private boolean sendHeartbeat = true;
  /** Time between heartbeats; at least 10s. */
  private Duration heartbeatInterval = Duration.ofSeconds(60);
  /** Whether the app metadata report (POST /v1/metadata) is sent once the app is ready. */
  private boolean sendMetadata = true;
  /** Whether request headers and bodies are captured at all. */
  private boolean enableRequestLogging = true;
  /**
   * Capture preset: metadata (no headers or bodies), redacted (headers and masked bodies, 16 KB
   * cap) or full (the defaults). It only fills capture-headers, capture-payloads,
   * log-request-body, log-response-body and max-payload-bytes when they are not set.
   */
  private CaptureProfile captureProfile;
  /** Whether request bodies are captured. Default true, unless capture-profile says otherwise. */
  private Boolean logRequestBody;
  /** Whether response bodies are captured. Default true, unless capture-profile says otherwise. */
  private Boolean logResponseBody;
  /** Whether request and response bodies are captured. Default true, unless capture-profile says otherwise. */
  private Boolean capturePayloads;
  /** Whether request and response headers are captured (redacted). Default true, unless capture-profile says otherwise. */
  private Boolean captureHeaders;
  /** Whether a server span is emitted per request. */
  private boolean captureSpans = true;
  /** Service name on spans; defaults to the app id. */
  private String serviceName = "";
  /** Body capture cap in bytes; 0 disables bodies. Default 65536 (16384 under capture-profile=redacted). */
  private Integer maxPayloadBytes;
  /** Extra query-parameter name regexes whose values are redacted; built-ins always apply. */
  private List<String> redactQueryParams = List.of();
  /** Extra header name regexes whose values are redacted; built-ins always apply. */
  private List<String> redactHeaders = List.of();
  /** Extra JSON/form body field name regexes whose values are redacted; built-ins always apply. */
  private List<String> redactBodyFields = List.of();
  /** Whether raw paths are grouped into route templates such as /orders/{id}. */
  private boolean parametrizePaths = true;
  /** Whether the client IP is recorded at all. */
  private boolean captureIp = true;
  /** Whether the client IP is truncated (IPv4 to /24, IPv6 to /48). */
  private boolean anonymizeIp = false;
  /** Case-insensitive path regexes of requests that are not captured at all. */
  private List<String> excludePaths = List.of();
  /** Case-insensitive User-Agent regexes of requests that are not captured at all. */
  private List<String> excludeUserAgents = List.of();
  /** Whether the built-in health-check, probe and static-file exclusions apply. */
  private boolean defaultExclusions = true;
  /** Fraction (0.0-1.0) of requests whose detail is kept; metrics always count every request. */
  private double sampleRate = 1.0;
  /** Order of the servlet filter registration, or of the WebFlux {@code WebFilter}. */
  private int filterOrder = Integer.MAX_VALUE - 100;

  public ApiLensConfig toClientConfig() {
    return ApiLensConfig.builder()
        .apiKey(apiKey)
        .projectSlug(projectSlug)
        .appId(appId)
        .baseUrl(baseUrl)
        .ingestPath(ingestPath)
        .spansPath(spansPath)
        .logsPath(logsPath)
        .environment(environment)
        .release(release)
        .commit(commit)
        .batchSize(batchSize)
        .flushInterval(flushInterval)
        .timeout(timeout)
        .verifyTls(verifyTls)
        .caBundlePath(caBundlePath)
        .maxQueueSize(maxQueueSize)
        .maxQueueBytes(maxQueueBytes)
        .maxBatchBytes(maxBatchBytes)
        .compress(compress)
        .maxRetries(maxRetries)
        .retryBackoffBase(retryBackoffBase)
        .retryBackoffMax(retryBackoffMax)
        .enabled(enabled)
        .userAgent(userAgent)
        .sendHeartbeat(sendHeartbeat)
        .heartbeatInterval(heartbeatInterval)
        .sendMetadata(sendMetadata)
        .build();
  }

  public ApiLensSpringOptions toSpringOptions() {
    ApiLensSpringOptions.Builder builder = ApiLensSpringOptions.builder();
    // Unset capture flags stay unset so capture-profile can fill them.
    if (logRequestBody != null) {
      builder.logRequestBody(logRequestBody);
    }
    if (logResponseBody != null) {
      builder.logResponseBody(logResponseBody);
    }
    if (capturePayloads != null) {
      builder.capturePayloads(capturePayloads);
    }
    if (captureHeaders != null) {
      builder.captureHeaders(captureHeaders);
    }
    if (maxPayloadBytes != null) {
      builder.maxPayloadBytes(maxPayloadBytes);
    }
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
        .sampleRate(sampleRate)
        .build();
  }

  public String getApiKey() {
    return apiKey;
  }

  public void setApiKey(String apiKey) {
    this.apiKey = apiKey;
  }

  public String getProjectSlug() {
    return projectSlug;
  }

  public void setProjectSlug(String projectSlug) {
    this.projectSlug = projectSlug;
  }

  public String getAppId() {
    return appId;
  }

  public void setAppId(String appId) {
    this.appId = appId;
  }

  public String getBaseUrl() {
    return baseUrl;
  }

  public void setBaseUrl(String baseUrl) {
    this.baseUrl = baseUrl;
  }

  public String getIngestPath() {
    return ingestPath;
  }

  public void setIngestPath(String ingestPath) {
    this.ingestPath = ingestPath;
  }

  public String getSpansPath() {
    return spansPath;
  }

  public void setSpansPath(String spansPath) {
    this.spansPath = spansPath;
  }

  public String getLogsPath() {
    return logsPath;
  }

  public void setLogsPath(String logsPath) {
    this.logsPath = logsPath;
  }

  public String getEnvironment() {
    return environment;
  }

  public void setEnvironment(String environment) {
    this.environment = environment;
  }

  public String getRelease() {
    return release;
  }

  public void setRelease(String release) {
    this.release = release;
  }

  public String getCommit() {
    return commit;
  }

  public void setCommit(String commit) {
    this.commit = commit;
  }

  public int getBatchSize() {
    return batchSize;
  }

  public void setBatchSize(int batchSize) {
    this.batchSize = batchSize;
  }

  public Duration getFlushInterval() {
    return flushInterval;
  }

  public void setFlushInterval(Duration flushInterval) {
    this.flushInterval = flushInterval;
  }

  public Duration getTimeout() {
    return timeout;
  }

  public void setTimeout(Duration timeout) {
    this.timeout = timeout;
  }

  public boolean isVerifyTls() {
    return verifyTls;
  }

  public void setVerifyTls(boolean verifyTls) {
    this.verifyTls = verifyTls;
  }

  public String getCaBundlePath() {
    return caBundlePath;
  }

  public void setCaBundlePath(String caBundlePath) {
    this.caBundlePath = caBundlePath;
  }

  public int getMaxQueueSize() {
    return maxQueueSize;
  }

  public void setMaxQueueSize(int maxQueueSize) {
    this.maxQueueSize = maxQueueSize;
  }

  public long getMaxQueueBytes() {
    return maxQueueBytes;
  }

  public void setMaxQueueBytes(long maxQueueBytes) {
    this.maxQueueBytes = maxQueueBytes;
  }

  public int getMaxBatchBytes() {
    return maxBatchBytes;
  }

  public void setMaxBatchBytes(int maxBatchBytes) {
    this.maxBatchBytes = maxBatchBytes;
  }

  public boolean isCompress() {
    return compress;
  }

  public void setCompress(boolean compress) {
    this.compress = compress;
  }

  public int getMaxRetries() {
    return maxRetries;
  }

  public void setMaxRetries(int maxRetries) {
    this.maxRetries = maxRetries;
  }

  public Duration getRetryBackoffBase() {
    return retryBackoffBase;
  }

  public void setRetryBackoffBase(Duration retryBackoffBase) {
    this.retryBackoffBase = retryBackoffBase;
  }

  public Duration getRetryBackoffMax() {
    return retryBackoffMax;
  }

  public void setRetryBackoffMax(Duration retryBackoffMax) {
    this.retryBackoffMax = retryBackoffMax;
  }

  public boolean isEnabled() {
    return enabled;
  }

  public void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  public String getUserAgent() {
    return userAgent;
  }

  public void setUserAgent(String userAgent) {
    this.userAgent = userAgent;
  }

  /** {@code apilens.send-heartbeat}: send {@code POST /v1/heartbeat} (default true). */
  public boolean isSendHeartbeat() {
    return sendHeartbeat;
  }

  public void setSendHeartbeat(boolean sendHeartbeat) {
    this.sendHeartbeat = sendHeartbeat;
  }

  /** {@code apilens.heartbeat-interval}: time between heartbeats (default 60s, at least 10s). */
  public Duration getHeartbeatInterval() {
    return heartbeatInterval;
  }

  public void setHeartbeatInterval(Duration heartbeatInterval) {
    this.heartbeatInterval = heartbeatInterval;
  }

  /** {@code apilens.send-metadata}: send the app metadata report on startup (default true). */
  public boolean isSendMetadata() {
    return sendMetadata;
  }

  public void setSendMetadata(boolean sendMetadata) {
    this.sendMetadata = sendMetadata;
  }

  public boolean isEnableRequestLogging() {
    return enableRequestLogging;
  }

  public void setEnableRequestLogging(boolean enableRequestLogging) {
    this.enableRequestLogging = enableRequestLogging;
  }

  public CaptureProfile getCaptureProfile() {
    return captureProfile;
  }

  public void setCaptureProfile(CaptureProfile captureProfile) {
    this.captureProfile = captureProfile;
  }

  public Boolean getLogRequestBody() {
    return logRequestBody;
  }

  public void setLogRequestBody(Boolean logRequestBody) {
    this.logRequestBody = logRequestBody;
  }

  public Boolean getLogResponseBody() {
    return logResponseBody;
  }

  public void setLogResponseBody(Boolean logResponseBody) {
    this.logResponseBody = logResponseBody;
  }

  public Boolean getCapturePayloads() {
    return capturePayloads;
  }

  public void setCapturePayloads(Boolean capturePayloads) {
    this.capturePayloads = capturePayloads;
  }

  public Boolean getCaptureHeaders() {
    return captureHeaders;
  }

  public void setCaptureHeaders(Boolean captureHeaders) {
    this.captureHeaders = captureHeaders;
  }

  public boolean isCaptureSpans() {
    return captureSpans;
  }

  public void setCaptureSpans(boolean captureSpans) {
    this.captureSpans = captureSpans;
  }

  public String getServiceName() {
    return serviceName;
  }

  public void setServiceName(String serviceName) {
    this.serviceName = serviceName;
  }

  public Integer getMaxPayloadBytes() {
    return maxPayloadBytes;
  }

  public void setMaxPayloadBytes(Integer maxPayloadBytes) {
    this.maxPayloadBytes = maxPayloadBytes;
  }

  public List<String> getRedactQueryParams() {
    return redactQueryParams;
  }

  public void setRedactQueryParams(List<String> redactQueryParams) {
    this.redactQueryParams = redactQueryParams;
  }

  public List<String> getRedactHeaders() {
    return redactHeaders;
  }

  public void setRedactHeaders(List<String> redactHeaders) {
    this.redactHeaders = redactHeaders;
  }

  public List<String> getRedactBodyFields() {
    return redactBodyFields;
  }

  public void setRedactBodyFields(List<String> redactBodyFields) {
    this.redactBodyFields = redactBodyFields;
  }

  public boolean isParametrizePaths() {
    return parametrizePaths;
  }

  public void setParametrizePaths(boolean parametrizePaths) {
    this.parametrizePaths = parametrizePaths;
  }

  public boolean isCaptureIp() {
    return captureIp;
  }

  public void setCaptureIp(boolean captureIp) {
    this.captureIp = captureIp;
  }

  public boolean isAnonymizeIp() {
    return anonymizeIp;
  }

  public void setAnonymizeIp(boolean anonymizeIp) {
    this.anonymizeIp = anonymizeIp;
  }

  public List<String> getExcludePaths() {
    return excludePaths;
  }

  public void setExcludePaths(List<String> excludePaths) {
    this.excludePaths = excludePaths;
  }

  public List<String> getExcludeUserAgents() {
    return excludeUserAgents;
  }

  public void setExcludeUserAgents(List<String> excludeUserAgents) {
    this.excludeUserAgents = excludeUserAgents;
  }

  public boolean isDefaultExclusions() {
    return defaultExclusions;
  }

  public void setDefaultExclusions(boolean defaultExclusions) {
    this.defaultExclusions = defaultExclusions;
  }

  public double getSampleRate() {
    return sampleRate;
  }

  public void setSampleRate(double sampleRate) {
    this.sampleRate = sampleRate;
  }

  public int getFilterOrder() {
    return filterOrder;
  }

  public void setFilterOrder(int filterOrder) {
    this.filterOrder = filterOrder;
  }
}
