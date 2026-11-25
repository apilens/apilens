package ai.apilens.resources;

import java.util.ArrayList;
import java.util.List;
import java.util.function.LongSupplier;

/** The collectors the SDK runs on this platform, in sampling order. */
public final class DefaultCollectors {
  private DefaultCollectors() {}

  /**
   * Container first (its CPU limit feeds the process's {@code pct_of_limit}), then process,
   * JVM, pools and processes. Linux-only collectors are left out elsewhere, so their values stay
   * null rather than zero.
   */
  public static List<Collector> create(Fs fs, DataSourcePools pools, boolean processList) {
    List<Collector> out = new ArrayList<>();
    boolean linux = fs.read("/proc/self/status") != null;
    int hostCores = HostCores.of(fs);
    ContainerCollectors container = null;
    if (linux) {
      container = new ContainerCollectors(new CgroupReader(fs, () -> hostCores), () -> hostCores);
      out.add(container.cpu());
      out.add(container.memory());
    }
    LongSupplier cpu = CpuTime.processCpuNanos();
    if (cpu != null) {
      ContainerCollectors limits = container;
      out.add(ProcessCollectors.cpu(cpu, () -> {
        Double limit = limits == null ? null : limits.limitCores();
        return limit != null ? limit : hostCores;
      }));
    }
    if (linux) {
      out.add(ProcessCollectors.memory(fs));
      out.add(ProcessCollectors.pss(fs));
    }
    try {
      out.add(JvmCollector.platform());
    } catch (RuntimeException | LinkageError ex) {
      // No platform MXBeans here (a stripped native image): no JVM block.
    }
    if (pools != null) {
      out.add(pools);
    }
    if (linux && processList) {
      out.add(new ProcessListCollector(fs));
    }
    return out;
  }
}
