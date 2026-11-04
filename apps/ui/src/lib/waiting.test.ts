import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_AFTER_MS,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  type PollResult,
  createPoller,
  errorState,
  expectedEndpoint,
  ingestStatusPath,
  pollDelay,
  pollResult,
  statusLine,
  testRequestCurl,
} from "./waiting";

const waiting: PollResult = { kind: "status", status: { received: false, first_at: null, last_at: null, count_1h: 0 } };

describe("pollDelay", () => {
  it("polls every 3 s, then every 10 s after two minutes", () => {
    expect(pollDelay(0)).toBe(POLL_FAST_MS);
    expect(pollDelay(BACKOFF_AFTER_MS - 1)).toBe(3_000);
    expect(pollDelay(BACKOFF_AFTER_MS)).toBe(POLL_SLOW_MS);
    expect(pollDelay(10 * 60_000)).toBe(10_000);
  });
});

describe("pollResult", () => {
  it("reads the status", () => {
    expect(pollResult(200, { ok: true, received: true, first_at: "2026-11-04T10:00:00Z", last_at: "2026-11-04T10:00:01Z", count_1h: 2 })).toEqual({
      kind: "status",
      status: { received: true, first_at: "2026-11-04T10:00:00Z", last_at: "2026-11-04T10:00:01Z", count_1h: 2 },
    });
    expect(pollResult(200, { ok: true })).toEqual(waiting);
  });

  it("sends an expired session to sign in", () => {
    expect(pollResult(401, { ok: false, code: "session_expired", next: "/sign-in?reason=session_expired" })).toEqual({
      kind: "expired",
      next: "/sign-in?reason=session_expired",
    });
  });

  it("passes other codes through, and names unreadable answers", () => {
    expect(pollResult(403, { ok: false, code: "forbidden" })).toEqual({ kind: "error", code: "forbidden" });
    expect(pollResult(502, null)).toEqual({ kind: "error", code: "unavailable" });
    expect(pollResult(0, "nope")).toEqual({ kind: "error", code: "network_error" });
  });
});

describe("status line", () => {
  it("says what the screen is doing", () => {
    expect(statusLine("waiting")).toMatch(/every 3 seconds/);
    expect(statusLine("slow")).toMatch(/every 10 seconds/);
    expect(statusLine("paused")).toMatch(/background/);
    expect(errorState("forbidden")).toBe("forbidden");
    expect(errorState("not_found")).toBe("forbidden");
    expect(errorState("unavailable")).toBe("error");
  });
});

describe("troubleshooting", () => {
  it("routes through the Route Handler", () => {
    expect(ingestStatusPath("kramerica-oil")).toBe("/api/projects/kramerica-oil/ingest-status");
  });

  it("names the endpoint the method sends to", () => {
    expect(expectedEndpoint("sdk", "https://ingest.example.com/")).toBe("https://ingest.example.com/v1");
    expect(expectedEndpoint("otlp", "https://ingest.example.com")).toBe("https://ingest.example.com/otlp");
  });

  it("builds a curl to the edge's /v1/requests with the key from the environment", () => {
    const curl = testRequestCurl("https://ingest.example.com", "checkout");
    expect(curl).toContain("curl -sS -X POST https://ingest.example.com/v1/requests");
    expect(curl).toContain('-H "X-API-Key: $APILENS_API_KEY"');
    expect(curl).toContain('"app_id":"checkout"');
    expect(curl).toContain(`"timestamp":'"$(date +%s)"'`);
    expect(curl).not.toMatch(/apl_live_/);
  });
});

describe("createPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(results: () => PollResult = () => waiting) {
    const poll = vi.fn(async (_signal: AbortSignal) => results());
    const seen: number[] = [];
    const pauses: boolean[] = [];
    const poller = createPoller({
      poll,
      onResult: (r, elapsed) => {
        seen.push(elapsed);
        return !(r.kind === "status" && r.status.received);
      },
      onPause: (p) => pauses.push(p),
    });
    return { poll, poller, seen, pauses };
  }

  it("polls now, every 3 s, then every 10 s after two minutes", async () => {
    const { poll, poller } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BACKOFF_AFTER_MS);
    const atBackoff = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(poll.mock.calls.length).toBeLessThanOrEqual(atBackoff + 1);
    const before = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll.mock.calls.length - before).toBe(3);
    poller.stop();
  });

  it("stops polling while hidden and polls at once when visible again", async () => {
    const { poll, poller, pauses } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(pauses).toEqual([true, false]);
    poller.stop();
  });

  it("aborts the poll in flight when hidden and drops its answer", async () => {
    let signal: AbortSignal | undefined;
    const poll = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<PollResult>((resolve) => setTimeout(() => resolve(waiting), 500));
    });
    const onResult = vi.fn(() => true);
    const poller = createPoller({ poll, onResult });
    poller.start();
    poller.pause();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onResult).not.toHaveBeenCalled();
    poller.stop();
  });

  it("starts paused in a hidden tab", async () => {
    const { poll, poller, pauses } = setup();
    poller.start(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).not.toHaveBeenCalled();
    expect(pauses).toEqual([true]);
    poller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("stops when the result says so, and keeps going on errors", async () => {
    let n = 0;
    const { poll, poller } = setup(() => {
      n += 1;
      if (n === 1) throw new Error("offline");
      return n === 2 ? waiting : { kind: "status", status: { received: true, first_at: null, last_at: null, count_1h: 1 } };
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("polls no more after stop", async () => {
    const { poll, poller } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    poller.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
