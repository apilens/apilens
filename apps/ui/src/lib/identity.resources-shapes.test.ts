// The runtime resources types of identity.ts (M7 #1127) against api/openapi/apilens.v1.json: each
// fixture is typed with every field set, so TypeScript rejects a field the type lacks and this test
// rejects a field the spec lacks or the spec has that the type leaves out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  AppInstance,
  InstanceEvent,
  InstanceEvents,
  InstanceRequests,
  InstanceResources,
  InstanceRuntime,
  InstanceSignal,
  InstanceSpark,
  ResourcePoint,
  ResourceSeries,
} from "./identity";

vi.mock("server-only", () => ({}));

interface Schema {
  properties?: Record<string, { enum?: string[] }>;
  required?: string[];
}
const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../api/openapi/apilens.v1.json", import.meta.url)), "utf8"),
) as { components: { schemas: Record<string, Schema> } };

const T = "2026-11-25T10:00:00Z";
const runtime: Required<InstanceRuntime> = { event_loop_p99: 18, heap_used: 140 * 2 ** 20, gc_pause_ms: 3 };
const resources: Required<InstanceResources> = {
  limit_source: "cgroup_v2",
  cpu_pct: 28,
  cpu_cores: 0.28,
  cpu_limit_cores: 1,
  mem_working_set: 447 * 2 ** 20,
  mem_rss: 354 * 2 ** 20,
  mem_pss: 290 * 2 ** 20,
  mem_limit: 2 ** 30,
  mem_pct: 43.6,
  throttled_ratio: 0.03,
  runtime,
};
const spark: Required<InstanceSpark> = { cpu_pct: [28, null], mem: [354 * 2 ** 20, null] };
const requests: Required<InstanceRequests> = { rpm: 205, p95_ms: 197, error_pct: 0.5 };
const signal: Required<InstanceSignal> = { kind: "leak", metric: "mem_rss", value: 40.3, detail: "RSS grew 40 MB/h" };
const instance: Required<AppInstance> = {
  instance_id: "gw-a2-91d4",
  environment: "production",
  status: "reporting",
  sdk_name: "apilenss",
  sdk_version: "0.5.0",
  sdk_latest_version: "0.5.0",
  sdk_outdated: false,
  runtime: "python 3.12.7",
  release: "2026.11.25-2",
  commit: "3f9a2c1",
  pid: 9,
  stats: {},
  first_seen_at: T,
  last_seen_at: T,
  hostname: "checkout-api-7d9f8b6c4-x2k4p",
  hostname_guess: false,
  container_id: "containerd://5b1e2f3a",
  pod_name: "checkout-api-7d9f8b6c4-x2k4p",
  pod_uid: "5b1e2f3a-9c8d-4e7f-a6b5-1d2c3b4a5f60",
  namespace: "shop",
  node_name: "gke-shop-pool-a-1c2d",
  platform: "k8s",
  region: "europe-west1",
  process_start_time: T,
  uptime_s: 18000,
  ended_at: null,
  ended_reason: "",
  resources,
  spark,
  requests,
  signals: [signal],
};
const point: Required<ResourcePoint> = { t: T, avg: 40, min: 20, max: 60, instances: 2 };
const series: Required<ResourceSeries> = { metric: "cpu_pct", unit: "percent", range: "6h", from: T, to: T, bucket_seconds: 300, limit: null, points: [point] };
const event: Required<InstanceEvent> = { kind: "oom", at: T, environment: "production", instance_id: "gw-b1", container_id: "c", pod_name: "p", details: {} };
const events: Required<InstanceEvents> = { range: "6h", from: T, to: T, events: [event] };

const cases: [string, object][] = [
  ["InstanceRuntime", runtime],
  ["InstanceResources", resources],
  ["InstanceSpark", spark],
  ["InstanceRequests", requests],
  ["InstanceSignal", signal],
  ["AppInstance", instance],
  ["ResourcePoint", point],
  ["ResourceSeries", series],
  ["InstanceEvent", event],
  ["InstanceEventsOutputBody", events],
];

describe("runtime resources types match the committed OpenAPI spec", () => {
  it.each(cases)("%s", (name, fixture) => {
    const schema = spec.components.schemas[name];
    expect(schema, `${name} is not in the spec`).toBeDefined();
    const props = Object.keys(schema.properties ?? {}).filter((p) => p !== "$schema").sort();
    expect(Object.keys(fixture).sort()).toEqual(props);
  });

  it("keeps the enums of the spec", () => {
    const s = spec.components.schemas;
    const units: ResourceSeries["unit"][] = ["percent", "cores", "bytes", "ms", "ratio", "count"];
    expect(s.ResourceSeries.properties?.unit.enum).toEqual(units);
    const kinds: InstanceEvent["kind"][] = ["restart", "oom", "suspected_oom", "oom_kill"];
    expect(s.InstanceEvent.properties?.kind.enum).toEqual(kinds);
    const signals: InstanceSignal["kind"][] = ["noisy", "leak"];
    expect(s.InstanceSignal.properties?.kind.enum).toEqual(signals);
    const status: NonNullable<AppInstance["status"]>[] = ["reporting", "stale", "silent"];
    expect(s.AppInstance.properties?.status.enum).toEqual(status);
  });
});
