// "Waiting for your first request" onboarding step (#334): how often it polls the ingest status
// (`GET /projects/{slug}/ingest-status`, #287, through the Route Handler at
// `/api/projects/{slug}/ingest-status`), when it shows troubleshooting, what it says while it
// waits and the test request it offers. Pure, or with its clock and timers injected, so the
// schedule and the hidden-tab pause can be unit tested.
import type { IngestStatus } from "./identity";
import { otlpEndpoint, sdkBaseUrl } from "./install";
import type { Method } from "./instrument";

/** Poll every 3 s at first, every 10 s once two minutes have gone by. */
export const POLL_FAST_MS = 3_000;
export const POLL_SLOW_MS = 10_000;
export const BACKOFF_AFTER_MS = 2 * 60_000;
/** Troubleshooting shows after three minutes without a request. */
export const TROUBLESHOOT_AFTER_MS = 3 * 60_000;

/** The browser's Route Handler for `slug`'s ingest status. */
export function ingestStatusPath(slug: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/ingest-status`;
}

/** How long to wait before the next poll, `elapsed` ms after waiting started. */
export function pollDelay(elapsed: number): number {
  return elapsed >= BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
}

/** One poll, as the screen cares: the status, an expired session (go to `next`), or a failure. */
export type PollResult =
  | { kind: "status"; status: IngestStatus }
  | { kind: "expired"; next: string }
  | { kind: "error"; code: string };

/** Reads the Route Handler's answer (`{ok: true, ...IngestStatus}` or `{ok: false, code, next?}`). */
export function pollResult(status: number, body: unknown): PollResult {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.ok === true) {
    return {
      kind: "status",
      status: {
        received: b.received === true,
        first_at: typeof b.first_at === "string" ? b.first_at : null,
        last_at: typeof b.last_at === "string" ? b.last_at : null,
        count_1h: typeof b.count_1h === "number" ? b.count_1h : 0,
      },
    };
  }
  const code = typeof b.code === "string" ? b.code : status >= 500 ? "unavailable" : "network_error";
  if (status === 401 && code === "session_expired") return { kind: "expired", next: typeof b.next === "string" ? b.next : "/sign-in" };
  return { kind: "error", code };
}

/** What the screen shows about the wait. */
export type WaitState = "waiting" | "slow" | "paused" | "error" | "forbidden" | "received";

/** The live status line for `state`. */
export function statusLine(state: WaitState): string {
  switch (state) {
    case "waiting":
      return "No requests yet. Checking every 3 seconds.";
    case "slow":
      return "No requests yet. Checking every 10 seconds.";
    case "paused":
      return "Paused while this tab is in the background.";
    case "error":
      return "We couldn’t check just now. Trying again.";
    case "forbidden":
      return "You can’t view this project any more, so we can’t check it.";
    case "received":
      return "Your first request arrived.";
  }
}

/** The state an error code puts the screen in: access problems are final, the rest are retried. */
export function errorState(code: string): WaitState {
  return code === "forbidden" || code === "not_found" ? "forbidden" : "error";
}

/** Where the SDK or the OTLP exporter must send to, for the troubleshooting list. */
export function expectedEndpoint(method: Method, ingestUrl: string): string {
  return method === "otlp" ? otlpEndpoint(ingestUrl) : sdkBaseUrl(ingestUrl);
}

/**
 * "Send a test request": one request record to the edge's `/v1/requests` with the key from
 * `APILENS_API_KEY` (the install step's environment line; the raw key is never shown again), for
 * `appId`, stamped now.
 */
export function testRequestCurl(ingestUrl: string, appId: string): string {
  const record = `{"requests":[{"app_id":"${appId}","timestamp":'"$(date +%s)"',"method":"GET","path":"/apilens/test","status_code":200,"response_time_ms":12}]}`;
  return [
    `curl -sS -X POST ${sdkBaseUrl(ingestUrl)}/requests \\`,
    '  -H "X-API-Key: $APILENS_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${record}'`,
  ].join("\n");
}

export interface PollerDeps {
  /** One poll; `signal` aborts it when the tab is hidden or the screen goes away. */
  poll: (signal: AbortSignal) => Promise<PollResult>;
  /** Each result; return false to stop polling (received, expired, forbidden). */
  onResult: (result: PollResult, elapsed: number) => boolean;
  /** Paused (tab hidden) or resumed. */
  onPause?: (paused: boolean) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface Poller {
  /** Polls now, then on the schedule; with `hidden` (the tab starts in the background) it starts paused. */
  start(hidden?: boolean): void;
  /** Tab hidden: no timer, the poll in flight aborted. */
  pause(): void;
  /** Tab visible again: polls now and goes on with the schedule. */
  resume(): void;
  /** For good (unmount, or a final result). */
  stop(): void;
}

/**
 * Polls with {@link pollDelay} between the end of one poll and the start of the next, so polls
 * never overlap. Time since `start` drives the backoff, hidden time included.
 */
export function createPoller({
  poll,
  onResult,
  onPause,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}: PollerDeps): Poller {
  let started = 0;
  let timer: unknown = null;
  let inflight: AbortController | null = null;
  let paused = false;
  let stopped = false;

  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    inflight?.abort();
    inflight = null;
  };

  const tick = async () => {
    timer = null;
    if (stopped || paused) return;
    const ctl = new AbortController();
    inflight = ctl;
    let result: PollResult;
    try {
      result = await poll(ctl.signal);
    } catch {
      result = { kind: "error", code: "network_error" };
    }
    // Paused, stopped or superseded while it ran: drop the answer.
    if (ctl.signal.aborted || inflight !== ctl) return;
    inflight = null;
    const elapsed = now() - started;
    if (!onResult(result, elapsed)) {
      stopped = true;
      return;
    }
    if (!stopped && !paused) timer = setTimer(tick, pollDelay(elapsed));
  };

  return {
    start(hidden = false) {
      started = now();
      stopped = false;
      paused = hidden;
      if (hidden) onPause?.(true);
      else void tick();
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      clear();
      onPause?.(true);
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      onPause?.(false);
      void tick();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
