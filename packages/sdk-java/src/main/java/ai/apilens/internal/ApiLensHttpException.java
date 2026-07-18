package ai.apilens.internal;

public final class ApiLensHttpException extends RuntimeException {
  private final boolean retryable;

  public ApiLensHttpException(String message, boolean retryable) {
    super(message);
    this.retryable = retryable;
  }

  public ApiLensHttpException(String message, Throwable cause, boolean retryable) {
    super(message, cause);
    this.retryable = retryable;
  }

  public boolean retryable() {
    return retryable;
  }
}
