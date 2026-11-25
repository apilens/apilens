package ai.apilens.resources;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@code processes}: the top {@value #MAX_PROCESSES} processes by RSS in the SDK's own cgroup,
 * once a minute, from {@code /proc} only: {@code pid}, {@code ppid}, {@code comm} (15
 * characters), CPU % of one core and RSS. It reads {@code /proc/<pid>/cgroup}, {@code stat} and
 * {@code status}; never {@code cmdline}, {@code environ} or {@code cwd}, where secrets live.
 *
 * <p>With a host PID namespace ({@code /proc/1/comm} is systemd or init and more than {@value
 * #HOST_PID_THRESHOLD} processes are visible) the listing turns itself off and flags {@code
 * host_pid_namespace}: other tenants' processes are none of our business.
 */
final class ProcessListCollector implements Collector {
  static final int MAX_PROCESSES = 20;
  static final int HOST_PID_THRESHOLD = 500;
  static final long SPACING_NANOS = 60_000_000_000L;
  /** USER_HZ: clock ticks per second of /proc/<pid>/stat times (100 on every Linux ABI). */
  static final double CLOCK_TICKS = 100.0;
  private static final Set<String> INIT_NAMES = Set.of("systemd", "init");

  private final Fs fs;
  private final long spacingNanos;
  private final Map<Long, long[]> previous = new HashMap<>();
  private List<Map<String, Object>> latest;
  private Boolean hostPidNamespace;

  ProcessListCollector(Fs fs) {
    this(fs, SPACING_NANOS);
  }

  ProcessListCollector(Fs fs, long spacingNanos) {
    this.fs = fs;
    this.spacingNanos = spacingNanos;
  }

  @Override
  public String name() {
    return "processes";
  }

  @Override
  public String capability() {
    return "processes";
  }

  @Override
  public long minSpacingNanos() {
    return spacingNanos;
  }

  private record Proc(long pid, Long ppid, String comm, Double cpuPct, Double rss) {}

  @Override
  public boolean sample(Window window, long now) {
    if (Boolean.TRUE.equals(hostPidNamespace)) {
      window.flag("host_pid_namespace");
      return false;
    }
    String own = fs.read("/proc/self/cgroup");
    if (own == null) {
      return false;
    }
    List<Long> pids = new ArrayList<>();
    for (String name : fs.list("/proc")) {
      if (!name.isEmpty() && name.chars().allMatch(Character::isDigit)) {
        try {
          pids.add(Long.parseLong(name));
        } catch (NumberFormatException ex) {
          // Not a pid.
        }
      }
    }
    if (hostPidNamespace == null) {
      String init = fs.firstLine(fs.path("/proc/1/comm"));
      hostPidNamespace = init != null && INIT_NAMES.contains(init) && pids.size() > HOST_PID_THRESHOLD;
      if (hostPidNamespace) {
        latest = null;
        window.flag("host_pid_namespace");
        return false;
      }
    }
    List<Proc> procs = new ArrayList<>();
    Map<Long, long[]> seen = new HashMap<>();
    for (long pid : pids) {
      String base = "/proc/" + pid + "/";
      String cgroup = fs.read(base + "cgroup");
      if (cgroup == null || !cgroup.equals(own)) {
        continue;
      }
      String stat = fs.read(base + "stat");
      if (stat == null) {
        continue;
      }
      int open = stat.indexOf('(');
      int close = stat.lastIndexOf(')');
      if (open < 0 || close < open) {
        continue;
      }
      String comm = stat.substring(open + 1, close);
      if (comm.length() > 15) {
        comm = comm.substring(0, 15);
      }
      String[] rest = stat.substring(close + 1).trim().split("\\s+");
      Long ppid = rest.length > 1 ? parseLong(rest[1]) : null;
      Double cpuPct = null;
      if (rest.length > 12) {
        Long utime = parseLong(rest[11]);
        Long stime = parseLong(rest[12]);
        if (utime != null && stime != null) {
          long ticks = utime + stime;
          seen.put(pid, new long[] {ticks, now});
          long[] prev = previous.get(pid);
          if (prev != null && ticks >= prev[0] && now > prev[1]) {
            double seconds = (now - prev[1]) / 1e9;
            cpuPct = (ticks - prev[0]) / CLOCK_TICKS / seconds * 100;
          }
        }
      }
      Double rss = Fs.colonValues(fs.read(base + "status")).get("VmRSS");
      procs.add(new Proc(pid, ppid, comm, cpuPct, rss));
    }
    previous.clear();
    previous.putAll(seen);
    procs.sort(Comparator.comparingDouble((Proc p) -> p.rss() == null ? -1 : p.rss()).reversed());
    List<Map<String, Object>> out = new ArrayList<>();
    for (Proc p : procs) {
      if (out.size() == MAX_PROCESSES) {
        break;
      }
      Map<String, Object> item = new LinkedHashMap<>();
      item.put("pid", p.pid());
      if (p.ppid() != null) {
        item.put("ppid", p.ppid());
      }
      item.put("comm", p.comm());
      if (p.cpuPct() != null) {
        item.put("cpu_pct", Gauge.num(p.cpuPct()));
      }
      if (p.rss() != null) {
        item.put("rss", Gauge.num(p.rss()));
      }
      out.add(item);
    }
    latest = out;
    return !out.isEmpty();
  }

  @Override
  public void drain(Window window) {
    if (latest != null && !latest.isEmpty()) {
      window.value("processes", latest);
    }
    if (Boolean.TRUE.equals(hostPidNamespace)) {
      window.flag("host_pid_namespace");
    }
  }

  private static Long parseLong(String raw) {
    try {
      return Long.parseLong(raw);
    } catch (NumberFormatException ex) {
      return null;
    }
  }
}
