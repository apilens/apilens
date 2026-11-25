// The Services tab of the Explore request drawer: the services one request went through, read from
// the spans of its trace. The caller (a browser, curl, another service) calls the request's
// service; each client span then calls either a service that reported its own spans in the trace
// (its server span is the client span's child) or a peer that reports nothing (a database, an
// HTTP API), named from the span's attributes. Pure, unit-tested in service-map.test.ts.
import type { TraceSpan } from "./identity";

export type NodeKind = "client" | "service" | "database" | "http" | "messaging" | "rpc" | "other";

export interface MapNode {
  id: string;
  name: string;
  kind: NodeKind;
  /** Where it is (host:port) or what it is (the user agent), when known. */
  detail: string;
  /** The service of the request itself. */
  self: boolean;
}

export interface MapEdge {
  from: string;
  to: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  /** What was called, most frequent first (at most 5): "GET /models", "SELECT tbl_users". */
  ops: { name: string; calls: number }[];
}

export interface ServiceMap {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Each node's column, left to right: the caller is 0. */
  depth: Record<string, number>;
}

/** Well-known ports of peers that name no system: "PostgreSQL" for :5432. */
const PORT_SYSTEMS: Record<string, [string, NodeKind]> = {
  "5432": ["PostgreSQL", "database"],
  "3306": ["MySQL", "database"],
  "1433": ["SQL Server", "database"],
  "1521": ["Oracle", "database"],
  "6379": ["Redis", "database"],
  "8123": ["ClickHouse", "database"],
  "9000": ["ClickHouse", "database"],
  "27017": ["MongoDB", "database"],
  "9200": ["Elasticsearch", "database"],
  "9042": ["Cassandra", "database"],
  "11211": ["Memcached", "database"],
  "9092": ["Kafka", "messaging"],
  "5672": ["RabbitMQ", "messaging"],
  "4222": ["NATS", "messaging"],
};

const SYSTEM_NAMES: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mssql: "SQL Server",
  oracle: "Oracle",
  redis: "Redis",
  clickhouse: "ClickHouse",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
  cassandra: "Cassandra",
  sqlite: "SQLite",
  memcached: "Memcached",
  kafka: "Kafka",
  rabbitmq: "RabbitMQ",
  nats: "NATS",
  aws_sqs: "SQS",
};

const CALLING = new Set(["client", "producer"]);

function attr(s: TraceSpan, ...keys: string[]): string {
  for (const k of keys) {
    const v = s.attributes?.[k];
    if (v) return v;
  }
  return "";
}

function hostPort(s: TraceSpan): string {
  let host = attr(s, "server.address", "net.peer.name", "network.peer.address", "net.peer.ip");
  let port = attr(s, "server.port", "net.peer.port", "network.peer.port");
  if (!host) {
    try {
      const u = new URL(attr(s, "url.full", "http.url"));
      host = u.hostname;
      port = port || u.port;
    } catch {
      // no URL either
    }
  }
  return host ? (port ? `${host}:${port}` : host) : "";
}

/** The peer a client span calls when no service of the trace answers it. */
export function peerOf(s: TraceSpan): Omit<MapNode, "self"> {
  const where = hostPort(s);
  const port = attr(s, "server.port", "net.peer.port");
  const named = attr(s, "peer.service");
  const db = attr(s, "db.system.name", "db.system");
  const mq = attr(s, "messaging.system");
  const rpc = attr(s, "rpc.system");
  if (named) return { id: `peer:${named}`, name: named, kind: db ? "database" : "service", detail: where };
  if (db) {
    const name = SYSTEM_NAMES[db.toLowerCase()] ?? db;
    return { id: `db:${name}:${where}`, name, kind: "database", detail: where };
  }
  if (mq) {
    const name = SYSTEM_NAMES[mq.toLowerCase()] ?? mq;
    return { id: `mq:${name}:${where}`, name, kind: "messaging", detail: where };
  }
  const known = PORT_SYSTEMS[port];
  if (known && !attr(s, "http.request.method", "http.method")) return { id: `db:${known[0]}:${where}`, name: known[0], kind: known[1], detail: where };
  if (rpc) {
    const svc = attr(s, "rpc.service");
    return { id: `rpc:${svc || where}`, name: svc || where || rpc, kind: "rpc", detail: svc ? where : rpc };
  }
  if (attr(s, "http.request.method", "http.method", "url.full", "http.url")) {
    if (known) return { id: `db:${known[0]}:${where}`, name: known[0], kind: known[1], detail: where };
    return { id: `http:${where}`, name: where || "HTTP", kind: "http", detail: "HTTP" };
  }
  return { id: `other:${where || s.name}`, name: where || s.name, kind: "other", detail: "" };
}

/** What a call did, short: "GET /models" for HTTP (the path without its query), else the span name. */
export function opOf(s: TraceSpan): string {
  const method = attr(s, "http.request.method", "http.method");
  if (method) {
    const route = attr(s, "http.route", "url.template");
    if (route) return `${method} ${route}`;
    try {
      return `${method} ${new URL(attr(s, "url.full", "http.url")).pathname}`;
    } catch {
      return s.name;
    }
  }
  return s.name;
}

