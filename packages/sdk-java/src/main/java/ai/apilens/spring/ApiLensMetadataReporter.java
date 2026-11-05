package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.ApiLensVersion;
import ai.apilens.IpPrivacy;
import ai.apilens.Redactor;
import ai.apilens.RequestExcluder;
import ai.apilens.internal.Strings;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Pattern;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationListener;
import org.springframework.core.SpringVersion;
import org.springframework.util.ClassUtils;

/**
 * Sends the app metadata report ({@code POST /v1/metadata}) once the application is ready, so
 * every controller mapping is registered:
 *
 * <pre>{@code
 * {
 *   "app_id": "orders-api",
 *   "project_slug": "shop",               // only when configured
 *   "environment": "production",
 *   "framework": "spring-boot",           // "spring" without Spring Boot
 *   "framework_version": "3.5.16",
 *   "java_version": "21.0.5",
 *   "sdk_version": "0.1.0",
 *   "spring_version": "6.2.19",
 *   "routes": [{"method": "GET", "path": "/orders/{id}"}],   // at most 2000
 *   "config": { ...effective capture config, see effectiveConfig... }
 * }
 * }</pre>
 *
 * <p>Routes come from every {@code RequestMappingHandlerMapping} in the context (Spring MVC
 * {@code @RequestMapping} methods); a mapping without a method condition is reported as
 * {@code "*"}. Never sent: the API key, the CA bundle path, and anything about callbacks beyond
 * whether one is set.
 */
public class ApiLensMetadataReporter implements ApplicationListener<ApplicationReadyEvent> {
  private static final Logger LOGGER = Logger.getLogger("apilens");
  private static final String HANDLER_MAPPING_CLASS =
      "org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping";

  private final ApiLensClient client;
  private final ApiLensSpringFilter filter;
  private final boolean consumerResolver;

  public ApiLensMetadataReporter(ApiLensClient client, ApiLensSpringFilter filter, boolean consumerResolver) {
    this.client = client;
    this.filter = filter;
    this.consumerResolver = consumerResolver;
  }

  @Override
  public void onApplicationEvent(ApplicationReadyEvent event) {
    report(event.getApplicationContext());
  }

  /** Starts the report for {@code context}; {@code false} when it was already sent or is off. */
  public boolean report(ApplicationContext context) {
    try {
      ApiLensSpringOptions options = filter.options();
      if (!options.enabled()) {
        return false;
      }
      Map<String, Object> config = effectiveConfig(client.config(), options, filter.excluder(), consumerResolver);
      return client.reportMetadata(options.environment(), () -> payload(context, options, config));
    } catch (RuntimeException ex) {
      LOGGER.log(Level.FINE, "API Lens could not start the app metadata report", ex);
      return false;
    }
  }

  private Map<String, Object> payload(
      ApplicationContext context, ApiLensSpringOptions options, Map<String, Object> config) {
    ApiLensConfig clientConfig = client.config();
    String bootVersion = bootVersion();
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("app_id", clientConfig.appId());
    if (!Strings.isBlank(clientConfig.projectSlug())) {
      body.put("project_slug", clientConfig.projectSlug());
    }
    body.put("environment", Strings.firstNonBlank(options.environment(), clientConfig.environment()));
    body.put("framework", bootVersion.isEmpty() ? "spring" : "spring-boot");
    body.put("framework_version", bootVersion.isEmpty() ? springVersion() : bootVersion);
    body.put("java_version", Strings.clean(System.getProperty("java.version")));
    body.put("sdk_version", ApiLensVersion.VERSION);
    body.put("spring_version", springVersion());
    body.put("routes", routes(context));
    body.put("config", config);
    return body;
  }

  /** Route templates of every Spring MVC handler mapping in {@code context}. */
  static List<Map<String, String>> routes(ApplicationContext context) {
    if (context == null || !ClassUtils.isPresent(HANDLER_MAPPING_CLASS, ApiLensMetadataReporter.class.getClassLoader())) {
      return List.of();
    }
    try {
      return SpringMvcRoutes.list(context);
    } catch (RuntimeException | LinkageError ex) {
      LOGGER.log(Level.FINE, "API Lens could not list the Spring MVC routes", ex);
      return List.of();
    }
  }

