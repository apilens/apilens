package ai.apilens.resources;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What the collectors measured since the last heartbeat, keyed by dotted path in the {@code
 * resources} block ({@code process.cpu.cores_used}). Gauges aggregate to {@code {min, avg, max,
 * last}}; counters are summed deltas; values and lists keep the latest. Nothing is ever filled in:
 * a path no collector wrote is absent from the block. Guarded by the sampler.
 */
public final class Window {
  private static final List<String> ORDER = List.of("process", "container", "runtime", "pools", "processes");

  private final Map<String, Gauge> gauges = new LinkedHashMap<>();
  private final Map<String, Double> counters = new LinkedHashMap<>();
  private final Map<String, Object> values = new LinkedHashMap<>();
  private final Set<String> flags = new LinkedHashSet<>();
  private String limitSource;

  /** One sample of a gauge; {@code null} (not measured) is ignored. */
  public void gauge(String path, Double value) {
    if (value != null && Double.isFinite(value)) {
      gauges.computeIfAbsent(path, k -> new Gauge()).add(value);
    }
  }

  /** A counter delta; {@code null} is ignored, and a measured 0 is kept. */
  public void counter(String path, Double delta) {
    if (delta != null && Double.isFinite(delta) && delta >= 0) {
      counters.merge(path, delta, Double::sum);
    }
  }

  /** A latest value (number, string or list); {@code null} is ignored. */
  public void value(String path, Object value) {
    if (value instanceof Double d && !Double.isFinite(d)) {
      return;
    }
    if (value != null) {
      values.put(path, value instanceof Double d ? Gauge.num(d) : value);
    }
  }

  public void flag(String flag) {
    flags.add(flag);
  }

  void limitSource(String source) {
    if (source != null) {
      limitSource = source;
    }
  }

  String limitSource() {
    return limitSource;
  }

  List<String> flags() {
    return new ArrayList<>(flags);
  }

  /** Whether anything was written under {@code path}. */
  boolean has(String path) {
    return gauges.containsKey(path) || counters.containsKey(path) || values.containsKey(path);
  }

  /** The nested block: process, container, runtime, pools, processes (those written). */
  Map<String, Object> tree() {
    Map<String, Object> root = new LinkedHashMap<>();
    for (String top : ORDER) {
      root.put(top, null);
    }
    gauges.forEach((path, gauge) -> put(root, path, gauge.toWire()));
    counters.forEach((path, sum) -> put(root, path, Gauge.num(sum)));
    values.forEach((path, value) -> put(root, path, value));
    root.values().removeIf(v -> v == null);
    return root;
  }

  void clear() {
    gauges.clear();
    counters.clear();
    values.clear();
    flags.clear();
  }

  @SuppressWarnings("unchecked")
  private static void put(Map<String, Object> root, String path, Object value) {
    if (value == null) {
      return;
    }
    String[] parts = path.split("\\.");
    Map<String, Object> node = root;
    for (int i = 0; i < parts.length - 1; i++) {
      Object child = node.get(parts[i]);
      if (!(child instanceof Map)) {
        child = new LinkedHashMap<String, Object>();
        node.put(parts[i], child);
      }
      node = (Map<String, Object>) child;
    }
    node.put(parts[parts.length - 1], value);
  }
}
