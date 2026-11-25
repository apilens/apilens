/**
 * cgroup reader (C3, #1108): the shared fixture table of the Python and Java
 * SDKs (testdata/cgroup), with host cores injected as 8.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import "../../src/node.js";
import {
  containerIdFromCgroupLine,
  containerIdFromMountinfo,
  cpusetCount,
  readCgroup,
} from "../../src/resources/cgroup.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../testdata/cgroup");
const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as {
  cases: Record<string, Record<string, unknown>>;
};
const ids = JSON.parse(readFileSync(join(FIXTURES, "container_ids.json"), "utf8")) as {
  cases: Record<string, [string, string | null]>;
};

/** The reader's snapshot in the fixture's shape (the fixture has no cpuset). */
function shape(root: string) {
  const s = readCgroup({ root, hostCores: 8 });
  const cpu = s.cpu ? (({ cpuset_cores: _, ...rest }) => rest)(s.cpu) : null;
  return { limit_source: s.limit_source, container_id: s.container_id, cpu, memory: s.memory };
}

describe("cgroup fixture table", () => {
  for (const [name, want] of Object.entries(expected.cases)) {
    it(name, () => {
      const { note: _, ...rest } = want;
      expect(shape(join(FIXTURES, name, "root"))).toEqual(rest);
    });
  }

  it("a missing file makes only its own fields null", () => {
    const dir = mkdtempSync(join(tmpdir(), "apilens-cgroup-"));
    try {
      cpSync(join(FIXTURES, "v2_namespaced_limited", "root"), dir, { recursive: true });
      rmSync(join(dir, "sys/fs/cgroup/memory.stat"));
      rmSync(join(dir, "sys/fs/cgroup/cpu.max"));
      const s = readCgroup({ root: dir, hostCores: 8 });
      expect(s.memory).toMatchObject({ current: 503316480, anon: null, file: null, working_set: null, limit: 536870912 });
      expect(s.cpu).toMatchObject({ limit_cores: null, usage_us: 123456789, nr_throttled: 180 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a root that does not exist reads as no cgroup", () => {
    expect(readCgroup({ root: "/nonexistent/apilens" })).toEqual({
      limit_source: "none", container_id: null, cpu: null, memory: null,
    });
  });

  it("caps the quota at the host cores", () => {
    const s = readCgroup({ root: join(FIXTURES, "v1_docker", "root"), hostCores: 1 });
    expect(s.cpu?.limit_cores).toBe(1);
  });

  it("drops a memory limit at or above the host's memory", () => {
    const s = readCgroup({ root: join(FIXTURES, "hybrid_v1_controllers", "root"), hostMemTotal: 1 << 30 });
    expect(s.memory?.limit).toBeNull();
  });
});

describe("container id table", () => {
  for (const [name, [line, want]] of Object.entries(ids.cases)) {
    it(name, () => {
      expect(containerIdFromCgroupLine(line)).toBe(want);
    });
  }
});

describe("containerIdFromMountinfo", () => {
  const sandbox = `1 2 259:1 /var/lib/containerd/io.containerd.grpc.v1.cri/sandboxes/${"a".repeat(64)}/hostname /etc/hostname rw - ext4 /dev/root rw`;
  const term =
    "4 2 259:1 /var/lib/kubelet/pods/8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/containers/app/5f2c9e1a /dev/termination-log rw - ext4 /dev/root rw";
  const real = `3 2 259:1 /var/lib/docker/containers/${"b".repeat(64)}/resolv.conf /etc/resolv.conf rw - ext4 /dev/root rw`;
  const k8s = "k8s:8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/app/5f2c9e1a";

  it("never takes a sandbox id", () => {
    expect(containerIdFromMountinfo(sandbox)).toBeNull();
  });
  it("falls back to the termination-log mount, at any mount point", () => {
    expect(containerIdFromMountinfo(`${sandbox}\n${term}`)).toBe(k8s);
    expect(containerIdFromMountinfo(term.replace("/dev/termination-log", "/tmp/msg"))).toBe(k8s);
  });
  it("prefers a containers/<id> mount", () => {
    expect(containerIdFromMountinfo(`${term}\n${real}`)).toBe("b".repeat(64));
  });
  it("ignores pod-level kubelet files", () => {
    const hosts = "5 2 259:1 /var/lib/kubelet/pods/8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/etc-hosts /etc/hosts rw - ext4 /dev/root rw";
    expect(containerIdFromMountinfo(hosts)).toBeNull();
  });
});

describe("cpusetCount", () => {
  it("counts ranges and singles", () => {
    expect(cpusetCount("0-3,6\n")).toBe(5);
    expect(cpusetCount("")).toBeNull();
    expect(cpusetCount(null)).toBeNull();
  });
});
