package ai.apilens.resources;

import java.util.LinkedHashMap;
import java.util.Map;

/** Samples of one gauge over a window: lowest, mean, highest and most recent. Not thread-safe. */
final class Gauge {
  private double min = Double.POSITIVE_INFINITY;
  private double max = Double.NEGATIVE_INFINITY;
  private double sum;
  private double last;
  private int n;

  void add(double value) {
    if (!Double.isFinite(value)) {
      return;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    last = value;
    n += 1;
  }

  int count() {
    return n;
  }

  double last() {
    return last;
  }

  double max() {
    return max;
  }

  /** {@code {min, avg, max, last}}, or {@code null} when nothing was sampled. */
  Map<String, Object> toWire() {
    if (n == 0) {
      return null;
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("min", num(min));
    out.put("avg", num(sum / n));
    out.put("max", num(max));
    out.put("last", num(last));
    return out;
  }

  /** A JSON number: integral values as longs, others rounded to 4 decimals. */
  static Number num(double value) {
    if (value == Math.rint(value) && Math.abs(value) < 9.007199254740992E15) {
      return (long) value;
    }
    return Math.round(value * 10_000d) / 10_000d;
  }
}
