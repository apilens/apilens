package ai.apilens.resources;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntSupplier;

/**
 * Reads the SDK's own cgroup (v1, v2 or hybrid) from procfs and cgroupfs, without trusting the
 * JDK's container metrics (which have cgroup v2 gaps on older 17 updates).
 *
 * <ul>
 *   <li>The version is decided per controller from {@code /proc/self/mountinfo}: a controller
 *       mounted as cgroup v1 is read as v1 even when a cgroup2 mount exists (hybrid).
 *   <li>The own cgroup comes from {@code /proc/self/cgroup}, made relative to the mount root
 *       (mountinfo field 4) so cgroup namespaces and v1 container mounts resolve.
 *   <li>Limits are the minimum over the cgroup and its ancestors up to the mount point; "no
 *       limit" ({@code max}, {@code -1}, sentinels at or above 2^62, above MemTotal) is null.
 *   <li>CPU usage and throttling are microseconds; memory is bytes.
 * </ul>
 *
 * Shared fixtures: {@code testdata/cgroup/expected.json}.
 */
public final class CgroupReader {
  /** At or above this a memory limit is a "no limit" sentinel (v1 page-aligned LONG_MAX). */
  static final double SENTINEL = Math.pow(2, 62);

  /** CPU of the cgroup: cumulative counters and the effective limit. Any field may be null. */
  public record Cpu(Double limitCores, Double usageUs, Double nrPeriods, Double nrThrottled, Double throttledUs) {}

  /** Memory of the cgroup, bytes. {@code oomKill} is the cumulative count. Any field may be null. */
  public record Memory(
      Double limit, Double current, Double workingSet, Double anon, Double file, Double swap, Double oomKill) {}

  /**
   * One read. {@code limitSource} is {@code cgroup_v2}, {@code cgroup_v1} or {@code none};
   * {@code cpu} and {@code memory} are null when that controller is not found.
   */
  public record Snapshot(String limitSource, String containerId, Cpu cpu, Memory memory) {}

  private record Mount(String root, String mountPoint, String fsType, Set<String> options) {}

  /** A controller's own cgroup directory and the mount point it sits under. */
  private record Controller(boolean v1, Path dir, Path mountDir) {}

  private final Fs fs;
  private final IntSupplier hostCores;
  private volatile Resolved resolved;

  private record Resolved(Controller cpu, Controller cpuacct, Controller memory, String containerId, Double memTotal) {}

  public CgroupReader(Fs fs, IntSupplier hostCores) {
    this.fs = fs;
    this.hostCores = hostCores;
  }

  /** The container id from {@code /proc/self/cgroup}, else mountinfo; {@code null} when none. */
  public String containerId() {
    return resolve().containerId();
  }

  public Snapshot read() {
    Resolved r = resolve();
    Cpu cpu = null;
    if (r.cpu() != null || r.cpuacct() != null) {
      cpu = (r.cpu() != null ? r.cpu() : r.cpuacct()).v1() ? cpuV1(r) : cpuV2(r.cpu());
    }
    Memory memory = null;
    if (r.memory() != null) {
      memory = r.memory().v1() ? memoryV1(r.memory(), r.memTotal()) : memoryV2(r.memory(), r.memTotal());
    }
    String source = "none";
    if (isV1(r.cpu()) || isV1(r.memory())) {
      source = "cgroup_v1";
    } else if (r.cpu() != null || r.memory() != null) {
      source = "cgroup_v2";
    }
    return new Snapshot(source, r.containerId(), cpu, memory);
  }

  private static boolean isV1(Controller c) {
    return c != null && c.v1();
  }

  // ---- resolution (once) ---------------------------------------------------

  private Resolved resolve() {
    Resolved r = resolved;
    if (r != null) {
      return r;
    }
    List<String> mountLines = fs.lines("/proc/self/mountinfo");
    List<Mount> mounts = new ArrayList<>();
    for (String line : mountLines) {
      Mount mount = parseMount(line);
      if (mount != null) {
        mounts.add(mount);
      }
    }
    List<String> cgroupLines = fs.lines("/proc/self/cgroup");
    String id = ContainerIds.fromCgroup(cgroupLines);
    if (id == null) {
      id = ContainerIds.fromMountinfo(mountLines);
    }
    Double memTotal = Fs.colonValues(fs.read("/proc/meminfo")).get("MemTotal");
    r = new Resolved(
        controller("cpu", mounts, cgroupLines),
        controller("cpuacct", mounts, cgroupLines),
        controller("memory", mounts, cgroupLines),
        id,
        memTotal);
    resolved = r;
    return r;
  }

