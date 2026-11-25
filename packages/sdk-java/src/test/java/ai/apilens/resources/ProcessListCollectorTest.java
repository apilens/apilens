package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProcessListCollectorTest {
  private static final String OWN = "0::/kubepods.slice/pod-a/cri-containerd-abc.scope\n";

  /** A fake /proc entry; {@code cmdline} and {@code environ} hold secrets that must never leak. */
  static void proc(Path root, long pid, long ppid, String comm, String cgroup, long rssKb, long ticks) throws IOException {
    Path dir = root.resolve("proc/" + pid);
    Files.createDirectories(dir);
    Files.writeString(dir.resolve("cgroup"), cgroup);
    Files.writeString(dir.resolve("stat"), pid + " (" + comm + ") S " + ppid + " 1 1 0 -1 4194560 100 0 0 0 "
        + ticks + " 0 0 0 20 0 9 0 100 1000000 250 18446744073709551615");
    Files.writeString(dir.resolve("status"), "Name:\t" + comm + "\nVmRSS:\t" + rssKb + " kB\n");
    Files.writeString(dir.resolve("cmdline"), comm + "\0--password=s3cr3t\0");
    Files.writeString(dir.resolve("environ"), "DB_PASSWORD=s3cr3t\0");
  }

  static Path self(Path root) throws IOException {
    Files.createDirectories(root.resolve("proc/self"));
    Files.writeString(root.resolve("proc/self/cgroup"), OWN);
    Files.createDirectories(root.resolve("proc/1"));
    return root;
  }

  @Test
  void aChildWithASecretInArgvNeverAppears(@TempDir Path root) throws Exception {
    self(root);
    proc(root, 1, 0, "java", OWN, 204800, 500);
    proc(root, 77, 1, "gunicorn-worker-process", OWN, 1024, 10);
    proc(root, 900, 1, "other-tenant", "0::/kubepods.slice/pod-b/cri-containerd-def.scope\n", 999999, 10);
    List<Path> read = new ArrayList<>();
    ProcessListCollector collector = new ProcessListCollector(Fs.at(root, read::add), 0);
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(collector));
    sampler.sampleNow();
    proc(root, 1, 0, "java", OWN, 204800, 650); // 150 ticks = 1.5 s of CPU
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    String json = new ObjectMapper().writeValueAsString(block);
    assertFalse(json.contains("s3cr3t"), json);
    assertFalse(json.contains("password"), json);
    assertFalse(json.contains("other-tenant"), "only our own cgroup: " + json);
    for (Path path : read) {
      String name = path.getFileName().toString();
      assertFalse(name.equals("cmdline") || name.equals("environ") || name.equals("cwd"), "read " + path);
    }
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> procs = (List<Map<String, Object>>) block.get("processes");
    assertEquals(2, procs.size());
    Map<String, Object> java = procs.get(0);
    assertEquals(1L, java.get("pid"));
    assertEquals(0L, java.get("ppid"));
    assertEquals("java", java.get("comm"));
    assertEquals(209715200L, java.get("rss"));
    assertTrue(((Number) java.get("cpu_pct")).doubleValue() > 0);
    assertEquals(List.of("pid", "ppid", "comm", "cpu_pct", "rss"), List.copyOf(procs.get(1).keySet()),
        "only the five documented fields");
    assertEquals("gunicorn-worker", procs.get(1).get("comm"), "comm is cut at 15 characters");
    assertEquals(0L, procs.get(1).get("cpu_pct"), "idle: a measured zero");
    assertEquals(List.of("processes"), block.get("capabilities"));
  }

  @Test
  void aRealChildWithASecretInArgvNeverAppears() throws Exception {
    org.junit.jupiter.api.Assumptions.assumeTrue(Files.isReadable(Path.of("/proc/self/status")), "Linux only");
    Process child = new ProcessBuilder("sh", "-c", "exec sleep 30", "sh", "--password=s3cr3t").start();
    try {
      ProcessListCollector collector = new ProcessListCollector(Fs.system(), 0);
      Window window = new Window();
      collector.sample(window, System.nanoTime());
      collector.drain(window);
      String json = new ObjectMapper().writeValueAsString(window.tree());
      assertFalse(json.contains("s3cr3t"), json);
    } finally {
      child.destroyForcibly();
    }
  }

  @Test
  void capOfTwenty(@TempDir Path root) throws Exception {
    self(root);
    for (int pid = 100; pid < 130; pid++) {
      proc(root, pid, 1, "p" + pid, OWN, pid, 1);
    }
    ProcessListCollector collector = new ProcessListCollector(Fs.at(root), 0);
    Window window = new Window();
    assertTrue(collector.sample(window, 0));
    collector.drain(window);
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> procs = (List<Map<String, Object>>) window.tree().get("processes");
    assertEquals(ProcessListCollector.MAX_PROCESSES, procs.size());
    assertEquals(129L, procs.get(0).get("pid"), "largest RSS first");
  }

  @Test
  void hostPidNamespaceTurnsTheListingOff(@TempDir Path root) throws Exception {
    self(root);
    Files.writeString(root.resolve("proc/1/comm"), "systemd\n");
    for (int pid = 2; pid < 2 + ProcessListCollector.HOST_PID_THRESHOLD + 1; pid++) {
      Files.createDirectories(root.resolve("proc/" + pid));
    }
    proc(root, 4242, 1, "java", OWN, 1000, 1);
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(new ProcessListCollector(Fs.at(root), 0)));
    sampler.sampleNow();
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    assertNull(block.get("processes"));
    assertEquals(List.of("host_pid_namespace"), block.get("flags"));
    assertTrue(((List<?>) block.get("capabilities")).isEmpty());
  }

  @Test
  void aSmallContainerWithInitIsNotTheHost(@TempDir Path root) throws Exception {
    self(root);
    proc(root, 1, 0, "init", OWN, 1000, 1);
    Files.writeString(root.resolve("proc/1/comm"), "init\n");
    ProcessListCollector collector = new ProcessListCollector(Fs.at(root), 0);
    assertTrue(collector.sample(new Window(), 0));
  }

  @Test
  void listsOncePerMinute() {
    assertEquals(60_000_000_000L, new ProcessListCollector(Fs.system()).minSpacingNanos());
  }
}
