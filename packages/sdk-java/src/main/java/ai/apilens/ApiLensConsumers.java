package ai.apilens;

import java.util.Optional;

/** Thread-local request consumer helpers for framework integrations. */
public final class ApiLensConsumers {
  private static final ThreadLocal<ApiLensConsumer> CURRENT = new ThreadLocal<>();

  private ApiLensConsumers() {}

  public static void setConsumer(String identifier) {
    CURRENT.set(ApiLensConsumer.of(identifier));
  }

  public static void setConsumer(String identifier, String name, String group) {
    CURRENT.set(ApiLensConsumer.of(identifier, name, group));
  }

  public static void setConsumer(ApiLensConsumer consumer) {
    if (consumer == null || consumer.isEmpty()) {
      CURRENT.remove();
      return;
    }
    CURRENT.set(consumer);
  }

  public static Optional<ApiLensConsumer> current() {
    return Optional.ofNullable(CURRENT.get());
  }

  public static void clear() {
    CURRENT.remove();
  }
}
