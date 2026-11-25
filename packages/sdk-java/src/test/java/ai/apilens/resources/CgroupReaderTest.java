package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The shared cgroup fixture table (testdata/cgroup), run exactly as the Python and TS SDKs do. */
class CgroupReaderTest {
  static final Path TESTDATA = Path.of("..", "..", "testdata");
  static final Path CGROUP = TESTDATA.resolve("cgroup");
  private static final ObjectMapper MAPPER = new ObjectMapper();
  /** expected.json: "tests inject host cores = 8". */
  private static final int HOST_CORES = 8;

  static CgroupReader reader(String fixture) {
    return new CgroupReader(Fs.at(CGROUP.resolve(fixture).resolve("root")), () -> HOST_CORES);
  }

  @Test
  void everyFixtureProducesTheExpectedValues() throws IOException {
    JsonNode cases = MAPPER.readTree(CGROUP.resolve("expected.json").toFile()).get("cases");
    assertTrue(cases.size() >= 6, "fixture table found");
    List<String> failures = new ArrayList<>();
    Iterator<Map.Entry<String, JsonNode>> it = cases.fields();
    while (it.hasNext()) {
      Map.Entry<String, JsonNode> entry = it.next();
      String name = entry.getKey();
      JsonNode want = entry.getValue();
      CgroupReader.Snapshot got = reader(name).read();
      check(failures, name, "limit_source", want.get("limit_source"), got.limitSource());
      check(failures, name, "container_id", want.get("container_id"), got.containerId());
      JsonNode cpu = want.get("cpu");
      if (cpu.isNull()) {
        if (got.cpu() != null) {
          failures.add(name + ".cpu: expected null, got " + got.cpu());
        }
      } else if (got.cpu() == null) {
        failures.add(name + ".cpu: expected values, got null");
      } else {
        check(failures, name, "cpu.limit_cores", cpu.get("limit_cores"), got.cpu().limitCores());
        check(failures, name, "cpu.usage_us", cpu.get("usage_us"), got.cpu().usageUs());
        check(failures, name, "cpu.nr_periods", cpu.get("nr_periods"), got.cpu().nrPeriods());
        check(failures, name, "cpu.nr_throttled", cpu.get("nr_throttled"), got.cpu().nrThrottled());
        check(failures, name, "cpu.throttled_us", cpu.get("throttled_us"), got.cpu().throttledUs());
      }
      JsonNode memory = want.get("memory");
      if (memory.isNull()) {
        if (got.memory() != null) {
          failures.add(name + ".memory: expected null, got " + got.memory());
        }
      } else if (got.memory() == null) {
        failures.add(name + ".memory: expected values, got null");
      } else {
        CgroupReader.Memory m = got.memory();
        check(failures, name, "memory.limit", memory.get("limit"), m.limit());
        check(failures, name, "memory.current", memory.get("current"), m.current());
        check(failures, name, "memory.working_set", memory.get("working_set"), m.workingSet());
        check(failures, name, "memory.anon", memory.get("anon"), m.anon());
        check(failures, name, "memory.file", memory.get("file"), m.file());
        check(failures, name, "memory.swap", memory.get("swap"), m.swap());
        check(failures, name, "memory.oom_kill", memory.get("oom_kill"), m.oomKill());
      }
    }
    assertTrue(failures.isEmpty(), String.join("\n", failures));
  }

  private static void check(List<String> failures, String fixture, String field, JsonNode want, Object got) {
    if (want == null || want.isNull()) {
      if (got != null) {
        failures.add(fixture + "." + field + ": expected null, got " + got);
      }
      return;
    }
    if (want.isTextual()) {
      if (!want.asText().equals(got)) {
        failures.add(fixture + "." + field + ": expected " + want.asText() + ", got " + got);
      }
      return;
    }
    if (!(got instanceof Double d) || Math.abs(d - want.asDouble()) > 1e-9) {
      failures.add(fixture + "." + field + ": expected " + want + ", got " + got);
    }
  }

  @Test
  void containerIdTable() throws IOException {
    JsonNode cases = MAPPER.readTree(CGROUP.resolve("container_ids.json").toFile()).get("cases");
    List<String> failures = new ArrayList<>();
    cases.fields().forEachRemaining(entry -> {
      String line = entry.getValue().get(0).asText();
      JsonNode want = entry.getValue().get(1);
      String got = ContainerIds.fromCgroupLine(line);
      String expected = want.isNull() ? null : want.asText();
      if (expected == null ? got != null : !expected.equals(got)) {
        failures.add(entry.getKey() + ": expected " + expected + ", got " + got);
      }
    });
    assertTrue(cases.size() >= 10);
    assertTrue(failures.isEmpty(), String.join("\n", failures));
  }

