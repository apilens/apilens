package ai.apilens;

import ai.apilens.internal.ApiLensHttpException;
import ai.apilens.internal.Delivery;
import ai.apilens.internal.HttpClients;
import ai.apilens.internal.Strings;
import com.fasterxml.jackson.core.JsonProcessingException;
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
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.DoubleSupplier;
import java.util.function.Function;
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
 * errors with full-jitter backoff, honouring {@code Retry-After}. Any other 4xx drops the
 * batch at once. {@link #stats()} reports what happened.
 */
public class ApiLensClient implements AutoCloseable {
  /** Record-count cap ({@code maxQueueSize}) hit; the oldest record was dropped. */
  public static final String DROP_QUEUE_FULL = "queue_full";
  /** Memory cap ({@code maxQueueBytes}) hit, or a record could not fit {@code maxBatchBytes}. */
  public static final String DROP_QUEUE_BYTES = "queue_bytes";
  /** Ingest rejected the batch with a non-retryable 4xx. */
  public static final String DROP_NON_RETRYABLE = "non_retryable";
  /** The batch still failed after {@code maxRetries}. */
  public static final String DROP_RETRIES_EXHAUSTED = "retries_exhausted";
  /** Not a drop: a record was shortened to fit {@code maxBatchBytes} and still sent. */
  public static final String DROP_TRUNCATED = "truncated";
  /** Every key of {@link ClientStats#dropCounts()}. */
  public static final List<String> DROP_REASONS = List.of(
      DROP_QUEUE_FULL, DROP_QUEUE_BYTES, DROP_NON_RETRYABLE, DROP_RETRIES_EXHAUSTED, DROP_TRUNCATED);

  /** Fixed per-record overhead added to the variable-length fields when estimating size. */
  static final int RECORD_OVERHEAD_BYTES = 512;

  private static final Logger LOGGER = Logger.getLogger("apilens");
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Duration NON_RETRYABLE_LOG_INTERVAL = Duration.ofMinutes(5);
  private static final Duration DROP_LOG_INTERVAL = Duration.ofMinutes(1);
  private static final int MAX_LOGGED_BODY_BYTES = 1024;
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
  private final AtomicLong sentBatches = new AtomicLong();
  private final AtomicLong sentRecords = new AtomicLong();
  private final AtomicLong failedBatches = new AtomicLong();
  private volatile String lastError;
  private volatile Instant lastSuccessAt;
  private final Map<Integer, Long> nonRetryableLoggedAt = new ConcurrentHashMap<>();
  private final AtomicLong lastDropLogNanos = new AtomicLong(System.nanoTime() - DROP_LOG_INTERVAL.toNanos());
  private final AtomicLong lastLoggedDropped = new AtomicLong();
  private final AtomicBoolean flushSubmitted = new AtomicBoolean();

  /** Waits between retries; replaced in tests. */
  volatile Sleeper sleeper = duration -> Thread.sleep(duration.toMillis());
  /** Jitter source in {@code [0, 1)}; replaced in tests. */
  volatile DoubleSupplier random = () -> ThreadLocalRandom.current().nextDouble();

  private volatile ScheduledExecutorService executor;

  public ApiLensClient(ApiLensConfig config) {
    this(config, HttpClients.create(config));
  }

  ApiLensClient(ApiLensConfig config, HttpClient httpClient) {
    this.config = Objects.requireNonNull(config, "config");
    this.httpClient = Objects.requireNonNull(httpClient, "httpClient");

    if (Strings.isBlank(config.apiKey())) {
      throw new IllegalArgumentException("apiKey is required");
    }
    if (Strings.isBlank(config.appId())) {
      throw new IllegalArgumentException("appId is required");
    }
    URI.create(config.baseUrl());

    for (String reason : DROP_REASONS) {
      drops.put(reason, new AtomicLong());
    }
    requestQueue = new RecordQueue<>(
        "requests", config::ingestPath, record -> record.toWire(config), RequestRecord::estimatedBytes);
    spanQueue = new RecordQueue<>(
        "spans", config::spansPath, record -> record.toWire(config), SpanRecord::estimatedBytes);
    logQueue = new RecordQueue<>(
        "logs", config::logsPath, record -> record.toWire(config), LogRecord::estimatedBytes);
    queues = List.of(requestQueue, spanQueue, logQueue);

    if (config.enabled()) {
      start();
    }
  }

  public ApiLensConfig config() {
    return config;
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
    ScheduledExecutorService service = Executors.newSingleThreadScheduledExecutor(new ApiLensThreadFactory());
    executor = service;
    long intervalMs = Math.max(config.flushInterval().toMillis(), 1);
    service.scheduleWithFixedDelay(this::flushSafely, intervalMs, intervalMs, TimeUnit.MILLISECONDS);
  }

  public void stop() {
    ScheduledExecutorService service = executor;
    executor = null;
    if (service != null) {
      service.shutdown();
    }
  }

  public void shutdown() {
    shutdown(true);
  }

  public void shutdown(boolean flush) {
    if (flush) {
      flushAll();
    }
    stop();
  }

  @Override
  public void close() {
    shutdown(true);
  }

  public void capture(RequestRecord record) {
    if (!config.enabled() || record == null) {
      return;
    }
    capture(requestQueue, record);
  }

  public void captureSpan(SpanRecord record) {
    if (!config.enabled() || record == null) {
      return;
    }
    capture(spanQueue, record);
  }

  public void captureLog(LogRecord record) {
    if (!config.enabled() || record == null) {
      return;
    }
    capture(logQueue, record);
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
        drop(DROP_QUEUE_BYTES, 1);
        return;
      }
      if (queue.size() >= config.maxQueueSize()) {
        pollFirst(queue);
        drop(DROP_QUEUE_FULL, 1);
      }
      while (queuedBytes + size > config.maxQueueBytes()) {
        // Oldest from this queue first; once it is empty, from whichever
        // other queue holds the most bytes.
        RecordQueue<?> victim = queue.size() > 0 ? queue : largestQueue();
        if (victim == null) {
          break;
        }
        pollFirst(victim);
        drop(DROP_QUEUE_BYTES, 1);
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

  private void drop(String reason, long count) {
    drops.get(reason).addAndGet(count);
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
      LOGGER.fine("API Lens ingest failed; dropped batch of " + batch.count + " " + queue.key);
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
        drop(DROP_NON_RETRYABLE, 1);
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
          drop(DROP_QUEUE_BYTES, 1);
          continue;
        }
        drop(DROP_TRUNCATED, 1);
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

    String reason = DROP_RETRIES_EXHAUSTED;
    Exception lastFailure = null;
    for (int attempt = 0; attempt <= config.maxRetries(); attempt += 1) {
      Duration retryAfter = null;
      try {
        post(queue.path.get(), body, gzipped);
        sentBatches.incrementAndGet();
        sentRecords.addAndGet(batch.count);
        lastSuccessAt = Instant.now();
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
      if (attempt >= config.maxRetries()) {
        break;
      }
      Duration delay = retryAfter != null
          ? retryAfter
          : Delivery.backoff(attempt, config.retryBackoffBase(), config.retryBackoffMax(), random.getAsDouble());
      LOGGER.fine("API Lens ingest attempt " + (attempt + 1) + " failed (" + describe(lastFailure)
          + "); retrying in " + delay.toMillis() + "ms");
      try {
        sleeper.sleep(delay);
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
        break;
      }
    }

    drop(reason, batch.count);
    failedBatches.incrementAndGet();
    lastError = describe(lastFailure);
    if (DROP_RETRIES_EXHAUSTED.equals(reason)) {
      LOGGER.log(Level.WARNING, "API Lens ingest failed after retries; dropping batch of "
          + batch.count + " " + queue.key, lastFailure);
    }
    return false;
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

  /** Log new drops at INFO at most once a minute. */
  private void logDrops() {
    long dropped = droppedCount();
    long previous = lastLoggedDropped.get();
    long now = System.nanoTime();
    long lastLog = lastDropLogNanos.get();
    if (dropped <= previous || now - lastLog < DROP_LOG_INTERVAL.toNanos()) {
      return;
    }
    if (lastDropLogNanos.compareAndSet(lastLog, now)) {
      lastLoggedDropped.set(dropped);
      LOGGER.info("API Lens dropped " + (dropped - previous) + " records (total " + dropped + "): "
          + dropCounts());
    }
  }

  private void post(String path, byte[] body, boolean gzipped) throws IOException, InterruptedException {
    URI endpoint = resolveEndpoint(path);
    HttpRequest.Builder builder = HttpRequest.newBuilder(endpoint)
        .timeout(config.timeout())
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
        return;
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
    @Override
    public Thread newThread(Runnable runnable) {
      Thread thread = new Thread(runnable, "apilens-flush");
      thread.setDaemon(true);
      return thread;
    }
  }
}
