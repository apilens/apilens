// The runtime resources client methods (M7 #1127) against the fake identity
// (e2e-fake/fake-identity.ts) and its seeded `k8s-python` scenario: 4 gunicorn workers in 2 pods
// (one leaking, the other pod OOMKilled and restarted), a Lambda instance and an old-SDK instance.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type IdentityClient, createClient } from "./identity";

vi.mock("server-only", () => ({}));

const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
let server: ChildProcess;
let client: IdentityClient;
let accessToken = "";

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("../../e2e-fake/fake-identity.ts", import.meta.url))], {
    env: { ...process.env, FAKE_IDENTITY_PORT: String(PORT), FAKE_IDENTITY_UI_URL: "http://localhost:3999" },
    stdio: "ignore",
  });
  client = createClient({ baseUrl: BASE });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const { code } = (await (await post("/__fake/handoff", { next: "/" })).json()) as { code: string };
  const bundle = await client.handoff({ code });
  if (!("access_token" in bundle)) throw new Error("expected a session bundle");
  accessToken = bundle.access_token;
  expect((await post("/__fake/apps", { apps: [{ id: APP, slug: "checkout-api", name: "Checkout API", resources: "k8s-python" }] })).status).toBe(204);
}, 15_000);

afterAll(() => {
  server?.kill();
});

describe("runtime resources", () => {
  it("lists instances with identity, resources, sparklines, requests and signals", async () => {
    const status = await client.appHealthStatus("shop", APP, { accessToken });
    const instances = status.instances ?? [];
    expect(instances).toHaveLength(8);
    const leak = instances.find((i) => i.instance_id === "gw-a2-91d4");
    expect(leak).toMatchObject({ platform: "k8s", pod_name: "checkout-api-7d9f8b6c4-x2k4p", namespace: "shop", ended_reason: "" });
    expect(leak?.signals?.[0]).toMatchObject({ kind: "leak" });
    expect(leak?.spark?.cpu_pct).toHaveLength(60);
    expect(leak?.resources?.limit_source).toBe("cgroup_v2");
    // Not in the status contract yet; the fake sends the container's processes for the drawer.
    expect(((leak?.resources as unknown as { processes: { pid: number }[] }).processes ?? []).some((p) => p.pid === 9)).toBe(true);
    expect(instances.filter((i) => i.ended_reason === "oom")).toHaveLength(2);
    const old = instances.find((i) => i.instance_id === "legacy-0f2b");
    expect(old?.resources).toBeNull();
    expect(old?.requests).toBeNull();
    const fn = instances.find((i) => i.platform === "lambda");
    expect(fn?.resources?.cpu_pct).toBeNull();
    expect(fn?.hostname_guess).toBe(true);
  });

  it("counts container memory once per container, not once per worker", async () => {
    const s = await client.appResources("shop", APP, { metric: "mem_working_set", range: "1h", environment: "production" }, { accessToken });
    expect(s.unit).toBe("bytes");
    expect(s.limit).toBe(1024 * 1024 * 1024);
    const last = (s.points ?? []).filter((p) => p.avg !== null).at(-1);
    // Two pods plus the Lambda instance: three scopes, though five workers run.
    expect(last?.instances).toBe(3);
    expect(last?.max ?? 0).toBeLessThan(1024 * 1024 * 1024);
  });

  it("answers gaps as nulls, never zeros", async () => {
    const s = await client.appResources("shop", APP, { metric: "mem_rss", range: "6h", instance: "gw-a1-5e1c" }, { accessToken });
    const points = s.points ?? [];
    expect(points.some((p) => p.avg === null && p.min === null && p.max === null && p.instances === 0)).toBe(true);
    expect(points.every((p) => p.avg === null || p.avg > 0)).toBe(true);
  });

  it("lists the OOM kills of the window", async () => {
    const { events } = await client.instanceEvents("shop", APP, { range: "6h" }, { accessToken });
    expect((events ?? []).map((e) => [e.kind, e.pod_name])).toEqual([
      ["oom", "checkout-api-7d9f8b6c4-m8q2z"],
      ["oom", "checkout-api-7d9f8b6c4-m8q2z"],
    ]);
    expect((await client.instanceEvents("shop", APP, { range: "1h" }, { accessToken })).events).toEqual([]);
  });
});
