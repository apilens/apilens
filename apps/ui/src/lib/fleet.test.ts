import { describe, expect, it } from "vitest";
import { balanceLine, buildFleet, defaultEnvironment, describeFleet, fleetEnvironments, fleetMode, median, unitKey } from "./fleet";
import type { AppInstance, InstanceEvent } from "./identity";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function inst(over: Partial<AppInstance> & { instance_id: string }): AppInstance {
  return {
    environment: "production",
    status: "reporting",
    sdk_name: "apilenss",
    sdk_version: "0.5.0",
    runtime: "python 3.12.7",
    release: "r1",
    commit: "",
    pid: 1,
    stats: {},
    first_seen_at: "2026-11-25T08:00:00Z",
    last_seen_at: "2026-11-25T10:00:00Z",
    platform: "k8s",
    hostname: "",
    hostname_guess: false,
    container_id: "",
    pod_name: "",
    node_name: "",
    region: "",
    uptime_s: 3600,
    ended_at: null,
    ended_reason: "",
    resources: null,
    spark: null,
    requests: null,
    signals: [],
    ...over,
  } as AppInstance;
}

const res = (over: Partial<NonNullable<AppInstance["resources"]>> = {}) =>
  ({
    limit_source: "cgroup_v2",
    cpu_pct: null,
    cpu_cores: null,
    cpu_limit_cores: null,
    mem_working_set: null,
    mem_rss: null,
    mem_pss: null,
    mem_limit: null,
    mem_pct: null,
    throttled_ratio: null,
    runtime: null,
    ...over,
  }) as NonNullable<AppInstance["resources"]>;

/** Two gunicorn workers per pod, pods on two nodes. */
function pod(name: string, node: string, cid: string, ws: number, cores: [number, number], rpm: [number, number], p95: [number, number]): AppInstance[] {
  return [0, 1].map((k) =>
    inst({
      instance_id: `${name}-w${k}`,
      pid: 8 + k,
      pod_name: name,
      hostname: name,
      node_name: node,
      container_id: cid,
      resources: res({ cpu_cores: cores[k], cpu_limit_cores: 1, mem_working_set: ws, mem_rss: 300 * MiB, mem_pss: 200 * MiB, mem_limit: GiB, throttled_ratio: 0.02 }),
      requests: { rpm: rpm[k], p95_ms: p95[k], error_pct: 0.5 },
    }),
  );
}

