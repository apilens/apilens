import { describe, expect, it } from "vitest";
import type { TraceSpan } from "./identity";
import { callerName, opOf, peerOf, serviceMap } from "./service-map";

const span = (p: Partial<TraceSpan> & { span_id: string }): TraceSpan => ({
  parent_span_id: "",
  name: "span",
  kind: "internal",
  service_name: "motadata-backend",
  start: "2026-11-25T07:00:00Z",
  duration_ms: 10,
  status: "ok",
  status_code: 0,
  status_message: "",
  attributes: {},
  events: null,
  links: null,
  ...p,
});

const REQ = { span_id: "root", user_agent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", ip_address: "10.0.0.7", status_code: 200, response_time_ms: 120, service: "" };

describe("serviceMap", () => {
  it("draws the browser, the service and every peer it called, with calls, errors and latency", () => {
    const spans = [
      span({ span_id: "root", name: "GET", kind: "server", duration_ms: 120 }),
      span({ span_id: "pg1", parent_span_id: "root", name: "SELECT motadata.tbl_user", kind: "client", duration_ms: 4, attributes: { "server.address": "localhost", "server.port": "5432", "db.operation": "SELECT" } }),
      span({ span_id: "pg2", parent_span_id: "root", name: "SELECT motadata.tbl_user", kind: "client", duration_ms: 6, attributes: { "server.address": "localhost", "server.port": "5432" } }),
      span({ span_id: "ch", parent_span_id: "root", name: "SELECT default", kind: "client", duration_ms: 30, attributes: { "server.address": "172.16.12.186", "server.port": "8123", "db.system": "clickhouse", "http.request.method": "POST" } }),
      span({ span_id: "mira", parent_span_id: "root", name: "GET", kind: "client", duration_ms: 80, status: "error", status_code: 502, attributes: { "server.address": "127.0.0.1", "server.port": "8000", "http.request.method": "GET", "url.full": "http://127.0.0.1:8000/mira-harness/models?x=1" } }),
    ];
    const m = serviceMap(spans, REQ);
    expect(m.nodes.map((n) => [n.name, n.kind, n.detail, m.depth[n.id]])).toEqual([
      ["Browser", "client", "10.0.0.7", 0],
      ["motadata-backend", "service", "", 1],
      ["127.0.0.1:8000", "http", "HTTP", 2],
      ["ClickHouse", "database", "172.16.12.186:8123", 2],
      ["PostgreSQL", "database", "localhost:5432", 2],
    ]);
    const pg = m.edges.find((e) => e.to.startsWith("db:PostgreSQL"));
    expect(pg).toMatchObject({ calls: 2, errors: 0, totalMs: 10, maxMs: 6, ops: [{ name: "SELECT motadata.tbl_user", calls: 2 }] });
    expect(m.edges.find((e) => e.to === "http:127.0.0.1:8000")).toMatchObject({ calls: 1, errors: 1, ops: [{ name: "GET /mira-harness/models", calls: 1 }] });
    expect(m.edges[0]).toMatchObject({ from: "client", to: "svc:motadata-backend", calls: 1, totalMs: 120 });
  });

  it("joins a service that reported its own spans, and what it called", () => {
    const spans = [
      span({ span_id: "root", kind: "server" }),
      span({ span_id: "call", parent_span_id: "root", kind: "client", duration_ms: 90, attributes: { "server.address": "127.0.0.1", "server.port": "8000", "http.request.method": "POST", "url.full": "http://127.0.0.1:8000/agents/run" } }),
      span({ span_id: "m", parent_span_id: "call", kind: "server", service_name: "mira-ai", duration_ms: 85 }),
      span({ span_id: "llm", parent_span_id: "m", kind: "client", service_name: "mira-ai", name: "POST", duration_ms: 70, attributes: { "server.address": "api.anthropic.com", "server.port": "443", "http.request.method": "POST", "url.full": "https://api.anthropic.com/v1/messages" } }),
    ];
    const m = serviceMap(spans, REQ);
    expect(m.nodes.map((n) => [n.name, m.depth[n.id]])).toEqual([
      ["Browser", 0],
      ["motadata-backend", 1],
      ["mira-ai", 2],
      ["api.anthropic.com:443", 3],
    ]);
    expect(m.edges.find((e) => e.to === "svc:mira-ai")).toMatchObject({ from: "svc:motadata-backend", calls: 1, totalMs: 90, ops: [{ name: "POST /agents/run", calls: 1 }] });
    // The client span answered by mira-ai is not also a peer of its own.
    expect(m.nodes.some((n) => n.id === "http:127.0.0.1:8000")).toBe(false);
  });

  it("counts a failed call to a service's address as a call to that service", () => {
    const at = { "server.address": "127.0.0.1", "server.port": "8000", "http.request.method": "POST", "url.full": "http://127.0.0.1:8000/runs" };
    const spans = [
      span({ span_id: "root", kind: "server" }),
      span({ span_id: "ok", parent_span_id: "root", kind: "client", attributes: at }),
      span({ span_id: "m", parent_span_id: "ok", kind: "server", service_name: "mira-ai" }),
      span({ span_id: "bad", parent_span_id: "root", kind: "client", status: "error", status_code: 502, attributes: at }),
    ];
    const m = serviceMap(spans, REQ);
    expect(m.nodes.map((n) => n.name)).toEqual(["Browser", "motadata-backend", "mira-ai"]);
    expect(m.edges.find((e) => e.to === "svc:mira-ai")).toMatchObject({ calls: 2, errors: 1 });
  });

  it("starts at the upstream service when another request of the trace called this one", () => {
    const spans = [
      span({ span_id: "up", kind: "server", service_name: "gateway" }),
      span({ span_id: "upc", parent_span_id: "up", kind: "client", service_name: "gateway", attributes: { "http.request.method": "GET", "url.full": "http://backend/api" } }),
      span({ span_id: "root", parent_span_id: "upc", kind: "server" }),
    ];
    const m = serviceMap(spans, REQ);
    expect(m.nodes.map((n) => [n.name, n.self])).toEqual([
      ["gateway", false],
      ["motadata-backend", true],
    ]);
  });

  it("is the caller and the service alone when the request has no spans", () => {
    const m = serviceMap([], { ...REQ, user_agent: "curl/8.7.1", service: "shop", status_code: 503 });
    expect(m.nodes.map((n) => n.name)).toEqual(["curl", "shop"]);
    expect(m.edges).toEqual([expect.objectContaining({ from: "client", to: "svc:shop", errors: 1 })]);
  });
});

describe("naming", () => {
  it("names callers, peers and operations", () => {
    expect(callerName("")).toBe("Client");
    expect(callerName("python-httpx/0.27")).toBe("python-httpx");
    expect(peerOf(span({ span_id: "a", kind: "client", attributes: { "peer.service": "billing", "server.address": "b", "server.port": "1" } }))).toMatchObject({ name: "billing", detail: "b:1" });
    expect(peerOf(span({ span_id: "a", kind: "producer", attributes: { "messaging.system": "kafka", "server.address": "k" } }))).toMatchObject({ name: "Kafka", kind: "messaging" });
    expect(opOf(span({ span_id: "a", attributes: { "http.request.method": "GET", "http.route": "/users/{id}" } }))).toBe("GET /users/{id}");
    expect(opOf(span({ span_id: "a", name: "SELECT x" }))).toBe("SELECT x");
  });
});
