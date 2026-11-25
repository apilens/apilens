"use client";

// The Services tab of the Explore request drawer: the services one request went through, as a
// tree read left to right (each service under the one that called it), every node carrying how
// its caller's calls went: count, failures, latency and what was called. Built from the trace's
// spans by serviceMap (lib/service-map.ts).
import { useMemo } from "react";
import type { RequestDetail, TraceSpan } from "@/lib/identity";
import { type MapEdge, type MapNode, type NodeKind, serviceMap } from "@/lib/service-map";
import { formatLatency } from "@/lib/traffic";
import { useAppName } from "./app-names";

const KIND_LABEL: Record<NodeKind, string> = {
  client: "Caller",
  service: "Service",
  database: "Database",
  http: "HTTP API",
  messaging: "Messaging",
  rpc: "RPC",
  other: "Peer",
};

/** The most-called operations shown under a node; the rest fold into "+N more". */
const OPS_SHOWN = 3;

interface TreeNode {
  node: MapNode;
  /** The call from its tree parent; null for a root. */
  edge: MapEdge | null;
  /** Other services that called it too (a node is drawn once, under its first caller). */
  alsoFrom: string[];
  children: TreeNode[];
}

/** Each node under its first caller (callers in column order), so a graph reads as one tree. */
function toTree(nodes: MapNode[], edges: MapEdge[]): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const incoming = new Map<string, MapEdge[]>();
  for (const e of edges) if (e.from !== e.to) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  for (const n of nodes) {
    if (!incoming.has(n.id)) {
      const t: TreeNode = { node: n, edge: null, alsoFrom: [], children: [] };
      placed.set(n.id, t);
      roots.push(t);
    }
  }
  // Breadth-first from the roots, so each node lands under its shallowest caller.
  const queue = [...roots];
  while (queue.length) {
    const parent = queue.shift() as TreeNode;
    for (const e of edges) {
      if (e.from !== parent.node.id || e.from === e.to) continue;
      const to = byId.get(e.to);
      if (!to) continue;
      const had = placed.get(e.to);
      if (had) {
        if (had.edge?.from !== e.from) had.alsoFrom.push(parent.node.name);
        continue;
      }
      const t: TreeNode = { node: to, edge: e, alsoFrom: [], children: [] };
      placed.set(e.to, t);
      parent.children.push(t);
      queue.push(t);
    }
  }
  return roots;
}

export function ServicesTab({ request, spans }: { request: RequestDetail; spans: TraceSpan[] }) {
  const appName = useAppName(request.app_id);
  const map = useMemo(
    () =>
      serviceMap(spans, {
        span_id: request.span_id,
        user_agent: request.user_agent,
        ip_address: request.ip_address,
        status_code: request.status_code,
        response_time_ms: request.response_time_ms,
        service: appName ?? "",
      }),
    [spans, request, appName],
  );
  const tree = useMemo(() => toTree(map.nodes, map.edges), [map]);
  const failed = map.edges.reduce((n, e) => n + e.errors, 0);
  const services = map.nodes.filter((n) => n.kind !== "client").length;

  return (
    <div className="rd-blocks">
      <section className="rd-block" aria-label="Services">
        <header className="rd-block__h">
          <h3 className="rd-block__title">Services</h3>
          <span className="rd-block__meta">
            {services} {services === 1 ? "service" : "services"}
          </span>
          <span className="rd-block__meta">
            {map.edges.length} {map.edges.length === 1 ? "connection" : "connections"}
          </span>
          {failed ? <span className="rd-block__meta svc-bad">{failed} failed</span> : null}
        </header>
        {!request.trace_id ? <p className="rd-empty">This request was not traced, so only its caller is shown.</p> : null}
        <ul className="svc-tree" aria-label="Service map">
          {tree.map((t) => (
            <Branch key={t.node.id} t={t} />
          ))}
        </ul>
        <p className="svc-legend">
          <span className="svc-dot svc-dot--service" /> Service <span className="svc-dot svc-dot--database" /> Database <span className="svc-dot svc-dot--http" /> HTTP API <span className="svc-dot svc-dot--client" /> Caller
        </p>
      </section>
    </div>
  );
}

function Branch({ t }: { t: TreeNode }) {
  return (
    <li className="svc-branch">
      <NodeCard t={t} />
      {t.children.length ? (
        <ul className="svc-tree svc-tree--sub">
          {t.children.map((c) => (
            <Branch key={c.node.id} t={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NodeCard({ t }: { t: TreeNode }) {
  const { node: n, edge: e } = t;
  const bad = Boolean(e?.errors);
  const avg = e && e.calls ? e.totalMs / e.calls : 0;
  const rest = e ? e.ops.length - OPS_SHOWN : 0;
  return (
    <div className={`svc-card svc-card--${n.kind}${n.self ? " is-self" : ""}${bad ? " is-bad" : ""}`}>
      <div className="svc-card__h">
        <span className="svc-card__kind">{n.self ? "This request" : KIND_LABEL[n.kind]}</span>
        <span className="svc-card__name" title={n.name}>
          {n.name}
        </span>
        {n.detail && n.detail !== n.name && n.detail !== "HTTP" ? <span className="svc-card__detail">{n.detail}</span> : null}
      </div>
      {e ? (
        <div className="svc-card__stats">
          <span>
            {e.calls.toLocaleString("en-US")} {e.calls === 1 ? "call" : "calls"}
          </span>
          {e.errors ? <span className="svc-bad">{e.errors} failed</span> : null}
          <span title="Average latency of the calls">avg {formatLatency(avg)}</span>
          {e.calls > 1 ? <span title="The slowest call">max {formatLatency(e.maxMs)}</span> : null}
        </div>
      ) : null}
      {e?.ops.length ? (
        <ul className="svc-ops" aria-label={`What ${n.name} was asked`}>
          {e.ops.slice(0, OPS_SHOWN).map((o) => (
            <li key={o.name} title={o.name}>
              <code>{o.name}</code>
              {o.calls > 1 ? <span className="svc-ops__n">×{o.calls}</span> : null}
            </li>
          ))}
          {rest > 0 ? <li className="svc-ops__more">+{rest} more</li> : null}
        </ul>
      ) : null}
      {t.alsoFrom.length ? <p className="svc-card__also">Also called by {t.alsoFrom.join(", ")}</p> : null}
    </div>
  );
}
