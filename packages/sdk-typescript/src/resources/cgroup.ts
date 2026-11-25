/**
 * cgroup v1 / v2 reader (D3–D5), the same rules as the Python and Java SDKs
 * and the same fixture table (testdata/cgroup/expected.json).
 *
 * - The version is decided per controller from /proc/self/mountinfo, never by
 *   probing files: a hybrid host has a cgroup2 mount but v1 cpu and memory.
 * - The process's own cgroup comes from /proc/self/cgroup, made relative to
 *   the mount's root field (field 4), so a cgroup namespace (own path `/`)
 *   and a v1 bind mount of the container's own cgroup both resolve.
 * - Limits are the minimum over the leaf and every ancestor up to the mount
 *   point (Kubernetes puts them on the pod slice, the leaf says `max`).
 * - "No limit" (`max`, -1, the v1 sentinel 9223372036854771712, anything at
 *   or above 2^62 or the host's memory) is null, never a number. A missing
 *   or unreadable file makes only its own fields null.
 *
 * Units: bytes, microseconds (v1's nanosecond counters are converted) and
 * cores. All reads are synchronous and only happen in the sampler's timer.
 */

import { type Reader, fileReader, keyValues, numberIn } from "./fs.js";

export type LimitSource = "cgroup_v2" | "cgroup_v1" | "none";

export type CgroupCpu = {
  limit_cores: number | null;
  usage_us: number | null;
  nr_periods: number | null;
  nr_throttled: number | null;
  throttled_us: number | null;
  /** CPUs of the cpuset (not a limit by itself; caps the effective cores). */
  cpuset_cores: number | null;
};

export type CgroupMemory = {
  limit: number | null;
  current: number | null;
  working_set: number | null;
  anon: number | null;
  file: number | null;
  swap: number | null;
  oom_kill: number | null;
};

export type CgroupSnapshot = {
  limit_source: LimitSource;
  container_id: string | null;
  cpu: CgroupCpu | null;
  memory: CgroupMemory | null;
};

export type CgroupOptions = {
  /** Root of the filesystem to read (tests: a fixture tree). Default "". */
  root?: string;
  reader?: Reader;
  /** Host CPUs (affinity-aware); caps `limit_cores`. */
  hostCores?: number;
  /** Host memory in bytes; a limit at or above it is no limit. */
  hostMemTotal?: number;
};

/** At or above this a memory limit is a "no limit" sentinel. */
const NO_LIMIT_BYTES = 2 ** 62;

type Mount = { root: string; mountpoint: string; fstype: string; options: string[] };

/** mountinfo escapes spaces and friends as `\040`. */
function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

export function parseMountinfo(text: string | null): Mount[] {
  const out: Mount[] = [];
  for (const line of (text ?? "").split("\n")) {
    const fields = line.trim().split(" ");
    const sep = fields.indexOf("-");
    if (sep < 5 || fields.length < sep + 3) {
      continue;
    }
    out.push({
      root: unescape(fields[3]),
      mountpoint: unescape(fields[4]),
      fstype: fields[sep + 1],
      options: (fields[sep + 3] ?? "").split(","),
    });
  }
  return out;
}

/** /proc/self/cgroup: controller ("" for v2) → own path. */
export function parseProcCgroup(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) {
      continue;
    }
    const controllers = line.slice(first + 1, second);
    const path = line.slice(second + 1).trim();
    if (controllers === "") {
      out.set("", path);
      continue;
    }
    for (const c of controllers.split(",")) {
      out.set(c, path);
    }
  }
  return out;
}

const ID_64 = /^(?:docker-|cri-containerd-|crio-|libpod-)?([0-9a-f]{64})$/;
const ID_ECS = /^([0-9a-f]{32}-\d+)$/;

/**
 * The container id one /proc/self/cgroup line names, or null: a 64-hex id
 * (with a docker-/cri-containerd-/crio-/libpod- prefix and .scope suffix, or
 * a bare path segment) or ECS `<32hex>-<digits>`. `crio-conmon-*` is the
 * runtime's monitor process, never the container.
 */
