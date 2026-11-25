package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.resources.GcTracker.Kind;
import java.lang.management.ManagementFactory;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.management.MBeanServer;
import org.junit.jupiter.api.Test;

/** GC classification with fake notifications per collector name (the bean names of each JVM). */
class JvmGcTest {
  /** name -> {kind, measures the live heap}: G1, ZGC, generational ZGC, Shenandoah, Parallel, Serial, OpenJ9. */
  static final Map<String, Object[]> COLLECTORS = new LinkedHashMap<>();

  static {
    COLLECTORS.put("G1 Young Generation", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("G1 Old Generation", new Object[] {Kind.PAUSE, true});
    COLLECTORS.put("G1 Concurrent GC", new Object[] {Kind.CONCURRENT, true});
    COLLECTORS.put("ZGC", new Object[] {Kind.CONCURRENT, true});
    COLLECTORS.put("ZGC Cycles", new Object[] {Kind.CONCURRENT, true});
    COLLECTORS.put("ZGC Pauses", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("ZGC Minor Cycles", new Object[] {Kind.CONCURRENT, false});
    COLLECTORS.put("ZGC Minor Pauses", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("ZGC Major Cycles", new Object[] {Kind.CONCURRENT, true});
    COLLECTORS.put("ZGC Major Pauses", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("Shenandoah Cycles", new Object[] {Kind.CONCURRENT, true});
    COLLECTORS.put("Shenandoah Pauses", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("PS Scavenge", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("PS MarkSweep", new Object[] {Kind.PAUSE, true});
    COLLECTORS.put("Copy", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("MarkSweepCompact", new Object[] {Kind.PAUSE, true});
    COLLECTORS.put("scavenge", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("global", new Object[] {Kind.PAUSE, true});
    COLLECTORS.put("partial gc", new Object[] {Kind.PAUSE, false});
    COLLECTORS.put("global garbage collect", new Object[] {Kind.PAUSE, true});
  }

  @Test
  void everyCollectorNameIsClassified() {
    COLLECTORS.forEach((name, want) -> {
      assertEquals(want[0], GcTracker.classify(name), name);
      assertEquals(want[1], GcTracker.measuresLiveHeap(name, "end of GC"), name);
    });
  }

  @Test
  void fakeNotificationsSplitPauseFromConcurrentTimePerCollector() {
    GcTracker tracker = new GcTracker(List.copyOf(COLLECTORS.keySet()), Set.of("Old", "Young"));
    for (String name : COLLECTORS.keySet()) {
      tracker.onGc(name, "end of GC", 10, Map.of());
      tracker.onGc(name, "end of GC", 2.5, Map.of());
    }
    List<Map<String, Object>> gc = tracker.drain();
    assertEquals(16, gc.size(), "capped at the contract's 16 collectors");
    for (Map<String, Object> item : gc) {
      String name = (String) item.get("name");
      Kind kind = (Kind) COLLECTORS.get(name)[0];
      assertEquals(2L, item.get("count"), name);
      if (kind == Kind.PAUSE) {
        assertEquals(12.5, item.get("pause_ms"), name);
        assertFalse(item.containsKey("concurrent_ms"), name + ": a pause bean never claims concurrent time");
      } else {
        assertEquals(12.5, item.get("concurrent_ms"), name);
        assertFalse(item.containsKey("pause_ms"), name + ": concurrent cycles are not pauses");
      }
    }
    // Drained: the next window starts at zero (a measured zero, not absent).
    Map<String, Object> next = tracker.drain().get(0);
    assertEquals(0L, next.get("count"));
    assertEquals(0L, next.get("pause_ms"));
  }

  @Test
  void heapAfterGcComesFromOldAndFullCollectionsOnly() {
    GcTracker tracker = new GcTracker(List.of("G1 Young Generation", "G1 Old Generation"),
        Set.of("G1 Eden Space", "G1 Old Gen", "G1 Survivor Space"));
    Map<String, Long> after = Map.of("G1 Eden Space", 0L, "G1 Old Gen", 300L, "G1 Survivor Space", 20L, "Metaspace", 999L);
    tracker.onGc("G1 Young Generation", "end of minor GC", 3, after);
    assertNull(tracker.heapAfterGc(), "a young collection is not a leak-trend point");
    tracker.onGc("G1 Old Generation", "end of major GC", 40, after);
    assertEquals(320.0, tracker.heapAfterGc(), "heap pools only");
    tracker.onGc("ZGC Major Pauses", "end of GC pause", 1, Map.of("G1 Old Gen", 1L));
    assertEquals(320.0, tracker.heapAfterGc(), "pause beans inside a cycle are skipped");
  }

  @Test
  void realG1SmokeAndHeapAfterGc() throws Exception {
    boolean g1 = ManagementFactory.getGarbageCollectorMXBeans().stream().anyMatch(b -> b.getName().startsWith("G1"));
    org.junit.jupiter.api.Assumptions.assumeTrue(g1, "not running G1");
    JvmCollector jvm = JvmCollector.platform();
    try {
      ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(jvm));
      sampler.sampleNow();
      JvmGcMatrixTest.collectGarbage(jvm.gc());
      sampler.sampleNow();
      Map<String, Object> block = sampler.drain();
      Map<String, Object> runtime = ProcessCollectorsTest.at(block, "runtime", "jvm");
      assertNotNull(runtime.get("heap_after_gc"), "System.gc() on G1 is a full collection: " + runtime);
      @SuppressWarnings("unchecked")
      List<Map<String, Object>> gc = (List<Map<String, Object>>) runtime.get("gc");
      Map<String, Object> old = gc.stream().filter(c -> c.get("name").equals("G1 Old Generation")).findFirst().orElseThrow();
      assertTrue(((Number) old.get("count")).longValue() >= 1);
      assertTrue(old.containsKey("pause_ms"));
    } finally {
      jvm.close();
    }
  }

  @Test
  void jvmBlockHasEveryContractField() {
    JvmCollector jvm = JvmCollector.platform();
    try {
      ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(jvm));
      sampler.sampleNow();
      Map<String, Object> runtime = ProcessCollectorsTest.at(sampler.drain(), "runtime", "jvm");
      for (String key : List.of("heap_used", "heap_committed", "heap_max", "non_heap_used", "metaspace",
          "direct_buffers", "threads", "gc", "pools")) {
        assertTrue(runtime.containsKey(key), key + " in " + runtime.keySet());
      }
      assertFalse(runtime.containsKey("virtual_threads"), "no API before JDK 24: absent, not 0");
      @SuppressWarnings("unchecked")
      List<Map<String, Object>> pools = (List<Map<String, Object>>) runtime.get("pools");
      assertTrue(pools.stream().anyMatch(p -> p.get("name").equals("Metaspace")));
      assertTrue(pools.size() <= JvmCollector.MAX_POOLS);
    } finally {
      jvm.close();
    }
  }

  @Test
  void noMBeanIsRegistered() {
    MBeanServer server = ManagementFactory.getPlatformMBeanServer();
    int before = server.getMBeanCount();
    Set<?> names = server.queryNames(null, null);
    ResourceSampler sampler = new ResourceSampler(Duration.ofMillis(10),
        DefaultCollectors.create(Fs.system(), new DataSourcePools(), true));
    sampler.sampleNow();
    sampler.sampleNow();
    sampler.drain();
    sampler.stop();
    assertEquals(before, server.getMBeanCount());
    assertEquals(names, server.queryNames(null, null));
  }
}
