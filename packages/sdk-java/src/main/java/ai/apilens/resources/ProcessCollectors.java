package ai.apilens.resources;

import java.io.IOException;
import java.nio.file.AccessDeniedException;
import java.util.Map;
import java.util.function.DoubleSupplier;
import java.util.function.LongSupplier;

/** The SDK process itself: CPU (any OS), RSS/threads/fds and PSS/USS (Linux procfs). */
final class ProcessCollectors {
  /** PSS/USS are costly to read (the kernel walks every mapping): once a minute. */
  static final long PSS_SPACING_NANOS = 60_000_000_000L;

  private ProcessCollectors() {}

  /**
   * {@code process.cpu}: cores busy from CPU-time deltas over wall time, and that share of the
   * effective limit ({@code limitCores}: the container quota, else the CPUs we may run on).
   */
  static Collector cpu(LongSupplier cpuNanos, DoubleSupplier limitCores) {
    return new Collector() {
      private long prevCpu = -1;
      private long prevAt;

      @Override
      public String name() {
        return "process.cpu";
      }

      @Override
      public String capability() {
        return "process.cpu";
      }

      @Override
      public boolean sample(Window window, long now) {
        long cpu = cpuNanos.getAsLong();
        if (cpu < 0) {
          return false;
        }
        boolean measured = false;
        if (prevCpu >= 0 && cpu >= prevCpu && now > prevAt) {
          double cores = (double) (cpu - prevCpu) / (now - prevAt);
          window.gauge("process.cpu.cores_used", cores);
          double limit = limitCores.getAsDouble();
          if (limit > 0) {
            window.gauge("process.cpu.pct_of_limit", cores / limit * 100);
          }
          measured = true;
        }
        prevCpu = cpu;
        prevAt = now;
        return measured;
      }
    };
  }

  /**
   * {@code process.memory}: RSS and OS threads from {@code /proc/self/status} (VmRSS is exact
   * bytes, independent of the page size) and open descriptors from {@code /proc/self/fd}. Linux
   * only; elsewhere the values stay null.
   */
  static Collector memory(Fs fs) {
    return new Collector() {
      @Override
      public String name() {
        return "process.memory";
      }

      @Override
      public String capability() {
        return "process.memory";
      }

      @Override
      public boolean sample(Window window, long now) {
        String status = fs.read("/proc/self/status");
        if (status == null) {
          return false;
        }
        Map<String, Double> values = Fs.colonValues(status);
        Double rss = values.get("VmRSS");
        window.gauge("process.memory.rss", rss);
        window.gauge("process.threads", values.get("Threads"));
        int fds = fs.list("/proc/self/fd").size();
        if (fds > 0) {
          window.gauge("process.fds", (double) fds);
        }
        return rss != null;
      }
    };
  }

  /**
   * {@code process.pss}: PSS and USS from {@code /proc/self/smaps_rollup} once a minute. A
   * permission error turns it off for good; other errors count like any collector's.
   */
  static Collector pss(Fs fs) {
    return new Collector() {
      @Override
      public String name() {
        return "process.pss";
      }

      @Override
      public String capability() {
        return "process.pss";
      }

      @Override
      public long minSpacingNanos() {
        return PSS_SPACING_NANOS;
      }

      @Override
      public boolean sample(Window window, long now) throws Unavailable, IOException {
        String text;
        try {
          text = fs.readOrThrow(fs.path("/proc/self/smaps_rollup"));
        } catch (AccessDeniedException ex) {
          throw new Unavailable("smaps_rollup: permission denied");
        } catch (java.nio.file.NoSuchFileException ex) {
          throw new Unavailable("smaps_rollup: not on this kernel");
        }
        Map<String, Double> values = Fs.colonValues(text);
        Double pss = values.get("Pss");
        Double clean = values.get("Private_Clean");
        Double dirty = values.get("Private_Dirty");
        window.gauge("process.memory.pss", pss);
        if (clean != null && dirty != null) {
          window.gauge("process.memory.uss", clean + dirty + values.getOrDefault("Private_Hugetlb", 0.0));
        }
        return pss != null;
      }
    };
  }
}
