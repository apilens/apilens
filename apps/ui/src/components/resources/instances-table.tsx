"use client";

import { useId, useState } from "react";
import { formatLastSeen, instanceSdk } from "@/lib/apps";
import { formatCount } from "@/lib/consumers";
import type { AppInstance, InstanceEvent } from "@/lib/identity";
import {
  INSTANCE_SORT_DEFAULT,
  type InstanceSort,
  type InstanceSortKey,
  filterInstances,
  formatResource,
  formatUptime,
  instanceBadges,
  instanceWhere,
  isServerless,
  memoryCell,
  nextInstanceSort,
  sortInstances,
  splitEnded,
} from "@/lib/resources";
import { formatLatency } from "@/lib/traffic";
import { Sparkline } from "../traffic/charts";
import { InstanceDrawer } from "./instance-drawer";
import "./resources.css";

const COLUMNS: readonly { key: InstanceSortKey; label: string; num?: boolean }[] = [
  { key: "instance", label: "Instance" },
  { key: "cpu", label: "CPU", num: true },
  { key: "mem", label: "Memory", num: true },
  { key: "throttled", label: "Throttled", num: true },
  { key: "rpm", label: "Req/min", num: true },
  { key: "p95", label: "p95", num: true },
  { key: "errors", label: "Errors", num: true },
  { key: "uptime", label: "Uptime", num: true },
  { key: "seen", label: "Last seen", num: true },
];

const DASH = "—";

/**
 * The SDK instances of an app with their resources and requests (M7 #1132): where each runs (pod
 * or host), CPU and memory now with the last hour as a sparkline, throttling, requests per minute,
 * p95 and error share (4xx and 5xx) over the last 15 minutes, and uptime. Badges say how an instance ended
 * (restarted, OOMKilled), what the server noticed (noisy, leaking) and serverless. A value an SDK
 * did not measure reads "—", never 0. Sortable by every column, filtered by environment; instances
 * that ended in the last 24 hours are collapsed under the live ones. A row opens the instance drawer.
 */
export function InstancesTable({
  project,
  app,
  instances,
  events,
  now,
  envFilter = true,
}: {
  project: string;
  app: string;
  instances: readonly AppInstance[];
  events: readonly InstanceEvent[] | null;
  now: number;
  /** Offer the environment filter (off when the page is already scoped to one). */
  envFilter?: boolean;
}) {
  const [sort, setSort] = useState<InstanceSort>(INSTANCE_SORT_DEFAULT);
  const [env, setEnv] = useState("");
  const [open, setOpen] = useState<AppInstance | null>(null);
  const envId = useId();
  const envs = [...new Set(instances.map((i) => i.environment).filter(Boolean))].sort();
  const { live, ended } = splitEnded(filterInstances(instances, env), now);
  const rows = sortInstances(live, sort);
  const endedRows = sortInstances(ended, { key: "seen", dir: "desc" });

  if (instances.length === 0) {
    return (
      <p className="tr-empty" role="status">
        No SDK instance has sent a heartbeat yet.
      </p>
    );
  }

  const table = (list: AppInstance[], label: string, sortable: boolean) => (
    <div className="rs-scroll">
      <table className="tr-table rs-table" aria-label={label}>
        <thead>
          <tr>
            {COLUMNS.map((c) => {
              const on = sortable && sort.key === c.key;
              return (
                <th key={c.key} scope="col" className={c.num ? "tr-num" : undefined} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                  {sortable ? (
                    <button type="button" className="tr-sort rs-sort" onClick={() => setSort((s) => nextInstanceSort(s, c.key))}>
                      {c.label}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {list.map((i) => (
            <Row key={i.instance_id} i={i} now={now} onOpen={() => setOpen(i)} />
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {envFilter && envs.length > 1 ? (
        <div className="rs-tools">
          <label className="tr-env" htmlFor={envId}>
            Environment
          </label>
          <select id={envId} className="tr-select" value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="">All environments</option>
            {envs.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {rows.length > 0 ? (
        table(rows, "SDK instances", true)
      ) : (
        <p className="tr-empty rs-pad" role="status">
          No live instance{env ? ` in ${env}` : ""}.
        </p>
      )}
      {endedRows.length > 0 ? (
        <details className="rs-ended">
          <summary>
            Ended in the last 24 h <span className="ap-count">{formatCount(endedRows.length)}</span>
          </summary>
          {table(endedRows, "Instances that ended in the last 24 hours", false)}
        </details>
      ) : null}
      {open ? <InstanceDrawer project={project} app={app} instance={open} events={events} now={now} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function Row({ i, now, onOpen }: { i: AppInstance; now: number; onOpen: () => void }) {
  const r = i.resources ?? null;
  const serverless = isServerless(i);
  const mem = memoryCell(i);
  const where = instanceWhere(i);
  const badges = instanceBadges(i);
  const memLimit = r?.mem_limit ?? undefined;
  return (
    <tr className="tr-row rs-row">
      <td className="rs-inst" data-label="Instance">
        <button type="button" className="rs-open" onClick={onOpen} aria-label={`Open instance ${where || i.instance_id}`}>
          <span className="rs-where">{where || i.instance_id}</span>
        </button>
        <span className="rs-sub">
          {where ? <code className="ap-mono">{i.instance_id}</code> : null}
          {i.environment ? <span className="rs-env">{i.environment}</span> : null}
          <span className="rs-sdk">{instanceSdk(i)}</span>
        </span>
        {badges.length > 0 ? (
          <span className="rs-badges">
            {badges.map((b) => (
              <span key={b.key} className={`rs-badge rs-badge--${b.tone}`} title={b.title}>
                {b.label}
              </span>
            ))}
          </span>
        ) : null}
      </td>
      <td className="tr-num rs-metric" data-label="CPU">
        {serverless ? (
          <span className="rs-hidden" title="Serverless: CPU only runs while a request is handled, so a percentage would mislead.">
            Hidden
          </span>
        ) : (
          <>
            <span>{r ? formatResource("percent", r.cpu_pct) : DASH}</span>
            {r && i.spark?.cpu_pct?.some((v) => v !== null) ? <Sparkline values={i.spark.cpu_pct} top={100} /> : null}
          </>
        )}
      </td>
      <td className="tr-num rs-metric" data-label="Memory">
        <span>{mem.main}</span>
        {mem.sub ? <span className="rs-sub2">{mem.sub}</span> : null}
        {r && i.spark?.mem?.some((v) => v !== null) ? <Sparkline values={i.spark.mem} top={memLimit} /> : null}
      </td>
      <td className="tr-num" data-label="Throttled">
        {r && !serverless ? formatResource("ratio", r.throttled_ratio) : DASH}
      </td>
      <td className="tr-num" data-label="Req/min">
        {i.requests ? formatCount(Math.round(i.requests.rpm * 10) / 10) : DASH}
      </td>
      <td className="tr-num" data-label="p95">
        {i.requests && i.requests.rpm > 0 ? formatLatency(i.requests.p95_ms) : DASH}
      </td>
      <td className="tr-num" data-label="Errors" title="Responses with status 400 or above, last 15 minutes">
        {i.requests ? formatResource("percent", i.requests.error_pct) : DASH}
      </td>
      <td className="tr-num" data-label="Uptime">
        {i.ended_at ? <span className="rs-hidden">Ended</span> : formatUptime(i.uptime_s)}
      </td>
      <td className="tr-num" data-label="Last seen">
        {formatLastSeen(i.last_seen_at, now).replace(/^Last seen /, "")}
      </td>
    </tr>
  );
}
