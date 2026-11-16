package ai.apilens.examples;

/** Thrown by {@code GET /boom/handled}; {@link ExampleErrorAdvice} answers it with a 500. */
public class HandledFailure extends RuntimeException {
  public HandledFailure(String message) {
    super(message);
  }
}
