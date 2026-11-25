package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProcessCollectorsTest {
  @SuppressWarnings("unchecked")
  static Map<String, Object> at(Map<String, Object> block, String... path) {
    Object node = block;
    for (String key : path) {
      node = node == null ? null : ((Map<String, Object>) node).get(key);
    }
    return (Map<String, Object>) node;
  }

  @Test
  void cpuBurnShowsUpAsCoresUsed() throws Exception {
    LongSupplier cpu = CpuTime.processCpuNanos();
    assumeTrue(cpu != null, "no process CPU time on this runtime");
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(ProcessCollectors.cpu(cpu, () -> 8)));
    sampler.sampleNow();
    long end = System.nanoTime() + 400_000_000L;
    long x = 0;
    while (System.nanoTime() < end) {
      x += Long.numberOfTrailingZeros(x + System.nanoTime());
    }
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    Map<String, Object> cores = at(block, "process", "cpu", "cores_used");
    assertNotNull(cores, "x=" + x + " " + block);
    double used = ((Number) cores.get("last")).doubleValue();
    assertTrue(used > 0.5, "a busy thread is at least half a core: " + used);
    double pct = ((Number) at(block, "process", "cpu", "pct_of_limit").get("last")).doubleValue();
    assertEquals(used / 8 * 100, pct, 0.01);
    assertEquals(List.of("process.cpu"), block.get("capabilities"));
  }

  @Test
  void firstCpuSampleIsOnlyABaseline() throws Exception {
    long[] cpu = {1_000};
    Collector collector = ProcessCollectors.cpu(() -> cpu[0], () -> 2);
    Window window = new Window();
    assertFalse(collector.sample(window, 0));
    assertTrue(window.tree().isEmpty(), "no value from one sample, never a 0");
    cpu[0] = 1_000 + 500_000_000L;
    assertTrue(collector.sample(window, 1_000_000_000L));
    assertEquals(0.5, ((Number) at(window.tree(), "process", "cpu", "cores_used").get("last")).doubleValue());
    assertEquals(25L, at(window.tree(), "process", "cpu", "pct_of_limit").get("last"));
  }

  @Test
  void reflectionGuardWithoutTheInterfaceIsNull() {
    Object platform = ManagementFactory.getOperatingSystemMXBean();
    assertNull(CpuTime.processCpuNanos(platform, List.<String[]>of(new String[] {"does.not.Exist", "getProcessCpuTime"})));
    assertNull(CpuTime.processCpuNanos(new Object(), CpuTime.CANDIDATES));
    assertNull(CpuTime.processCpuNanos(null, CpuTime.CANDIDATES));
    // A bean of the plain java.lang.management type only (as on GraalVM native image).
    java.lang.management.OperatingSystemMXBean plain = new java.lang.management.OperatingSystemMXBean() {
      public String getName() {
        return "x";
      }

      public String getArch() {
        return "x";
      }

      public String getVersion() {
        return "x";
      }

      public int getAvailableProcessors() {
        return 1;
      }

      public double getSystemLoadAverage() {
        return -1;
      }

      public javax.management.ObjectName getObjectName() {
        return null;
      }
    };
    assertNull(CpuTime.processCpuNanos(plain, CpuTime.CANDIDATES));
  }

  @Test
  void notLinuxMeansNoRssAndNoProcfsCollectors(@TempDir Path empty) throws Exception {
    Collector memory = ProcessCollectors.memory(Fs.at(empty));
    Window window = new Window();
    assertFalse(memory.sample(window, 0));
    assertTrue(window.tree().isEmpty(), "RSS null, never 0");
    List<String> names = DefaultCollectors.create(Fs.at(empty), null, true).stream().map(Collector::name).toList();
    assertFalse(names.contains("process.memory"));
    assertFalse(names.contains("container.cpu"));
    assertFalse(names.contains("processes"));
    assertTrue(names.contains("runtime"));
  }

  @Test
  void linuxProcfsGivesRssThreadsAndFds(@TempDir Path root) throws Exception {
    Files.createDirectories(root.resolve("proc/self/fd"));
    for (int i = 0; i < 3; i++) {
      Files.writeString(root.resolve("proc/self/fd/" + i), "");
    }
    Files.writeString(root.resolve("proc/self/status"), "Name:\tjava\nVmRSS:\t  204800 kB\nThreads:\t42\n");
    Window window = new Window();
    assertTrue(ProcessCollectors.memory(Fs.at(root)).sample(window, 0));
    Map<String, Object> tree = window.tree();
    assertEquals(209715200L, at(tree, "process", "memory", "rss").get("last"));
    assertEquals(42L, at(tree, "process", "threads").get("max"));
    assertEquals(3L, at(tree, "process", "fds").get("min"));
  }

  @Test
  void pssAndUssFromSmapsRollup(@TempDir Path root) throws Exception {
    Files.createDirectories(root.resolve("proc/self"));
    Files.writeString(root.resolve("proc/self/smaps_rollup"),
        "55d0-7ffd ---p 00000000 00:00 0 [rollup]\nRss:  2048 kB\nPss:  1024 kB\nPrivate_Clean:  100 kB\nPrivate_Dirty:  412 kB\n");
    Window window = new Window();
    assertTrue(ProcessCollectors.pss(Fs.at(root)).sample(window, 0));
    assertEquals(1048576L, at(window.tree(), "process", "memory", "pss").get("last"));
    assertEquals(524288L, at(window.tree(), "process", "memory", "uss").get("last"));
  }

  @Test
  void smapsRollupPermissionErrorTurnsPssOffAndTheSamplerContinues(@TempDir Path root) throws Exception {
    Files.createDirectories(root.resolve("proc/self"));
    Path rollup = root.resolve("proc/self/smaps_rollup");
    Files.writeString(rollup, "Pss: 1 kB\n");
    assertTrue(rollup.toFile().setReadable(false, false));
    try {
      assumeTrue(!Files.isReadable(rollup), "running as root");
      ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(
          ProcessCollectors.pss(Fs.at(root)), ResourceSamplerTest.gauge("process.cpu", "process.cpu.cores_used", 1)));
      sampler.sampleNow();
      sampler.sampleNow();
      assertEquals(List.of("process.pss"), sampler.disabledCollectors());
      Map<String, Object> block = sampler.drain();
      assertEquals(2, block.get("n"));
      assertNull(at(block, "process", "memory"), "pss null, not 0");
    } finally {
      rollup.toFile().setReadable(true, false);
    }
  }

  @Test
  void pssIsSampledOncePerMinute() {
    assertEquals(60_000_000_000L, ProcessCollectors.pss(Fs.system()).minSpacingNanos());
  }
}