  private Controller controller(String name, List<Mount> mounts, List<String> cgroupLines) {
    // v1 first: a controller mounted as v1 is v1 even when a cgroup2 mount exists (hybrid).
    for (String line : cgroupLines) {
      String[] parts = line.trim().split(":", 3);
      if (parts.length != 3 || parts[1].isEmpty()) {
        continue;
      }
      if (!Arrays.asList(parts[1].split(",")).contains(name)) {
        continue;
      }
      for (Mount mount : mounts) {
        if (mount.fsType().equals("cgroup") && mount.options().contains(name)) {
          return new Controller(true, join(mount, parts[2]), fs.path(mount.mountPoint()));
        }
      }
    }
    if (name.equals("cpuacct")) {
      return null; // v2 has no cpuacct: usage is in cpu.stat
    }
    for (String line : cgroupLines) {
      String[] parts = line.trim().split(":", 3);
      if (parts.length != 3 || !parts[0].equals("0") || !parts[1].isEmpty()) {
        continue;
      }
      for (Mount mount : mounts) {
        if (mount.fsType().equals("cgroup2")) {
          return new Controller(false, join(mount, parts[2]), fs.path(mount.mountPoint()));
        }
      }
    }
    return null;
  }

  /** The directory of cgroup {@code path} under {@code mount}, honouring the mount root. */
  private Path join(Mount mount, String path) {
    String root = mount.root();
    String relative;
    if (root.equals("/")) {
      relative = path;
    } else if (path.equals(root) || path.startsWith(root + "/")) {
      relative = path.substring(root.length());
    } else {
      relative = ""; // a namespaced path outside the mount root: the mount point is ours
    }
    Path mountDir = fs.path(mount.mountPoint());
    String trimmed = relative.replaceAll("^/+", "");
    Path dir = trimmed.isEmpty() ? mountDir : mountDir.resolve(trimmed);
    return fs.isDirectory(dir) ? dir : mountDir;
  }

  private static Mount parseMount(String line) {
    int dash = line.indexOf(" - ");
    if (dash < 0) {
      return null;
    }
    String[] left = line.substring(0, dash).split(" ");
    String[] right = line.substring(dash + 3).split(" ");
    if (left.length < 5 || right.length < 1) {
      return null;
    }
    String fsType = right[0];
    if (!fsType.equals("cgroup") && !fsType.equals("cgroup2")) {
      return null;
    }
    Set<String> options = new HashSet<>();
    if (right.length >= 3) {
      options.addAll(Arrays.asList(right[2].split(",")));
    }
    return new Mount(unescape(left[3]), unescape(left[4]), fsType, options);
  }

