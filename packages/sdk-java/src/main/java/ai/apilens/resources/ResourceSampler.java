package ai.apilens.resources;

import ai.apilens.RemotePolicy;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Samples runtime resources on one daemon thread ({@code apilens-resources}) every interval and
 * aggregates them into a {@link Window} that each heartbeat drains into its {@code resources}
 * block (contract v1, {@code apps/docs/ingest/heartbeat.mdx}).
 *
 * <p>Safety: every collector is isolated (its errors are counted and swallowed, and it is
 * disabled after {@value #MAX_CONSECUTIVE_FAILURES} failures in a row); the thread is a daemon,
 * so it never keeps the JVM alive; the sampler measures its own CPU time ({@code
 * sampler_cost_us}) and doubles its interval while it costs more than 0.1% of one core. The
 * remote policy only narrows: it can pause sampling, lengthen the interval and skip collectors.
 */
public final class ResourceSampler implements AutoCloseable {
  /** Contract version of the block. */
  public static final int VERSION = 1;
  /** A collector failing this many samples in a row is disabled. */
  public static final int MAX_CONSECUTIVE_FAILURES = 5;
  /** Budget: the sampler may use this share of one core. */
  static final double BUDGET = 0.001;
  /** The interval is at most this many times the configured one when backing off. */
  static final int MAX_BACKOFF = 8;

  private static final Logger LOGGER = Logger.getLogger("apilens");

  private final Duration localInterval;
  private final List<Slot> slots;
  private final Window window = new Window();
  private final LongSupplier nanoClock;
  private final LongSupplier threadCpuNanos;
  private volatile RemotePolicy.Resources policy = RemotePolicy.Resources.UNRESTRICTED;
  private volatile ScheduledExecutorService executor;
  private volatile boolean stopped;

  // Guarded by window.
  private long windowStart;
  private int samples;
  private long costNanos;
  private int backoff = 1;

  private static final class Slot {
    final Collector collector;
    int consecutiveFailures;
    long errors;
    boolean disabled;
    boolean measured;
    long lastRun = Long.MIN_VALUE;

    Slot(Collector collector) {
      this.collector = collector;
    }
  }

  /** A sampler over {@code collectors}, sampling every {@code interval} (no minimum: tests). */
  public ResourceSampler(Duration interval, List<? extends Collector> collectors) {
    this(interval, collectors, System::nanoTime, defaultThreadCpu());
  }

  ResourceSampler(Duration interval, List<? extends Collector> collectors, LongSupplier nanoClock, LongSupplier threadCpuNanos) {
    this.localInterval = interval;
    List<Slot> list = new ArrayList<>();
    for (Collector collector : collectors) {
      list.add(new Slot(collector));
    }
    this.slots = List.copyOf(list);
    this.nanoClock = nanoClock;
    this.threadCpuNanos = threadCpuNanos;
    this.windowStart = nanoClock.getAsLong();
  }

  private static LongSupplier defaultThreadCpu() {
    try {
      ThreadMXBean threads = ManagementFactory.getThreadMXBean();
      if (threads.isCurrentThreadCpuTimeSupported()) {
        if (!threads.isThreadCpuTimeEnabled()) {
          // Read-only: never switch JVM-wide settings on; fall back to wall time.
          return System::nanoTime;
        }
        return threads::getCurrentThreadCpuTime;
      }
    } catch (RuntimeException | LinkageError ex) {
      // No thread CPU time here.
    }
    return System::nanoTime;
  }

  /** Starts the daemon thread; the first sample is taken at once. Idempotent. */
  public synchronized void start() {
    if (executor != null || stopped) {
      return;
    }
    ScheduledExecutorService service = Executors.newSingleThreadScheduledExecutor(runnable -> {
      Thread thread = new Thread(runnable, "apilens-resources");
      thread.setDaemon(true);
      thread.setPriority(Thread.MIN_PRIORITY);
      return thread;
    });
    executor = service;
    schedule(service, 0);
  }

  /** Whether the sampling thread is running. */
  public boolean running() {
    return executor != null && !stopped;
  }

  /** Stops the thread and releases the collectors' listeners. */
  public synchronized void stop() {
    stopped = true;
    ScheduledExecutorService service = executor;
    executor = null;
    if (service != null) {
      service.shutdownNow();
    }
    for (Slot slot : slots) {
      try {
        slot.collector.close();
      } catch (RuntimeException | LinkageError ex) {
        // Never fail a shutdown over a listener.
      }
    }
  }

  @Override
  public void close() {
    stop();
  }

  /** Applies the heartbeat's {@code policy.resources}; it only ever narrows the local config. */
  public void applyPolicy(RemotePolicy.Resources remote) {
    policy = remote == null ? RemotePolicy.Resources.UNRESTRICTED : remote;
  }

  public RemotePolicy.Resources policy() {
    return policy;
  }

  /** The interval now in use: the longer of the local and remote ones, times the backoff. */
  public Duration effectiveInterval() {
    Duration base = localInterval;
    // The remote floor is the SDK's own minimum (the config never goes below it); only a longer
    // remote interval changes anything.
    if (policy.minIntervalS() > RemotePolicy.Resources.FLOOR_INTERVAL_S) {
      Duration remote = Duration.ofSeconds(policy.minIntervalS());
      if (remote.compareTo(base) > 0) {
        base = remote;
      }
    }
    int factor;
    synchronized (window) {
      factor = backoff;
    }
    return base.multipliedBy(factor);
  }

  private void schedule(ScheduledExecutorService service, long delayNanos) {
    try {
      service.schedule(this::tick, delayNanos, TimeUnit.NANOSECONDS);
    } catch (RejectedExecutionException ex) {
      // Stopped.
    }
  }

  private void tick() {
    try {
      sampleNow();
    } catch (VirtualMachineError err) {
      throw err;
    } catch (Throwable t) {
      LOGGER.log(Level.FINE, "API Lens resource sample failed", t);
    } finally {
      ScheduledExecutorService service = executor;
      if (service != null && !stopped) {
        schedule(service, effectiveInterval().toNanos());
      }
    }
  }

  /** Takes one sample of every collector now (the thread does this every interval). */
  public void sampleNow() {
    RemotePolicy.Resources remote = policy;
    if (!remote.enabled()) {
      return;
    }
    long cpu0 = threadCpuNanos.getAsLong();
    long now = nanoClock.getAsLong();
    synchronized (window) {
      for (Slot slot : slots) {
        Collector collector = slot.collector;
        if (slot.disabled || !remote.allows(collector.name())) {
          continue;
        }
        long spacing = collector.minSpacingNanos();
        if (spacing > 0 && slot.lastRun != Long.MIN_VALUE && now - slot.lastRun < spacing) {
          continue;
        }
        slot.lastRun = now;
        try {
          if (collector.sample(window, now)) {
            slot.measured = true;
          }
          slot.consecutiveFailures = 0;
        } catch (Collector.Unavailable ex) {
          slot.errors += 1;
          slot.disabled = true;
          LOGGER.fine("API Lens resources: " + collector.name() + " is unavailable: " + ex.getMessage());
        } catch (VirtualMachineError err) {
          throw err;
        } catch (Throwable t) {
          slot.errors += 1;
          slot.consecutiveFailures += 1;
          if (slot.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            slot.disabled = true;
            LOGGER.log(Level.FINE, "API Lens resources: " + collector.name() + " disabled after "
                + MAX_CONSECUTIVE_FAILURES + " failures", t);
          }
        }
      }
      long cost = Math.max(threadCpuNanos.getAsLong() - cpu0, 0);
      samples += 1;
      costNanos += cost;
      adjustBackoff(cost);
    }
  }

  /** Doubles the interval while one sample costs more than the budget; halves it back below a quarter. */
  private void adjustBackoff(long costNanos) {
    long base = Math.max(localInterval.toNanos(), 1);
    double share = (double) costNanos / (base * (double) backoff);
    if (share > BUDGET && backoff < MAX_BACKOFF) {
      backoff *= 2;
    } else if (share < BUDGET / 4 && backoff > 1) {
      backoff /= 2;
    }
  }

  /**
   * The {@code resources} block of the window since the last drain, and a fresh window; {@code
   * null} when no sample was taken (paused, or nothing yet).
   */
  public Map<String, Object> drain() {
    synchronized (window) {
      long now = nanoClock.getAsLong();
      if (samples == 0) {
        return null;
      }
      RemotePolicy.Resources remote = policy;
      for (Slot slot : slots) {
        if (!slot.disabled && remote.allows(slot.collector.name())) {
          try {
            slot.collector.drain(window);
          } catch (VirtualMachineError err) {
            throw err;
          } catch (Throwable t) {
            slot.errors += 1;
          }
        }
      }
      if (backoff > 1) {
        window.flag("sampler_backoff");
      }
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("v", VERSION);
      out.put("window_s", Gauge.num(Math.round((now - windowStart) / 1e8) / 10.0));
      out.put("n", samples);
      out.put("sampler_cost_us", Gauge.num(Math.round(costNanos / (double) samples / 100.0) / 10.0));
      out.put("capabilities", capabilities());
      out.put("limit_source", window.limitSource() == null ? "host" : window.limitSource());
      out.putAll(window.tree());
      out.put("flags", window.flags());
      window.clear();
      samples = 0;
      costNanos = 0;
      windowStart = now;
      return out;
    }
  }

  private List<String> capabilities() {
    Set<String> out = new LinkedHashSet<>();
    RemotePolicy.Resources remote = policy;
    for (Slot slot : slots) {
      if (slot.measured && !slot.disabled && remote.allows(slot.collector.name())) {
        out.add(slot.collector.capability());
      }
    }
    return new ArrayList<>(out);
  }

  /** Errors per collector name since start. */
  public Map<String, Long> collectorErrors() {
    Map<String, Long> out = new LinkedHashMap<>();
    synchronized (window) {
      for (Slot slot : slots) {
        out.merge(slot.collector.name(), slot.errors, Long::sum);
      }
    }
    return out;
  }

  /** Names of the collectors disabled after failing. */
  public List<String> disabledCollectors() {
    List<String> out = new ArrayList<>();
    synchronized (window) {
      for (Slot slot : slots) {
        if (slot.disabled) {
          out.add(slot.collector.name());
        }
      }
    }
    return out;
  }

  /** The collectors, in sampling order. */
  public List<Collector> collectors() {
    List<Collector> out = new ArrayList<>();
    for (Slot slot : slots) {
      out.add(slot.collector);
    }
    return out;
  }
}