  /**
   * The capture configuration the filter runs with: built-in masking patterns and exclusions
   * are listed with the user's, and env overrides ({@code APILENS_CAPTURE_IP}, {@code
   * APILENS_EXCLUDE_PATHS}...) are applied. Callbacks are reported as booleans only.
   */
  public static Map<String, Object> effectiveConfig(
      ApiLensConfig config, ApiLensSpringOptions options, RequestExcluder excluder, boolean consumerResolver) {
    Map<String, Object> out = new LinkedHashMap<>();
    if (options.captureProfile() != null) {
      out.put("capture_profile", options.captureProfile().wireName());
    }
    out.put("capture_headers", options.captureHeaders());
    out.put("capture_request_body", options.capturePayloads() && options.logRequestBody());
    out.put("capture_response_body", options.capturePayloads() && options.logResponseBody());
    out.put("max_payload_bytes", options.maxPayloadBytes());
    out.put("capture_spans", options.captureSpans());
    out.put("capture_ip", IpPrivacy.effectiveCaptureIp(options.captureIp()));
    out.put("anonymize_ip", IpPrivacy.effectiveAnonymizeIp(options.anonymizeIp()));
    out.put("redact_query_params", concat(Redactor.DEFAULT_MASK_QUERY_PARAMS, options.redactQueryParams()));
    out.put("redact_headers", concat(Redactor.DEFAULT_MASK_HEADER_PATTERNS, options.redactHeaders()));
    out.put("redact_body_fields", concat(Redactor.DEFAULT_MASK_BODY_FIELDS, options.redactBodyFields()));
    out.put("default_exclusions", options.defaultExclusions());
    out.put("exclude_paths", patterns(excluder == null ? List.of() : excluder.pathPatterns()));
    out.put("exclude_user_agents", patterns(excluder == null ? List.of() : excluder.userAgentPatterns()));
    out.put("sample_rate", options.sampleRate());
    out.put("parametrize_paths", options.parametrizePaths());
    out.put("batch_size", config.batchSize());
    out.put("flush_interval", config.flushInterval().toMillis() / 1000.0);
    out.put("max_queue_size", config.maxQueueSize());
    out.put("max_queue_bytes", config.maxQueueBytes());
    out.put("max_batch_bytes", config.maxBatchBytes());
    out.put("max_retries", config.maxRetries());
    out.put("compress", config.compress());
    out.put("custom_ca", !Strings.isBlank(config.caBundlePath()));
    out.put("verify_tls", config.verifyTls());
    out.put("heartbeat_interval", config.heartbeatInterval().toMillis() / 1000.0);
    Map<String, Object> callbacks = new LinkedHashMap<>();
    callbacks.put("mask_request_body", options.maskRequestBody() != null);
    callbacks.put("mask_response_body", options.maskResponseBody() != null);
    callbacks.put("sample_on_request", options.sampleOnRequest() != null);
    callbacks.put("sample_on_response", options.sampleOnResponse() != null);
    callbacks.put("consumer_resolver", consumerResolver);
    out.put("callbacks", callbacks);
    return out;
  }

  private static List<String> concat(List<String> defaults, List<String> user) {
    List<String> out = new ArrayList<>(defaults);
    out.addAll(RequestExcluder.splitPatterns(user));
    return out;
  }

  private static List<String> patterns(List<Pattern> compiled) {
    List<String> out = new ArrayList<>(compiled.size());
    compiled.forEach(pattern -> out.add(pattern.pattern()));
    return out;
  }

  private static String bootVersion() {
    try {
      return Strings.clean(SpringBootVersion.getVersion());
    } catch (RuntimeException | LinkageError ex) {
      return "";
    }
  }

  private static String springVersion() {
    try {
      return Strings.clean(SpringVersion.getVersion());
    } catch (RuntimeException | LinkageError ex) {
      return "";
    }
  }
}