export function containerIdFromCgroupLine(line: string): string | null {
  const second = line.indexOf(":", line.indexOf(":") + 1);
  const path = second >= 0 ? line.slice(second + 1).trim() : line.trim();
  let found: string | null = null;
  for (const raw of path.split("/")) {
    const segment = raw.replace(/\.scope$/, "");
    if (segment.startsWith("crio-conmon-")) {
      continue;
    }
    const m = ID_64.exec(segment) ?? ID_ECS.exec(segment);
    if (m) {
      found = m[1];
    }
  }
  return found;
}

/** kubelet's per-container-start file: `…/pods/<uid>/containers/<name>/<suffix>`. */
const KUBELET_CONTAINER =
  /\/pods\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/containers\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\/([0-9A-Za-z]+)$/;

/**
 * `{ podUid, name, suffix }` when a mount root is kubelet's per-container file
 * (`/dev/termination-log` or the pod's `terminationMessagePath`), else null.
 */
export function kubeletContainerFromMountRoot(root: string): { podUid: string; name: string; suffix: string } | null {
  const m = KUBELET_CONTAINER.exec(root);
  return m ? { podUid: m[1], name: m[2], suffix: m[3] } : null;
}

/**
 * The container id in mountinfo (cgroup v2 with a cgroup namespace hides it
 * from /proc/self/cgroup): the runtime bind-mounts files from
 * `…/containers/<id>/` (hostname, resolv.conf). `sandboxes/<id>` is the pod
 * sandbox (one per pod), never this container.
 *
 * Failing that (containerd + cgroup v2 Kubernetes, where hostname and
 * resolv.conf come from the sandbox), kubelet's termination-log mount: its
 * root `…/pods/<uid>/containers/<name>/<suffix>` gets a new suffix on every
 * container start and is shared by every process in it, so the id is
 * `k8s:<uid>/<name>/<suffix>`.
 */
export function containerIdFromMountinfo(text: string | null): string | null {
  const roots = (text ?? "").split("\n").map((line) => line.trim().split(" ")[3] ?? "");
  for (const root of roots) {
    const m = /\/(?:containers|overlay-containers)\/([0-9a-f]{64})(?:\/|$)/.exec(root);
    if (m) {
      return m[1];
    }
  }
  for (const root of roots) {
    const k = kubeletContainerFromMountRoot(unescape(root));
    if (k) {
      return `k8s:${k.podUid}/${k.name}/${k.suffix}`;
    }
  }
  return null;
}

/** The container id from /proc/self/cgroup, else mountinfo. */
export function containerId(reader: Reader): string | null {
  for (const line of (reader.text("/proc/self/cgroup") ?? "").split("\n")) {
    const id = line.trim() ? containerIdFromCgroupLine(line) : null;
    if (id) {
      return id;
    }
  }
  return containerIdFromMountinfo(reader.text("/proc/self/mountinfo"));
}

/** Number of CPUs in a cpuset list (`0-3,6`), or null. */
export function cpusetCount(text: string | null): number | null {
  const raw = (text ?? "").trim();
  if (!raw) {
    return null;
  }
  let n = 0;
  for (const part of raw.split(",")) {
    const [a, b] = part.split("-").map((x) => Number.parseInt(x, 10));
    if (!Number.isFinite(a)) {
      return null;
    }
    n += Number.isFinite(b) ? Math.max(b - a + 1, 0) : 1;
  }
  return n > 0 ? n : null;
}

function join(a: string, b: string): string {
  const out = `${a}/${b}`.replace(/\/+/g, "/");
  return out.length > 1 ? out.replace(/\/$/, "") : out;
}

