"use client";

import { Fragment, useState } from "react";
import { formatCount } from "@/lib/consumers";
import {
  type FleetUnit,
  balanceLine,
  buildFleet,
  defaultEnvironment,
  describeFleet,
  fleetEnvironments,
  fleetMode,
  memoryLabel,
} from "@/lib/fleet";
import type { AppInstance, InstanceEvent } from "@/lib/identity";
import { formatResource, formatUptime } from "@/lib/resources";
import { formatLatency } from "@/lib/traffic";
import { InstanceDrawer } from "./instance-drawer";
import "./resources.css";

const DASH = "—";
type SortKey = "attention" | "share" | "p95" | "cpu" | "mem";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "share", label: "Traffic" },
  { key: "p95", label: "p95" },
  { key: "cpu", label: "CPU" },
  { key: "mem", label: "Memory" },
];

function sortUnits(units: FleetUnit[], key: SortKey): FleetUnit[] {
  if (key === "attention") return units;
  const v = (u: FleetUnit) => (key === "share" ? u.share : key === "p95" ? u.p95 : key === "cpu" ? u.cpuPct : u.memPct) ?? -1;
  return [...units].sort((a, b) => v(b) - v(a) || a.name.localeCompare(b.name));
}

/**
 * The instances behind one app, as the load balancer and the limits see them (M7): one row per
 * pod, container or VM with its forked workers folded in. Each row says how much of the traffic it
 * takes against an even spread, how its p95 compares with the fleet, and its CPU and memory as a
 * share of a named limit; rows that need a look come first, with the reason. One environment at a
 * time, production first. A single box reads as one card, serverless as a summary.
 */
