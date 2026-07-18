package ai.apilens.spring;

import ai.apilens.ApiLensConfig;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Spring Boot properties for API Lens. */
@ConfigurationProperties(prefix = "apilens")
public class ApiLensProperties {
  private String apiKey = "";
  private String projectSlug = "";
  private String appId = "";
  private String baseUrl = "https://ingest.apilens.ai/v1";
  private String ingestPath = "requests";
  private String spansPath = "traces";
  private String logsPath = "logs";
  private String environment = "production";
  private String release = "";
  private String commit = "";
  private int batchSize = 200;
  private Duration flushInterval = Duration.ofSeconds(3);
  private Duration timeout = Duration.ofSeconds(5);
  private boolean verifyTls = true;
  private String caBundlePath = "";
  private int maxQueueSize = 10_000;
  private int maxRetries = 3;
  private Duration retryBackoffBase = Duration.ofMillis(250);
  private Duration retryBackoffMax = Duration.ofSeconds(5);
  private boolean enabled = true;
  private String userAgent = "";
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
        .maxRetries(maxRetries)
        .retryBackoffBase(retryBackoffBase)
        .retryBackoffMax(retryBackoffMax)
        .enabled(enabled)
        .userAgent(userAgent)
        .build();
  }

  public ApiLensSpringOptions toSpringOptions() {
    return ApiLensSpringOptions.builder()
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

  public boolean isEnableRequestLogging() {
    return enableRequestLogging;
  }

  public void setEnableRequestLogging(boolean enableRequestLogging) {
    this.enableRequestLogging = enableRequestLogging;
  }

  public boolean isLogRequestBody() {
    return logRequestBody;
  }

  public void setLogRequestBody(boolean logRequestBody) {
    this.logRequestBody = logRequestBody;
  }

  public boolean isLogResponseBody() {
    return logResponseBody;
  }

  public void setLogResponseBody(boolean logResponseBody) {
    this.logResponseBody = logResponseBody;
  }

  public boolean isCapturePayloads() {
    return capturePayloads;
  }

  public void setCapturePayloads(boolean capturePayloads) {
    this.capturePayloads = capturePayloads;
  }

  public boolean isCaptureHeaders() {
    return captureHeaders;
  }

  public void setCaptureHeaders(boolean captureHeaders) {
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

  public int getMaxPayloadBytes() {
    return maxPayloadBytes;
  }

  public void setMaxPayloadBytes(int maxPayloadBytes) {
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

  public int getFilterOrder() {
    return filterOrder;
  }

  public void setFilterOrder(int filterOrder) {
    this.filterOrder = filterOrder;
  }
}
