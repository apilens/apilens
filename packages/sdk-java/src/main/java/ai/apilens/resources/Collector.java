package ai.apilens.resources;

/**
 * One source of resource numbers. The sampler calls {@link #sample} every interval on its own
 * thread and {@link #drain} when a heartbeat takes the window; both under the window's lock. A
 * collector that throws is counted and, after {@link ResourceSampler#MAX_CONSECUTIVE_FAILURES}
 * failures in a row, disabled; one that throws {@link Unavailable} is disabled at once.
 */
public interface Collector {
  /**
   * The remote-policy name ({@code process.cpu}, {@code process.memory}, {@code process.pss},
   * {@code container.cpu}, {@code container.memory}, {@code runtime}, {@code pools}, {@code
   * processes}).
   */
  String name();

  /** The {@code capabilities} token sent while the collector works. */
  String capability();

  /**
   * Takes one sample into {@code window}; {@code nowNanos} is {@link System#nanoTime()}.
   *
   * @return whether anything was measured (only then does it count as a capability)
   */
  boolean sample(Window window, long nowNanos) throws Exception;

  /** Adds what is kept per window (lists, ratios) when a heartbeat drains it. */
  default void drain(Window window) {}

  /** Shortest time between two samples of this collector, in nanoseconds; 0 = every tick. */
  default long minSpacingNanos() {
    return 0;
  }

  /** Releases listeners; called once when the sampler stops. */
  default void close() {}

  /** Thrown when the collector can never work here (e.g. permission denied): disable it now. */
  final class Unavailable extends Exception {
    private static final long serialVersionUID = 1L;

    public Unavailable(String message) {
      super(message, null, false, false);
    }
  }
}
