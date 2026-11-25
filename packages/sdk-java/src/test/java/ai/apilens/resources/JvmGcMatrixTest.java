package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Runs under every collector (the surefire gc-* executions: Parallel, Serial, ZGC, generational
 * ZGC, Shenandoah; the default run is G1): after real collections, each reported collector has
 * the right kind of time and the heap-after-GC leak point is present.
 */
class JvmGcMatrixTest {
  /** Garbage plus System.gc(), then waits for the notifications (delivered asynchronously). */
  static void collectGarbage(GcTracker tracker) throws InterruptedException {
    long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
    while (System.nanoTime() < deadline) {
      List<byte[]> junk = new ArrayList<>();
      for (int i = 0; i < 64; i++) {
        junk.add(new byte[64 * 1024]);
      }
      junk.clear();
      System.gc();
      Thread.sleep(50);
      if (tracker.heapAfterGc() != null) {
        return;
      }
    }
  }

  @Test
  void pauseAndConcurrentTimeAreClassifiedForThisCollector() throws Exception {
    List<String> beans = ManagementFactory.getGarbageCollectorMXBeans().stream()
        .map(GarbageCollectorMXBean::getName).toList();
    System.out.println("GC matrix collectors: " + beans);
    JvmCollector jvm = JvmCollector.platform();
    try {
      assertTrue(jvm.gc().listening(), "HotSpot has GC notifications");
      ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(jvm));
      sampler.sampleNow();
      collectGarbage(jvm.gc());
      sampler.sampleNow();
      Map<String, Object> runtime = ProcessCollectorsTest.at(sampler.drain(), "runtime", "jvm");
      assertNotNull(runtime.get("heap_after_gc"), "heap after GC under " + beans + ": " + runtime);
      @SuppressWarnings("unchecked")
      List<Map<String, Object>> gc = (List<Map<String, Object>>) runtime.get("gc");
      assertTrue(gc.stream().anyMatch(c -> ((Number) c.get("count")).longValue() > 0), "collections seen: " + gc);
      for (Map<String, Object> collector : gc) {
        String name = ((String) collector.get("name")).toLowerCase(Locale.ROOT);
        boolean concurrent = name.contains("cycles") || name.contains("concurrent") || name.equals("zgc");
        assertTrue(collector.containsKey(concurrent ? "concurrent_ms" : "pause_ms"), collector.toString());
        assertFalse(collector.containsKey(concurrent ? "pause_ms" : "concurrent_ms"), collector.toString());
      }
      for (String bean : beans) {
        assertTrue(gc.stream().anyMatch(c -> c.get("name").equals(bean)), bean + " reported in " + gc);
      }
    } finally {
      jvm.close();
    }
  }
}
