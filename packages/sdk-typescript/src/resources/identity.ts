/**
 * Where the process runs (D7), sent as the heartbeat's `identity`. Resolved
 * once per process; the ECS metadata fetch (one try, 1 s, unref'd) fills in
 * what it knows later, off the request path.
 *
 * Sources, in order: Downward API env vars, well-known files (the service
 * account namespace, /proc/self/cgroup and mountinfo), then the hostname. A
 * pod name taken from the hostname is marked `hostname_guess: true`; so is
 * any identity where the hostname is all there is.
 */

import type * as nodeOs from "node:os";

import { builtin, processObject } from "../runtime.js";
import { containerId } from "./cgroup.js";
import { type Reader, fileReader } from "./fs.js";

export type Platform = "k8s" | "ecs" | "cloud_run" | "app_engine" | "heroku" | "fly" | "lambda" | "vm" | "bare";

export type Identity = {
  hostname?: string;
  hostname_guess?: boolean;
  container_id?: string;
  pod_name?: string;
  pod_uid?: string;
  namespace?: string;
  node_name?: string;
  platform?: Platform;
  region?: string;
  process_start_time?: string;
};

export type IdentityOptions = {
  env?: Record<string, string | undefined>;
  reader?: Reader;
  hostname?: string;
  /** Epoch ms the process started. */
  startedAtMs?: number;
};

const NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
/** DMI vendors / products of a virtual machine (cloud or local hypervisor). */
const VM_DMI = /amazon|ec2|google|microsoft|azure|qemu|kvm|vmware|virtualbox|xen|openstack|digitalocean|hetzner|bochs|parallels/i;

function first(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** The platform the env vars and files point to (`bare` when none does). */
export function detectPlatform(env: Record<string, string | undefined>, reader: Reader): Platform {
  if (first(env, "AWS_LAMBDA_FUNCTION_NAME")) {
    return "lambda";
  }
  if (first(env, "KUBERNETES_SERVICE_HOST")) {
    return "k8s";
  }
  if (first(env, "K_SERVICE") && first(env, "K_REVISION")) {
    return "cloud_run";
  }
  if (
    first(env, "ECS_CONTAINER_METADATA_URI_V4", "ECS_CONTAINER_METADATA_URI")
    || (env.AWS_EXECUTION_ENV ?? "").startsWith("AWS_ECS")
  ) {
    return "ecs";
  }
  if (first(env, "GAE_SERVICE", "GAE_APPLICATION")) {
    return "app_engine";
  }
  if (first(env, "DYNO")) {
    return "heroku";
  }
  if (first(env, "FLY_APP_NAME", "FLY_MACHINE_ID")) {
    return "fly";
  }
  const dmi = `${reader.text("/sys/class/dmi/id/sys_vendor") ?? ""} ${reader.text("/sys/class/dmi/id/product_name") ?? ""}`;
  return VM_DMI.test(dmi) ? "vm" : "bare";
}

/** The pod uid in the cgroup path (`pod8a6f…_…` or `pod8a6f…-…`) or kubelet mounts. */
export function podUidFromFiles(reader: Reader): string | undefined {
  const uid = /pod([0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12})/;
  const cgroup = uid.exec(reader.text("/proc/self/cgroup") ?? "");
  if (cgroup) {
    return cgroup[1].replace(/_/g, "-");
  }
  const mount = /\/kubelet\/pods\/([0-9a-f-]{36})\//.exec(reader.text("/proc/self/mountinfo") ?? "");
  return mount?.[1];
}

function region(env: Record<string, string | undefined>): string | undefined {
  return first(env, "AWS_REGION", "AWS_DEFAULT_REGION", "FLY_REGION", "GOOGLE_CLOUD_REGION");
}

/** ISO 8601 UTC at second precision. */
function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function hostName(): string | undefined {
  try {
    return builtin<typeof nodeOs>("os")?.hostname?.() || undefined;
  } catch {
    return undefined;
  }
}

/** Epoch ms the process started (`process.uptime()` back from now). */
export function processStartMs(): number | undefined {
  try {
    const uptime = (processObject() as { uptime?: () => number } | undefined)?.uptime?.();
    return typeof uptime === "number" && Number.isFinite(uptime) ? Date.now() - uptime * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the identity from env and files (synchronous; no network). */
export function resolveIdentity(options: IdentityOptions = {}): Identity {
  const env = options.env ?? processObject()?.env ?? {};
  const reader = options.reader ?? fileReader();
  const hostname = options.hostname ?? (first(env, "HOSTNAME") || hostName());
  const platform = detectPlatform(env, reader);
  const out: Identity = { platform };
  if (hostname) {
    out.hostname = hostname;
  }

  const id = containerId(reader);
  if (id) {
    out.container_id = id;
  }

  if (platform === "k8s") {
    const podName = first(env, "POD_NAME", "K8S_POD_NAME", "KUBERNETES_POD_NAME");
    // Without the Downward API the pod name is the hostname, except with
    // hostNetwork, where it is the node's: a guess either way.
    out.pod_name = podName ?? hostname;
    out.hostname_guess = !podName;
    const namespace = first(env, "POD_NAMESPACE", "K8S_NAMESPACE", "KUBERNETES_NAMESPACE")
      ?? (reader.text(NAMESPACE_FILE)?.trim() || undefined);
    if (namespace) {
      out.namespace = namespace;
    }
    const node = first(env, "NODE_NAME", "K8S_NODE_NAME", "KUBERNETES_NODE_NAME");
    if (node) {
      out.node_name = node;
    }
    const uid = first(env, "POD_UID", "K8S_POD_UID") ?? podUidFromFiles(reader);
    if (uid) {
      out.pod_uid = uid;
    }
  } else {
    // Only the hostname says where this runs.
    out.hostname_guess = true;
  }
  if (out.pod_name === undefined) {
    delete out.pod_name;
  }

  const r = region(env);
  if (r) {
    out.region = r;
  }
  const started = options.startedAtMs ?? processStartMs();
  if (started !== undefined) {
    out.process_start_time = isoSeconds(started);
  }
  return out;
}

type EcsContainer = {
  DockerId?: unknown;
  Labels?: Record<string, unknown>;
  Limits?: { CPU?: unknown; Memory?: unknown };
};

export type EcsMetadata = { containerId?: string; region?: string };

/**
 * One fetch of the ECS task metadata endpoint v4 (`ECS_CONTAINER_METADATA_URI_V4`),
 * bounded by `timeoutMs` and never throwing. The timer is unref'd, so it never
 * keeps the process alive.
 */
export async function fetchEcsMetadata(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  timeoutMs = 1000,
): Promise<EcsMetadata | undefined> {
  const uri = first(env, "ECS_CONTAINER_METADATA_URI_V4");
  if (!uri) {
    return undefined;
  }
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(undefined);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const request = (async (): Promise<EcsMetadata | undefined> => {
      const response = await fetchImpl(uri, { signal: controller?.signal });
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as EcsContainer;
      const out: EcsMetadata = {};
      if (typeof body.DockerId === "string" && /^[0-9a-f-]{12,128}$/.test(body.DockerId)) {
        out.containerId = body.DockerId;
      }
      const arn = body.Labels?.["com.amazonaws.ecs.task-arn"];
      const m = typeof arn === "string" ? /^arn:aws[^:]*:ecs:([a-z0-9-]+):/.exec(arn) : null;
      if (m) {
        out.region = m[1];
      }
      return out;
    })().catch(() => undefined);
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
