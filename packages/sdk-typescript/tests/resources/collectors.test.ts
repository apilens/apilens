/**
 * Collectors: process CPU and memory (C2, #1107), Node runtime (C5, #1110),
 * DB pools (C6, #1111) and the process list (C7, #1112).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import "../../src/node.js";
import { instrumentMysql2, instrumentPg } from "../../src/db.js";
import { fileReader } from "../../src/resources/fs.js";
import { NodeRuntimeCollector } from "../../src/resources/node-runtime.js";
import { PoolsCollector, resetPools } from "../../src/resources/pools.js";
import {
  ProcessCpuCollector,
  ProcessMemoryCollector,
  ProcessPssCollector,
  normalizeConstrainedMemory,
} from "../../src/resources/process.js";
import { MAX_PROCESSES, ProcessListCollector } from "../../src/resources/processes.js";
import { ResourceSampler } from "../../src/resources/sampler.js";
import type { ResourcesBlock, SampleContext } from "../../src/resources/types.js";

function ctx(overrides: Partial<SampleContext> = {}): SampleContext {
  return {
    nowMs: performance.now(),
    gap: false,
    slow: true,
    cgroup: () => null,
    limitCores: () => 4,
    flag: () => {},
    ...overrides,
  };
}

const empty = (): ResourcesBlock => ({ v: 1, capabilities: [], flags: [] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function busy(ms: number): void {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) {
    x += Math.sqrt(x + 1);
  }
}

describe("process CPU and memory (C2)", () => {
  it("a CPU burn shows cores_used close to 1", () => {
    const cpu = new ProcessCpuCollector();
    cpu.sample(ctx());
    busy(300);
    cpu.sample(ctx());
    const out = empty();
    cpu.drain(out);
    const cores = out.process?.cpu?.cores_used?.last ?? 0;
    expect(cores).toBeGreaterThan(0.6);
    expect(cores).toBeLessThan(1.6);
    // Against a 4-core limit.
    expect(out.process?.cpu?.pct_of_limit?.last).toBeCloseTo((cores / 4) * 100, 0);
  });

  it("the first CPU sample is only a baseline", () => {
    const cpu = new ProcessCpuCollector();
    cpu.sample(ctx());
    const out = empty();
    cpu.drain(out);
    expect(out.process).toBeUndefined();
  });

  it("RSS every sample", () => {
    const mem = new ProcessMemoryCollector(fileReader("/nonexistent"), false);
    mem.sample();
    mem.sample();
    const out = empty();
    mem.drain(out);
    expect(out.process?.memory?.rss?.last).toBeGreaterThan(1 << 20);
    // Not Linux here: no threads or fds rather than zeros.
    expect(out.process?.threads).toBeUndefined();
    expect(out.process?.fds).toBeUndefined();
  });

  it("reads threads, fds, PSS and USS from /proc/self (Linux)", () => {
    const root = mkdtempSync(join(tmpdir(), "apilens-proc-"));
    try {
      mkdirSync(join(root, "proc/self/fd"), { recursive: true });
      for (const fd of ["0", "1", "2", "7"]) {
        writeFileSync(join(root, "proc/self/fd", fd), "");
      }
      writeFileSync(join(root, "proc/self/status"), "Name:\tnode\nThreads:\t11\n");
      writeFileSync(join(root, "proc/self/smaps_rollup"), "Rss: 2048 kB\nPss: 1024 kB\nPrivate_Clean: 100 kB\nPrivate_Dirty: 400 kB\n");
      const mem = new ProcessMemoryCollector(fileReader(root), true);
      const pss = new ProcessPssCollector(fileReader(root), true);
      mem.sample();
      pss.sample(ctx());
      const out = empty();
      mem.drain(out);
      pss.drain(out);
      expect(out.process?.threads?.last).toBe(11);
      expect(out.process?.fds?.last).toBe(4);
      expect(out.process?.memory?.pss?.last).toBe(1024 * 1024);
      expect(out.process?.memory?.uss?.last).toBe(500 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns PSS off after the first failed read", () => {
    const pss = new ProcessPssCollector(fileReader("/nonexistent"), true);
    expect(pss.available()).toBe(true);
    pss.sample(ctx());
    expect(pss.active()).toBe(false);
    expect(pss.available()).toBe(false);
  });

  it("constrainedMemory sentinels are null", () => {
    const host = 16 * 2 ** 30;
    expect(normalizeConstrainedMemory(0, host)).toBeNull();
    expect(normalizeConstrainedMemory(undefined, host)).toBeNull();
    expect(normalizeConstrainedMemory(2 ** 64 - 1, host)).toBeNull();
    expect(normalizeConstrainedMemory(9223372036854771712, host)).toBeNull();
    expect(normalizeConstrainedMemory(32 * 2 ** 30, host)).toBeNull();
    expect(normalizeConstrainedMemory(512 * 2 ** 20, host)).toBe(512 * 2 ** 20);
  });

  const bun = (globalThis as { Bun?: unknown }).Bun;
  it.runIf(Boolean(bun))("Bun smoke: process collectors measure", () => {
    const cpu = new ProcessCpuCollector();
    expect(cpu.available()).toBe(true);
  });
});

describe("Node runtime (C5)", () => {
  it("blocking the loop for 200 ms shows max >= 200", async () => {
    const rt = new NodeRuntimeCollector();
    rt.sample(ctx());
    await sleep(60);
    busy(200);
    await sleep(60);
    const out = empty();
    rt.drain(out);
    rt.stop();
    const delay = out.runtime?.node?.event_loop_delay_ms;
    expect(delay?.max).toBeGreaterThanOrEqual(200);
    expect(delay?.p50).toBeGreaterThan(0);
  });

  it("resets the histogram every window", async () => {
    const rt = new NodeRuntimeCollector();
    rt.sample(ctx());
    await sleep(40);
    busy(150);
    await sleep(40);
    rt.drain(empty());
    await sleep(100);
    const out = empty();
    rt.drain(out);
    rt.stop();
    expect(out.runtime?.node?.event_loop_delay_ms?.max ?? 0).toBeLessThan(150);
  });

  it("discards the first ELU snapshot (it is cumulative since start)", async () => {
    const rt = new NodeRuntimeCollector();
    rt.sample(ctx({ slow: false }));
    const first = empty();
    rt.drain(first);
    expect(first.runtime?.node?.elu).toBeUndefined();
    await sleep(20);
    rt.sample(ctx({ slow: false }));
    const second = empty();
    rt.drain(second);
    rt.stop();
    const elu = second.runtime?.node?.elu?.last;
    expect(elu).toBeGreaterThanOrEqual(0);
    expect(elu).toBeLessThanOrEqual(1);
  });

  it("the full memoryUsage only on slow samples", () => {
    const rt = new NodeRuntimeCollector();
    rt.sample(ctx({ slow: false }));
    const fast = empty();
    rt.drain(fast);
    expect(fast.runtime?.node?.heap_used).toBeUndefined();
    rt.sample(ctx({ slow: true }));
    const slow = empty();
    rt.drain(slow);
    rt.stop();
    expect(slow.runtime?.node?.heap_used?.last).toBeGreaterThan(0);
    expect(slow.runtime?.node?.heap_total?.last).toBeGreaterThan(0);
    expect(slow.runtime?.node?.external?.last).toBeGreaterThan(0);
  });

  it("counts GC entries", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const rt = new NodeRuntimeCollector();
    rt.sample(ctx());
    gc();
    gc();
    await sleep(50);
    const out = empty();
    rt.drain(out);
    rt.stop();
    const stats = out.runtime?.node?.gc;
    expect(stats?.count).toBeGreaterThanOrEqual(1);
    expect(stats?.pause_ms_sum).toBeGreaterThan(0);
    expect(stats?.pause_ms_max).toBeLessThanOrEqual(stats?.pause_ms_sum ?? 0);
  });

  it("a runtime without perf_hooks reports only what it has", () => {
    const rt = new NodeRuntimeCollector({});
    rt.sample(ctx());
    const out = empty();
    rt.drain(out);
    expect(out.runtime?.node?.event_loop_delay_ms).toBeUndefined();
    expect(out.runtime?.node?.gc).toBeUndefined();
    expect(out.runtime?.node?.heap_used).toBeDefined();
  });
});

describe("DB pools (C6)", () => {
  afterEach(() => resetPools());

  class FakePgPool {
    totalCount = 5;
    idleCount = 2;
    waitingCount = 1;
    options = { max: 10, database: "shop" };
    connect(): string {
      return "conn";
    }
  }

  class FakeMysqlPool {
    _allConnections = [1, 2, 3, 4];
    _freeConnections = { length: 1 };
    _connectionQueue = { length: 2 };
    config = { connectionLimit: 8, connectionConfig: { database: "orders" } };
    getConnection(cb: (e: null, c: string) => void): void {
      cb(null, "conn");
    }
  }

  it("reports a pg.Pool and a mysql2 pool found by the driver hooks", () => {
    instrumentPg({ Client: class { query() {} }, Pool: FakePgPool });
    instrumentMysql2({ Connection: class { query() {} execute() {} }, Pool: FakeMysqlPool });
    const pg = new FakePgPool();
    expect(pg.connect()).toBe("conn");
    let got = "";
    new FakeMysqlPool().getConnection((_, c) => {
      got = c;
    });
    expect(got).toBe("conn");

    const pools = new PoolsCollector();
    expect(pools.active()).toBe(true);
    pools.sample();
    pg.idleCount = 0;
    pools.sample();
    const out = empty();
    pools.drain(out);
    expect(out.pools).toEqual([
      { name: "shop", kind: "pg", used: { min: 3, avg: 4, max: 5, last: 5 }, idle: 0, max: 10, pending: { min: 1, avg: 1, max: 1, last: 1 } },
      { name: "orders", kind: "mysql2", used: { min: 3, avg: 3, max: 3, last: 3 }, idle: 1, max: 8, pending: { min: 2, avg: 2, max: 2, last: 2 } },
    ]);
  });

  it("no pool: no pools key and no capability", () => {
    const sampler = new ResourceSampler({ timers: false, linux: false, collectors: [new PoolsCollector()] });
    sampler.start();
    const block = sampler.drain();
    expect(block).not.toHaveProperty("pools");
    expect(block?.capabilities).toEqual([]);
  });
});

describe("process list (C7)", () => {
  let root = "";

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function proc(pid: number, opts: { cgroup?: string; rssKb?: number; name?: string; ppid?: number; ticks?: number } = {}) {
    const dir = join(root, "proc", String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cgroup"), opts.cgroup ?? "0::/app\n");
    writeFileSync(join(dir, "status"), `Name:\t${opts.name ?? "node"}\nPPid:\t${opts.ppid ?? 1}\nVmRSS:\t${opts.rssKb ?? 1000} kB\n`);
    const t = opts.ticks ?? 0;
    writeFileSync(join(dir, "stat"), `${pid} (${opts.name ?? "node"}) S ${opts.ppid ?? 1} 1 1 0 -1 0 0 0 0 0 ${t} 0 0 0 20 0 1 0 100 0 0`);
    // What the collector must never read.
    writeFileSync(join(dir, "cmdline"), "node\0server.js\0--password=s3cr3t\0");
    writeFileSync(join(dir, "environ"), "DB_PASSWORD=s3cr3t\0");
  }

  function setup(): void {
    root = mkdtempSync(join(tmpdir(), "apilens-procs-"));
    mkdirSync(join(root, "proc/self"), { recursive: true });
    writeFileSync(join(root, "proc/self/cgroup"), "0::/app\n");
    mkdirSync(join(root, "proc/1"), { recursive: true });
  }

  it("keeps our cgroup's processes, never argv or env, top by RSS", () => {
    setup();
    proc(1, { name: "tini", rssKb: 500, ppid: 0 });
    proc(7, { name: "node", rssKb: 90_000, ticks: 100 });
    proc(8, { name: "a-very-long-process-name", rssKb: 2_000 });
    proc(9, { name: "sidecar", rssKb: 99_999, cgroup: "0::/other\n" });
    const list = new ProcessListCollector(fileReader(root), true);
    let t = 1000;
    list.sample(ctx({ nowMs: t }));
    writeFileSync(join(root, "proc/7/stat"), "7 (node) S 1 1 1 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 100 0 0");
    t += 10_000;
    list.sample(ctx({ nowMs: t }));
    const out = empty();
    list.drain(out);
    const json = JSON.stringify(out);
    expect(json).not.toContain("s3cr3t");
    expect(json).not.toContain("server.js");
    expect(out.processes?.map((p) => p.pid)).toEqual([7, 8, 1]);
    expect(out.processes?.[0]).toEqual({ pid: 7, ppid: 1, comm: "node", rss: 90_000 * 1024, cpu_pct: 10 });
    expect(out.processes?.[1].comm).toBe("a-very-long-pro");
    expect(out.processes?.[1].comm.length).toBeLessThanOrEqual(15);
  });

  it(`caps the list at ${MAX_PROCESSES}`, () => {
    setup();
    for (let pid = 2; pid < 30; pid += 1) {
      proc(pid, { rssKb: pid * 10 });
    }
    const list = new ProcessListCollector(fileReader(root), true);
    list.sample(ctx());
    const out = empty();
    list.drain(out);
    expect(out.processes).toHaveLength(MAX_PROCESSES);
    expect(out.processes?.[0].pid).toBe(29);
  });

  it("turns off on a host PID namespace, with a flag", () => {
    setup();
    writeFileSync(join(root, "proc/1/comm"), "systemd\n");
    for (let pid = 2; pid < 505; pid += 1) {
      mkdirSync(join(root, "proc", String(pid)));
    }
    const flags: string[] = [];
    const list = new ProcessListCollector(fileReader(root), true);
    list.sample(ctx({ flag: (f) => flags.push(f) }));
    list.sample(ctx({ flag: (f) => flags.push(f), slow: false }));
    const out = empty();
    list.drain(out);
    expect(out.processes).toBeUndefined();
    expect(list.active()).toBe(false);
    expect(flags).toEqual(["host_pid_namespace", "host_pid_namespace"]);
  });

  it("is absent off Linux", () => {
    expect(new ProcessListCollector(fileReader(), false).available()).toBe(false);
  });

  it.runIf(process.platform === "linux")("a child with --password=s3cr3t never appears in the payload", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", "--", "--password=s3cr3t"], { stdio: "ignore" });
    try {
      await sleep(200);
      const list = new ProcessListCollector(fileReader(), true);
      list.sample(ctx());
      const out = empty();
      list.drain(out);
      expect(JSON.stringify(out)).not.toContain("s3cr3t");
    } finally {
      child.kill();
    }
  });
});
