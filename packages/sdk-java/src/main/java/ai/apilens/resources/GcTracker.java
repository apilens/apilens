package ai.apilens.resources;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Garbage collection per collector over the window: count, stop-the-world {@code pause_ms} and
 * {@code concurrent_ms} (concurrent cycles are not pauses), plus heap used right after the last
 * old/full collection (the leak trend).
 *
 * <p>Fed by {@code GarbageCollectionNotificationInfo} notifications ({@link GcNotifications})
 * where the runtime has them; elsewhere by polling each bean's count and time. Reads platform
 * MXBeans only; it never registers an MBean.
 */
final class GcTracker {
  /** What a collector bean's time measures. */
  enum Kind {
    PAUSE,
    CONCURRENT
  }

  private static final class Acc {
    final Kind kind;
    long count;
    double ms;
    long polledCount = -1;
    long polledMs = -1;

    Acc(Kind kind) {
      this.kind = kind;
    }
  }

  private final Map<String, Acc> collectors = new LinkedHashMap<>();
  private final Set<String> heapPools;
  private volatile Double heapAfterGc;
  private GcNotifications notifications;

  GcTracker(List<String> collectorNames, Set<String> heapPools) {
    for (String name : collectorNames) {
      collectors.put(name, new Acc(classify(name)));
    }
    this.heapPools = Set.copyOf(heapPools);
  }

  /** A tracker over the platform's collectors, listening for notifications when it can. */
  static GcTracker platform() {
    List<String> names = new ArrayList<>();
    for (GarbageCollectorMXBean bean : ManagementFactory.getGarbageCollectorMXBeans()) {
      names.add(bean.getName());
    }
    Set<String> heap = new HashSet<>();
    for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
      if (pool.getType() == MemoryType.HEAP) {
        heap.add(pool.getName());
      }
    }
    GcTracker tracker = new GcTracker(names, heap);
    tracker.notifications = GcNotifications.install(tracker);
    return tracker;
  }

  boolean listening() {
    return notifications != null;
  }

  /**
   * Pause or concurrent, by bean name. "Cycles" beans (ZGC, generational ZGC Minor/Major,
   * Shenandoah) time concurrent work; every other bean (G1 Young/Old Generation, G1's "Concurrent
   * GC" bean, which times the Remark/Cleanup stop-the-world pauses on JDK 20+, ZGC/Shenandoah
   * "Pauses", Parallel {@code PS *}, Serial {@code Copy} /
   * {@code MarkSweepCompact}, OpenJ9 {@code scavenge} / {@code global} / {@code partial gc})
   * times stop-the-world pauses.
   */
  static Kind classify(String name) {
    String lower = name.toLowerCase(Locale.ROOT);
    // "ZGC" alone is the single cycle-time bean of JDK 11-16.
    if (lower.contains("cycles") || lower.equals("zgc")) {
      return Kind.CONCURRENT;
    }
    return Kind.PAUSE;
  }

  /**
   * Whether a collection by {@code name} leaves the heap at its live size, so heap-after-GC is
   * a leak-trend point: old/full/major collections and whole-heap concurrent cycles, never
   * young/minor ones or the pause beans inside a cycle.
   */
  static boolean measuresLiveHeap(String name, String action) {
    String lower = name.toLowerCase(Locale.ROOT);
    if (lower.contains("pauses") || lower.contains("minor") || lower.contains("young")
        || lower.contains("scavenge") || lower.equals("copy") || lower.contains("partial")) {
      return false;
    }
    if (lower.contains("old") || lower.contains("marksweep") || lower.contains("major")
        || lower.contains("global") || lower.contains("full") || lower.contains("cycles")
        || lower.contains("concurrent") || lower.equals("zgc")) {
      return true;
    }
    return action != null && action.toLowerCase(Locale.ROOT).contains("major");
  }

  /**
   * One finished collection. {@code usedAfterByPool} is the pools' used bytes right after it
   * (may be empty).
   */
  void onGc(String name, String action, double durationMs, Map<String, Long> usedAfterByPool) {
    synchronized (collectors) {
      Acc acc = collectors.computeIfAbsent(name, n -> new Acc(classify(n)));
      acc.count += 1;
      if (durationMs >= 0 && Double.isFinite(durationMs)) {
        acc.ms += durationMs;
      }
    }
    if (usedAfterByPool != null && !usedAfterByPool.isEmpty() && measuresLiveHeap(name, action)) {
      long sum = 0;
      boolean any = false;
      for (Map.Entry<String, Long> pool : usedAfterByPool.entrySet()) {
        if (heapPools.contains(pool.getKey()) && pool.getValue() != null && pool.getValue() >= 0) {
          sum += pool.getValue();
          any = true;
        }
      }
      if (any) {
        heapAfterGc = (double) sum;
      }
    }
  }

  /** Without notifications: count and time deltas of every bean since the last poll. */
  void poll() {
    if (notifications != null) {
      return;
    }
    for (GarbageCollectorMXBean bean : ManagementFactory.getGarbageCollectorMXBeans()) {
      long count = bean.getCollectionCount();
      long ms = bean.getCollectionTime();
      synchronized (collectors) {
        Acc acc = collectors.computeIfAbsent(bean.getName(), n -> new Acc(classify(n)));
        if (acc.polledCount >= 0 && count >= acc.polledCount && ms >= acc.polledMs) {
          acc.count += count - acc.polledCount;
          acc.ms += ms - acc.polledMs;
        }
        acc.polledCount = count;
        acc.polledMs = ms;
      }
    }
  }

  Double heapAfterGc() {
    return heapAfterGc;
  }

  /** {@code [{name, count, pause_ms | concurrent_ms}]} since the last drain; resets. */
  List<Map<String, Object>> drain() {
    List<Map<String, Object>> out = new ArrayList<>();
    synchronized (collectors) {
      for (Map.Entry<String, Acc> entry : collectors.entrySet()) {
        if (out.size() == 16) {
          break;
        }
        Acc acc = entry.getValue();
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("name", entry.getKey().length() > 64 ? entry.getKey().substring(0, 64) : entry.getKey());
        item.put("count", acc.count);
        item.put(acc.kind == Kind.PAUSE ? "pause_ms" : "concurrent_ms", Gauge.num(acc.ms));
        out.add(item);
        acc.count = 0;
        acc.ms = 0;
      }
    }
    return out;
  }

  void close() {
    GcNotifications n = notifications;
    notifications = null;
    if (n != null) {
      n.remove();
    }
  }
}
