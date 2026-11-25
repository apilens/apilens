package ai.apilens.resources;


/**
 * CPUs this process may run on: {@code Cpus_allowed_list} of {@code /proc/self/status} (CPU
 * affinity and cpuset) on Linux, else {@link Runtime#availableProcessors()}. Unlike {@code
 * availableProcessors()} it ignores {@code -XX:ActiveProcessorCount} and the JVM's own reading of
 * the cgroup quota, which the cgroup reader applies itself.
 */
final class HostCores {
  private HostCores() {}

  static int of(Fs fs) {
    String status = fs.read("/proc/self/status");
    if (status != null) {
      for (String line : status.split("\n")) {
        if (line.startsWith("Cpus_allowed_list:")) {
          int n = countList(line.substring(line.indexOf(':') + 1).trim());
          if (n > 0) {
            return n;
          }
        }
      }
    }
    return Math.max(Runtime.getRuntime().availableProcessors(), 1);
  }

  /** {@code "0-3,6,8-9"} -> 7; 0 when unparseable. */
  static int countList(String list) {
    int total = 0;
    try {
      for (String part : list.split(",")) {
        part = part.trim();
        if (part.isEmpty()) {
          continue;
        }
        int dash = part.indexOf('-');
        if (dash < 0) {
          Integer.parseInt(part);
          total += 1;
        } else {
          int from = Integer.parseInt(part.substring(0, dash));
          int to = Integer.parseInt(part.substring(dash + 1));
          total += Math.max(to - from + 1, 0);
        }
      }
    } catch (NumberFormatException ex) {
      return 0;
    }
    return total;
  }

}
