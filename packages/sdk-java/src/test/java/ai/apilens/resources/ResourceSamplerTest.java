package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.RemotePolicy;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class ResourceSamplerTest {
  /** A collector writing one gauge per sample. */
  static Collector gauge(String name, String path, double value) {
    return new Collector() {
      @Override
      public String name() {
        return name;
      }

      @Override
      public String capability() {
        return name;
      }

      @Override
      public boolean sample(Window window, long now) {
        window.gauge(path, value);
        return true;
      }
    };
  }

  static Collector throwing(String name, AtomicInteger calls) {
    return new Collector() {
      @Override
      public String name() {
        return name;
      }

      @Override
      public String capability() {
        return name;
      }

      @Override
      public boolean sample(Window window, long now) {
        calls.incrementAndGet();
        window.gauge("process.threads", 99.0);
        throw new IllegalStateException("boom");
      }
    };
  }

  @Test
  void aThrowingCollectorIsIsolatedAndDisabledAfterFiveFailures() {
    AtomicInteger calls = new AtomicInteger();
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(
        throwing("process.memory", calls), gauge("process.cpu", "process.cpu.cores_used", 0.5)));
    for (int i = 0; i < 8; i++) {
      sampler.sampleNow(); // never throws
    }
    assertEquals(ResourceSampler.MAX_CONSECUTIVE_FAILURES, calls.get(), "not called once disabled");
    assertEquals(List.of("process.memory"), sampler.disabledCollectors());
    assertEquals(5L, sampler.collectorErrors().get("process.memory"));
    assertEquals(0L, sampler.collectorErrors().get("process.cpu"));
    Map<String, Object> block = sampler.drain();
    assertEquals(8, block.get("n"));
    assertEquals(List.of("process.cpu"), block.get("capabilities"));
    @SuppressWarnings("unchecked")
    Map<String, Object> cpu = (Map<String, Object>) ((Map<String, Object>) block.get("process")).get("cpu");
    assertEquals(Map.of("min", 0.5, "avg", 0.5, "max", 0.5, "last", 0.5), cpu.get("cores_used"));
  }

  @Test
  void aFailureStreakIsResetBySuccess() {
    AtomicInteger calls = new AtomicInteger();
    Collector flaky = new Collector() {
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
        if (calls.incrementAndGet() % 4 == 0) {
          return true;
        }
        throw new RuntimeException("flaky");
      }
    };
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(flaky));
    for (int i = 0; i < 20; i++) {
      sampler.sampleNow();
    }
    assertTrue(sampler.disabledCollectors().isEmpty());
    assertEquals(20, calls.get());
  }

  @Test
  void unavailableDisablesAtOnce() {
    AtomicInteger calls = new AtomicInteger();
    Collector denied = new Collector() {
      @Override
      public String name() {
        return "process.pss";
      }

      @Override
      public String capability() {
        return "process.pss";
      }

      @Override
      public boolean sample(Window window, long now) throws Unavailable {
        calls.incrementAndGet();
        throw new Unavailable("EACCES");
      }
    };
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(denied, gauge("process.cpu", "process.cpu.cores_used", 1)));
    sampler.sampleNow();
    sampler.sampleNow();
    assertEquals(1, calls.get());
    assertEquals(List.of("process.pss"), sampler.disabledCollectors());
    assertEquals(2, sampler.drain().get("n"));
  }

  @Test
  void drainResetsTheWindowAndIsNullWithoutSamples() {
    AtomicLong clock = new AtomicLong(0);
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15),
        List.of(gauge("process.cpu", "process.cpu.cores_used", 2)), clock::get, () -> 0);
    assertNull(sampler.drain(), "nothing sampled yet");
    clock.set(15_000_000_000L);
    sampler.sampleNow();
    clock.set(60_000_000_000L);
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    assertEquals(1, block.get("v"));
    assertEquals(60L, block.get("window_s"));
    assertEquals(2, block.get("n"));
    assertEquals("host", block.get("limit_source"));
    assertEquals(List.of(), block.get("flags"));
    assertNull(sampler.drain(), "a fresh window");
  }

  @Test
  void remotePolicyPausesSkipsAndLengthens() {
    AtomicInteger cpuCalls = new AtomicInteger();
    Collector cpu = new Collector() {
      @Override
      public String name() {
        return "process.cpu";
      }

      @Override
      public String capability() {
        return "process.cpu";
      }

      @Override
      public boolean sample(Window window, long now) {
        cpuCalls.incrementAndGet();
        window.gauge("process.cpu.cores_used", 1.0);
        return true;
      }
    };
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15),
        List.of(cpu, gauge("runtime", "runtime.jvm.threads", 10)));

    sampler.applyPolicy(new RemotePolicy.Resources(false, 15, Set.of()));
    sampler.sampleNow();
    assertEquals(0, cpuCalls.get());
    assertNull(sampler.drain(), "enabled=false: no sampling, no block");

    sampler.applyPolicy(new RemotePolicy.Resources(true, 60, Set.of("process.cpu")));
    sampler.sampleNow();
    assertEquals(0, cpuCalls.get(), "disabled collector skipped");
    Map<String, Object> block = sampler.drain();
    assertFalse(block.containsKey("process"));
    assertTrue(block.containsKey("runtime"));
    assertEquals(List.of("runtime"), block.get("capabilities"));
    assertEquals(Duration.ofSeconds(60), sampler.effectiveInterval());

    // Narrow only: a remote interval shorter than the local one keeps the local one.
    ResourceSampler slow = new ResourceSampler(Duration.ofSeconds(120), List.of());
    slow.applyPolicy(new RemotePolicy.Resources(true, 30, Set.of()));
    assertEquals(Duration.ofSeconds(120), slow.effectiveInterval());
    slow.applyPolicy(null);
    assertEquals(Duration.ofSeconds(120), slow.effectiveInterval());
  }

  @Test
  void backsOffWhileOverBudgetAndRecovers() {
    AtomicLong cpu = new AtomicLong();
    AtomicLong cost = new AtomicLong(200_000_000L); // 200 ms per sample: 1.3% of a core at 15 s
    Collector expensive = new Collector() {
      @Override
      public String name() {
        return "processes";
      }

      @Override
      public String capability() {
        return "processes";
      }

      @Override
      public boolean sample(Window window, long now) {
        cpu.addAndGet(cost.get());
        return true;
      }
    };
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(expensive), System::nanoTime, cpu::get);
    sampler.sampleNow();
    assertEquals(Duration.ofSeconds(30), sampler.effectiveInterval());
    sampler.sampleNow();
    assertEquals(Duration.ofSeconds(60), sampler.effectiveInterval());
    for (int i = 0; i < 5; i++) {
      sampler.sampleNow();
    }
    assertEquals(Duration.ofSeconds(15L * ResourceSampler.MAX_BACKOFF), sampler.effectiveInterval(), "capped");
    Map<String, Object> block = sampler.drain();
    assertEquals(200_000L, block.get("sampler_cost_us"));
    assertTrue(((List<?>) block.get("flags")).contains("sampler_backoff"));
    cost.set(10_000L); // 10 µs: far under budget
    for (int i = 0; i < 4; i++) {
      sampler.sampleNow();
    }
    assertEquals(Duration.ofSeconds(15), sampler.effectiveInterval());
  }

  @Test
  void theThreadSamplesEveryIntervalAndStops() throws Exception {
    AtomicInteger samples = new AtomicInteger();
    Collector counting = new Collector() {
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
        samples.incrementAndGet();
        return true;
      }
    };
    ResourceSampler sampler = new ResourceSampler(Duration.ofMillis(20), List.of(counting));
    sampler.start();
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while (samples.get() < 3 && System.nanoTime() < deadline) {
      Thread.sleep(5);
    }
    assertTrue(samples.get() >= 3);
    Thread thread = Thread.getAllStackTraces().keySet().stream()
        .filter(t -> t.getName().equals("apilens-resources")).findFirst().orElse(null);
    assertNotNull(thread);
    assertTrue(thread.isDaemon(), "never keeps the JVM alive");
    sampler.stop();
    int after = samples.get();
    Thread.sleep(100);
    assertTrue(samples.get() <= after + 1);
    assertFalse(sampler.running());
  }

  /** The JVM exits on its own with the sampler running (a daemon thread, no shutdown needed). */
  @Test
  void theJvmExitsCleanly() throws Exception {
    String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
    Process child = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"), ExitMain.class.getName())
        .redirectErrorStream(true)
        .start();
    boolean exited = child.waitFor(30, TimeUnit.SECONDS);
    String output = new String(child.getInputStream().readAllBytes());
    if (!exited) {
      child.destroyForcibly();
    }
    assertTrue(exited, "the JVM did not exit: " + output);
    assertEquals(0, child.exitValue(), output);
    assertTrue(output.contains("sampling"), output);
  }

  /** Starts the real sampler and returns from main without stopping it. */
  public static final class ExitMain {
    public static void main(String[] args) throws Exception {
      ResourceSampler sampler = new ResourceSampler(Duration.ofMillis(10),
          DefaultCollectors.create(Fs.system(), new DataSourcePools(), true));
      sampler.start();
      Thread.sleep(100);
      System.out.println(sampler.running() ? "sampling" : "not sampling");
    }
  }
}
