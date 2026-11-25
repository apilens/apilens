"use client";

import { useTimeZone } from "@/lib/time-zone-context";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { formatLastSeen, instanceRelease, instanceSdk } from "@/lib/apps";
import { formatBucket } from "@/lib/consumers";
import { formatBytes } from "@/lib/endpoint-detail";
import type { AppInstance, InstanceEvent, InstanceProcess } from "@/lib/identity";
import {
  EVENT_LABEL,
  LIMIT_HINT,
  PLATFORM_LABEL,
  formatResource,
  formatUptime,
  instanceBadges,
  instanceWhere,
  isServerless,
  resourcesHref,
} from "@/lib/resources";
import { CopyValue } from "../copy-value";

const TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const at = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? "" : `${TIME.format(t)} UTC`;
};

/** The container's processes, when the server sends them on the snapshot (the status API does not yet). */
function instanceProcesses(i: AppInstance): InstanceProcess[] | null {
  const list = (i.resources as { processes?: unknown } | null | undefined)?.processes;
  return Array.isArray(list) ? (list as InstanceProcess[]) : null;
}

/**
 * One instance in a side panel (M7 #1133): where it runs (platform, pod, namespace, node,
 * container id with copy, hostname marked when it is a guess, process start), its SDK and runtime,
 * its resources now, the processes in its container (top 20 by RSS) and its restarts and OOM
 * kills. Fields the SDK did not report are left out, never shown blank. A link opens the Resources
 * tab filtered to the instance. A modal `<dialog>`: Escape, the close button and a click outside
 * close it, and focus goes back to the row.
 */