  /** mountinfo escapes space, tab, newline and backslash as octal ({@code \040}). */
  private static String unescape(String raw) {
    if (raw.indexOf('\\') < 0) {
      return raw;
    }
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (c == '\\' && i + 3 < raw.length()) {
        String octal = raw.substring(i + 1, i + 4);
        if (octal.matches("[0-7]{3}")) {
          out.append((char) Integer.parseInt(octal, 8));
          i += 3;
          continue;
        }
      }
      out.append(c);
    }
    return out.toString();
  }

  /** The cgroup and its ancestors up to (and including) the mount point, leaf first. */
  private static List<Path> ancestors(Controller c) {
    List<Path> out = new ArrayList<>();
    Path dir = c.dir();
    while (dir != null && dir.startsWith(c.mountDir())) {
      out.add(dir);
      if (dir.equals(c.mountDir())) {
        break;
      }
      dir = dir.getParent();
    }
    return out;
  }

  // ---- v2 --------------------------------------------------------------------

  private Cpu cpuV2(Controller c) {
    Double limit = null;
    for (Path dir : ancestors(c)) {
      String line = fs.firstLine(dir.resolve("cpu.max"));
      if (line == null) {
        continue;
      }
      String[] parts = line.split("\\s+");
      Double quota = parts[0].equals("max") ? null : Fs.parse(parts[0]);
      Double period = parts.length > 1 ? Fs.parse(parts[1]) : Double.valueOf(100_000);
      if (quota != null && quota > 0 && period != null && period > 0) {
        limit = min(limit, quota / period);
      }
    }
    Map<String, Double> stat = fs.keyValues(c.dir().resolve("cpu.stat"));
    return new Cpu(
        capCores(limit),
        stat == null ? null : stat.get("usage_usec"),
        stat == null ? null : stat.get("nr_periods"),
        stat == null ? null : stat.get("nr_throttled"),
        stat == null ? null : stat.get("throttled_usec"));
  }

  private Memory memoryV2(Controller c, Double memTotal) {
    Double limit = null;
    for (Path dir : ancestors(c)) {
      limit = minLimit(limit, fs.firstLine(dir.resolve("memory.max")), memTotal);
    }
    Path dir = c.dir();
    Double current = fs.number(dir.resolve("memory.current"));
    Map<String, Double> stat = fs.keyValues(dir.resolve("memory.stat"));
    Map<String, Double> events = fs.keyValues(dir.resolve("memory.events"));
    return new Memory(
        limit,
        current,
        workingSet(current, stat == null ? null : stat.get("inactive_file")),
        stat == null ? null : stat.get("anon"),
        stat == null ? null : stat.get("file"),
        fs.number(dir.resolve("memory.swap.current")),
        events == null ? null : events.get("oom_kill"));
  }

  // ---- v1 --------------------------------------------------------------------

  private Cpu cpuV1(Resolved r) {
    Double limit = null;
    Map<String, Double> stat = null;
    if (r.cpu() != null) {
      for (Path dir : ancestors(r.cpu())) {
        Double quota = fs.number(dir.resolve("cpu.cfs_quota_us"));
        Double period = fs.number(dir.resolve("cpu.cfs_period_us"));
        if (quota != null && quota > 0 && period != null && period > 0) {
          limit = min(limit, quota / period);
        }
      }
      stat = fs.keyValues(r.cpu().dir().resolve("cpu.stat"));
    }
    Controller acct = r.cpuacct() != null ? r.cpuacct() : r.cpu();
    Double usageNs = acct == null ? null : fs.number(acct.dir().resolve("cpuacct.usage"));
    Double throttledNs = stat == null ? null : stat.get("throttled_time");
    return new Cpu(
        capCores(limit),
        usageNs == null ? null : usageNs / 1000,
        stat == null ? null : stat.get("nr_periods"),
        stat == null ? null : stat.get("nr_throttled"),
        throttledNs == null ? null : throttledNs / 1000);
  }

  private Memory memoryV1(Controller c, Double memTotal) {
    Double limit = null;
    for (Path dir : ancestors(c)) {
      limit = minLimit(limit, fs.firstLine(dir.resolve("memory.limit_in_bytes")), memTotal);
    }
    Path dir = c.dir();
    Double current = fs.number(dir.resolve("memory.usage_in_bytes"));
    Map<String, Double> stat = fs.keyValues(dir.resolve("memory.stat"));
    Map<String, Double> oom = fs.keyValues(dir.resolve("memory.oom_control"));
    Double swapTotal = fs.number(dir.resolve("memory.memsw.usage_in_bytes"));
    Double swap = swapTotal != null && current != null ? Math.max(swapTotal - current, 0) : null;
    return new Memory(
        limit,
        current,
        workingSet(current, first(stat, "total_inactive_file", "inactive_file")),
        first(stat, "total_rss", "rss"),
        first(stat, "total_cache", "cache"),
        swap,
        oom == null ? null : oom.get("oom_kill"));
  }

  // ---- helpers ---------------------------------------------------------------

  private static Double first(Map<String, Double> stat, String a, String b) {
    if (stat == null) {
      return null;
    }
    Double value = stat.get(a);
    return value != null ? value : stat.get(b);
  }

  private static Double workingSet(Double current, Double inactiveFile) {
    if (current == null) {
      return null;
    }
    return inactiveFile == null ? current : Math.max(current - inactiveFile, 0);
  }

  private static Double minLimit(Double limit, String raw, Double memTotal) {
    if (raw == null || raw.equals("max")) {
      return limit;
    }
    Double value = Fs.parse(raw);
    if (value == null || value <= 0 || value >= SENTINEL || (memTotal != null && value > memTotal)) {
      return limit;
    }
    return min(limit, value);
  }

  private Double capCores(Double quotaCores) {
    if (quotaCores == null) {
      return null;
    }
    int host = hostCores.getAsInt();
    return host > 0 ? Math.min(quotaCores, host) : quotaCores;
  }

  private static Double min(Double a, double b) {
    return a == null ? b : Math.min(a, b);
  }
}