export function FleetTable({
  project,
  app,
  instances,
  events,
  now,
  scopeEnv = "",
}: {
  project: string;
  app: string;
  instances: readonly AppInstance[];
  events: readonly InstanceEvent[] | null;
  now: number;
  /** The page's environment filter; when set, the table follows it and offers no switch of its own. */
  scopeEnv?: string;
}) {
  const envs = scopeEnv ? [] : fleetEnvironments(instances);
  const [ownEnv, setEnv] = useState(() => defaultEnvironment(instances));
  const env = scopeEnv || ownEnv;
  const [sort, setSort] = useState<SortKey>("attention");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<AppInstance | null>(null);
  const units = buildFleet(instances, env, events);
  const mode = fleetMode(units);
  const balance = balanceLine(units);
  const toggle = (k: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  if (instances.length === 0) {
    return (
      <p className="tr-empty" role="status">
        No SDK instance has sent a heartbeat yet.
      </p>
    );
  }

  return (
    <div className="fl">
      <div className="fl-head">
        {envs.length > 1 ? (
          <div className="fl-envs" role="group" aria-label="Environment">
            {envs.map((e) => (
              <button key={e} type="button" className="fl-env" aria-pressed={e === env} onClick={() => setEnv(e)}>
                {e}
              </button>
            ))}
          </div>
        ) : null}
        {mode !== "empty" && mode !== "serverless" ? (
          <p className="fl-describe">
            <strong>{describeFleet(units)}</strong>
            {balance ? <span className={balance.even ? "fl-balance" : "fl-balance fl-balance--off"}>{balance.text}</span> : null}
          </p>
        ) : null}
        {mode === "fleet" && units.length > 1 ? (
          <label className="fl-sort">
            Sort by{" "}
            <select className="tr-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {mode === "empty" ? (
        <p className="tr-empty rs-pad" role="status">
          No live instance in {env}.
        </p>
      ) : mode === "serverless" ? (
        <Serverless units={units} />
      ) : mode === "single" ? (
        <Single unit={units[0]} onOpen={setOpen} />
      ) : (
        <div className="rs-scroll">
          <table className="tr-table fl-table" aria-label={`Instances in ${env}`}>
            <thead>
              <tr>
                <th scope="col">Instance</th>
                <th scope="col">Traffic share</th>
                <th scope="col" className="tr-num">
                  p95
                </th>
                <th scope="col" className="tr-num">
                  Errors
                </th>
                <th scope="col">CPU</th>
                <th scope="col">Memory</th>
                <th scope="col" className="tr-num">
                  Up
                </th>
              </tr>
            </thead>
            <tbody>
              {sortUnits(units, sort).map((u) => (
                <Fragment key={u.key}>
                  <UnitRow u={u} open={expanded.has(u.key)} onToggle={() => toggle(u.key)} />
                  {expanded.has(u.key) ? <WorkerRows u={u} onOpen={setOpen} /> : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? <InstanceDrawer project={project} app={app} instance={open} events={events} now={now} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function Findings({ u, all = false }: { u: FleetUnit; all?: boolean }) {
  if (u.unmeasured) {
    return (
      <span className="rs-badges">
        <span className="rs-badge rs-badge--muted" title="This SDK release does not sample CPU and memory.">
          SDK too old for resources
        </span>
      </span>
    );
  }
  if (u.findings.length === 0) return null;
  const shown = all ? u.findings : u.findings.slice(0, 2);
  const tone = { critical: "error", warning: "warn", info: "info" } as const;
  return (
    <span className="rs-badges">
      {shown.map((f) => (
        <span key={f.key} className={`rs-badge rs-badge--${tone[f.tone]}`} title={f.detail}>
          {f.label}
        </span>
      ))}
      {u.findings.length > shown.length ? <span className="rs-badge rs-badge--muted">+{u.findings.length - shown.length}</span> : null}
    </span>
  );
}

function where(u: FleetUnit): string {
  return [u.node && `node ${u.node}`, u.region, u.release && `release ${u.release}`].filter(Boolean).join(" · ");
}

function Meter({ pct, warnAt = 80, critAt = 90 }: { pct: number | null; warnAt?: number; critAt?: number }) {
  if (pct === null) return null;
  const tone = pct >= critAt ? " fl-meter--crit" : pct >= warnAt ? " fl-meter--warn" : "";
  return (
    <span className={`fl-meter${tone}`} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  );
}

function cpuCell(u: FleetUnit): { main: string; sub: string; title: string } {
  if (u.cpuCores === null) return { main: DASH, sub: "", title: "Not measured" };
  const cores = formatResource("cores", u.cpuCores);
  if (u.cpuPct === null) return { main: cores, sub: "no limit set", title: `${cores} in use; no CPU limit is set.` };
  const limit = formatResource("cores", u.cpuLimitCores);
  const of = u.cpuOf === "host" ? `of ${limit} on the host` : `of ${limit} limit`;
  return { main: formatResource("percent", u.cpuPct), sub: of, title: `${cores} in use, ${of}, across ${u.workers.length === 1 ? "its process" : `its ${u.workers.length} workers`}.` };
}

function memCell(u: FleetUnit): { main: string; sub: string; title: string } {
  if (u.memBytes === null) return { main: DASH, sub: "", title: "Not measured" };
  const bytes = formatResource("bytes", u.memBytes);
  if (u.memPct === null) return { main: bytes, sub: "no limit set", title: memoryLabel(u) };
  return { main: formatResource("percent", u.memPct), sub: `${bytes} of ${formatResource("bytes", u.memLimit)}`, title: memoryLabel(u) };
}

function UnitRow({ u, open, onToggle }: { u: FleetUnit; open: boolean; onToggle: () => void }) {
  const cpu = cpuCell(u);
  const mem = memCell(u);
  const many = u.workers.length > 1;
  return (
    <tr className={`tr-row fl-row${u.attention >= 100 ? " fl-row--crit" : ""}`}>
      <td className="fl-inst">
        <button type="button" className="fl-toggle" onClick={onToggle} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the ${u.workers.length === 1 ? "process" : `${u.workers.length} workers`} of ${u.name}`}>
          <span className={`fl-chev${open ? " fl-chev--open" : ""}`} aria-hidden="true" />
          <span className="fl-name">{u.name}</span>
        </button>
        <span className="rs-sub">
          {many ? <span>{u.workers.length} workers</span> : null}
          {where(u) ? <span>{where(u)}</span> : null}
        </span>
        <Findings u={u} />
      </td>
      <td className="fl-share">
        {u.share === null ? (
          DASH
        ) : (
          <>
            <span className="fl-share-num">{formatResource("ratio", u.share)}</span>
            <span className="rs-sub2">{u.rpm === null ? "" : `${formatCount(Math.round(u.rpm))} req/min`}</span>
            <span className="fl-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, u.share * 100)}%` }} />
            </span>
          </>
        )}
      </td>
      <td className="tr-num">{u.p95 === null ? DASH : formatLatency(u.p95)}</td>
      <td className="tr-num">{u.errorPct === null ? DASH : formatResource("percent", u.errorPct)}</td>
      <td className="fl-res" title={cpu.title}>
        <span>{cpu.main}</span>
        {cpu.sub ? <span className="rs-sub2">{cpu.sub}</span> : null}
        <Meter pct={u.cpuPct} warnAt={85} critAt={95} />
      </td>
      <td className="fl-res" title={mem.title}>
        <span>{mem.main}</span>
        {mem.sub ? <span className="rs-sub2">{mem.sub}</span> : null}
        <Meter pct={u.memPct} />
      </td>
      <td className="tr-num">{formatUptime(u.uptimeS)}</td>
    </tr>
  );
}

function WorkerRows({ u, onOpen }: { u: FleetUnit; onOpen: (i: AppInstance) => void }) {
  return (
    <>
      {u.workers.map((w) => {
        const r = w.resources;
        const memV = r?.mem_pss ?? r?.mem_rss ?? null;
        return (
          <tr key={w.instance_id} className="fl-worker">
            <td className="fl-inst">
              <button type="button" className="rs-open fl-worker-open" onClick={() => onOpen(w)}>
                {w.pid ? `pid ${w.pid}` : w.instance_id}
              </button>
              <span className="rs-sub">
                <code className="ap-mono">{w.instance_id.slice(0, 8)}</code>
                <span>{w.runtime}</span>
              </span>
            </td>
            <td>{w.requests ? `${formatCount(Math.round(w.requests.rpm))} req/min` : DASH}</td>
            <td className="tr-num">{w.requests && w.requests.rpm > 0 ? formatLatency(w.requests.p95_ms) : DASH}</td>
            <td className="tr-num">{w.requests ? formatResource("percent", w.requests.error_pct) : DASH}</td>
            <td className="fl-res">{r ? formatResource("cores", r.cpu_cores) : DASH}</td>
            <td className="fl-res" title={r?.mem_pss != null ? "This worker's PSS: its own pages plus its share of pages shared with the other workers." : "This worker's RSS."}>
              {formatResource("bytes", memV)}
              <span className="rs-sub2">{r?.mem_pss != null ? "PSS" : r?.mem_rss != null ? "RSS" : ""}</span>
            </td>
            <td className="tr-num">{formatUptime(w.uptime_s)}</td>
          </tr>
        );
      })}
    </>
  );
}

/** One box (one VM or pod): a card, not a one-row table. */
function Single({ unit: u, onOpen }: { unit: FleetUnit; onOpen: (i: AppInstance) => void }) {
  const cpu = cpuCell(u);
  const mem = memCell(u);
  return (
    <div className="fl-single">
      <div className="fl-single-head">
        <span className="fl-name">{u.name}</span>
        {where(u) ? <span className="rs-sub">{where(u)}</span> : null}
        <Findings u={u} all />
      </div>
      <dl className="fl-facts">
        <div title={cpu.title}>
          <dt>CPU</dt>
          <dd>
            {cpu.main} <span className="rs-sub2">{cpu.sub}</span>
            <Meter pct={u.cpuPct} warnAt={85} critAt={95} />
          </dd>
        </div>
        <div title={mem.title}>
          <dt>Memory</dt>
          <dd>
            {mem.main} <span className="rs-sub2">{mem.sub}</span>
            <Meter pct={u.memPct} />
          </dd>
        </div>
        <div>
          <dt>Requests</dt>
          <dd>{u.rpm === null ? DASH : `${formatCount(Math.round(u.rpm))} req/min`}</dd>
        </div>
        <div>
          <dt>p95</dt>
          <dd>{u.p95 === null ? DASH : formatLatency(u.p95)}</dd>
        </div>
        <div>
          <dt>Up</dt>
          <dd>{formatUptime(u.uptimeS)}</dd>
        </div>
      </dl>
      {u.workers.length > 1 ? (
        <p className="fl-workers-inline">
          {u.workers.length} workers:{" "}
          {u.workers.map((w, k) => (
            <Fragment key={w.instance_id}>
              {k > 0 ? ", " : ""}
              <button type="button" className="rs-open fl-worker-open" onClick={() => onOpen(w)}>
                {w.pid ? `pid ${w.pid}` : w.instance_id.slice(0, 8)}
              </button>
            </Fragment>
          ))}
        </p>
      ) : (
        <button type="button" className="rs-open fl-worker-open" onClick={() => onOpen(u.workers[0])}>
          Process details
        </button>
      )}
    </div>
  );
}

/** Serverless instances come and go with traffic: a summary, never a row each. */
function Serverless({ units }: { units: FleetUnit[] }) {
  const mems = units.map((u) => u.memPct).filter((v): v is number => v !== null);
  const rpm = units.reduce((n, u) => n + (u.rpm ?? 0), 0);
  return (
    <div className="fl-single">
      <p className="fl-note">
        <strong>{units.length === 1 ? "1 serverless instance is" : `${units.length} serverless instances are`} live.</strong> They start and stop with traffic, so they are
        summarised rather than listed one by one, and CPU is left out: it only runs while a request is handled.
      </p>
      <dl className="fl-facts">
        <div>
          <dt>Requests</dt>
          <dd>{formatCount(Math.round(rpm))} req/min</dd>
        </div>
        <div>
          <dt>Memory, busiest instance</dt>
          <dd>{mems.length ? `${formatResource("percent", Math.max(...mems))} of its limit` : DASH}</dd>
        </div>
      </dl>
    </div>
  );
}