export function InstanceDrawer({
  project,
  app,
  instance: i,
  events,
  now,
  onClose,
}: {
  project: string;
  app: string;
  instance: AppInstance;
  events: readonly InstanceEvent[] | null;
  now: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const tz = useTimeZone();
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    const back = document.activeElement as HTMLElement | null;
    if (d && !d.open) d.showModal();
    return () => back?.focus?.();
  }, []);
  const r = i.resources ?? null;
  const where = instanceWhere(i);
  const mine = (events ?? []).filter((e) => e.instance_id === i.instance_id || (!!i.container_id && e.container_id === i.container_id));
  const processes = instanceProcesses(i);
  const serverless = isServerless(i);

  const identity: [string, ReactNode][] = [];
  const add = (label: string, value: ReactNode | null | undefined | false) => {
    if (value !== null && value !== undefined && value !== false && value !== "") identity.push([label, value]);
  };
  add("Platform", i.platform ? (PLATFORM_LABEL[i.platform] ?? i.platform) : null);
  add("Region", i.region);
  add("Pod", i.pod_name ? <code>{i.pod_name}</code> : null);
  add("Namespace", i.namespace ? <code>{i.namespace}</code> : null);
  add("Node", i.node_name ? <code>{i.node_name}</code> : null);
  add("Container", i.container_id ? <CopyValue value={i.container_id} label="container id" /> : null);
  add(
    "Hostname",
    i.hostname ? (
      <>
        <code>{i.hostname}</code>
        {i.hostname_guess ? (
          <span className="rs-badge rs-badge--muted" title="No platform file or Downward API named the host; this is the process's own hostname.">
            Guess
          </span>
        ) : null}
      </>
    ) : null,
  );
  add("Process id", i.pid !== null && i.pid !== undefined ? <code>{i.pid}</code> : null);
  add("Process start", at(i.process_start_time) || null);
  add("Uptime", i.uptime_s !== null && i.uptime_s !== undefined && !i.ended_at ? formatUptime(i.uptime_s) : null);
  add("Ended", i.ended_at ? `${at(i.ended_at)}${i.ended_reason ? `, ${EVENT_LABEL[i.ended_reason as keyof typeof EVENT_LABEL] ?? (i.ended_reason === "graceful" ? "stopped cleanly" : i.ended_reason)}` : ""}` : null);
  add("SDK", <code>{instanceSdk(i)}</code>);
  add("Runtime", i.runtime);
  add("Release", instanceRelease(i));
  add("Environment", i.environment);
  add("Last seen", formatLastSeen(i.last_seen_at, now));

  const now_: [string, string][] = [];
  if (r) {
    if (!serverless && r.cpu_pct !== null) now_.push(["CPU", `${formatResource("percent", r.cpu_pct)}${r.cpu_cores !== null ? ` (${formatResource("cores", r.cpu_cores)})` : ""}`]);
    if (r.cpu_limit_cores !== null) now_.push(["CPU limit", formatResource("cores", r.cpu_limit_cores)]);
    if (r.mem_working_set !== null) now_.push(["Working set", `${formatBytes(r.mem_working_set)}${r.mem_pct !== null ? ` (${formatResource("percent", r.mem_pct)} of the limit)` : ""}`]);
    if (r.mem_rss !== null) now_.push(["RSS", formatBytes(r.mem_rss)]);
    if (r.mem_pss !== null) now_.push(["PSS", formatBytes(r.mem_pss)]);
    if (r.mem_limit !== null) now_.push(["Memory limit", formatBytes(r.mem_limit)]);
    if (!serverless && r.throttled_ratio !== null) now_.push(["Throttled", formatResource("ratio", r.throttled_ratio)]);
    if (r.runtime?.event_loop_p99 !== null && r.runtime?.event_loop_p99 !== undefined) now_.push(["Event-loop p99", formatResource("ms", r.runtime.event_loop_p99)]);
    if (r.runtime?.heap_used !== null && r.runtime?.heap_used !== undefined) now_.push(["Heap used", formatBytes(r.runtime.heap_used)]);
    if (r.runtime?.gc_pause_ms !== null && r.runtime?.gc_pause_ms !== undefined) now_.push(["GC pause", formatResource("ms", r.runtime.gc_pause_ms)]);
    const hint = LIMIT_HINT[r.limit_source];
    if (hint) now_.push(["Limit source", hint]);
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes it; Escape is the dialog's own.
    <dialog
      ref={ref}
      className="rs-drawer"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="rs-drawer__in">
        <header className="rs-drawer__head">
          <div>
            <h2 id={titleId} className="rs-drawer__title">
              {where || i.instance_id}
            </h2>
            <p className="rs-drawer__sub">
              {where ? <code>{i.instance_id}</code> : null}
              {instanceBadges(i).map((b) => (
                <span key={b.key} className={`rs-badge rs-badge--${b.tone}`} title={b.title}>
                  {b.label}
                </span>
              ))}
            </p>
          </div>
          <button type="button" className="rs-close" aria-label="Close instance details" onClick={() => ref.current?.close()}>
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </header>
        <div className="rs-drawer__body">
          <p className="rs-drawer__link">
            <a className="cp-link" href={resourcesHref(project, app, { instance: i.instance_id, env: i.environment })}>
              Show this instance on the Resources tab
            </a>
          </p>

          <section className="rs-drawer__sec" aria-labelledby={`${titleId}-id`}>
            <h3 id={`${titleId}-id`}>Identity</h3>
            <dl className="rs-dl">
              {identity.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rs-drawer__sec" aria-labelledby={`${titleId}-now`}>
            <h3 id={`${titleId}-now`}>Resources now</h3>
            {r === null ? (
              <p className="tr-empty">This SDK version does not report CPU and memory. Upgrade it to see them.</p>
            ) : now_.length === 0 ? (
              <p className="tr-empty">No resource values in the last heartbeat.</p>
            ) : (
              <dl className="rs-dl">
                {now_.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {serverless ? <p className="tr-empty rs-note">CPU is hidden: a serverless instance only gets CPU while it handles a request.</p> : null}
          </section>

          {processes && processes.length > 0 ? (
            <section className="rs-drawer__sec" aria-labelledby={`${titleId}-ps`}>
              <h3 id={`${titleId}-ps`}>Processes in the container</h3>
              <table className="rs-ps">
                <thead>
                  <tr>
                    <th scope="col">PID</th>
                    <th scope="col">Parent</th>
                    <th scope="col">Name</th>
                    <th scope="col" className="tr-num">
                      CPU
                    </th>
                    <th scope="col" className="tr-num">
                      RSS
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {processes.map((p) => (
                    <tr key={p.pid} className={p.pid === i.pid ? "is-self" : undefined}>
                      <td>
                        <code>{p.pid}</code>
                      </td>
                      <td>
                        <code>{p.ppid ?? "—"}</code>
                      </td>
                      <td>
                        <code>{p.comm}</code>
                        {p.pid === i.pid ? <span className="rs-self"> this instance</span> : null}
                      </td>
                      <td className="tr-num">{formatResource("percent", p.cpu_pct)}</td>
                      <td className="tr-num">{p.rss === null || p.rss === undefined ? "—" : formatBytes(p.rss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="tr-empty rs-note">Top 20 by RSS, from the instance’s own cgroup. Command lines and environments are never collected.</p>
            </section>
          ) : null}

          <section className="rs-drawer__sec" aria-labelledby={`${titleId}-ev`}>
            <h3 id={`${titleId}-ev`}>Restarts and OOM kills</h3>
            {events === null ? (
              <p className="tr-empty">We couldn’t load this instance’s events just now.</p>
            ) : mine.length === 0 ? (
              <p className="tr-empty">None in this range.</p>
            ) : (
              <ol className="rs-events">
                {mine.map((e) => (
                  <li key={`${e.kind}-${e.at}-${e.instance_id}`}>
                    <span className={`rs-ev-dot rs-ev-dot--${e.kind === "restart" ? "restart" : "oom"}`} aria-hidden="true" />
                    <b>{EVENT_LABEL[e.kind] ?? e.kind}</b>
                    <span className="rs-ev-at">{formatBucket(e.at, "24h", tz)}</span>
                    {e.instance_id !== i.instance_id ? <span className="rs-ev-who">in the same container</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </dialog>
  );
}
