package ai.apilens.resources;

import java.lang.management.BufferPoolMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code runtime}: JVM internals under {@code runtime.jvm}. Heap used/committed/max, heap after
 * the last old/full GC, non-heap, metaspace, direct buffers, platform threads, every memory pool
 * (used/committed/max at the end of the window) and GC per collector ({@link GcTracker}).
 * Virtual threads are not counted (no API before JDK 24), so the field is never sent.
 *
 * <p>It only reads the platform MXBeans; it registers nothing in the MBean server and nothing in
 * any Micrometer registry.
 */
final class JvmCollector implements Collector {
  static final int MAX_POOLS = 32;
  private static final String PREFIX = "runtime.jvm.";

  private final MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
  private final ThreadMXBean threads = ManagementFactory.getThreadMXBean();
  private final List<MemoryPoolMXBean> pools = ManagementFactory.getMemoryPoolMXBeans();
  private final List<BufferPoolMXBean> buffers = ManagementFactory.getPlatformMXBeans(BufferPoolMXBean.class);
  private final GcTracker gc;
  private List<Map<String, Object>> lastPools;

  JvmCollector(GcTracker gc) {
    this.gc = gc;
  }

  static JvmCollector platform() {
    return new JvmCollector(GcTracker.platform());
  }

  GcTracker gc() {
    return gc;
  }

  @Override
  public String name() {
    return "runtime";
  }

  @Override
  public String capability() {
    return "runtime.jvm";
  }

  @Override
  public boolean sample(Window window, long now) {
    MemoryUsage heap = memory.getHeapMemoryUsage();
    window.gauge(PREFIX + "heap_used", (double) heap.getUsed());
    window.gauge(PREFIX + "heap_committed", (double) heap.getCommitted());
    if (heap.getMax() >= 0) {
      window.value(PREFIX + "heap_max", (double) heap.getMax());
    }
    window.gauge(PREFIX + "non_heap_used", (double) memory.getNonHeapMemoryUsage().getUsed());
    List<Map<String, Object>> list = new ArrayList<>();
    for (MemoryPoolMXBean pool : pools) {
      if (!pool.isValid()) {
        continue;
      }
      MemoryUsage usage = pool.getUsage();
      if (usage == null) {
        continue;
      }
      if (pool.getName().equals("Metaspace")) {
        window.gauge(PREFIX + "metaspace", (double) usage.getUsed());
      }
      if (list.size() < MAX_POOLS) {
        Map<String, Object> item = new LinkedHashMap<>();
        String name = pool.getName();
        item.put("name", name.length() > 64 ? name.substring(0, 64) : name);
        item.put("used", usage.getUsed());
        item.put("committed", usage.getCommitted());
        if (usage.getMax() >= 0) {
          item.put("max", usage.getMax());
        }
        list.add(item);
      }
    }
    lastPools = list;
    for (BufferPoolMXBean buffer : buffers) {
      if (buffer.getName().equals("direct") && buffer.getMemoryUsed() >= 0) {
        window.gauge(PREFIX + "direct_buffers", (double) buffer.getMemoryUsed());
      }
    }
    window.gauge(PREFIX + "threads", (double) threads.getThreadCount());
    gc.poll();
    return true;
  }

  @Override
  public void drain(Window window) {
    window.value(PREFIX + "heap_after_gc", gc.heapAfterGc());
    window.value(PREFIX + "gc", gc.drain());
    if (lastPools != null) {
      window.value(PREFIX + "pools", lastPools);
    }
  }

  @Override
  public void close() {
    gc.close();
  }
}