describe("buildFleet", () => {
  it("folds forked workers into their pod: working set once, cores and requests added, slowest worker's p95", () => {
    const units = buildFleet([...pod("api-a", "n1", "c-a", 400 * MiB, [0.2, 0.3], [100, 100], [120, 180]), ...pod("api-b", "n2", "c-b", 420 * MiB, [0.25, 0.25], [100, 100], [110, 130])], "production", null);
    expect(units).toHaveLength(2);
    const a = units.find((u) => u.name === "api-a");
    expect(a?.workers).toHaveLength(2);
    expect(a?.memBytes).toBe(400 * MiB); // never 800: the working set is the container's, shared by both workers
    expect(a?.memOf).toBe("working_set");
    expect(a?.memPct).toBeCloseTo((400 / 1024) * 100);
    expect(a?.cpuCores).toBeCloseTo(0.5);
    expect(a?.cpuPct).toBeCloseTo(50);
    expect(a?.rpm).toBe(200);
    expect(a?.p95).toBe(180);
    expect(a?.share).toBeCloseTo(0.5);
    expect(a?.findings).toEqual([]);
    expect(describeFleet(units)).toBe("2 pods on 2 nodes · 4 workers");
    expect(balanceLine(units)).toEqual({ even: true, text: "Traffic is spread evenly across 2." });
  });

  it("names the VM behind a load balancer that takes too much traffic and is slow, and sorts it first", () => {
    const vm = (host: string, rpm: number, p95: number, cores: number) =>
      [0, 1].map((k) =>
        inst({
          instance_id: `${host}-${k}`,
          platform: "vm",
          hostname: host,
          resources: res({ limit_source: "host", cpu_cores: cores, cpu_limit_cores: 4, mem_pss: 300 * MiB, mem_rss: 400 * MiB, mem_limit: 8 * GiB }),
          requests: { rpm, p95_ms: p95, error_pct: 0 },
        }),
      );
    const units = buildFleet([...vm("orders-vm-1", 50, 120, 0.4), ...vm("orders-vm-2", 50, 130, 0.4), ...vm("orders-vm-3", 200, 480, 1.7)], "production", null);
    expect(units[0].name).toBe("orders-vm-3");
    expect(units[0].kind).toBe("vm");
    expect(units[0].memOf).toBe("pss");
    expect(units[0].memBytes).toBe(600 * MiB);
    expect(units[0].cpuOf).toBe("host");
    expect(units[0].findings.map((f) => f.key)).toEqual(["cpu", "share", "slow"]);
    expect(units[0].findings.find((f) => f.key === "share")?.label).toBe("2.0× its share of traffic");
    expect(units[1].findings).toEqual([]); // low only because vm-3 takes the excess
    expect(describeFleet(units)).toBe("3 hosts behind a load balancer · 6 workers");
    expect(balanceLine(units)).toEqual({ even: false, text: "orders-vm-3 takes 67% of requests; even would be 33%." });
  });

  it("names a starved unit when the rest are even", () => {
    const one = (host: string, rpm: number) => inst({ instance_id: host, platform: "vm", hostname: host, requests: { rpm, p95_ms: 100, error_pct: 0 } });
    const units = buildFleet([one("a", 100), one("b", 100), one("c", 100), one("d", 10)], "production", null);
    expect(units.find((u) => u.name === "d")?.findings.map((f) => f.label)).toEqual(["Little traffic"]);
    expect(units.filter((u) => u.name !== "d").every((u) => u.findings.length === 0)).toBe(true);
  });

  it("flags memory near the limit and OOM kills from the events, and keeps environments apart", () => {
    // One OOM kill took both of the pod's workers: one event to the operator.
    const events: InstanceEvent[] = ["gone-1", "gone-2"].map((id) => ({ kind: "oom" as const, at: "2026-11-25T09:00:12Z", environment: "production", instance_id: id, container_id: "c-b1", pod_name: "api-b", details: null }));
    const instances = [...pod("api-a", "n1", "c-a", 960 * MiB, [0.2, 0.2], [10, 10], [100, 100]), ...pod("api-b", "n1", "c-b2", 300 * MiB, [0.2, 0.2], [10, 10], [100, 100]), inst({ instance_id: "stg", environment: "staging", hostname: "stg-1" })];
    const units = buildFleet(instances, "production", events);
    expect(units.map((u) => u.name)).toEqual(["api-b", "api-a"]); // an OOM kill outranks memory pressure
    expect(units[0].findings[0]).toMatchObject({ key: "oom", tone: "critical", label: "OOM killed" });
    expect(units[1].findings[0]).toMatchObject({ key: "mem", tone: "critical", label: "Memory 94% of limit" });
    expect(units.some((u) => u.name === "stg-1")).toBe(false);
  });

  it("leaves what was not measured empty, never zero", () => {
    const units = buildFleet([inst({ instance_id: "old", hostname: "box-1", platform: "" })], "production", null);
    expect(units[0]).toMatchObject({ unmeasured: true, cpuPct: null, memBytes: null, rpm: null, share: null });
  });
});

describe("fleet modes and scope", () => {
  it("picks the layout from the fleet", () => {
    expect(fleetMode([])).toBe("empty");
    const one = buildFleet(pod("api-a", "n1", "c-a", 1, [0.1, 0.1], [1, 1], [1, 1]), "production", null);
    expect(fleetMode(one)).toBe("single");
    const mixed = buildFleet([...pod("api-a", "n1", "c-a", 1, [0.1, 0.1], [100, 100], [1, 1]), ...pod("api-b", "n2", "c-b", 1, [0.1, 0.1], [100, 100], [1, 1]), inst({ instance_id: "l1", platform: "lambda", requests: { rpm: 5, p95_ms: 1, error_pct: 0 } })], "production", null);
    expect(describeFleet(mixed)).toBe("2 pods on 2 nodes · 4 workers · plus 1 serverless instance");
    expect(mixed.find((u) => u.serverless)).toMatchObject({ share: null, findings: [] }); // not part of the load-balanced fleet
    const lambdas = buildFleet([inst({ instance_id: "l1", platform: "lambda", hostname: "169.254.1.1", hostname_guess: true }), inst({ instance_id: "l2", platform: "lambda" })], "production", null);
    expect(lambdas).toHaveLength(2); // serverless instances are never folded together
    expect(fleetMode(lambdas)).toBe("serverless");
  });

  it("opens on production, lists it first and never offers a mix of environments", () => {
    const xs = [inst({ instance_id: "a", environment: "staging" }), inst({ instance_id: "b", environment: "staging" }), inst({ instance_id: "c", environment: "production" })];
    expect(defaultEnvironment(xs)).toBe("production");
    expect(fleetEnvironments(xs)).toEqual(["production", "staging"]);
    expect(defaultEnvironment([inst({ instance_id: "a", environment: "staging" })])).toBe("staging");
  });

  it("keys a process by container, then a real hostname, then itself", () => {
    expect(unitKey(inst({ instance_id: "x", container_id: "c1", hostname: "h" }))).toBe("c:c1");
    expect(unitKey(inst({ instance_id: "x", hostname: "h", platform: "vm" }))).toBe("h:h");
    expect(unitKey(inst({ instance_id: "x", hostname: "h", hostname_guess: true }))).toBe("p:x");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});