function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** The process's cgroup directory under `mount`, and its ancestors up to the mount point. */
function cgroupDirs(reader: Reader, mount: Mount, ownPath: string | undefined): string[] {
  const own = ownPath ?? "/";
  let rel = "";
  if (mount.root === "/") {
    rel = own;
  } else if (own === mount.root || own.startsWith(`${mount.root}/`)) {
    rel = own.slice(mount.root.length);
  }
  let leaf = join(mount.mountpoint, rel || "/");
  if (!reader.isDir(leaf)) {
    leaf = mount.mountpoint;
  }
  const dirs = [leaf];
  let dir = leaf;
  while (dir !== mount.mountpoint && dir.startsWith(mount.mountpoint) && dir !== "/") {
    dir = parent(dir);
    dirs.push(dir);
  }
  return dirs;
}

const nul = (v: number | undefined): number | null => (v === undefined ? null : v);

function minOf(values: Array<number | undefined>): number | undefined {
  const real = values.filter((v): v is number => v !== undefined);
  return real.length > 0 ? Math.min(...real) : undefined;
}

function memoryLimit(raw: number | undefined, hostMemTotal: number | undefined): number | undefined {
  if (raw === undefined || raw <= 0 || raw >= NO_LIMIT_BYTES) {
    return undefined;
  }
  if (hostMemTotal !== undefined && hostMemTotal > 0 && raw >= hostMemTotal) {
    return undefined;
  }
  return raw;
}

function limitCores(quota: number | undefined, cpuset: number | null, hostCores: number | undefined): number | null {
  if (quota === undefined) {
    return null;
  }
  return Math.min(quota, cpuset ?? Number.POSITIVE_INFINITY, hostCores ?? Number.POSITIVE_INFINITY);
}

function workingSet(current: number | undefined, inactive: number | undefined): number | null {
  if (current === undefined || inactive === undefined) {
    return null;
  }
  return Math.max(current - inactive, 0);
}

function v2Cpu(reader: Reader, dirs: string[], hostCores: number | undefined): CgroupCpu {
  const quotas = dirs.map((dir) => {
    const [quota, period] = (reader.text(join(dir, "cpu.max")) ?? "").trim().split(/\s+/);
    const q = Number(quota);
    const p = Number(period);
    return quota !== "max" && q > 0 && p > 0 ? q / p : undefined;
  });
  const stat = keyValues(reader.text(join(dirs[0], "cpu.stat")));
  const cpuset = cpusetCount(reader.text(join(dirs[0], "cpuset.cpus.effective")));
  return {
    limit_cores: limitCores(minOf(quotas), cpuset, hostCores),
    usage_us: nul(stat.get("usage_usec")),
    nr_periods: nul(stat.get("nr_periods")),
    nr_throttled: nul(stat.get("nr_throttled")),
    throttled_us: nul(stat.get("throttled_usec")),
    cpuset_cores: cpuset,
  };
}

function v2Memory(reader: Reader, dirs: string[], hostMemTotal: number | undefined): CgroupMemory {
  const leaf = dirs[0];
  const limit = minOf(dirs.map((dir) => memoryLimit(numberIn(reader.text(join(dir, "memory.max"))), hostMemTotal)));
  const current = numberIn(reader.text(join(leaf, "memory.current")));
  const stat = keyValues(reader.text(join(leaf, "memory.stat")));
  const events = keyValues(reader.text(join(leaf, "memory.events")));
  return {
    limit: nul(limit),
    current: nul(current),
    working_set: workingSet(current, stat.get("inactive_file")),
    anon: nul(stat.get("anon")),
    file: nul(stat.get("file")),
    swap: nul(numberIn(reader.text(join(leaf, "memory.swap.current")))),
    oom_kill: nul(events.get("oom_kill")),
  };
}

