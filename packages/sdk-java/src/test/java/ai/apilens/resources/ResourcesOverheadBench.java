package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/**
 * Cost of the runtime-resources sampler (M7, D11): resources on vs off. Not part of the normal
 * build (the class name does not end in {@code Test}); run it with
 *
 * <pre>
 *   mvn -B -ntp test -Dtest=ResourcesOverheadBench -Dsurefire.failIfNoSpecifiedTests=false \
 *       -Dapilens.bench=true -Dapilens.bench.out=target/resources-overhead
 * </pre>
 *
 * <ol>
 *   <li><b>CPU per sample.</b> A sampler with the default collectors is sampled {@code samples}
 *       times; its clock advances 60 s per sample, so every sample also runs the 60 s collectors
 *       (PSS, the process list): the worst case. CPU is this thread's CPU time per {@code
 *       sampleNow()}. The share of a core is the mean over the production interval (15 s).
 *   <li><b>Request latency.</b> A CPU-bound request (build and serialise a 1 KB map) is timed on
 *       this thread, first alone, then while the sampler runs on its own daemon thread every 100
 *       ms (150x production). The JVM sampler never runs on a request thread, so this shows only
 *       contention for cores.
 * </ol>
 *
 * <p>Thresholds (#1139): a median CPU per worst-case sample over 1 ms, or a mean share over 0.1 %
 * of one core at 15 s, fails the test. The median, not p95: a noisy neighbour on a shared runner
 * moves the tail (p95 and max are reported). The latency delta is reported, never gated.
 */
class ResourcesOverheadBench {
  private static final double INTERVAL_S = 15;
  private static final long SLOW_EVERY_NANOS = TimeUnit.SECONDS.toNanos(60);

  @Test
  void samplerStaysUnderBudget() throws Exception {
    Assumptions.assumeTrue(Boolean.getBoolean("apilens.bench"), "set -Dapilens.bench=true");
    int samples = Integer.getInteger("apilens.bench.samples", 300);
    int warmup = Integer.getInteger("apilens.bench.warmup", 100);
    int iterations = Integer.getInteger("apilens.bench.iterations", 20_000);
    double maxSampleMs = Double.parseDouble(System.getProperty("apilens.bench.maxSampleMs", "1"));
    double maxCorePct = Double.parseDouble(System.getProperty("apilens.bench.maxCorePct", "0.1"));

    ThreadMXBean threads = ManagementFactory.getThreadMXBean();
    AtomicLong clock = new AtomicLong(1_000_000_000L);
    List<Collector> collectors = DefaultCollectors.create(Fs.system(), new DataSourcePools(), true);
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(60), collectors, clock::get,
        threads::getCurrentThreadCpuTime);
    double[] costs = new double[samples];
    for (int i = 0; i < warmup + samples; i++) {
      clock.addAndGet(SLOW_EVERY_NANOS);
      long t0 = threads.getCurrentThreadCpuTime();
      sampler.sampleNow();
      long cost = threads.getCurrentThreadCpuTime() - t0;
      if (i >= warmup) {
        costs[i - warmup] = cost / 1000.0;
      }
    }
    Map<String, Object> block = sampler.drain();
    double mean = Arrays.stream(costs).average().orElse(0);
    double corePct = mean / (INTERVAL_S * 1e6) * 100;

    Map<String, Map<String, Double>> latency = requestLatency(iterations);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("sdk", "java");
    result.put("runtime", "java " + Runtime.version() + " " + System.getProperty("java.vm.name"));
    result.put("platform", System.getProperty("os.name") + " " + System.getProperty("os.arch"));
    result.put("limit_source", block == null ? null : block.get("limit_source"));
    result.put("capabilities", block == null ? List.of() : block.get("capabilities"));
    Map<String, Double> cpu = new LinkedHashMap<>();
    cpu.put("p50", pct(costs, 0.5));
    cpu.put("p95", pct(costs, 0.95));
    cpu.put("max", Arrays.stream(costs).max().orElse(0));
    cpu.put("mean", mean);
    result.put("sample_cpu_us", cpu);
    result.put("core_pct_at_15s", corePct);
    result.put("latency_ms", latency);
    result.put("stress_interval_s", 0.1);
    List<String> breaches = new ArrayList<>();
    if (cpu.get("p50") > maxSampleMs * 1000) {
      breaches.add(String.format(Locale.ROOT, "median CPU per sample %.0f us > %s ms", cpu.get("p50"), maxSampleMs));
    }
    if (corePct > maxCorePct) {
      breaches.add(String.format(Locale.ROOT, "sampler share %.4f %% of a core > %s %%", corePct, maxCorePct));
    }
    result.put("breaches", breaches);

