package ai.apilens.resources;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The container id named by {@code /proc/self/cgroup} or, on cgroup v2 with a cgroup namespace
 * (own path {@code /}), by the bind mounts in {@code /proc/self/mountinfo}. Shared table:
 * {@code testdata/cgroup/container_ids.json}.
 */
final class ContainerIds {
  private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
  private static final Pattern ECS = Pattern.compile("[0-9a-f]{32}-[0-9]+");
  private static final String[] PREFIXES = {"docker-", "cri-containerd-", "crio-", "libpod-"};
  /** containerd/Docker/Podman keep per-container files under containers/<id>/. */
  private static final Pattern MOUNT_ID =
      Pattern.compile("/(?:containers|overlay-containers)/([0-9a-f]{64})(?:/|$)");
  /**
   * kubelet's per-container-start file ({@code /dev/termination-log} or the pod's
   * {@code terminationMessagePath}): {@code <kubelet root>/pods/<uid>/containers/<name>/<suffix>}.
   */
  private static final Pattern KUBELET_CONTAINER = Pattern.compile(
      "/pods/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/containers/"
          + "([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)/([0-9A-Za-z]+)$");

  private ContainerIds() {}

  /** The id in one {@code /proc/self/cgroup} line, or {@code null}. */
  static String fromCgroupLine(String line) {
    if (line == null) {
      return null;
    }
    String[] parts = line.trim().split(":", 3);
    String path = parts.length == 3 ? parts[2] : line.trim();
    String[] segments = path.split("/");
    for (int i = segments.length - 1; i >= 0; i--) {
      String segment = segments[i];
      if (segment.isEmpty()) {
        continue;
      }
      // crio-conmon-<id> is CRI-O's monitor process, never the container itself.
      if (segment.startsWith("crio-conmon-")) {
        return null;
      }
      if (segment.endsWith(".scope")) {
        segment = segment.substring(0, segment.length() - ".scope".length());
      }
      for (String prefix : PREFIXES) {
        if (segment.startsWith(prefix)) {
          segment = segment.substring(prefix.length());
          break;
        }
      }
      if (HEX64.matcher(segment).matches() || ECS.matcher(segment).matches()) {
        return segment;
      }
    }
    return null;
  }

  /** The first id named by any line of {@code /proc/self/cgroup}. */
  static String fromCgroup(List<String> lines) {
    for (String line : lines) {
      String id = fromCgroupLine(line);
      if (id != null) {
        return id;
      }
    }
    return null;
  }

  /**
   * The id in the mount roots (field 4) of {@code mountinfo}: {@code /etc/resolv.conf} and
   * {@code /etc/hosts} are bind-mounted from {@code .../containers/<id>/}. Sandbox (pause
   * container) paths are per pod and never match.
   *
   * <p>Failing that (containerd + cgroup v2 Kubernetes, where hostname and resolv.conf come from
   * the sandbox), kubelet's termination-log mount: its root {@code .../pods/<uid>/containers/
   * <name>/<suffix>} gets a new suffix on every container start and is shared by every process in
   * it, so the id is {@code k8s:<uid>/<name>/<suffix>}.
   */
  static String fromMountinfo(List<String> lines) {
    for (String line : lines) {
      String[] fields = line.split(" ");
      if (fields.length < 5) {
        continue;
      }
      Matcher matcher = MOUNT_ID.matcher(fields[3]);
      if (matcher.find()) {
        return matcher.group(1);
      }
    }
    for (String line : lines) {
      String[] fields = line.split(" ");
      if (fields.length < 5) {
        continue;
      }
      Matcher matcher = KUBELET_CONTAINER.matcher(fields[3]);
      if (matcher.find()) {
        return "k8s:" + matcher.group(1) + "/" + matcher.group(2) + "/" + matcher.group(3);
      }
    }
    return null;
  }
}
