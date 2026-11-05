package ai.apilens.internal;

import java.time.Duration;

/** A failed ingest POST, classified as retryable or not. */
public final class ApiLensHttpException extends RuntimeException {
  private final boolean retryable;
  private final int status;
  private final Duration retryAfter;
  private final String body;

  public ApiLensHttpException(String message, boolean retryable) {
    this(message, null, retryable, 0, null, "");
  }

  public ApiLensHttpException(String message, Throwable cause, boolean retryable) {
    this(message, cause, retryable, 0, null, "");
  }

  public ApiLensHttpException(
      String message,
      Throwable cause,
      boolean retryable,
      int status,
      Duration retryAfter,
      String body) {
    super(message, cause);
    this.retryable = retryable;
    this.status = status;
    this.retryAfter = retryAfter;
    this.body = body == null ? "" : body;
  }

  public boolean retryable() {
    return retryable;
  }

  /** HTTP status, or 0 for a network error or timeout. */
  public int status() {
    return status;
  }

  /** Server-sent {@code Retry-After} (capped), or {@code null} when absent. */
  public Duration retryAfter() {
    return retryAfter;
  }

  /** Response body (truncated) of a rejected batch; empty otherwise. */
  public String body() {
    return body;
  }
}
