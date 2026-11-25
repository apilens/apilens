/**
 * Runtime resources (M7): what the client adds to every heartbeat.
 *
 * - `identity`: where the process runs, resolved once (D7).
 * - `resources`: the sampler's window (D1, contract v1).
 *
 * Modes:
 * - `node`: the main thread of a Node-compatible process (Node, Bun, Deno)
 *   samples. Each cluster / PM2 worker is its own process and samples itself.
 * - `edge`: Cloudflare Workers, Vercel Edge, anything without
 *   `process.versions.node`: `capabilities: []`, nothing else (D13).
 * - `off`: `captureResources: false`, or a `worker_threads` worker (the main
 *   thread already samples this process): no `resources`.
 *
 * `identity` is sent whenever this is a process's main thread (`node` mode, or
 * `off` because of `captureResources: false`): it is tiny and the server needs
 * it to infer restarts. The kill switch turns off `resources` only. Edge
 * runtimes and `worker_threads` workers send no identity.
 */

import { builtin, isEdgeRuntime, processObject } from "../runtime.js";
import { type EcsMetadata, type Identity, fetchEcsMetadata, resolveIdentity } from "./identity.js";
import { type ResourcesPolicy, ResourceSampler, edgeResourcesBlock } from "./sampler.js";
import type { ResourcesBlock } from "./types.js";

export { RESOURCES_INTERVAL_MS, RESOURCES_MIN_INTERVAL_MS, ResourceSampler, type ResourcesPolicy } from "./sampler.js";
export type { Identity } from "./identity.js";
export type { ResourcesBlock } from "./types.js";

export type ResourcesMode = "node" | "edge" | "off";

/** Whether this is a `worker_threads` worker (not the main thread). */
export function isWorkerThread(): boolean {
  try {
    const wt = builtin<{ isMainThread?: boolean }>("worker_threads");
    return wt?.isMainThread === false;
  } catch {
    return false;
  }
}

export function resourcesMode(captureResources: boolean): ResourcesMode {
  if (!captureResources) {
    return "off";
  }
  if (isEdgeRuntime()) {
    return "edge";
  }
  return isWorkerThread() ? "off" : "node";
}

export type RuntimeResourcesOptions = {
  captureResources: boolean;
  intervalMs: number;
  captureProcessList: boolean;
  /** Inline flush mode: no timer, `sampleIfDue()` runs at each flush. */
  inline: boolean;
  fetchImpl?: typeof fetch;
};

/** Whether this process sends `identity`: a Node main thread, whatever `captureResources` says. */
export function sendsIdentity(): boolean {
  return !isEdgeRuntime() && !isWorkerThread();
}

export class RuntimeResources {
  readonly mode: ResourcesMode;
  /** Whether heartbeats carry `identity` (independent of `captureResources`). */
  readonly identityEnabled: boolean;
  private sampler?: ResourceSampler;
  private identityValue?: Identity;
  private ecsStarted = false;
  private policy?: ResourcesPolicy;

  constructor(private readonly options: RuntimeResourcesOptions) {
    this.mode = resourcesMode(options.captureResources);
    this.identityEnabled = this.mode === "node" || (this.mode === "off" && sendsIdentity());
  }

  /** The process identity (resolved on first use; never throws). */
  identity(): Identity | undefined {
    if (!this.identityEnabled) {
      return undefined;
    }
    if (!this.identityValue) {
      try {
        this.identityValue = resolveIdentity();
      } catch {
        this.identityValue = {};
      }
    }
    return this.identityValue;
  }

  /** Start sampling (and the one ECS metadata fetch). Idempotent. */
  start(): void {
    if (this.mode !== "node") {
      // Kill switch: no sampler, but identity still gets its ECS container id.
      if (this.identityEnabled) {
        this.startEcs();
      }
      return;
    }
    if (!this.sampler) {
      this.sampler = new ResourceSampler({
        intervalMs: this.options.intervalMs,
        captureProcessList: this.options.captureProcessList,
        platform: this.identity()?.platform,
        timers: !this.options.inline,
        env: processObject()?.env,
      });
      this.sampler.applyPolicy(this.policy);
    }
    this.sampler.start();
    this.startEcs();
  }

  stop(): void {
    this.sampler?.stop();
  }

  private startEcs(): void {
    const identity = this.identity();
    if (this.ecsStarted || identity?.platform !== "ecs" || !this.options.fetchImpl) {
      return;
    }
    this.ecsStarted = true;
    const fetchImpl = this.options.fetchImpl;
    void fetchEcsMetadata(processObject()?.env ?? {}, fetchImpl)
      .then((meta: EcsMetadata | undefined) => {
        if (!meta || !this.identityValue) {
          return;
        }
        if (meta.containerId && !this.identityValue.container_id) {
          this.identityValue.container_id = meta.containerId;
        }
        if (meta.region && !this.identityValue.region) {
          this.identityValue.region = meta.region;
        }
      })
      .catch(() => undefined);
  }

  /** Inline flush mode: sample at the end of an invocation when one is due. */
  sampleIfDue(): void {
    this.sampler?.sampleIfDue();
  }

  /** Apply the heartbeat response's `policy.resources` (undefined: local only). */
  applyPolicy(policy: ResourcesPolicy | undefined): void {
    this.policy = policy;
    this.sampler?.applyPolicy(policy);
  }

  /** `identity` and `resources` for one heartbeat body (both may be absent). */
  heartbeatFields(): { identity?: Identity; resources?: ResourcesBlock } {
    try {
      if (this.mode === "edge") {
        return { resources: edgeResourcesBlock() };
      }
      const identity = this.identity();
      const resources = this.mode === "node" ? this.sampler?.drain() : undefined;
      return {
        ...(identity && Object.keys(identity).length > 0 ? { identity: { ...identity } } : {}),
        ...(resources ? { resources } : {}),
      };
    } catch {
      return {};
    }
  }
}
