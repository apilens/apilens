package ai.apilens;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Point-in-time delivery health snapshot from {@link ApiLensClient#stats()}.
 *
 * <p>{@code dropCounts} holds the records dropped per reason ({@code queue_full}, {@code
 * queue_bytes}, {@code non_retryable}, {@code retries_exhausted}) plus {@code truncated}:
 * records shortened to fit {@code maxBatchBytes} and still sent, so not part of {@code
 * droppedCount}. Keys keep the order of {@link ApiLensClient#DROP_REASONS}.
 */
public record ClientStats(
    int queuedRecords,
    long queuedBytes,
    long sentBatches,
    long sentRecords,
    long failedBatches,
    long droppedCount,
    Map<String, Long> dropCounts,
    String lastError,
    Instant lastSuccessAt) {
  public ClientStats {
    dropCounts = Collections.unmodifiableMap(new LinkedHashMap<>(dropCounts));
  }
}
