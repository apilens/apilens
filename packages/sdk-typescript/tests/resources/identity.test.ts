/**
 * Platform and Kubernetes identity (C4, #1109) and `instance_id` on request
 * records (C9, #1114).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import "../../src/node.js";
import { ApiLensClient } from "../../src/client.js";
import { type Reader, fileReader } from "../../src/resources/fs.js";
import { fetchEcsMetadata, resolveIdentity } from "../../src/resources/identity.js";

const CGROUP = join(dirname(fileURLToPath(import.meta.url)), "../../../../testdata/cgroup");
const STARTED = Date.UTC(2026, 10, 25, 8, 0, 0, 450);

/** A reader over an in-memory file map. */
function files(map: Record<string, string>): Reader {
  return {
    text: (path) => map[path] ?? null,
    list: () => null,
    isDir: () => false,
  };
}

const none = files({});

describe("identity matrix", () => {
  const cases: Array<[string, Record<string, string>, Reader, Record<string, unknown>]> = [
    [
      "kubernetes with the Downward API",
      {
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
        POD_NAME: "storefront-7d9c8b6f5-x2k4q",
        POD_NAMESPACE: "shop",
        POD_UID: "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b",
        NODE_NAME: "gke-prod-pool-1-a1b2c3",
      },
      fileReader(join(CGROUP, "v2_k8s_nested/root")),
      {
        platform: "k8s",
        hostname: "storefront-7d9c8b6f5-x2k4q",
        hostname_guess: false,
        pod_name: "storefront-7d9c8b6f5-x2k4q",
        pod_uid: "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b",
        namespace: "shop",
        node_name: "gke-prod-pool-1-a1b2c3",
        container_id: "3f4e9c2b1a0d8e7f6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e",
        process_start_time: "2026-11-25T08:00:00Z",
      },
    ],
    [
      "kubernetes without env: pod from hostname (a guess), namespace file, uid from cgroup",
      { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
      (() => {
        const real = fileReader(join(CGROUP, "v2_k8s_nested/root"));
        return {
          ...real,
          text: (path: string) =>
            path === "/var/run/secrets/kubernetes.io/serviceaccount/namespace" ? "shop\n" : real.text(path),
        };
      })(),
      {
        platform: "k8s",
        hostname_guess: true,
        pod_name: "storefront-7d9c8b6f5-x2k4q",
        namespace: "shop",
        pod_uid: "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b",
      },
    ],
    [
      "cgroup v2 namespaced: the container id from mountinfo",
      { KUBERNETES_SERVICE_HOST: "10.0.0.1", POD_NAME: "p" },
      fileReader(join(CGROUP, "v2_namespaced_limited/root")),
      { container_id: "3f4e9c2b1a0d8e7f6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e", pod_uid: "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b" },
    ],
    [
      "containerd + cgroup v2 (kind): sandbox hostname, id and pod uid from the termination-log mount",
      { KUBERNETES_SERVICE_HOST: "10.0.0.1", POD_NAME: "p" },
      fileReader(join(CGROUP, "v2_kind_sandbox/root")),
      {
        container_id: "k8s:8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b/app/5f2c9e1a",
        pod_uid: "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b",
      },
    ],
    ["ecs", { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/x", AWS_REGION: "eu-west-1" }, none, { platform: "ecs", region: "eu-west-1", hostname_guess: true }],
    ["lambda", { AWS_LAMBDA_FUNCTION_NAME: "fn", AWS_REGION: "us-east-1" }, none, { platform: "lambda", region: "us-east-1" }],
    ["cloud run", { K_SERVICE: "api", K_REVISION: "api-00001" }, none, { platform: "cloud_run" }],
    ["app engine", { GAE_SERVICE: "default", GAE_APPLICATION: "p~app" }, none, { platform: "app_engine" }],
    ["heroku", { DYNO: "web.1" }, none, { platform: "heroku" }],
    ["fly.io", { FLY_APP_NAME: "api", FLY_REGION: "ams" }, none, { platform: "fly", region: "ams" }],
    ["a VM (DMI vendor)", {}, files({ "/sys/class/dmi/id/sys_vendor": "Google\n" }), { platform: "vm", hostname_guess: true }],
    ["bare metal or a laptop", {}, none, { platform: "bare", hostname_guess: true }],
  ];

  for (const [name, env, reader, want] of cases) {
    it(name, () => {
      const hostname = env.POD_NAME ?? "storefront-7d9c8b6f5-x2k4q";
      const identity = resolveIdentity({ env, reader, hostname, startedAtMs: STARTED });
      expect(identity).toMatchObject(want);
      expect(identity.process_start_time).toBe("2026-11-25T08:00:00Z");
    });
  }

  it("only the hostname known: hostname_guess and nothing else invented", () => {
    const identity = resolveIdentity({ env: {}, reader: none, hostname: "neels-macbook.local", startedAtMs: STARTED });
    expect(identity).toEqual({
      platform: "bare",
      hostname: "neels-macbook.local",
      hostname_guess: true,
      process_start_time: "2026-11-25T08:00:00Z",
    });
  });
});

describe("ECS metadata", () => {
  const env = { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/abc" };

  it("reads the container id and region", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      DockerId: "5a0d5ceddf6c44c1928d367a815d890f-1234567890",
      Labels: { "com.amazonaws.ecs.task-arn": "arn:aws:ecs:eu-west-1:123456789012:task/c/5a0d" },
    }))) as typeof fetch;
    expect(await fetchEcsMetadata(env, fetchImpl)).toEqual({
      containerId: "5a0d5ceddf6c44c1928d367a815d890f-1234567890",
      region: "eu-west-1",
    });
  });

  it("a failure is silent", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(fetchEcsMetadata(env, fetchImpl)).resolves.toBeUndefined();
    await expect(fetchEcsMetadata(env, (async () => new Response("no", { status: 500 })) as typeof fetch)).resolves.toBeUndefined();
  });

  it("is bounded by its timeout", async () => {
    const hang = (() => new Promise<Response>(() => {})) as typeof fetch;
    const t0 = Date.now();
    await expect(fetchEcsMetadata(env, hang, 100)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does nothing off ECS", async () => {
    let called = false;
    await fetchEcsMetadata({}, (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch);
    expect(called).toBe(false);
  });
});

describe("instance_id on request records (C9)", () => {
  afterEach(async () => {
    await ApiLensClient.shutdown();
  });

  it("every queued and sent record carries the client's instance id", async () => {
    const bodies: string[] = [];
    const client = new ApiLensClient({
      apiKey: "k",
      compress: false,
      logger: { debug() {}, warn() {} },
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 202 });
      }) as typeof fetch,
    });
    client.capture({ method: "GET", path: "/a", status_code: 200, response_time_ms: 1 });
    client.capture({ method: "POST", path: "/b", status_code: 500, response_time_ms: 2 });
    expect(client.queue.map((r) => r.instance_id)).toEqual([client.instanceId, client.instanceId]);
    await client.flushAll();
    const sent = JSON.parse(bodies[0]).requests as Array<{ instance_id: string }>;
    expect(sent.map((r) => r.instance_id)).toEqual([client.instanceId, client.instanceId]);
  });
});