function v1Cpu(
  reader: Reader,
  cpuDirs: string[],
  acctDir: string | undefined,
  cpusetDir: string | undefined,
  hostCores: number | undefined,
): CgroupCpu {
  const quotas = cpuDirs.map((dir) => {
    const q = numberIn(reader.text(join(dir, "cpu.cfs_quota_us")));
    const p = numberIn(reader.text(join(dir, "cpu.cfs_period_us")));
    return q !== undefined && p !== undefined && q > 0 && p > 0 ? q / p : undefined;
  });
  const stat = keyValues(reader.text(join(cpuDirs[0], "cpu.stat")));
  const usageNs = acctDir === undefined ? undefined : numberIn(reader.text(join(acctDir, "cpuacct.usage")));
  const throttledNs = stat.get("throttled_time");
  const cpuset = cpusetDir === undefined ? null : cpusetCount(reader.text(join(cpusetDir, "cpuset.cpus")));
  return {
    limit_cores: limitCores(minOf(quotas), cpuset, hostCores),
    usage_us: usageNs === undefined ? null : usageNs / 1000,
    nr_periods: nul(stat.get("nr_periods")),
    nr_throttled: nul(stat.get("nr_throttled")),
    throttled_us: throttledNs === undefined ? null : throttledNs / 1000,
    cpuset_cores: cpuset,
  };
}

function v1Memory(reader: Reader, dirs: string[], hostMemTotal: number | undefined): CgroupMemory {
  const leaf = dirs[0];
  const limit = minOf(
    dirs.map((dir) => memoryLimit(numberIn(reader.text(join(dir, "memory.limit_in_bytes"))), hostMemTotal)),
  );
  const current = numberIn(reader.text(join(leaf, "memory.usage_in_bytes")));
  const stat = keyValues(reader.text(join(leaf, "memory.stat")));
  const memsw = numberIn(reader.text(join(leaf, "memory.memsw.usage_in_bytes")));
  const oom = keyValues(reader.text(join(leaf, "memory.oom_control")));
  return {
    limit: nul(limit),
    current: nul(current),
    working_set: workingSet(current, stat.get("total_inactive_file") ?? stat.get("inactive_file")),
    anon: nul(stat.get("total_rss") ?? stat.get("rss")),
    file: nul(stat.get("total_cache") ?? stat.get("cache")),
    swap: memsw !== undefined && current !== undefined ? Math.max(memsw - current, 0) : null,
    oom_kill: nul(oom.get("oom_kill")),
  };
}

/** One reading of the process's cgroup (D3–D5). */
export function readCgroup(options: CgroupOptions = {}): CgroupSnapshot {
  const reader = options.reader ?? fileReader(options.root ?? "");
  const mounts = parseMountinfo(reader.text("/proc/self/mountinfo"));
  const own = parseProcCgroup(reader.text("/proc/self/cgroup"));
  const v1 = (controller: string): Mount | undefined =>
    mounts.find((m) => m.fstype === "cgroup" && m.options.includes(controller));
  const v2 = mounts.find((m) => m.fstype === "cgroup2");

  const memV1 = v1("memory");
  const cpuV1 = v1("cpu");
  const none: CgroupSnapshot = { limit_source: "none", container_id: null, cpu: null, memory: null };
  if (!memV1 && !cpuV1 && !v2) {
    return none;
  }
  const v2Dirs = v2 ? cgroupDirs(reader, v2, own.get("")) : undefined;

  let cpu: CgroupCpu | null = null;
  if (cpuV1) {
    const acct = v1("cpuacct");
    const cpuset = v1("cpuset");
    cpu = v1Cpu(
      reader,
      cgroupDirs(reader, cpuV1, own.get("cpu")),
      acct ? cgroupDirs(reader, acct, own.get("cpuacct"))[0] : undefined,
      cpuset ? cgroupDirs(reader, cpuset, own.get("cpuset"))[0] : undefined,
      options.hostCores,
    );
  } else if (v2Dirs) {
    cpu = v2Cpu(reader, v2Dirs, options.hostCores);
  }

  let memory: CgroupMemory | null = null;
  if (memV1) {
    memory = v1Memory(reader, cgroupDirs(reader, memV1, own.get("memory")), options.hostMemTotal);
  } else if (v2Dirs) {
    memory = v2Memory(reader, v2Dirs, options.hostMemTotal);
  }

  return {
    limit_source: memV1 || cpuV1 ? "cgroup_v1" : "cgroup_v2",
    container_id: containerId(reader),
    cpu,
    memory,
  };
}
