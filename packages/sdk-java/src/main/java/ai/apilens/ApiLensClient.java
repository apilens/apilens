package ai.apilens;

import ai.apilens.internal.ApiLensHttpException;
import ai.apilens.internal.HttpClients;
import ai.apilens.internal.Strings;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.logging.Level;
import java.util.logging.Logger;

/** Asynchronous API Lens ingest client with bounded queues and retry/backoff. */
public class ApiLensClient implements AutoCloseable {
  private static final Logger LOGGER = Logger.getLogger("apilens");
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private final ApiLensConfig config;
  private final HttpClient httpClient;
  private final Object queueLock = new Object();
  private final ArrayDeque<RequestRecord> requestQueue = new ArrayDeque<>();
  private final ArrayDeque<SpanRecord> spanQueue = new ArrayDeque<>();
  private final ArrayDeque<LogRecord> logQueue = new ArrayDeque<>();
  private final AtomicLong droppedCount = new AtomicLong();
  private final AtomicBoolean flushSubmitted = new AtomicBoolean();

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

  public long droppedCount() {
    return droppedCount.get();
  }

  public int queuedRequestCount() {
    synchronized (queueLock) {
      return requestQueue.size();
    }
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
    int size = offer(requestQueue, record);
    if (size >= config.batchSize()) {
      submitFlush();
    }
  }

  public void captureSpan(SpanRecord record) {
    if (!config.enabled() || record == null) {
      return;
    }
    int size = offer(spanQueue, record);
    if (size >= config.batchSize()) {
      submitFlush();
    }
  }

  public void captureLog(LogRecord record) {
    if (!config.enabled() || record == null) {
      return;
    }
    int size = offer(logQueue, record);
    if (size >= config.batchSize()) {
      submitFlush();
    }
  }

  public int flushOnce() {
    int total = 0;
    total += flushQueue(requestQueue, "records", this::sendRequests);
    total += flushQueue(spanQueue, "spans", this::sendSpans);
    total += flushQueue(logQueue, "logs", this::sendLogs);
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

  private <T> int offer(ArrayDeque<T> queue, T record) {
    synchronized (queueLock) {
      if (queue.size() >= config.maxQueueSize()) {
        queue.removeFirst();
        droppedCount.incrementAndGet();
      }
      queue.addLast(record);
      return queue.size();
    }
  }

  private void submitFlush() {
    ScheduledExecutorService service = executor;
    if (service == null || service.isShutdown() || !flushSubmitted.compareAndSet(false, true)) {
      return;
    }
    service.execute(() -> {
      try {
        flushSafely();
      } finally {
        flushSubmitted.set(false);
      }
    });
  }

  private void flushSafely() {
    try {
      flushOnce();
    } catch (Exception ex) {
      LOGGER.log(Level.WARNING, "Unexpected error while flushing API Lens queue", ex);
    }
  }

  private <T> int flushQueue(ArrayDeque<T> queue, String label, BatchSender<T> sender) {
    List<T> batch = popBatch(queue, config.batchSize());
    if (batch.isEmpty()) {
      return 0;
    }
    if (sendWithRetry(batch, sender)) {
      return batch.size();
    }
    LOGGER.warning("API Lens ingest failed; dropping batch of " + batch.size() + " " + label);
    return 0;
  }

  private <T> List<T> popBatch(ArrayDeque<T> queue, int size) {
    synchronized (queueLock) {
      if (queue.isEmpty()) {
        return List.of();
      }
      List<T> batch = new ArrayList<>(Math.min(size, queue.size()));
      while (!queue.isEmpty() && batch.size() < size) {
        batch.add(queue.removeFirst());
      }
      return batch;
    }
  }

  private <T> boolean sendWithRetry(List<T> batch, BatchSender<T> sender) {
    Exception lastError = null;
    for (int attempt = 0; attempt <= config.maxRetries(); attempt += 1) {
      try {
        sender.send(batch);
        return true;
      } catch (ApiLensHttpException ex) {
        lastError = ex;
        if (!ex.retryable() || attempt >= config.maxRetries()) {
          break;
        }
      } catch (Exception ex) {
        lastError = ex;
        if (attempt >= config.maxRetries()) {
          break;
        }
      }

      sleep(backoff(attempt));
    }
    if (lastError != null) {
      LOGGER.log(Level.WARNING, "API Lens ingest request failed after retries", lastError);
    }
    return false;
  }

  private Duration backoff(int attempt) {
    long base = Math.max(config.retryBackoffBase().toMillis(), 1);
    long max = Math.max(config.retryBackoffMax().toMillis(), 1);
    long factor = 1L << Math.min(attempt, 30);
    return Duration.ofMillis(Math.min(base * factor, max));
  }

  private void sleep(Duration duration) {
    try {
      Thread.sleep(duration.toMillis());
    } catch (InterruptedException ex) {
      Thread.currentThread().interrupt();
    }
  }

  private void sendRequests(List<RequestRecord> batch) throws IOException, InterruptedException {
    postJson(config.ingestPath(), Map.of("requests", wire(batch, record -> record.toWire(config))));
  }

  private void sendSpans(List<SpanRecord> batch) throws IOException, InterruptedException {
    postJson(config.spansPath(), Map.of("spans", wire(batch, record -> record.toWire(config))));
  }

  private void sendLogs(List<LogRecord> batch) throws IOException, InterruptedException {
    postJson(config.logsPath(), Map.of("logs", wire(batch, record -> record.toWire(config))));
  }

  private <T> List<Map<String, Object>> wire(List<T> batch, Function<T, Map<String, Object>> mapper) {
    return batch.stream().map(mapper).toList();
  }

  private void postJson(String path, Map<String, Object> payload) throws IOException, InterruptedException {
    URI endpoint = resolveEndpoint(path);
    String body = MAPPER.writeValueAsString(payload);
    HttpRequest request = HttpRequest.newBuilder(endpoint)
        .timeout(config.timeout())
        .header("Content-Type", "application/json")
        .header("X-API-Key", config.apiKey())
        .header("User-Agent", config.userAgent())
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build();

    HttpResponse<Void> response = httpClient.send(request, HttpResponse.BodyHandlers.discarding());
    int status = response.statusCode();
    if (status >= 400) {
      boolean retryable = status == 429 || status >= 500;
      throw new ApiLensHttpException("API Lens ingest returned status=" + status, retryable);
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

  @FunctionalInterface
  private interface BatchSender<T> {
    void send(List<T> batch) throws IOException, InterruptedException;
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