/** A caller's name from its user agent: browsers read as "Browser", tools by their product name. */
export function callerName(userAgent: string): string {
  const ua = userAgent.trim();
  if (!ua) return "Client";
  if (/^Mozilla\//.test(ua) && /(Chrome|Safari|Firefox|Edg|OPR)\//.test(ua)) return "Browser";
  const product = ua.split(/[\s/;(]/)[0];
  return product || "Client";
}

function failed(s: TraceSpan): boolean {
  return s.status === "error" || s.status_code >= 500;
}

/**
 * The map of a request's trace. `request` names the request's own span and its caller; spans of
 * other requests of the trace (a caller upstream of this one) are kept, so the map is the trace's.
 */
export function serviceMap(spans: readonly TraceSpan[], request: { span_id: string; user_agent: string; ip_address?: string; status_code: number; response_time_ms: number; service: string }): ServiceMap {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const ops = new Map<string, Map<string, number>>();

  const self = byId.get(request.span_id)?.service_name || request.service || "This API";
  const serviceId = (name: string) => `svc:${name}`;
  const addNode = (n: MapNode) => {
    const had = nodes.get(n.id);
    if (!had) nodes.set(n.id, n);
    else if (n.self) had.self = true;
    return n.id;
  };
  const addEdge = (from: string, to: string, ms: number, bad: boolean, op: string) => {
    const key = `${from}→${to}`;
    let e = edges.get(key);
    if (!e) {
      e = { from, to, calls: 0, errors: 0, totalMs: 0, maxMs: 0, ops: [] };
      edges.set(key, e);
      ops.set(key, new Map());
    }
    e.calls += 1;
    if (bad) e.errors += 1;
    e.totalMs += ms;
    e.maxMs = Math.max(e.maxMs, ms);
    if (op) {
      const m = ops.get(key) as Map<string, number>;
      m.set(op, (m.get(op) ?? 0) + 1);
    }
  };
  const service = (s: TraceSpan) => addNode({ id: serviceId(s.service_name || self), name: s.service_name || self, kind: "service", detail: "", self: (s.service_name || self) === self });

  // The caller: the request's own client, unless a span upstream in the trace called it.
  const root = byId.get(request.span_id);
  const upstream = root && root.parent_span_id ? byId.get(root.parent_span_id) : undefined;
  addNode({ id: serviceId(self), name: self, kind: "service", detail: "", self: true });
  if (!upstream) {
    const caller = addNode({ id: "client", name: callerName(request.user_agent), kind: "client", detail: request.ip_address || "", self: false });
    addEdge(caller, serviceId(self), request.response_time_ms, request.status_code >= 500, "");
  }

  // Where each service of the trace answers: a client span to the same host:port that the trace
  // holds no answer for (it failed, or was not sampled there) still went to that service.
  const answeredAt = new Map<string, string>();
  for (const s of spans) {
    const parent = s.parent_span_id ? byId.get(s.parent_span_id) : undefined;
    const where = parent && CALLING.has(parent.kind) && (s.kind === "server" || s.kind === "consumer") ? hostPort(parent) : "";
    if (where && s.service_name) answeredAt.set(where, s.service_name);
  }

  for (const s of spans) {
    const parent = s.parent_span_id ? byId.get(s.parent_span_id) : undefined;
    // A service called by another one: its server (or consumer) span under that one's span.
    if (parent && (s.kind === "server" || s.kind === "consumer") && (parent.service_name !== s.service_name || CALLING.has(parent.kind))) {
      // The caller's client span says how the call went from its side; without one, the server's.
      const call = CALLING.has(parent.kind) ? parent : s;
      addEdge(service(parent), service(s), call.duration_ms, failed(call), opOf(call));
      continue;
    }
    if (!CALLING.has(s.kind)) continue;
    // Answered by a service of the trace: the edge above covers it.
    if (spans.some((c) => c.parent_span_id === s.span_id && (c.kind === "server" || c.kind === "consumer"))) continue;
    const at = answeredAt.get(hostPort(s));
    const to = at ? addNode({ id: serviceId(at), name: at, kind: "service", detail: "", self: at === self }) : addNode({ ...peerOf(s), self: false });
    addEdge(service(s), to, s.duration_ms, failed(s), opOf(s));
  }

  for (const [key, e] of edges) {
    e.ops = [...(ops.get(key) as Map<string, number>)].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, 5);
  }

  // Columns: the longest path from a node without callers, so callees sit right of their callers.
  const depth: Record<string, number> = {};
  const into = new Map<string, string[]>();
  for (const e of edges.values()) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  const visit = (id: string, seen: Set<string>): number => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const from = (into.get(id) ?? []).filter((f) => f !== id);
    const d = from.length ? Math.max(...from.map((f) => visit(f, seen))) + 1 : 0;
    depth[id] = d;
    return d;
  };
  for (const id of nodes.keys()) visit(id, new Set());

  return {
    nodes: [...nodes.values()].sort((a, b) => depth[a.id] - depth[b.id] || Number(b.self) - Number(a.self) || a.name.localeCompare(b.name)),
    edges: [...edges.values()].sort((a, b) => depth[a.from] - depth[b.from] || b.calls - a.calls),
    depth,
  };
}
