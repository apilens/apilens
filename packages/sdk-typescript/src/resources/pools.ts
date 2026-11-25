/**
 * Database connection pools (C6): `pg.Pool` (totalCount / idleCount /
 * waitingCount, `options.max`) and mysql2 pools (all / free connections and
 * the waiting queue, `config.connectionLimit`).
 *
 * Pools are discovered by the pg and mysql2 hooks in db.ts: the first
 * `connect()` / `getConnection()` of a pool registers it here. Pools are held
 * weakly, so tracking never keeps an ended pool alive. No pool, no `pools`.
 */

import type { Collector, ResourcePool, ResourcesBlock } from "./types.js";
import { GaugeAcc, compact } from "./window.js";

const MAX_POOLS = 10;

export type PoolKind = "pg" | "mysql2";

type PoolReading = { used?: number; idle?: number; max?: number; pending?: number };

type Entry = {
  ref: { deref(): object | undefined };
  kind: PoolKind;
  name: string;
  used: GaugeAcc;
  pending: GaugeAcc;
  idle?: number;
  max?: number;
};

const entries: Entry[] = [];
const tracked = new WeakSet<object>();

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Length of an array or a Denque-like queue. */
function size(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return value.length;
  }
  return num((value as { length?: unknown } | null | undefined)?.length);
}

/** One reading of `pool` (exported for tests). */
export function readPool(kind: PoolKind, pool: object): PoolReading {
  const p = pool as Record<string, unknown>;
  if (kind === "pg") {
    const total = num(p.totalCount);
    const idle = num(p.idleCount);
    return {
      used: total !== undefined && idle !== undefined ? Math.max(total - idle, 0) : undefined,
      idle,
      max: num((p.options as { max?: unknown } | undefined)?.max),
      pending: num(p.waitingCount),
    };
  }
  const all = size(p._allConnections);
  const free = size(p._freeConnections);
  return {
    used: all !== undefined && free !== undefined ? Math.max(all - free, 0) : undefined,
    idle: free,
    max: num((p.config as { connectionLimit?: unknown } | undefined)?.connectionLimit),
    pending: size(p._connectionQueue),
  };
}

function poolName(kind: PoolKind, pool: object): string {
  const p = pool as { options?: { database?: unknown }; config?: { connectionConfig?: { database?: unknown } } };
  const db = kind === "pg" ? p.options?.database : p.config?.connectionConfig?.database;
  const base = typeof db === "string" && db.trim() ? db.trim().slice(0, 56) : "default";
  let name = base;
  for (let i = 2; entries.some((e) => e.name === name); i += 1) {
    name = `${base}-${i}`;
  }
  return name;
}

function weak(target: object): { deref(): object | undefined } {
  const W = (globalThis as { WeakRef?: new (t: object) => { deref(): object | undefined } }).WeakRef;
  return typeof W === "function" ? new W(target) : { deref: () => target };
}

/** Start reporting `pool` (idempotent; never throws). */
export function trackPool(pool: unknown, kind: PoolKind): void {
  try {
    if (!pool || typeof pool !== "object" || tracked.has(pool)) {
      return;
    }
    // Forget ended pools first, then keep at most MAX_POOLS.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (!entries[i].ref.deref()) {
        entries.splice(i, 1);
      }
    }
    if (entries.length >= MAX_POOLS) {
      return;
    }
    tracked.add(pool);
    entries.push({ ref: weak(pool), kind, name: poolName(kind, pool), used: new GaugeAcc(), pending: new GaugeAcc() });
  } catch {
    // Never fail the app's connect().
  }
}

/** Forget every tracked pool (tests). */
export function resetPools(): void {
  entries.length = 0;
}

export class PoolsCollector implements Collector {
  readonly name = "pools" as const;
  readonly capability = "pools";

  available(): boolean {
    return true;
  }

  active(): boolean {
    return entries.length > 0;
  }

  sample(): void {
    for (const entry of entries) {
      const pool = entry.ref.deref();
      if (!pool) {
        continue;
      }
      const r = readPool(entry.kind, pool);
      entry.used.add(r.used);
      entry.pending.add(r.pending);
      entry.idle = r.idle;
      entry.max = r.max;
    }
  }

  drain(out: ResourcesBlock): void {
    const pools: ResourcePool[] = [];
    for (const entry of entries) {
      const used = entry.used.drain(2);
      const pending = entry.pending.drain(2);
      if (!used && !pending && entry.idle === undefined) {
        continue;
      }
      pools.push({ name: entry.name, kind: entry.kind, ...compact({ used, idle: entry.idle, max: entry.max, pending }) });
    }
    if (pools.length > 0) {
      out.pools = pools;
    }
  }
}
