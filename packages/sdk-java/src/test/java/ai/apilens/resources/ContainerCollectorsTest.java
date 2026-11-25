package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ContainerCollectorsTest {
  @Test
  void deltasRatesAndThrottlingOverTheWindow(@TempDir Path tmp) throws Exception {
    Path root = CgroupReaderTest.copy("v2_namespaced_limited", tmp);
    Path cg = root.resolve("sys/fs/cgroup");
    ContainerCollectors container = new ContainerCollectors(new CgroupReader(Fs.at(root), () -> 8), () -> 8);
    AtomicLong clock = new AtomicLong(1_000_000_000L);
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15),
        List.of(container.cpu(), container.memory()), clock::get, () -> 0);
    sampler.sampleNow();
    // 15 s later: 3 s of CPU used (0.2 cores), 100 more periods, 25 throttled, one OOM kill.
    Files.writeString(cg.resolve("cpu.stat"),
        "usage_usec 126456789\nnr_periods 1100\nnr_throttled 205\nthrottled_usec 2600000\n");
    Files.writeString(cg.resolve("memory.events"), "oom_kill 2\n");
    clock.addAndGet(15_000_000_000L);
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    assertEquals("cgroup_v2", block.get("limit_source"));
    assertEquals(List.of("container.cpu", "container.memory"), block.get("capabilities"));
    Map<String, Object> cpu = ProcessCollectorsTest.at(block, "container", "cpu");
    assertEquals(0.2, ((Number) ((Map<?, ?>) cpu.get("cores_used")).get("last")).doubleValue(), 1e-9);
    assertEquals(40L, ((Map<?, ?>) cpu.get("pct_of_limit")).get("last"));
    assertEquals(0.5, cpu.get("limit_cores"));
    assertEquals(0.25, cpu.get("throttled_ratio"));
    assertEquals(200000L, cpu.get("throttled_us"));
    Map<String, Object> memory = ProcessCollectorsTest.at(block, "container", "memory");
    assertEquals(536870912L, memory.get("limit"));
    assertEquals(1L, memory.get("oom_kill"));
    assertEquals(419430400L, ((Map<?, ?>) memory.get("working_set")).get("max"));
    assertEquals("3f4e9c2b1a0d8e7f6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e",
        ProcessCollectorsTest.at(block, "container").get("container_id"));
    assertEquals(0.5, container.limitCores());
  }

  @Test
  void noCgroupSendsNoContainerBlock() {
    ContainerCollectors container = new ContainerCollectors(CgroupReaderTest.reader("no_cgroup"), () -> 8);
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(container.cpu(), container.memory()));
    sampler.sampleNow();
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    assertNull(block.get("container"));
    assertEquals("host", block.get("limit_source"));
    assertTrue(((List<?>) block.get("capabilities")).isEmpty());
  }

  @Test
  void unlimitedCpuIsAPercentOfTheHostAndNullLimit() {
    ContainerCollectors container = new ContainerCollectors(CgroupReaderTest.reader("v2_unlimited"), () -> 8);
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(container.cpu(), container.memory()));
    sampler.sampleNow();
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    Map<String, Object> cpu = ProcessCollectorsTest.at(block, "container", "cpu");
    assertNull(cpu.get("limit_cores"));
    assertNull(cpu.get("throttled_ratio"), "no quota and no periods: not measurable");
    assertNull(ProcessCollectorsTest.at(block, "container", "memory").get("limit"), "'max' is no limit");
    assertNull(ProcessCollectorsTest.at(block, "container", "memory").get("swap"));
  }
}