  @Test
  void aMissingFileNullsThatFieldOnly(@TempDir Path tmp) throws IOException {
    Path root = copy("v2_namespaced_limited", tmp);
    Files.delete(root.resolve("sys/fs/cgroup/memory.stat"));
    Files.delete(root.resolve("sys/fs/cgroup/cpu.stat"));
    CgroupReader.Snapshot snap = new CgroupReader(Fs.at(root), () -> HOST_CORES).read();
    assertNull(snap.memory().anon());
    assertNull(snap.memory().file());
    // No inactive_file: the working set falls back to current, never to 0.
    assertEquals(503316480d, snap.memory().workingSet());
    assertEquals(503316480d, snap.memory().current());
    assertEquals(536870912d, snap.memory().limit());
    assertNull(snap.cpu().usageUs());
    assertNull(snap.cpu().nrPeriods());
    assertEquals(0.5, snap.cpu().limitCores());
  }

  @Test
  void anUnreadableFileNullsThatFieldOnly(@TempDir Path tmp) throws IOException {
    Path root = copy("v2_unlimited", tmp);
    Path current = root.resolve("sys/fs/cgroup/memory.current");
    assertTrue(current.toFile().setReadable(false, false));
    try {
      org.junit.jupiter.api.Assumptions.assumeTrue(!Files.isReadable(current), "running as root");
      CgroupReader.Snapshot snap = new CgroupReader(Fs.at(root), () -> HOST_CORES).read();
      assertNull(snap.memory().current());
      assertNull(snap.memory().workingSet());
      assertEquals(73400320d, snap.memory().anon());
      assertEquals(5000000d, snap.cpu().usageUs());
    } finally {
      current.toFile().setReadable(true, false);
    }
  }

  @Test
  void effectiveCoresAreTheMinimumOfQuotaAndAllowedCpus() {
    // Quota of 2 cores but only one CPU allowed (affinity/cpuset): 1.
    assertEquals(1.0, new CgroupReader(Fs.at(CGROUP.resolve("v1_docker/root")), () -> 1).read().cpu().limitCores());
    assertEquals(2.0, reader("v1_docker").read().cpu().limitCores());
    assertEquals(4, HostCores.countList("0-3"));
    assertEquals(7, HostCores.countList("0-3,6,8-9"));
    assertEquals(0, HostCores.countList("x"));
  }

  @Test
  void memoryLimitAboveMemTotalIsNoLimit(@TempDir Path tmp) throws IOException {
    Path root = copy("v2_namespaced_limited", tmp);
    Files.writeString(root.resolve("proc/meminfo"), "MemTotal:         262144 kB\n");
    assertNull(new CgroupReader(Fs.at(root), () -> HOST_CORES).read().memory().limit());
  }

  @Test
  void hostCoresReadsTheAllowedList(@TempDir Path tmp) throws IOException {
    Files.createDirectories(tmp.resolve("proc/self"));
    Files.writeString(tmp.resolve("proc/self/status"), "Name:\tjava\nCpus_allowed_list:\t0-5\n");
    assertEquals(6, HostCores.of(Fs.at(tmp)));
    assertNotNull(HostCores.of(Fs.at(tmp.resolve("missing"))));
  }

  static Path copy(String fixture, Path into) throws IOException {
    Path source = CGROUP.resolve(fixture).resolve("root");
    Path target = into.resolve(fixture);
    try (Stream<Path> paths = Files.walk(source)) {
      for (Path path : paths.sorted(Comparator.naturalOrder()).toList()) {
        Path dest = target.resolve(source.relativize(path).toString());
        if (Files.isDirectory(path)) {
          Files.createDirectories(dest);
        } else {
          Files.copy(path, dest);
        }
      }
    }
    return target;
  }

  @Test
  void mountinfoNeverTakesASandboxAndFallsBackToTheTerminationLog() {
    String sandbox = "1 2 259:1 /var/lib/containerd/io.containerd.grpc.v1.cri/sandboxes/" + "a".repeat(64)
        + "/hostname /etc/hostname rw - ext4 /dev/root rw";
    String term = "4 2 259:1 /var/lib/kubelet/pods/8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/containers/app/5f2c9e1a"
        + " /dev/termination-log rw - ext4 /dev/root rw";
    String real = "3 2 259:1 /var/lib/docker/containers/" + "b".repeat(64)
        + "/resolv.conf /etc/resolv.conf rw - ext4 /dev/root rw";
    String hosts = "5 2 259:1 /var/lib/kubelet/pods/8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/etc-hosts"
        + " /etc/hosts rw - ext4 /dev/root rw";
    String k8s = "k8s:8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/app/5f2c9e1a";
    assertNull(ContainerIds.fromMountinfo(List.of(sandbox, hosts)));
    assertEquals(k8s, ContainerIds.fromMountinfo(List.of(sandbox, term)));
    assertEquals(k8s, ContainerIds.fromMountinfo(
        List.of(term.replace("/dev/termination-log", "/tmp/msg"))));
    assertEquals("b".repeat(64), ContainerIds.fromMountinfo(List.of(term, real)));
  }
}
