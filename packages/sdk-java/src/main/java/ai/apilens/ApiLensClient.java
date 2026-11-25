package ai.apilens;

import ai.apilens.internal.ApiLensHttpException;
import ai.apilens.internal.Delivery;
import ai.apilens.internal.HttpClients;
import ai.apilens.internal.Strings;
import ai.apilens.resources.DataSourcePools;
import ai.apilens.resources.DefaultCollectors;
import ai.apilens.resources.Fs;
import ai.apilens.resources.IdentityResolver;
import ai.apilens.resources.ResourceSampler;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.DoubleSupplier;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.function.ToIntFunction;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Asynchronous API Lens ingest client.
 *
 * <p>Capture only enqueues. The request, span and log queues are bounded by record count
 * ({@code maxQueueSize}, per queue) and by estimated bytes ({@code maxQueueBytes}, shared);
 * either limit drops the oldest records first. A background thread cuts batches at {@code
 * batchSize} records or {@code maxBatchBytes}, gzips them, and retries 408/429/5xx/network
 * errors with full-jitter backoff, honouring {@code Retry-After}, for up to {@code
 * maxRetryDuration} (default 300 s). Any other 4xx drops the batch at once; a 200 that refuses
 * some records (partial accept) drops only those. Every dropped record is counted by signal and
 * reason, logged at WARNING (at most once a minute) and reported to ingest in the next heartbeat
 * ({@code dropped}). {@link #stats()} reports what happened.
 *
 * <p>Unless {@code registerShutdownHook} is off (the Spring Boot auto-configuration turns it
 * off and closes the client itself), a running client registers a JVM shutdown hook that
 * flushes the queues, bounded by {@code shutdownTimeout} (default 5 s).
 *
 * <p>A second daemon thread sends {@code POST /v1/heartbeat} for every registered app (the
 * configured {@code appId} and any {@link #registerApp}): on start, every {@code
 * heartbeatInterval} and once more with {@code final=true} on {@link #shutdown()}. The response
 * carries the app's {@link RemotePolicy}, applied to capture until the next heartbeat. The same
 * thread sends the app metadata report ({@link #reportMetadata}) once per process. Neither ever
 * blocks or delays record delivery.
 *
 * <p>Unless {@code captureResources} is off, a third daemon thread ({@code apilens-resources})
 * samples CPU, memory, the container's cgroup and JVM internals every {@code resourcesInterval}
 * (default 15 s); every heartbeat carries the window's aggregate as {@code resources} and the
 * process's {@code identity} (host, container, Kubernetes pod). See {@link ResourceSampler}.
 */
public class ApiLensClient implements AutoCloseable {
  /** Record-count cap ({@code maxQueueSize}) hit; the oldest record was dropped. */
  public static final String DROP_QUEUE_FULL = "queue_full";
  /** Memory cap ({@code maxQueueBytes}) hit, or a record could not fit {@code maxBatchBytes}. */
  public static final String DROP_QUEUE_BYTES = "queue_bytes";
  /** Ingest rejected the batch with a non-retryable 4xx. */
  public static final String DROP_NON_RETRYABLE = "non_retryable";
  /** The batch still failed after {@code maxRetryDuration} (or {@code maxRetries}). */
  public static final String DROP_RETRIES_EXHAUSTED = "retries_exhausted";
  /** Ingest answered 200 but refused the record as invalid (partial accept). */
  public static final String DROP_INVALID = "invalid";
  /** Ingest answered 200 but refused the record because of its app or environment. */
  public static final String DROP_APP_REJECTED = "app_rejected";
  /** Still queued or unsent when {@link #shutdown()} ran out of {@code shutdownTimeout}. */
  public static final String DROP_SHUTDOWN = "shutdown";
  /** Not a drop: a record was shortened to fit {@code maxBatchBytes} and still sent. */
  public static final String DROP_TRUNCATED = "truncated";
  /** A kept request had more than {@link TraceContext#MAX_CHILD_SPANS} child spans. */
  public static final String DROP_SPAN_CAP = "span_cap";
  /** Every key of {@link ClientStats#dropCounts()}. */
  public static final List<String> DROP_REASONS = List.of(
      DROP_QUEUE_FULL, DROP_QUEUE_BYTES, DROP_NON_RETRYABLE, DROP_RETRIES_EXHAUSTED, DROP_INVALID,
      DROP_APP_REJECTED, DROP_SHUTDOWN, DROP_TRUNCATED, DROP_SPAN_CAP);

  /** {@code sdk_name} in heartbeats. */
  public static final String SDK_NAME = "apilens-java-sdk";
  /** Route templates kept in one metadata report; ingest keeps the same number. */
  public static final int MAX_METADATA_ROUTES = 2000;
  /** A failed metadata report (408/429/5xx/network) is retried this many times. */
  static final int METADATA_MAX_RETRIES = 3;
  /** Method of a route that answers every HTTP method. */
  public static final String ANY_METHOD = "*";

  /** Fixed per-record overhead added to the variable-length fields when estimating size. */
  static final int RECORD_OVERHEAD_BYTES = 512;

  private static final Logger LOGGER = Logger.getLogger("apilens");
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Duration NON_RETRYABLE_LOG_INTERVAL = Duration.ofMinutes(5);
  private static final Duration DROP_LOG_INTERVAL = Duration.ofMinutes(1);
  /** How long shutdown waits for an interrupted background flush to count its batch. */
  private static final Duration SHUTDOWN_GRACE = Duration.ofMillis(200);
  private static final int MAX_LOGGED_BODY_BYTES = 1024;
  private static final int MAX_RESPONSE_BYTES = 64 * 1024;
  private static final java.util.regex.Pattern API_KEY_NAME_SEPARATORS =
      java.util.regex.Pattern.compile("[-_. ]");
  private static final String TROUBLESHOOTING_URL = "https://apilens.ai/docs/support/troubleshooting";
  // Shortened first, in this order, when a single record exceeds maxBatchBytes.
  private static final List<String> TRUNCATE_FIELDS = List.of(
      "response_payload", "request_payload", "response_headers", "request_headers", "payload", "message");

  private final ApiLensConfig config;
  private final HttpClient httpClient;
  private final Object queueLock = new Object();
  private final RecordQueue<RequestRecord> requestQueue;
  private final RecordQueue<SpanRecord> spanQueue;
  private final RecordQueue<LogRecord> logQueue;
  private final List<RecordQueue<?>> queues;
  private long queuedBytes;
  private final Map<String, AtomicLong> drops = new LinkedHashMap<>();
  /** Drops not yet reported in an accepted heartbeat: signal -> reason -> records. */
  private final Map<String, Map<String, AtomicLong>> unreportedDrops = new ConcurrentHashMap<>();
  private final AtomicLong sentBatches = new AtomicLong();
  private final AtomicLong sentRecords = new AtomicLong();
  private final AtomicLong failedBatches = new AtomicLong();
  private volatile String lastError;
  private volatile Instant lastSuccessAt;
  private final Map<Integer, Long> nonRetryableLoggedAt = new ConcurrentHashMap<>();
  private final AtomicLong lastDropLogNanos = new AtomicLong(System.nanoTime() - DROP_LOG_INTERVAL.toNanos());
  private final AtomicLong lastLoggedDropped = new AtomicLong();
  private final AtomicBoolean flushSubmitted = new AtomicBoolean();
  /** {@link #nanoClock} time {@link #shutdown()} must be done by; 0 while not shutting down. */
  private volatile long shutdownDeadline;
  private final AtomicReference<Thread> shutdownHook = new AtomicReference<>();

  /** Waits between retries; replaced in tests. */
  volatile Sleeper sleeper = duration -> Thread.sleep(duration.toMillis());
  /** Jitter source in {@code [0, 1)}; replaced in tests. */
  volatile DoubleSupplier random = () -> ThreadLocalRandom.current().nextDouble();
  /** Clock of the retry window and the shutdown deadline; replaced in tests. */
  volatile LongSupplier nanoClock = System::nanoTime;

  private volatile ScheduledExecutorService executor;

  // ---- heartbeat / metadata state ----
  /** (base URL, app, environment) of every metadata report this process started. */
  private static final Set<String> METADATA_REPORTED = ConcurrentHashMap.newKeySet();
  private final String instanceId = UUID.randomUUID().toString();
  private final long startedNanos = System.nanoTime();
  private final Duration heartbeatInterval;
  /** Registered app -> System.nanoTime() the next heartbeat is due. */
  private final Map<AppKey, Long> heartbeatDue = new ConcurrentHashMap<>();
  /** The configured app: its heartbeats carry the client's drop counts. */
  private final AppKey primaryApp;
  private final Object heartbeatSendLock = new Object();
  private final Set<Integer> heartbeatRejectionsLogged = ConcurrentHashMap.newKeySet();
  private volatile RemotePolicy remotePolicy = RemotePolicy.CAPTURE_EVERYTHING;
  private volatile ScheduledExecutorService heartbeatExecutor;

  // ---- runtime resources state ----
  private final DataSourcePools dataSourcePools = new DataSourcePools();
  private volatile ResourceSampler resourceSampler;
  /** Resolves {@code identity}; replaced in tests. */
  volatile IdentityResolver identityResolver = IdentityResolver.system();
  /** The block of the configured app's last heartbeat, repeated on the other apps' heartbeats. */
  private volatile Map<String, Object> lastResources;

  public ApiLensClient(ApiLensConfig config) {
    this(config, HttpClients.create(config));
  }

  ApiLensClient(ApiLensConfig config, HttpClient httpClient) {
    this(config, httpClient, null, true);
  }

  /**
   * Tests only: {@code heartbeatInterval} overrides the configured interval (and may be below
   * 10 s); {@code autoStart=false} leaves the background threads to an explicit {@link #start()}.
   */
  ApiLensClient(ApiLensConfig config, HttpClient httpClient, Duration heartbeatInterval, boolean autoStart) {
    this.config = Objects.requireNonNull(config, "config");
    this.httpClient = Objects.requireNonNull(httpClient, "httpClient");
    this.heartbeatInterval = heartbeatInterval != null ? heartbeatInterval : config.heartbeatInterval();

    if (Strings.isBlank(config.apiKey())) {
      throw new IllegalArgumentException("apiKey is required");
    }
    // appId is optional (see ApiLensConfig#appId); say once which app the data goes to.
    LOGGER.info(config.describeAppChoice());
    URI.create(config.baseUrl());

    for (String reason : DROP_REASONS) {
      drops.put(reason, new AtomicLong());
    }
    requestQueue = new RecordQueue<>(
        "requests", config::ingestPath, this::requestWire, RequestRecord::estimatedBytes);
    spanQueue = new RecordQueue<>(
        "spans", config::spansPath, record -> record.toWire(config), SpanRecord::estimatedBytes);
    logQueue = new RecordQueue<>(
        "logs", config::logsPath, record -> record.toWire(config), LogRecord::estimatedBytes);
    queues = List.of(requestQueue, spanQueue, logQueue);
    primaryApp = appKey(config.appId(), config.environment());
    registerApp(config.appId(), config.environment());

    if (config.enabled() && autoStart) {
      start();
    }
  }

  public ApiLensConfig config() {
    return config;
  }

  /** A request record's wire form, stamped with this process's {@code instance_id}. */
  private Map<String, Object> requestWire(RequestRecord record) {
    Map<String, Object> wire = record.toWire(config);
    wire.put("instance_id", instanceId);
    return wire;
  }

  public boolean isEnabled() {
    return config.enabled();
  }

  /** Records dropped for any reason (truncated records were still sent and are not counted). */
  public long droppedCount() {
    long total = 0;
    for (Map.Entry<String, AtomicLong> entry : drops.entrySet()) {
      if (!DROP_TRUNCATED.equals(entry.getKey())) {
        total += entry.getValue().get();
      }
    }
    return total;
  }

  /** Records dropped so far by reason; see {@link #DROP_REASONS}. */
  public Map<String, Long> dropCounts() {
    Map<String, Long> out = new LinkedHashMap<>();
    drops.forEach((reason, count) -> out.put(reason, count.get()));
    return out;
  }

  public int queuedRequestCount() {
    synchronized (queueLock) {
      return requestQueue.size();
    }
  }

  /** Estimated bytes held by the three queues (bounded by {@code maxQueueBytes}). */
  public long queuedBytes() {
    synchronized (queueLock) {
      return queuedBytes;
    }
  }

  /** Point-in-time delivery health snapshot. */
  public ClientStats stats() {
    int records;
    long bytes;
    synchronized (queueLock) {
      records = requestQueue.size() + spanQueue.size() + logQueue.size();
      bytes = queuedBytes;
    }
    return new ClientStats(
        records,
        bytes,
        sentBatches.get(),
        sentRecords.get(),
        failedBatches.get(),
        droppedCount(),
        dropCounts(),
        lastError,
        lastSuccessAt);
  }

  public void start() {
    if (!config.enabled() || executor != null) {
      return;
    }
    ScheduledExecutorService service =
        Executors.newSingleThreadScheduledExecutor(new ApiLensThreadFactory("apilens-flush"));
    executor = service;
    long intervalMs = Math.max(config.flushInterval().toMillis(), 1);
    service.scheduleWithFixedDelay(this::flushSafely, intervalMs, intervalMs, TimeUnit.MILLISECONDS);
    startResources();
    startHeartbeats();
    registerShutdownHook();
  }

  // ---- runtime resources --------------------------------------------------

  private synchronized void startResources() {
    if (resourceSampler != null || !config.captureResources() || !config.sendHeartbeat()) {
      return;
    }
    try {
      ResourceSampler sampler = new ResourceSampler(config.resourcesInterval(),
          DefaultCollectors.create(Fs.system(), dataSourcePools, config.captureProcessList()));
      sampler.applyPolicy(remotePolicy.resources());
      resourceSampler = sampler;
      sampler.start();
    } catch (RuntimeException | LinkageError ex) {
      LOGGER.log(Level.FINE, "API Lens could not start resource sampling", ex);
    }
  }

  /** Tests: replaces the resource sampler (started by the caller, or sampled by hand). */
  void useResourceSampler(ResourceSampler sampler) {
    ResourceSampler previous = resourceSampler;
    resourceSampler = sampler;
    if (previous != null && previous != sampler) {
      previous.stop();
    }
  }

  /** The resource sampler; {@code null} when resources are not captured or not started. */
  public ResourceSampler resourceSampler() {
    return resourceSampler;
  }

  /**
   * Reports the connection pool behind {@code dataSource} (HikariCP, also behind Spring proxies)
   * in the heartbeat's {@code pools} as {@code name}. The Spring Boot auto-configuration does
   * this for every {@code DataSource} bean. At most {@value DataSourcePools#MAX_POOLS} pools.
   */
  public void registerDataSource(String name, javax.sql.DataSource dataSource) {
    dataSourcePools.register(name, dataSource);
  }

  /** The heartbeat's {@code identity}: resolved once per process, the ECS metadata fetched once (1 s). */
  public Map<String, Object> identity() {
    try {
      return identityResolver.identity(httpClient);
    } catch (RuntimeException ex) {
      return Map.of();
    }
  }

  /** Stops the background threads without flushing; removes the JVM shutdown hook. */
  public void stop() {
    removeShutdownHook();
    ScheduledExecutorService service = executor;
    executor = null;
    if (service != null) {
      service.shutdown();
    }
    ScheduledExecutorService beats = heartbeatExecutor;
    heartbeatExecutor = null;
    if (beats != null) {
      // Pending heartbeats and a metadata report not sent yet are cancelled.
      beats.shutdownNow();
    }
    ResourceSampler sampler = resourceSampler;
    resourceSampler = null;
    if (sampler != null) {
      sampler.stop();
    }
  }

  public void shutdown() {
    shutdown(true);
  }

  /**
   * Flushes the queues when {@code flush} is true, sends the final heartbeat ({@code
   * final=true}, carrying the drop counts) when heartbeats are running, and stops the background
   * threads. The flush takes at most {@code shutdownTimeout}: retries stop at that deadline, and
   * whatever is still queued or unsent then is dropped and counted as {@link #DROP_SHUTDOWN}.
   */
  public void shutdown(boolean flush) {
    removeShutdownHook();
    long deadline = nanoClock.getAsLong() + config.shutdownTimeout().toNanos();
    shutdownDeadline = deadline == 0 ? 1 : deadline;
    ScheduledExecutorService service = executor;
    executor = null;
    if (service != null) {
      // A flush already running on the background thread finishes (bounded by the deadline).
      service.shutdown();
    }
    if (flush) {
      flushAll();
    }
    if (service != null) {
      try {
        if (!service.awaitTermination(Math.max(remainingNanos(), 0L), TimeUnit.NANOSECONDS)) {
          // Past the deadline: interrupt a retry still waiting so it counts its batch.
          service.shutdownNow();
          service.awaitTermination(SHUTDOWN_GRACE.toMillis(), TimeUnit.MILLISECONDS);
        }
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
      }
    }
    discardQueued(DROP_SHUTDOWN);
    logDrops(true);
    if (heartbeatExecutor != null) {
      sendHeartbeat(true);
    }
    stop();
  }

  /** Nanoseconds left before the shutdown deadline; {@link Long#MAX_VALUE} while not shutting down. */
  private long remainingNanos() {
    long deadline = shutdownDeadline;
    return deadline == 0 ? Long.MAX_VALUE : deadline - nanoClock.getAsLong();
  }

  /** Drops (and counts) every queued record. */
  private void discardQueued(String reason) {
    synchronized (queueLock) {
      for (RecordQueue<?> queue : queues) {
        if (queue.size() > 0) {
          drop(queue.key, reason, queue.size());
          queue.items.clear();
          queuedBytes -= queue.bytes;
          queue.bytes = 0;
        }
      }
    }
  }

  // ---- JVM shutdown hook ------------------------------------------------

  /** The registered JVM shutdown hook; {@code null} when none is registered. */
  Thread shutdownHook() {
    return shutdownHook.get();
  }

  private void registerShutdownHook() {
    if (!config.registerShutdownHook() || shutdownHook.get() != null) {
      return;
    }
    Thread hook = new Thread(this::runShutdownHook, "apilens-shutdown");
    if (!shutdownHook.compareAndSet(null, hook)) {
      return;
    }
    try {
      Runtime.getRuntime().addShutdownHook(hook);
    } catch (IllegalStateException | SecurityException ex) {
      // The JVM is already exiting, or hooks are not allowed: nothing to register.
      shutdownHook.compareAndSet(hook, null);
    }
  }

  private void removeShutdownHook() {
    Thread hook = shutdownHook.getAndSet(null);
    if (hook == null || hook == Thread.currentThread()) {
      return;
    }
    try {
      Runtime.getRuntime().removeShutdownHook(hook);
    } catch (IllegalStateException | SecurityException ex) {
      // The JVM is already exiting; the hook runs (or ran) and finds nothing left to do.
    }
  }

  private void runShutdownHook() {
    try {
      shutdown(true);
    } catch (RuntimeException ex) {
      LOGGER.log(Level.WARNING, "API Lens shutdown flush failed", ex);
    }
  }

  @Override
  public void close() {
    shutdown(true);
  }

  /** Enqueues {@code record}; does nothing while the remote policy has capture disabled. */
  public void capture(RequestRecord record) {
    if (!config.enabled() || record == null || !remotePolicy.enabled()) {
      return;
    }
    capture(requestQueue, record);
  }

  /** Enqueues {@code record}; does nothing while the remote policy has capture disabled. */
  public void captureSpan(SpanRecord record) {
    if (!config.enabled() || record == null || !remotePolicy.enabled()) {
      return;
    }
    capture(spanQueue, record);
  }

  /**
   * Counts {@code count} child spans of a kept request that went over the per-request cap
   * ({@link TraceContext#MAX_CHILD_SPANS}) as {@code span_cap} drops, reported in the heartbeat.
   */
  public void countSpanCapDrops(long count) {
    if (count > 0) {
      drop("spans", DROP_SPAN_CAP, count);
    }
  }

  /** Enqueues {@code record}; does nothing while the remote policy has capture disabled. */
  public void captureLog(LogRecord record) {
    if (!config.enabled() || record == null || !remotePolicy.enabled()) {
      return;
    }
    capture(logQueue, record);
  }

  // ---- heartbeat --------------------------------------------------------

  /** Id of this client in heartbeats: a random UUID, new for every client (process start). */
  public String instanceId() {
    return instanceId;
  }

  /**
   * The capture policy from the last successful heartbeat; {@link
   * RemotePolicy#CAPTURE_EVERYTHING} before the first one. A failed heartbeat keeps the previous
   * policy. Integrations combine it with the local options so it can only narrow capture.
   */
  public RemotePolicy remotePolicy() {
    return remotePolicy;
  }

  /**
   * Sends heartbeats for {@code appId} in {@code environment} (blank: the configured one) from
   * now on; the first goes out within a second. The configured {@code appId} is registered by
   * the constructor. Registering an app twice does nothing.
   */
  public void registerApp(String appId, String environment) {
    heartbeatDue.putIfAbsent(appKey(appId, environment), System.nanoTime());
  }

  private AppKey appKey(String appId, String environment) {
    // "" is the project's default app (no app name configured); its heartbeats carry app_id "".
    String app = Strings.clean(appId);
    String env = Strings.isBlank(environment)
        ? config.environment()
        : environment.trim().toLowerCase(Locale.ROOT);
    return new AppKey(app, env);
  }

  /**
   * Sends a heartbeat for every registered app now; {@code true} when all succeeded. Never
   * throws and never retries: a failure keeps the previous policy and only reschedules.
   */
  public boolean sendHeartbeat() {
    return sendHeartbeat(false);
  }

  boolean sendHeartbeat(boolean finalBeat) {
    if (!config.enabled() || !config.sendHeartbeat() || heartbeatDue.isEmpty()) {
      return false;
    }
    boolean ok = true;
    for (AppKey key : List.copyOf(heartbeatDue.keySet())) {
      ok = heartbeatOne(key, finalBeat) && ok;
    }
    return ok;
  }

  /** The {@code POST /v1/heartbeat} body for one app (see {@code apps/docs/ingest/heartbeat.mdx}). */
  public Map<String, Object> heartbeatPayload(String appId, String environment, boolean finalBeat) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("app_id", appId);
    body.put("environment", Strings.firstNonBlank(environment, config.environment()));
    body.put("instance_id", instanceId);
    body.put("sdk_name", SDK_NAME);
    body.put("sdk_version", ApiLensVersion.VERSION);
    body.put("runtime", "java " + Strings.firstNonBlank(System.getProperty("java.version"), "unknown"));
    Long pid = currentPid();
    if (pid != null) {
      body.put("pid", pid);
    }
    body.put("uptime_s", Math.max((System.nanoTime() - startedNanos) / 1_000_000_000L, 0L));
    body.put("stats", statsWire(stats()));
    if (!Strings.isBlank(config.projectSlug())) {
      body.put("project_slug", config.projectSlug());
    }
    if (!Strings.isBlank(config.release())) {
      body.put("release", config.release());
    }
    if (!Strings.isBlank(config.commit())) {
      body.put("commit", config.commit());
    }
    if (finalBeat) {
      body.put("final", true);
    }
    Map<String, Object> where = identity();
    if (!where.isEmpty()) {
      body.put("identity", where);
    }
    return body;
  }

  /** {@link ClientStats} in the JSON form the heartbeat carries as {@code stats}. */
  public static Map<String, Object> statsWire(ClientStats stats) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("queued_records", stats.queuedRecords());
    out.put("queued_bytes", stats.queuedBytes());
    out.put("sent_batches", stats.sentBatches());
    out.put("sent_records", stats.sentRecords());
    out.put("failed_batches", stats.failedBatches());
    out.put("dropped", stats.droppedCount());
    out.put("drop_counts", new LinkedHashMap<>(stats.dropCounts()));
    out.put("last_error", stats.lastError() == null ? "" : stats.lastError());
    out.put("last_success_at", stats.lastSuccessAt() == null ? null : stats.lastSuccessAt().toString());
    return out;
  }

  private void startHeartbeats() {
    if (heartbeatExecutor != null || !(config.sendHeartbeat() || config.sendMetadata())) {
      return;
    }
    ScheduledExecutorService service =
        Executors.newSingleThreadScheduledExecutor(new ApiLensThreadFactory("apilens-heartbeat"));
    heartbeatExecutor = service;
    if (config.sendHeartbeat()) {
      long tickMs = Math.max(Math.min(1000L, heartbeatInterval.toMillis() / 4), 10L);
      service.scheduleWithFixedDelay(this::heartbeatTick, 0, tickMs, TimeUnit.MILLISECONDS);
    }
  }

  /** Sends the heartbeats that are due. Heartbeat thread only. */
  private void heartbeatTick() {
    try {
      long now = System.nanoTime();
      for (Map.Entry<AppKey, Long> entry : heartbeatDue.entrySet()) {
        if (now - entry.getValue() >= 0) {
          heartbeatOne(entry.getKey(), false);
        }
      }
    } catch (RuntimeException ex) {
      LOGGER.log(Level.FINE, "API Lens heartbeat failed", ex);
    }
  }

  private boolean heartbeatOne(AppKey key, boolean finalBeat) {
    synchronized (heartbeatSendLock) {
      Duration next = heartbeatInterval;
      try {
        @SuppressWarnings("unchecked")
        Map<String, Object> body =
            (Map<String, Object>) stripApiKeyFields(heartbeatPayload(key.appId(), key.environment(), finalBeat));
        // The client's drops ride on the configured app's heartbeat only, so they count once.
        Map<String, Map<String, Long>> dropped = key.equals(primaryApp) ? unreportedDrops() : Map.of();
        if (!dropped.isEmpty()) {
          body.put("dropped", dropped);
        }
        // The configured app's heartbeat drains the window; other apps repeat its last block.
        Map<String, Object> resources = key.equals(primaryApp) ? drainResources() : lastResources;
        if (resources != null) {
          body.put("resources", resources);
        }
        byte[] raw = post(config.heartbeatPath(), MAPPER.writeValueAsBytes(body), false, true);
        // Accepted: these drops are reported; newer ones wait for the next heartbeat.
        markReported(dropped);
        applyHeartbeatResponse(raw);
        return true;
      } catch (ApiLensHttpException ex) {
        if (ex.retryAfter() != null) {
          next = ex.retryAfter();
        }
        logHeartbeatFailure(ex, finalBeat);
        return false;
      } catch (IOException ex) {
        LOGGER.fine("API Lens heartbeat failed: " + describe(ex));
        return false;
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
        return false;
      } finally {
        heartbeatDue.put(key, System.nanoTime() + next.toNanos());
      }
    }
  }

  private void applyHeartbeatResponse(byte[] raw) {
    RemotePolicy policy = null;
    try {
      JsonNode data = raw == null || raw.length == 0 ? null : MAPPER.readTree(raw);
      policy = data == null ? null : RemotePolicy.fromJson(data.get("policy"));
    } catch (IOException ex) {
      // Not JSON: keep the previous policy.
    }
    if (policy == null) {
      LOGGER.fine("API Lens heartbeat response has no valid policy; keeping the previous policy");
      return;
    }
    RemotePolicy previous = remotePolicy;
    remotePolicy = policy;
    ResourceSampler sampler = resourceSampler;
    if (sampler != null) {
      sampler.applyPolicy(policy.resources());
    }
    if (!policy.equals(previous)) {
      LOGGER.info("API Lens remote capture policy is now " + policy.toWire());
    }
  }

  private Map<String, Object> drainResources() {
    ResourceSampler sampler = resourceSampler;
    if (sampler == null) {
      return null;
    }
    try {
      Map<String, Object> block = sampler.drain();
      lastResources = block;
      return block;
    } catch (RuntimeException ex) {
      LOGGER.log(Level.FINE, "API Lens could not drain the resources window", ex);
      return null;
    }
  }

  private void logHeartbeatFailure(ApiLensHttpException ex, boolean finalBeat) {
    int status = ex.status();
    if (finalBeat && status == 429) {
      // A final heartbeat right after a regular one; expected and ignored.
      return;
    }
    if ((status == 401 || status == 403 || status == 422) && heartbeatRejectionsLogged.add(status)) {
      LOGGER.warning("API Lens ingest rejected the heartbeat with status " + status + ": "
          + (ex.body().isEmpty() ? "<empty body>" : ex.body()));
      return;
    }
    LOGGER.fine("API Lens heartbeat failed: " + describe(ex));
  }

  /**
   * Drops not yet reported in an accepted heartbeat, per signal ({@code requests}, {@code spans},
   * {@code logs}) and reason: the heartbeat's {@code dropped} field. Truncated records were sent
   * and are not part of it.
   */
  public Map<String, Map<String, Long>> unreportedDrops() {
    Map<String, Map<String, Long>> out = new LinkedHashMap<>();
    for (RecordQueue<?> queue : queues) {
      Map<String, AtomicLong> reasons = unreportedDrops.get(queue.key);
      if (reasons == null) {
        continue;
      }
      Map<String, Long> counts = new LinkedHashMap<>();
      for (String reason : DROP_REASONS) {
        AtomicLong n = reasons.get(reason);
        if (n != null && n.get() > 0) {
          counts.put(reason, n.get());
        }
      }
      if (!counts.isEmpty()) {
        out.put(queue.key, counts);
      }
    }
    return out;
  }

  private void markReported(Map<String, Map<String, Long>> reported) {
    reported.forEach((signal, reasons) -> {
      Map<String, AtomicLong> pending = unreportedDrops.get(signal);
      if (pending != null) {
        reasons.forEach((reason, n) -> pending.get(reason).addAndGet(-n));
      }
    });
  }

  private static Long currentPid() {
    try {
      return ProcessHandle.current().pid();
    } catch (RuntimeException ex) {
      return null;
    }
  }

  // ---- app metadata -----------------------------------------------------

  /**
   * Sends the app metadata report ({@code POST /v1/metadata}) once per process for this
   * client's app in {@code environment}, without blocking: {@code build} runs on the heartbeat
   * thread and returns the body (see {@link #sendMetadata}). Returns {@code true} when this call
   * started the report; later calls for the same app and environment return {@code false}, as
   * do disabled clients ({@code enabled=false}, {@code sendMetadata=false}, env {@code
   * APILENS_SEND_METADATA=false}) and stopped ones.
   */
  public boolean reportMetadata(String environment, Supplier<Map<String, Object>> build) {
    if (!config.enabled() || !config.sendMetadata() || build == null) {
      return false;
    }
    String env = Strings.isBlank(environment)
        ? config.environment()
        : environment.trim().toLowerCase(Locale.ROOT);
    String key = config.baseUrl() + "\n" + config.appId() + "\n" + env;
    ScheduledExecutorService service = heartbeatExecutor;
    if (service == null || !METADATA_REPORTED.add(key)) {
      return false;
    }
    try {
      service.execute(() -> {
        Map<String, Object> payload;
        try {
          payload = build.get();
        } catch (RuntimeException ex) {
          LOGGER.log(Level.FINE, "API Lens could not build the app metadata report", ex);
          return;
        }
        if (payload != null) {
          sendMetadata(payload);
        }
      });
      return true;
    } catch (RuntimeException ex) {
      METADATA_REPORTED.remove(key);
      return false;
    }
  }

  /**
   * POSTs one app metadata report now; {@code true} on 2xx. Fills in {@code app_id} and {@code
   * environment} when missing, removes any field naming an API key at any depth, and normalises
   * {@code routes} (upper-case methods, no blanks or duplicates, at most {@link
   * #MAX_METADATA_ROUTES}). 408/429/5xx and network errors are retried up to 3 times.
   */
  @SuppressWarnings("unchecked")
  public boolean sendMetadata(Map<String, Object> payload) {
    if (payload == null) {
      return false;
    }
    Map<String, Object> body = (Map<String, Object>) stripApiKeyFields(payload);
    body.putIfAbsent("app_id", config.appId());
    body.putIfAbsent("environment", config.environment());
    body.put("routes", capRoutes(body.get("routes")));
    byte[] json;
    try {
      json = MAPPER.writeValueAsBytes(body);
    } catch (JsonProcessingException ex) {
      LOGGER.log(Level.FINE, "API Lens could not serialise the app metadata report", ex);
      return false;
    }
    byte[] sent = json;
    boolean gzipped = false;
    if (config.compress()) {
      try {
        sent = Delivery.gzip(json);
        gzipped = true;
      } catch (IOException ex) {
        sent = json;
      }
    }
    Exception last = null;
    for (int attempt = 0; attempt <= METADATA_MAX_RETRIES; attempt += 1) {
      Duration retryAfter = null;
      try {
        post(config.metadataPath(), sent, gzipped, false);
        return true;
      } catch (ApiLensHttpException ex) {
        last = ex;
        if (!ex.retryable()) {
          LOGGER.warning("API Lens ingest rejected the app metadata report with status " + ex.status()
              + ": " + (ex.body().isEmpty() ? "<empty body>" : ex.body()));
          return false;
        }
        retryAfter = ex.retryAfter();
      } catch (IOException ex) {
        last = ex;
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
        return false;
      }
      if (attempt >= METADATA_MAX_RETRIES) {
        break;
      }
      try {
        sleeper.sleep(retryAfter != null
            ? retryAfter
            : Delivery.backoff(attempt, config.retryBackoffBase(), config.retryBackoffMax(), random.getAsDouble()));
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
    LOGGER.fine("API Lens app metadata report failed: " + describe(last));
    return false;
  }

  /**
   * Normalises route templates: entries are maps with {@code method} and {@code path}; methods
   * are trimmed and upper-cased, entries without a method or path and duplicates are dropped,
   * and at most {@link #MAX_METADATA_ROUTES} are kept.
   */
  public static List<Map<String, String>> capRoutes(Object routes) {
    List<Map<String, String>> out = new ArrayList<>();
    if (!(routes instanceof Collection<?> items)) {
      return out;
    }
    Set<String> seen = new LinkedHashSet<>();
    for (Object item : items) {
      if (out.size() >= MAX_METADATA_ROUTES) {
        break;
      }
      if (!(item instanceof Map<?, ?> route)) {
        continue;
      }
      String method = Strings.clean(route.get("method") == null ? "" : String.valueOf(route.get("method")))
          .toUpperCase(Locale.ROOT);
      String path = Strings.clean(route.get("path") == null ? "" : String.valueOf(route.get("path")));
      if (method.isEmpty() || path.isEmpty() || !seen.add(method + " " + path)) {
        continue;
      }
      Map<String, String> entry = new LinkedHashMap<>();
      entry.put("method", method);
      entry.put("path", path);
      out.add(entry);
    }
    return out;
  }

  /**
   * A deep copy of {@code value} without any map key naming an API key ({@code api_key}, {@code
   * apiKey}, {@code api-key}, any case) at any depth: ingest rejects heartbeat and metadata
   * bodies that carry one.
   */
  static Object stripApiKeyFields(Object value) {
    if (value instanceof Map<?, ?> map) {
      Map<String, Object> out = new LinkedHashMap<>();
      map.forEach((k, v) -> {
        String name = String.valueOf(k);
        if (!isApiKeyName(name)) {
          out.put(name, stripApiKeyFields(v));
        }
      });
      return out;
    }
    if (value instanceof Collection<?> items) {
      List<Object> out = new ArrayList<>(items.size());
      items.forEach(item -> out.add(stripApiKeyFields(item)));
      return out;
    }
    return value;
  }

  static boolean isApiKeyName(String name) {
    return API_KEY_NAME_SEPARATORS.matcher(name.toLowerCase(Locale.ROOT)).replaceAll("").equals("apikey");
  }

  public int flushOnce() {
    int total = 0;
    for (RecordQueue<?> queue : queues) {
      total += flushQueue(queue);
    }
    logDrops();
    return total;
  }

  public int flushAll() {
    int total = 0;
    while (true) {
      int sent = flushOnce();
      if (sent <= 0) {
        return total;
      }
      total += sent;
    }
  }

  static int attributesLength(Map<String, String> attributes) {
    int total = 0;
    for (Map.Entry<String, String> entry : attributes.entrySet()) {
      total += Strings.clean(entry.getKey()).length() + Strings.clean(entry.getValue()).length();
    }
    return total;
  }

  private <T> void capture(RecordQueue<T> queue, T record) {
    int size = queue.sizer.applyAsInt(record);
    boolean flushNow;
    synchronized (queueLock) {
      if (size > config.maxQueueBytes()) {
        // A single record over the whole budget would evict everything and
        // still not fit: shed it instead.
        drop(queue.key, DROP_QUEUE_BYTES, 1);
        return;
      }
      if (queue.size() >= config.maxQueueSize()) {
        pollFirst(queue);
        drop(queue.key, DROP_QUEUE_FULL, 1);
      }
      while (queuedBytes + size > config.maxQueueBytes()) {
        // Oldest from this queue first; once it is empty, from whichever
        // other queue holds the most bytes.
        RecordQueue<?> victim = queue.size() > 0 ? queue : largestQueue();
        if (victim == null) {
          break;
        }
        pollFirst(victim);
        drop(victim.key, DROP_QUEUE_BYTES, 1);
      }
      queue.items.addLast(new Queued<>(record, size));
      queue.bytes += size;
      queuedBytes += size;
      flushNow = queue.size() >= config.batchSize() || queue.bytes >= config.maxBatchBytes();
    }
    if (flushNow) {
      submitFlush();
    }
  }

  private void pollFirst(RecordQueue<?> queue) {
    Queued<?> head = queue.items.pollFirst();
    if (head != null) {
      queue.bytes -= head.bytes;
      queuedBytes -= head.bytes;
    }
  }

  private RecordQueue<?> largestQueue() {
    return queues.stream()
        .filter(q -> q.size() > 0)
        .max(Comparator.comparingLong(q -> q.bytes))
        .orElse(null);
  }

  private void drop(String signal, String reason, long count) {
    drops.get(reason).addAndGet(count);
    if (!DROP_TRUNCATED.equals(reason)) {
      unreportedDrops.computeIfAbsent(signal, s -> new ConcurrentHashMap<>())
          .computeIfAbsent(reason, r -> new AtomicLong())
          .addAndGet(count);
    }
  }

  private void submitFlush() {
    ScheduledExecutorService service = executor;
    if (service == null || service.isShutdown() || !flushSubmitted.compareAndSet(false, true)) {
      return;
    }
    try {
      service.execute(() -> {
        try {
          flushSafely();
        } finally {
          flushSubmitted.set(false);
        }
      });
    } catch (RuntimeException ex) {
      flushSubmitted.set(false);
    }
  }

  private void flushSafely() {
    try {
      flushOnce();
    } catch (Exception ex) {
      LOGGER.log(Level.WARNING, "Unexpected error while flushing API Lens queue", ex);
    }
  }

  private <T> int flushQueue(RecordQueue<T> queue) {
    while (true) {
      if (remainingNanos() <= 0) {
        // Past the shutdown deadline: shutdown() counts what is left.
        return 0;
      }
      List<Queued<T>> taken = take(queue, config.batchSize());
      if (taken.isEmpty()) {
        return 0;
      }
      PreparedBatch batch = prepare(queue, taken);
      if (batch.count == 0) {
        // Every taken record was unsendable (dropped); try the next ones.
        continue;
      }
      if (sendWithRetry(queue, batch)) {
        return batch.count;
      }
      return 0;
    }
  }

  private <T> List<Queued<T>> take(RecordQueue<T> queue, int size) {
    synchronized (queueLock) {
      if (queue.size() == 0) {
        return List.of();
      }
      List<Queued<T>> taken = new ArrayList<>(Math.min(size, queue.size()));
      while (queue.size() > 0 && taken.size() < size) {
        Queued<T> head = queue.items.pollFirst();
        queue.bytes -= head.bytes;
        queuedBytes -= head.bytes;
        taken.add(head);
      }
      return taken;
    }
  }

  /** Put records that did not fit this batch back at the head of the queue, in order. */
  private <T> void pushBack(RecordQueue<T> queue, List<Queued<T>> rest) {
    synchronized (queueLock) {
      for (int i = rest.size() - 1; i >= 0; i -= 1) {
        Queued<T> item = rest.get(i);
        queue.items.addFirst(item);
        queue.bytes += item.bytes;
        queuedBytes += item.bytes;
      }
    }
  }

  /**
   * Serialise {@code taken} into one JSON body no larger than {@code maxBatchBytes}. Records
   * that do not fit go back on the queue for the next batch. A single record larger than the
   * limit is truncated (payloads first) rather than dropped.
   */
  private <T> PreparedBatch prepare(RecordQueue<T> queue, List<Queued<T>> taken) {
    byte[] prefix = ("{\"" + queue.key + "\":[").getBytes(StandardCharsets.UTF_8);
    byte[] suffix = "]}".getBytes(StandardCharsets.UTF_8);
    long limit = (long) config.maxBatchBytes() - prefix.length - suffix.length;

    ByteArrayOutputStream body = new ByteArrayOutputStream();
    body.writeBytes(prefix);
    int count = 0;
    long total = 0;
    for (int i = 0; i < taken.size(); i += 1) {
      Map<String, Object> wire = queue.wire.apply(taken.get(i).record);
      byte[] json;
      try {
        json = MAPPER.writeValueAsBytes(wire);
      } catch (JsonProcessingException ex) {
        LOGGER.log(Level.FINE, "API Lens could not serialise a record; dropping it", ex);
        drop(queue.key, DROP_NON_RETRYABLE, 1);
        continue;
      }
      int separator = count > 0 ? 1 : 0;
      if (count > 0 && total + separator + json.length > limit) {
        pushBack(queue, taken.subList(i, taken.size()));
        break;
      }
      if (json.length > limit) {
        json = truncate(wire, limit);
        if (json == null) {
          drop(queue.key, DROP_QUEUE_BYTES, 1);
          continue;
        }
        drop(queue.key, DROP_TRUNCATED, 1);
      }
      if (separator > 0) {
        body.write(',');
      }
      body.writeBytes(json);
      total += separator + json.length;
      count += 1;
    }
    body.writeBytes(suffix);
    return new PreparedBatch(count, body.toByteArray());
  }

  /**
   * Shorten {@code wire}'s payload fields (then headers, then any other long string) until its
   * JSON fits in {@code limit} bytes; {@code null} when it cannot be made to fit.
   */
  private static byte[] truncate(Map<String, Object> wire, long limit) {
    Map<String, Object> copy = new LinkedHashMap<>(wire);
    List<String> fields = new ArrayList<>();
    for (String field : TRUNCATE_FIELDS) {
      if (copy.get(field) instanceof String) {
        fields.add(field);
      }
    }
    copy.entrySet().stream()
        .filter(entry -> entry.getValue() instanceof String && !TRUNCATE_FIELDS.contains(entry.getKey()))
        .sorted(Comparator.comparingInt((Map.Entry<String, Object> e) -> ((String) e.getValue()).length())
            .reversed())
        .forEach(entry -> fields.add(entry.getKey()));

    try {
      byte[] json = MAPPER.writeValueAsBytes(copy);
      for (String field : fields) {
        while (json.length > limit) {
          String value = (String) copy.get(field);
          if (value.isEmpty()) {
            break;
          }
          long excess = json.length - limit;
          int next = (int) Math.max(Math.min(value.length() - excess, value.length() - 1L), 0L);
          if (next > 0 && Character.isHighSurrogate(value.charAt(next - 1))) {
            next -= 1;
          }
          copy.put(field, value.substring(0, next));
          json = MAPPER.writeValueAsBytes(copy);
        }
        if (json.length <= limit) {
          return json;
        }
      }
      return json.length <= limit ? json : null;
    } catch (JsonProcessingException ex) {
      return null;
    }
  }

  private boolean sendWithRetry(RecordQueue<?> queue, PreparedBatch batch) {
    byte[] body = batch.body;
    boolean gzipped = false;
    if (config.compress()) {
      // Runs on the flush thread (or an explicit flush/shutdown), never on
      // the request path: capture only enqueues.
      try {
        body = Delivery.gzip(batch.body);
        gzipped = true;
      } catch (IOException ex) {
        LOGGER.log(Level.FINE, "API Lens gzip failed; sending uncompressed", ex);
      }
    }

    // Retried with backoff until maxRetryDuration has passed since the first attempt (D7), or
    // until the shutdown deadline, whichever comes first.
    long windowEnd = nanoClock.getAsLong() + config.maxRetryDuration().toNanos();
    String reason = DROP_RETRIES_EXHAUSTED;
    Exception lastFailure = null;
    for (int attempt = 0; ; attempt += 1) {
      Duration retryAfter = null;
      try {
        byte[] answer = post(queue.path.get(), body, gzipped, true);
        accepted(queue, batch.count, answer);
        return true;
      } catch (ApiLensHttpException ex) {
        lastFailure = ex;
        if (!ex.retryable()) {
          reason = DROP_NON_RETRYABLE;
          logNonRetryable(ex, batch.count);
          break;
        }
        retryAfter = ex.retryAfter();
      } catch (IOException ex) {
        lastFailure = ex;
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
        lastFailure = ex;
        break;
      }
      if (config.maxRetries() != ApiLensConfig.UNLIMITED_RETRIES && attempt >= config.maxRetries()) {
        break;
      }
      long left = windowEnd - nanoClock.getAsLong();
      long toDeadline = remainingNanos();
      if (toDeadline <= left) {
        left = toDeadline;
        if (left <= 0) {
          reason = DROP_SHUTDOWN;
        }
      }
      if (left <= 0) {
        break;
      }
      Duration delay = retryAfter != null
          ? retryAfter
          : Delivery.backoff(attempt, config.retryBackoffBase(), config.retryBackoffMax(), random.getAsDouble());
      if (delay.toNanos() > left) {
        // The last attempt goes out when the window (or the shutdown deadline) ends.
        delay = Duration.ofNanos(left);
      }
      LOGGER.fine("API Lens ingest attempt " + (attempt + 1) + " failed (" + describe(lastFailure)
          + "); retrying in " + delay.toMillis() + "ms");
      try {
        sleeper.sleep(delay);
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
        break;
      }
    }

    if (!DROP_NON_RETRYABLE.equals(reason) && remainingNanos() <= 0) {
      reason = DROP_SHUTDOWN;
    }
    drop(queue.key, reason, batch.count);
    failedBatches.incrementAndGet();
    lastError = describe(lastFailure);
    // Logged at WARNING by logDrops (rate-limited), not once per batch.
    LOGGER.fine("API Lens ingest failed (" + reason + "); dropped batch of " + batch.count + " " + queue.key);
    return false;
  }

  /**
   * A batch answered 2xx. Ingest accepts batches partially: {@code invalid} counts records it
   * refused on their own and {@code rejected[].records} those refused because of their app; both
   * are dropped (and counted), the rest were stored.
   */
  private void accepted(RecordQueue<?> queue, int count, byte[] answer) {
    long invalid = 0;
    long rejected = 0;
    String detail = null;
    if (answer != null && answer.length > 0) {
      try {
        JsonNode data = MAPPER.readTree(answer);
        if (data != null && data.isObject()) {
          invalid = Math.max(data.path("invalid").asLong(0), 0);
          for (JsonNode app : data.path("rejected")) {
            long n = Math.max(app.path("records").asLong(0), 0);
            rejected += n;
            if (detail == null && n > 0) {
              detail = Strings.firstNonBlank(app.path("detail").asText(""), app.path("error").asText(""));
            }
          }
          JsonNode first = data.path("errors").path(0);
          if (invalid > 0 && first.isObject()) {
            detail = "record " + first.path("index").asInt() + ": " + first.path("reason").asText("");
          }
        }
      } catch (IOException ex) {
        // Not JSON (an older ingest): the whole batch was accepted.
      }
    }
    invalid = Math.min(invalid, count);
    rejected = Math.min(rejected, count - invalid);
    sentBatches.incrementAndGet();
    sentRecords.addAndGet(count - invalid - rejected);
    lastSuccessAt = Instant.now();
    if (invalid > 0) {
      drop(queue.key, DROP_INVALID, invalid);
    }
    if (rejected > 0) {
      drop(queue.key, DROP_APP_REJECTED, rejected);
    }
    if (invalid + rejected > 0) {
      lastError = "ingest refused " + (invalid + rejected) + " of " + count + " " + queue.key
          + (Strings.isBlank(detail) ? "" : " (" + detail + ")");
    }
  }

  private static String describe(Exception ex) {
    if (ex == null) {
      return null;
    }
    String message = ex.getMessage();
    return Strings.isBlank(message) ? ex.getClass().getSimpleName() : message;
  }

  /** Log a rejected batch at most once per status per 5 minutes, so a bad key cannot flood logs. */
  private void logNonRetryable(ApiLensHttpException ex, int count) {
    int status = ex.status();
    long now = System.nanoTime();
    Long last = nonRetryableLoggedAt.get(status);
    if (last != null && now - last < NON_RETRYABLE_LOG_INTERVAL.toNanos()) {
      return;
    }
    nonRetryableLoggedAt.put(status, now);
    if (status == 401) {
      LOGGER.severe("API Lens ingest rejected the API key (401 Unauthorized), so telemetry is being "
          + "dropped. Check that apiKey is a valid project API key for " + config.baseUrl()
          + ". Troubleshooting: " + TROUBLESHOOTING_URL);
      return;
    }
    LOGGER.warning("API Lens ingest rejected a batch of " + count + " records with status " + status
        + " (not retried): " + (ex.body().isEmpty() ? "<empty body>" : ex.body()));
  }

  private void logDrops() {
    logDrops(false);
  }

  /** Log new drops at WARNING, at most once a minute unless {@code force} (shutdown). */
  private void logDrops(boolean force) {
    long dropped = droppedCount();
    long previous = lastLoggedDropped.get();
    long now = System.nanoTime();
    long lastLog = lastDropLogNanos.get();
    if (dropped <= previous || (!force && now - lastLog < DROP_LOG_INTERVAL.toNanos())) {
      return;
    }
    if (lastDropLogNanos.compareAndSet(lastLog, now)) {
      lastLoggedDropped.set(dropped);
      Map<String, Long> counts = new LinkedHashMap<>(dropCounts());
      counts.values().removeIf(n -> n == 0);
      String error = lastError;
      LOGGER.warning("API Lens dropped " + (dropped - previous) + " records (total " + dropped + "): "
          + counts + (Strings.isBlank(error) ? "" : "; last error: " + error));
    }
  }

  private void post(String path, byte[] body, boolean gzipped) throws IOException, InterruptedException {
    post(path, body, gzipped, false);
  }

  /** POSTs {@code body}; returns the response body on success when {@code readResponse}, else empty. */
  private byte[] post(String path, byte[] body, boolean gzipped, boolean readResponse)
      throws IOException, InterruptedException {
    URI endpoint = resolveEndpoint(path);
    Duration timeout = config.timeout();
    long left = remainingNanos();
    if (left < timeout.toNanos()) {
      // Shutting down: no request outlives the shutdown deadline.
      timeout = Duration.ofNanos(Math.max(left, 1_000_000L));
    }
    HttpRequest.Builder builder = HttpRequest.newBuilder(endpoint)
        .timeout(timeout)
        .header("Content-Type", "application/json")
        .header("X-API-Key", config.apiKey())
        .header("User-Agent", config.userAgent());
    if (gzipped) {
      builder.header("Content-Encoding", "gzip");
    }
    HttpRequest request = builder.POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();

    HttpResponse<InputStream> response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
    int status = response.statusCode();
    try (InputStream in = response.body()) {
      if (status < 400) {
        return readResponse ? in.readNBytes(MAX_RESPONSE_BYTES) : new byte[0];
      }
      if (Delivery.isRetryableStatus(status)) {
        Duration retryAfter = Delivery.parseRetryAfter(
            response.headers().firstValue("Retry-After").orElse(null), Instant.now());
        throw new ApiLensHttpException(
            "API Lens ingest returned status=" + status, null, true, status, retryAfter, "");
      }
      throw new ApiLensHttpException(
          "API Lens ingest returned status=" + status, null, false, status, null, readErrorBody(in));
    }
  }

  private static String readErrorBody(InputStream in) {
    try {
      byte[] raw = in.readNBytes(MAX_LOGGED_BODY_BYTES + 1);
      int length = Math.min(raw.length, MAX_LOGGED_BODY_BYTES);
      String text = new String(raw, 0, length, StandardCharsets.UTF_8).strip();
      return raw.length > MAX_LOGGED_BODY_BYTES ? text + "..." : text;
    } catch (IOException ex) {
      return "";
    }
  }

  private URI resolveEndpoint(String path) {
    String value = Strings.clean(path);
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return URI.create(value);
    }

    String baseValue = config.baseUrl().replaceAll("/+$", "");
    URI base = URI.create(baseValue + "/");
    if (value.startsWith("/")) {
      return URI.create(base.getScheme() + "://" + base.getRawAuthority()).resolve(value);
    }
    return base.resolve(value);
  }

  /** Waits between retry attempts. */
  @FunctionalInterface
  interface Sleeper {
    void sleep(Duration duration) throws InterruptedException;
  }

  private record Queued<T>(T record, int bytes) {}

  private record AppKey(String appId, String environment) {}

  private record PreparedBatch(int count, byte[] body) {}

  /** One of the request/span/log queues. Mutated only under {@code queueLock}. */
  private static final class RecordQueue<T> {
    final String key;
    final Supplier<String> path;
    final Function<T, Map<String, Object>> wire;
    final ToIntFunction<T> sizer;
    final ArrayDeque<Queued<T>> items = new ArrayDeque<>();
    long bytes;

    RecordQueue(String key, Supplier<String> path, Function<T, Map<String, Object>> wire, ToIntFunction<T> sizer) {
      this.key = key;
      this.path = path;
      this.wire = wire;
      this.sizer = sizer;
    }

    int size() {
      return items.size();
    }
  }

  private static final class ApiLensThreadFactory implements ThreadFactory {
    private final String name;

    ApiLensThreadFactory(String name) {
      this.name = name;
    }

    @Override
    public Thread newThread(Runnable runnable) {
      Thread thread = new Thread(runnable, name);
      thread.setDaemon(true);
      return thread;
    }
  }
}