    String table = render(result, cpu, latency);
    System.out.println(table);
    String out = System.getProperty("apilens.bench.out");
    if (out != null && !out.isBlank()) {
      write(Path.of(out + ".md"), table);
      write(Path.of(out + ".json"), json(result));
    }
    assertTrue(breaches.isEmpty(), "resources sampler over budget: " + breaches);
  }

  private static Map<String, Map<String, Double>> requestLatency(int iterations) throws Exception {
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15),
        DefaultCollectors.create(Fs.system(), new DataSourcePools(), true));
    int rounds = 6;
    int per = Math.max(1, iterations / rounds);
    List<Double> off = new ArrayList<>();
    List<Double> on = new ArrayList<>();
    for (int i = 0; i < 5_000; i++) {
      request();
    }
    for (int r = 0; r < rounds; r++) {
      time(per, off);
      ScheduledExecutorService stress = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread t = new Thread(task, "bench-sampler");
        t.setDaemon(true);
        return t;
      });
      stress.scheduleAtFixedRate(sampler::sampleNow, 0, 100, TimeUnit.MILLISECONDS);
      time(per, on);
      stress.shutdownNow();
      stress.awaitTermination(2, TimeUnit.SECONDS);
    }
    Map<String, Map<String, Double>> out = new LinkedHashMap<>();
    out.put("off", summary(off));
    out.put("on", summary(on));
    Map<String, Double> added = new LinkedHashMap<>();
    for (String k : out.get("off").keySet()) {
      added.put(k, out.get("on").get(k) - out.get("off").get(k));
    }
    out.put("added", added);
    return out;
  }

  private static void time(int n, List<Double> into) {
    for (int i = 0; i < n; i++) {
      long t0 = System.nanoTime();
      request();
      into.add((System.nanoTime() - t0) / 1e6);
    }
  }

  private static volatile int sink;

  /** A stand-in request: build a small JSON-ish response of about 1 KB. */
  private static void request() {
    StringBuilder sb = new StringBuilder(1100).append('{');
    for (int i = 0; i < 40; i++) {
      sb.append('"').append("field").append(i).append("\":\"").append("value-").append(i * 31).append("\",");
    }
    sb.append("\"pad\":\"").append("x".repeat(200)).append("\"}");
    sink += sb.toString().getBytes(StandardCharsets.UTF_8).length;
  }

  private static Map<String, Double> summary(List<Double> values) {
    double[] v = values.stream().mapToDouble(Double::doubleValue).toArray();
    Map<String, Double> out = new LinkedHashMap<>();
    out.put("p50_ms", pct(v, 0.5));
    out.put("p95_ms", pct(v, 0.95));
    out.put("p99_ms", pct(v, 0.99));
    return out;
  }

  private static double pct(double[] values, double q) {
    double[] sorted = values.clone();
    Arrays.sort(sorted);
    int idx = (int) Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[idx];
  }

  private static String render(Map<String, Object> r, Map<String, Double> cpu, Map<String, Map<String, Double>> lat) {
    StringBuilder sb = new StringBuilder();
    sb.append(String.format(Locale.ROOT, "### Java SDK resources sampler (%s, %s, limit_source %s)%n%n",
        r.get("runtime"), r.get("platform"), r.get("limit_source")));
    sb.append("| CPU per sample p50 | p95 | max | share of a core at 15 s |\n|---|---|---|---|\n");
    sb.append(String.format(Locale.ROOT, "| %.0f us | %.0f us | %.0f us | %.4f %% |%n%n",
        cpu.get("p50"), cpu.get("p95"), cpu.get("max"), (double) r.get("core_pct_at_15s")));
    sb.append("Request latency, sampler every 100 ms (150x production) vs off:\n\n");
    sb.append("| | p50 | p95 | p99 |\n|---|---|---|---|\n");
    for (String k : List.of("off", "on", "added")) {
      Map<String, Double> m = lat.get(k);
      String fmt = k.equals("added") ? "| %s | %+.4f ms | %+.4f ms | %+.4f ms |%n" : "| %s | %.4f ms | %.4f ms | %.4f ms |%n";
      sb.append(String.format(Locale.ROOT, fmt, k, m.get("p50_ms"), m.get("p95_ms"), m.get("p99_ms")));
    }
    return sb.toString();
  }

  /** Minimal JSON for the bench output (maps, lists, strings, numbers, null). */
  private static String json(Object v) {
    if (v == null) {
      return "null";
    }
    if (v instanceof Map<?, ?> m) {
      StringBuilder sb = new StringBuilder("{");
      boolean first = true;
      for (Map.Entry<?, ?> e : m.entrySet()) {
        sb.append(first ? "" : ",").append(json(String.valueOf(e.getKey()))).append(':').append(json(e.getValue()));
        first = false;
      }
      return sb.append('}').toString();
    }
    if (v instanceof List<?> l) {
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < l.size(); i++) {
        sb.append(i == 0 ? "" : ",").append(json(l.get(i)));
      }
      return sb.append(']').toString();
    }
    if (v instanceof Number || v instanceof Boolean) {
      return String.valueOf(v);
    }
    return '"' + String.valueOf(v).replace("\\", "\\\\").replace("\"", "\\\"") + '"';
  }

  private static void write(Path path, String content) throws IOException {
    if (path.getParent() != null) {
      Files.createDirectories(path.getParent());
    }
    Files.writeString(path, content);
  }
}
