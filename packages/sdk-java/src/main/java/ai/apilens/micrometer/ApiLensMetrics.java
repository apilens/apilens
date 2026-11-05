package ai.apilens.micrometer;

import ai.apilens.ApiLensClient;
import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tag;
import io.micrometer.core.instrument.Tags;
import io.micrometer.core.instrument.binder.MeterBinder;
import java.util.Objects;

/**
 * Micrometer binder for {@link ApiLensClient#stats()}. Needs {@code micrometer-core} on the
 * classpath; Spring Boot registers it automatically when it is.
 *
 * <ul>
 *   <li>{@code apilens.queue.records} (gauge): records waiting to be sent
 *   <li>{@code apilens.queue.bytes} (gauge): estimated bytes queued
 *   <li>{@code apilens.batches.sent} / {@code apilens.records.sent} (counters)
 *   <li>{@code apilens.batches.failed} (counter): batches dropped after a failed send
 *   <li>{@code apilens.records.dropped} (counter, tag {@code reason}): {@code queue_full},
 *       {@code queue_bytes}, {@code non_retryable}, {@code retries_exhausted}
 *   <li>{@code apilens.records.truncated} (counter): records shortened to fit {@code
 *       maxBatchBytes} and still sent
 * </ul>
 */
public final class ApiLensMetrics implements MeterBinder {
  private final ApiLensClient client;
  private final Iterable<Tag> tags;

  public ApiLensMetrics(ApiLensClient client) {
    this(client, Tags.empty());
  }

  public ApiLensMetrics(ApiLensClient client, Iterable<Tag> tags) {
    this.client = Objects.requireNonNull(client, "client");
    this.tags = tags == null ? Tags.empty() : tags;
  }

  @Override
  public void bindTo(MeterRegistry registry) {
    Gauge.builder("apilens.queue.records", client, c -> c.stats().queuedRecords())
        .description("API Lens records waiting to be sent")
        .tags(tags)
        .register(registry);
    Gauge.builder("apilens.queue.bytes", client, c -> c.queuedBytes())
        .description("Estimated bytes held by the API Lens queues")
        .baseUnit("bytes")
        .tags(tags)
        .register(registry);
    FunctionCounter.builder("apilens.batches.sent", client, c -> c.stats().sentBatches())
        .description("API Lens ingest batches sent")
        .tags(tags)
        .register(registry);
    FunctionCounter.builder("apilens.records.sent", client, c -> c.stats().sentRecords())
        .description("API Lens records sent")
        .tags(tags)
        .register(registry);
    FunctionCounter.builder("apilens.batches.failed", client, c -> c.stats().failedBatches())
        .description("API Lens ingest batches dropped after a failed send")
        .tags(tags)
        .register(registry);
    for (String reason : ApiLensClient.DROP_REASONS) {
      if (ApiLensClient.DROP_TRUNCATED.equals(reason)) {
        continue;
      }
      FunctionCounter.builder("apilens.records.dropped", client, c -> dropCount(c, reason))
          .description("API Lens records dropped, by reason")
          .tags(tags)
          .tag("reason", reason)
          .register(registry);
    }
    FunctionCounter.builder("apilens.records.truncated", client,
            c -> dropCount(c, ApiLensClient.DROP_TRUNCATED))
        .description("API Lens records shortened to fit maxBatchBytes and still sent")
        .tags(tags)
        .register(registry);
  }

  private static double dropCount(ApiLensClient client, String reason) {
    Long count = client.dropCounts().get(reason);
    return count == null ? 0 : count;
  }
}
