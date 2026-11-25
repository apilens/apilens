package ai.apilens.resources;

import java.util.function.IntSupplier;

/**
 * The cgroup the SDK runs in, as two collectors ({@code container.cpu} and {@code
 * container.memory}) over one {@link CgroupReader} read per tick. Every worker of a container
 * sends the same numbers; the server keeps one series per {@code container_id}.
 */
public final class ContainerCollectors {
  private final CgroupReader reader;
  private final IntSupplier hostCores;
  private CgroupReader.Snapshot snapshot;
  private long snapshotAt = Long.MIN_VALUE;
  private volatile Double limitCores;

  public ContainerCollectors(CgroupReader reader, IntSupplier hostCores) {
    this.reader = reader;
    this.hostCores = hostCores;
  }

  /** The latest effective CPU limit in cores; null when there is no quota. */
  public Double limitCores() {
    return limitCores;
  }

  /** One read per tick, shared by both collectors. */
  private CgroupReader.Snapshot snapshot(long now) {
    if (snapshot == null || snapshotAt != now) {
      snapshot = reader.read();
      snapshotAt = now;
      limitCores = snapshot.cpu() == null ? null : snapshot.cpu().limitCores();
    }
    return snapshot;
  }

  private static void common(Window window, CgroupReader.Snapshot snap) {
    window.limitSource(snap.limitSource().equals("none") ? null : snap.limitSource());
    window.value("container.container_id", snap.containerId());
  }

  public Collector cpu() {
    return new Collector() {
      private Double prevUsage;
      private Double prevPeriods;
      private Double prevThrottled;
      private Double prevThrottledUs;
      private long prevAt;
      private double sumPeriods;
      private double sumThrottled;
      private boolean deltas;

      @Override
      public String name() {
        return "container.cpu";
      }

      @Override
      public String capability() {
        return "container.cpu";
      }

      @Override
      public boolean sample(Window window, long now) {
        CgroupReader.Snapshot snap = snapshot(now);
        CgroupReader.Cpu cpu = snap.cpu();
        if (cpu == null) {
          return false;
        }
        common(window, snap);
        window.value("container.cpu.limit_cores", cpu.limitCores());
        boolean measured = cpu.limitCores() != null;
        if (prevUsage != null && cpu.usageUs() != null && now > prevAt) {
          double used = cpu.usageUs() - prevUsage;
          if (used >= 0) {
            double cores = used * 1000.0 / (now - prevAt);
            window.gauge("container.cpu.cores_used", cores);
            double limit = cpu.limitCores() != null ? cpu.limitCores() : hostCores.getAsInt();
            if (limit > 0) {
              window.gauge("container.cpu.pct_of_limit", cores / limit * 100);
            }
            measured = true;
          }
        }
        Double periods = delta(prevPeriods, cpu.nrPeriods());
        Double throttled = delta(prevThrottled, cpu.nrThrottled());
        if (periods != null && throttled != null) {
          sumPeriods += periods;
          sumThrottled += throttled;
          deltas = true;
        }
        window.counter("container.cpu.throttled_us", delta(prevThrottledUs, cpu.throttledUs()));
        prevUsage = cpu.usageUs();
        prevPeriods = cpu.nrPeriods();
        prevThrottled = cpu.nrThrottled();
        prevThrottledUs = cpu.throttledUs();
        prevAt = now;
        return measured || cpu.usageUs() != null;
      }

      @Override
      public void drain(Window window) {
        if (deltas) {
          if (sumPeriods > 0) {
            window.value("container.cpu.throttled_ratio", Math.min(sumThrottled / sumPeriods, 1.0));
          } else if (window.has("container.cpu.limit_cores")) {
            window.value("container.cpu.throttled_ratio", 0.0);
          }
        }
        sumPeriods = 0;
        sumThrottled = 0;
        deltas = false;
      }
    };
  }

  public Collector memory() {
    return new Collector() {
      private Double prevOomKill;

      @Override
      public String name() {
        return "container.memory";
      }

      @Override
      public String capability() {
        return "container.memory";
      }

      @Override
      public boolean sample(Window window, long now) {
        CgroupReader.Snapshot snap = snapshot(now);
        CgroupReader.Memory memory = snap.memory();
        if (memory == null) {
          return false;
        }
        common(window, snap);
        window.gauge("container.memory.current", memory.current());
        window.gauge("container.memory.working_set", memory.workingSet());
        window.gauge("container.memory.anon", memory.anon());
        window.gauge("container.memory.file", memory.file());
        window.gauge("container.memory.swap", memory.swap());
        window.value("container.memory.limit", memory.limit());
        window.counter("container.memory.oom_kill", delta(prevOomKill, memory.oomKill()));
        if (memory.oomKill() != null) {
          prevOomKill = memory.oomKill();
        }
        return memory.current() != null;
      }
    };
  }

  /** {@code now - prev}; null without a baseline; a reset (negative) re-baselines to null. */
  static Double delta(Double prev, Double now) {
    if (prev == null || now == null) {
      return null;
    }
    double d = now - prev;
    return d >= 0 ? d : null;
  }
}
